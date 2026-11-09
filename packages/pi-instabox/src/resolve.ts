/**
 * @inobit/pi-instabox — 解析链纯函数：决定「这一次打到哪台 box」。
 *
 * 契约（方案 §4.3/§4.4、§5.1、T6）：
 * - 5 级来源，顺序固定：`box` 参数 → 本轮最后一条 user 消息 → 会话目标 entry →
 *   配置 `defaultBox` → `instabox ls` 第一台。先命中先返回，命中即停。
 * - **不静默降级**：`box` 参数与会话目标写错是硬错误（`invalid-param` /
 *   `invalid-session`），绝不退到下一级；消息里出现多个箱名是 `ambiguous`，不猜。
 *   唯一允许降级的是配置里的 `defaultBox`：`onConfigMissing` 默认 `"skip"`（**默认降级**），
 *   并在结果里带 `skippedConfig: true`；`"fail"` 时才返回 `invalid-config`。
 * - 调用方义务（T14/T15 参照）：看到 `skippedConfig: true` 时按**每会话只 warn 一次**提示
 *   「`config.defaultBox` 指向不存在的箱，已回落到 `ls` 第一台」，并继续按 `first` 执行；
 *   本模块只负责把「配置没生效」标出来，不打印、不去重、不记忆会话。
 * - 名字匹配是**精确 token**（前后不是字母/数字/`_`/`-`）且大小写敏感，不做子串匹配：
 *   `agentic` / `agent-browser` / `Agent` 都不算 `agent`。
 * - 只把 `boxes` 里存在的名字当作候选：消息里提到一个不存在的箱名等于没提（那种名字
 *   本来也打不到），因此走下一级。
 * - 纯函数：不 import pi 运行时、不调 CLI、不读文件、无时钟；`boxes` 的顺序是唯一语义。
 */

import type { BoxInfo } from "./boxes.ts";

/** 命中来源，与解析链 5 级一一对应 */
export type ResolveSource = "param" | "message" | "session" | "config" | "first";

/** 解析失败原因（前 4 种是硬错误，`no-boxes` 是环境问题） */
export type ResolveFailureKind = "no-boxes" | "invalid-param" | "invalid-session" | "ambiguous" | "invalid-config";

/**
 * 解析结果：成功带来源（供 `[box=…]` 回显与 `/instabox-status` 展示），
 * 失败带可直接展示的 `message` 与 `candidates`（当前可用箱名，供提示与命令补全）。
 */
export type ResolveResult =
	| {
			ok: true;
			box: string;
			source: ResolveSource;
			/** 仅在跳过不存在的配置 `defaultBox` 并回落到 `ls` 第一台时出现 */
			skippedConfig?: true;
	  }
	| { ok: false; kind: ResolveFailureKind; message: string; candidates: string[] };

/** 配置 `defaultBox` 指向不存在的箱时的处理：`skip` 降级到第一台（默认），`fail` 硬错误 */
export type ConfigMissingPolicy = "fail" | "skip";

/** `resolveBox` 的输入：所有来源都由调用方取好再传进来（本模块不碰宿主与 CLI） */
export interface ResolveBoxInput {
	/** 模型显式传的 `box` 参数（空串/纯空白视为未传） */
	paramBox?: string;
	/** 本轮最后一条 user 消息的纯文本（只用来找箱名提及） */
	lastUserMessage?: string;
	/** `readTarget(getBranch())` 的结果 */
	sessionTarget?: string;
	/** 配置里的 `defaultBox`（空串＝未配置） */
	configDefaultBox?: string;
	/** `instabox ls` 的结果（可能为空；只有顺序有意义） */
	boxes: BoxInfo[];
	/** 配置 `defaultBox` 不存在时的策略，默认 `"skip"` */
	onConfigMissing?: ConfigMissingPolicy;
}

/**
 * 5 级解析链：返回第一个命中的来源，或一个带候选的失败结果。
 * 失败结果**不 throw**，由调用方决定转成工具 `isError` 结果还是命令提示。
 */
