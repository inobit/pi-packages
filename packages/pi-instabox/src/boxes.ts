/**
 * @inobit/pi-instabox — `instabox ls --json` 解析与时序缓存（零第三方依赖）。
 *
 * 契约（方案 §5.1、§7.2）：
 * - 只保留本包用到的字段：`name`（匹配与展示）、`state`（是否 running）、`desiredState`
 *   （唤醒分流）、`template.id` / `template.version`（诊断）。`ls` 的实际输出是顶层
 *   `name` / `state` / `desiredState` + 嵌套 `template.{id,version,digest}`（本机实测），
 *   其余字段（`spec` / `storage` / `runtime` / …）一律丢弃。
 * - 解析容错：非数组输入、非对象元素、缺 `name` 的元素都跳过，**绝不 throw**；
 *   标量字段先判类型再转字符串（对象/数组/`null` 视为缺失），不把 `[object Object]`
 *   之类的东西塞进 box 名。
 * - 缓存：成功结果按 {@link BOXES_TTL_MS} 记时；失败**不缓存**（下次调用重试）；
 *   并发调用共享同一次 in-flight `ls`（同一 Promise），因此不会重复 spawn CLI。
 * - 时间为注入面（{@link ClockFn}），单测用假时钟验证命中/过期边界，不 sleep。
 */

import { type ExecFn, listBoxesRaw } from "./cli.ts";

/** 会话内 `ls` 缓存有效期（毫秒）：覆盖单轮内的多次解析，又不至于让状态长期陈旧。 */
export const BOXES_TTL_MS = 5_000;

/** `ls --json` 里本包保留的字段；缺失的字符串字段归一为 `""`（未知态）。 */
export interface BoxInfo {
	/** box 名（`ls` 的顶层 `name`，也是解析链与工具参数的匹配键） */
	name: string;
	/** 当前状态（本机观察到 `running` / `suspended`；未知态按「不可用」处理） */
	state: string;
	/** 期望状态（`suspended` 表示人工暂停 → 唤醒链走 `start`） */
	desiredState: string;
	/** 模板 id（`template.id`，仅诊断） */
	templateId: string;
	/** 模板版本（`template.version`，日期串，仅诊断；**不是** MCP `serverInfo.version`） */
	templateVersion: string;
}

/**
 * `instabox ls --json` 的 `JSON.parse` 结果 → {@link BoxInfo}[]。
 * 非数组 → `[]`；单项缺 `name`（或名字为空）→ 跳过；其余字段缺失 → `""`。
 */
export function parseLsJson(raw: unknown): BoxInfo[] {
	if (!Array.isArray(raw)) return [];
	const boxes: BoxInfo[] = [];
	for (const item of raw) {
		const box = parseBox(item);
		if (box) boxes.push(box);
	}
	return boxes;
}

/** 单元素解析：`undefined` 表示该条不是可用 box，调用方跳过。 */
function parseBox(item: unknown): BoxInfo | undefined {
	if (!isRecord(item)) return undefined;
	const name = text(item["name"])?.trim() ?? "";
	if (!name) return undefined;
	const template = item["template"];
	return {
		name,
		state: text(item["state"])?.trim() ?? "",
		desiredState: text(item["desiredState"])?.trim() ?? "",
		templateId: isRecord(template) ? (text(template["id"]) ?? "") : "",
		templateVersion: isRecord(template) ? (text(template["version"]) ?? "") : "",
	};
}

/** 注入的时钟：返回 epoch 毫秒（默认 `Date.now`，单测换成可控计数器）。与 `template.ts` 的 `ClockFn` 同形。 */
export type ClockFn = () => number;

/** `list()` 选项：`force` 跳过 TTL 直接重拉（并发时仍复用 in-flight，不会多 spawn）。 */
export interface ListBoxesOptions {
	force?: boolean;
}

/** `list()` 结果：失败时 `boxes` 为空且带 `error`，**不 throw**、不回放过期缓存。 */
export interface ListBoxesResult {
	/** 本次是否拿到 `ls` 的输出（缓存命中也算成功） */
	ok: boolean;
	/** box 列表（`ok: false` 时为 `[]`） */
	boxes: BoxInfo[];
	/** 失败原因（`ok: false` 时必有） */
	error?: string;
}

/** 会话级 `ls` 缓存句柄：单例挂在 `index.ts` 的装配里。 */
export interface BoxLister {
	/** 取 box 列表：TTL 内命中缓存；并发调用共享同一次 `ls` */
	list(opts?: ListBoxesOptions): Promise<ListBoxesResult>;
	/** 丢弃缓存（例如唤醒后要重读状态时），不影响已在飞的请求 */
	invalidate(): void;
}

/** 构造 {@link BoxLister} 的注入面。 */
export interface BoxListerOptions {
	/** 注入的 CLI 执行函数（见 `cli.ts` 的 `ExecFn`） */
	exec: ExecFn;
	/** 时钟（默认 `Date.now`） */
	clock?: ClockFn;
	/** 覆盖 {@link BOXES_TTL_MS}（非负数才生效；`0` = 每次都重拉） */
	ttlMs?: number;
}

/** 默认真实时钟：缓存记时用，与单测注入面无关。 */
const defaultClock: ClockFn = () => Date.now();

/**
 * 创建会话级 `ls` 缓存：
 * - TTL 从**成功**结果写入缓存的那一刻算起，`elapsed < ttl` 命中（等于 TTL 即过期）。
 * - 失败的 `ls` 不写缓存，下一次 `list()` 立即重试。
 * - 已在飞的请求一律复用（`force` 也不并发 spawn）。
 */
export function createBoxLister(options: BoxListerOptions): BoxLister {
	const { exec } = options;
	const clock = options.clock ?? defaultClock;
	const ttlMs = resolveTtl(options.ttlMs);
	let cached: { at: number; boxes: BoxInfo[] } | undefined;
	let inflight: Promise<ListBoxesResult> | undefined;

	async function fetchBoxes(): Promise<ListBoxesResult> {
		const raw = await listBoxesRaw(exec);
		if (!raw.ok) return { ok: false, boxes: [], error: raw.error };
		const boxes = parseLsJson(raw.json);
		cached = { at: clock(), boxes };
		return { ok: true, boxes };
	}

	return {
		list(opts: ListBoxesOptions = {}): Promise<ListBoxesResult> {
			if (inflight) return inflight;
			if (opts.force !== true && cached !== undefined && clock() - cached.at < ttlMs) {
				return Promise.resolve({ ok: true, boxes: cached.boxes });
			}
			const pending = fetchBoxes().finally(() => {
				inflight = undefined;
			});
			inflight = pending;
			return pending;
		},
		invalidate(): void {
			cached = undefined;
		},
	};
}

/** TTL 归一：只接受有限非负数，其余回落到 {@link BOXES_TTL_MS}。 */
function resolveTtl(ttlMs: number | undefined): number {
	return typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : BOXES_TTL_MS;
}

/** 宽松对象判定（数组与 `null` 都不算对象）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 标量转字符串：只认 `string` / `number` / `boolean`，其余（对象、数组、`null`）视为缺失。 */
function text(raw: unknown): string | undefined {
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return undefined;
}