export function resolveBox(input: ResolveBoxInput): ResolveResult {
	const names = boxNames(input.boxes);

	const param = nonEmpty(input.paramBox);
	if (param !== undefined) {
		if (names.includes(param)) return { ok: true, box: param, source: "param" };
		return failure("invalid-param", `unknown box "${param}"`, names);
	}

	const mentions = findBoxMentions(input.lastUserMessage ?? "", names);
	const mention = mentions.length === 1 ? mentions[0] : undefined;
	if (mention !== undefined) return { ok: true, box: mention, source: "message" };
	if (mentions.length > 1) {
		return failure("ambiguous", `the message mentions ${mentions.length} boxes (${mentions.join(", ")})`, mentions);
	}

	const session = nonEmpty(input.sessionTarget);
	if (session !== undefined) {
		if (names.includes(session)) return { ok: true, box: session, source: "session" };
		return failure("invalid-session", `session target "${session}" is not an existing box`, names);
	}

	const config = nonEmpty(input.configDefaultBox);
	let skippedConfig = false;
	if (config !== undefined) {
		if (names.includes(config)) return { ok: true, box: config, source: "config" };
		if ((input.onConfigMissing ?? "skip") === "fail") {
			return failure("invalid-config", `config defaultBox "${config}" is not an existing box`, names);
		}
		// 配置写错只降级、不硬失败；用 skippedConfig 让调用方仍能 warn 一次
		skippedConfig = true;
	}

	// 取过滤后的名字（而非 `boxes[0]`）：`name: ""` 的条目在别处都被当无效，
	// 这里也不能把空箱名当成命中的第一台。
	const first = names[0];
	if (first === undefined) return failure("no-boxes", "instabox ls returned no boxes", []);
	if (skippedConfig) return { ok: true, box: first, source: "first", skippedConfig: true };
	return { ok: true, box: first, source: "first" };
}

/**
 * 在文本里找出所有**精确 token** 形式的箱名提及：去重、按首次出现位置排序。
 * 大小写敏感；`agentic` / `agent-browser` / `Agent` 都不匹配 `agent`。
 */
export function findBoxMentions(text: string, names: string[]): string[] {
	const hits: { name: string; at: number }[] = [];
	for (const name of uniqueNames(names)) {
		const at = firstTokenIndex(text, name);
		if (at >= 0) hits.push({ name, at });
	}
	hits.sort((a, b) => a.at - b.at);
	return hits.map((hit) => hit.name);
}

/**
 * token 边界字符集：ASCII 字母、数字、`_`、`-`。
 *
 * 只把 ASCII 算作 token 内字符，因此中文/日文等直接相邻的写法（如 `用agent跑`）仍算
 * 一次提及——instabox 箱名本身是 ASCII，CJK 贴着箱名写是正常表达而不是子串误判；
 * 反过来，箱名被夹在非拉丁单词里（现实中不出现）会漏判，这个方向的误判是安全的。
 */
const TOKEN_CHAR = /[A-Za-z0-9_-]/;

/** `name` 在 `text` 里作为独立 token 的首次出现位置；没有则 `-1` */
function firstTokenIndex(text: string, name: string): number {
	let from = 0;
	while (from <= text.length) {
		const at = text.indexOf(name, from);
		if (at < 0) return -1;
		if (isBoundary(text.charAt(at - 1)) && isBoundary(text.charAt(at + name.length))) return at;
		from = at + 1;
	}
	return -1;
}

/** 空串（越界）或非 token 字符即边界 */
function isBoundary(ch: string): boolean {
	return !TOKEN_CHAR.test(ch);
}

/** `boxes` → 去重后的名字列表（保持 `ls` 顺序；空名忽略） */
function boxNames(boxes: readonly BoxInfo[]): string[] {
	return uniqueNames(boxes.map((box) => box.name));
}

/** 去重并丢掉空名，保持首次出现顺序 */
function uniqueNames(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const name of names) {
		if (name === "" || seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

/** 归一化单值来源：`undefined` 表示「这一级没给值」（空串/纯空白等同未给） */
function nonEmpty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** 构造失败结果：`message` 后统一附上候选，便于直接展示与给模型纠错 */
function failure(kind: ResolveFailureKind, head: string, candidates: string[]): ResolveResult {
	const tail = candidates.length > 0 ? `available boxes: ${candidates.join(", ")}` : "instabox ls returned no boxes";
	return { ok: false, kind, message: `${head}; ${tail}`, candidates: [...candidates] };
}
