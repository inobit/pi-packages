/**
 * @inobit/pi-instabox — **per-box** 模板缓存 + 版本比对 + 拉取编排（方案 §4.6 V3、§4.7 D7、§5.1）。
 *
 * 契约：
 * - 缓存按 box 建索引（`{ version: 1, boxes: { [box]: CachedTemplate } }`），落在
 *   `<agentDir>/pi-instabox/templates.json`（`paths.templateCacheFile`，见 `config.ts`）。
 *   按箱建索引的理由（方案 C-b）：`template.version` 在本机是日期串且三台箱各不相同，
 *   全局单条缓存会被“版本永远不同 → 反复重拉”拖成每次都拉。
 * - 版本比对的 `serverInfoVersion` **只能**取自远端 `initialize` 的 `serverInfo.version`
 *   （即 `instabox-computer-use` 版本），不是 `ls` 的 `template.version`。`templateId` /
 *   `templateVersion` 只作为诊断字段透传保留，本模块不采集。
 * - **绝不唤醒 box**：本模块不 import `cli.ts`，也不调用任何 `wake` / `start` / `resume`；
 *   只通过注入的 `clientFactory` 拿连接、`initialize()` + `listTools()`。`instabox ssh` 到
 *   暂停箱会直接失败，失败即返回 `ok: false` 并保留旧缓存——唤醒链归 `pool.ts`。
 * - **每次 `ensure()` 先握手一次**（`initialize` → `serverInfo.version`），用这次握手的版本
 *   与缓存比对（方案 §5.4）：版本相同且未过期 → 直接返回缓存（不 `listTools`）；版本不同 /
 *   已过期 / 无缓存 → `listTools` 并写缓存。版本校验不依赖调用方传参，因此远端
 *   `instabox-computer-use` 升版后下一次 `ensure()` 就会刷新 schema，而不是等 TTL 到期。
 *   这笔握手成本是设计的一部分（`session_start` 一次），不要用“跳过握手”去优化。
 * - 复用而非独占连接：客户端由 `pool.ts` 持有，本模块**不调用 `close()`**。
 * - 失败面：拉取失败只返回 `{ ok: false, error, stale? }`（`stale` 为旧缓存，供调用方降级），
 *   写盘失败只 `warn`，都不 throw 到会话层。
 * - 注入面：`fs`（读/写文本）、`clock`（epoch 毫秒）、`clientFactory` 全部可替；默认实现的
 *   `fs` 用 `node:fs`，原子写（同目录临时文件 + `rename`）只在默认实现里。
 */

import fs from "node:fs";
import path from "node:path";
import type { InstaboxPaths } from "./config.ts";
import type { InitializeResult, RemoteClient, RemoteTool } from "./remote.ts";

/** 缓存文件结构版本（结构不兼容时整份丢弃并重建）。 */
export const TEMPLATE_CACHE_VERSION = 1;

/** 默认 TTL：168 小时（7 天，方案 §5.1）。 */
export const DEFAULT_TEMPLATE_TTL_MS = 168 * 60 * 60 * 1_000;

/** 单箱缓存条目。 */
export interface CachedTemplate {
	/** 远端 `initialize` 的 `serverInfo.version`（远端未报时为空串，此时只靠 TTL 刷新） */
	serverInfoVersion: string;
	/** 诊断字段（来自 `ls`；本模块不采集远端值，只保留入参或旧缓存里的值） */
	templateId?: string;
	/** 诊断字段（来自 `ls`；本模块不采集远端值，只保留入参或旧缓存里的值） */
	templateVersion?: string;
	/** 拉取时间（ISO 8601，用于 TTL 判定） */
	fetchedAt: string;
	/** 远端 `tools/list` 原样结果（schema 未转 TypeBox） */
	tools: RemoteTool[];
}

/** 缓存文件内容：per-box 索引。 */
export type TemplateCache = {
	version: typeof TEMPLATE_CACHE_VERSION;
	boxes: Record<string, CachedTemplate>;
};

/** 读文本（默认 {@link nodeReadText}；抛错视为该文件不存在）。 */
export type ReadTextFn = (file: string) => string;

/** 写文本（默认 {@link nodeWriteText}，同目录临时文件 + `rename`；失败可抛，由调用方降级）。 */
export type WriteTextFn = (file: string, text: string) => void;

/** 注入的文件系统：本模块只用到这两个动作。 */
export interface TemplateFileSystem {
	readText: ReadTextFn;
	writeText: WriteTextFn;
}

/** 注入的时钟：返回 epoch 毫秒（默认 `Date.now`）。 */
export type ClockFn = () => number;

/** per-box 客户端工厂（装配处传 `pool.get(box)`）。 */
export type TemplateClientFactory = (box: string) => RemoteClient;

/** 警告出口（写盘失败等非致命问题；默认丢弃）。 */
export type WarnFn = (message: string) => void;

export interface TemplateStoreOptions {
	/** `resolvePaths()` 的返回值；本模块只消费 `templateCacheFile` */
	paths: Pick<InstaboxPaths, "templateCacheFile">;
	/** 按 box 取一个**已连上但不唤醒**的远端客户端 */
	clientFactory: TemplateClientFactory;
	/** 注入的文件系统，默认 {@link nodeTemplateFileSystem} */
	fs?: TemplateFileSystem;
	/** 注入的时钟，默认 `Date.now` */
	clock?: ClockFn;
	/** 覆盖 {@link DEFAULT_TEMPLATE_TTL_MS} */
	ttlMs?: number;
	/** 诊断出口（写盘失败、坏缓存等只在这里报） */
	warn?: WarnFn;
}

export interface TemplateEnsureOptions {
	/**
	 * 显式声明的远端版本，**优先于本次握手得到的 `serverInfo.version`**。
	 * 一般不传：`ensure()` 自己会握手取版本。仅在调用方已经确定版本时用于覆盖判定。
	 */
	serverVersion?: string;
	/** 诊断字段（来自 `ls` 的 `template.id`）：给定时覆盖旧缓存值，缺省继承 */
	templateId?: string;
	/** 诊断字段（来自 `ls` 的 `template.version`）：给定时覆盖旧缓存值，缺省继承 */
	templateVersion?: string;
	/** 取消信号（透传给 `tools/list`） */
	signal?: AbortSignal;
}

/** `ensure` 的成功分支：`refetched: false` 表示这次是缓存命中。 */
export interface TemplateEnsureSuccess {
	ok: true;
	template: CachedTemplate;
	refetched: boolean;
}

/** `ensure` 的失败分支：`error` 可直接进 debug 日志或工具结果。 */
export interface TemplateEnsureFailure {
	ok: false;
	error: string;
	/** 该箱的旧缓存（存在时给出）：调用方可用过期 schema 降级，`ok: false` 语义不变 */
	stale?: CachedTemplate;
}

export type TemplateEnsureResult = TemplateEnsureSuccess | TemplateEnsureFailure;

/** per-box 模板缓存读写 + 拉取编排。 */
export interface TemplateStore {
	/** 内存中的该箱缓存（首次调用时从磁盘惰性加载）；未知箱返回 `undefined` */
	get(box: string): CachedTemplate | undefined;
	/**
	 * 先握手一次拿远端版本（`serverInfo.version`），再决定：
	 * 版本相同且未过期 → 返回缓存（`refetched: false`，不 `listTools`）；
	 * 版本不同 / 已过期 / 无缓存 → `listTools` 并写缓存（`refetched: true`）。
	 * 任何失败都返回 `ok: false`（有旧缓存时一并给出 `stale`），不动内存与磁盘。
	 */
	ensure(box: string, options?: TemplateEnsureOptions): Promise<TemplateEnsureResult>;
}

/**
 * 空的 boxes 索引：**空原型**。键来自磁盘 / 远端（任意字符串），`__proto__`、`constructor`
 * 这类键不该读到 `Object.prototype` 上的成员，也不该写穿到原型。
 */
function emptyBoxes(): Record<string, CachedTemplate> {
	return Object.create(null);
}

/** 空缓存（每次新建，避免调用方改到共享对象）。 */
export function createEmptyTemplateCache(): TemplateCache {
	return { version: TEMPLATE_CACHE_VERSION, boxes: emptyBoxes() };
}

/**
 * 缓存是否超过 TTL。
 *
 * - `now` 是 epoch 毫秒；恰好等于 `ttlMs` 边界即视为过期（“最多用这么久”）。
 * - `fetchedAt` 无法解析时判过期（宁可重拉一次）。
 * - `fetchedAt` 在未来（`now - fetchedAt < 0`）判未过期：时钟回拨不至于每次都重拉。
 */
export function isStale(entry: CachedTemplate, now: number, ttlMs: number = DEFAULT_TEMPLATE_TTL_MS): boolean {
	const fetchedAt = Date.parse(entry.fetchedAt);
	if (Number.isNaN(fetchedAt)) return true;
	return now - fetchedAt >= ttlMs;
}

/** 缓存条目是否缺 / 版本是否已变（无条目即为需要拉取）。 */
export function needsRefetch(entry: CachedTemplate | undefined, serverInfoVersion: string): boolean {
	if (entry === undefined) return true;
	return entry.serverInfoVersion !== serverInfoVersion;
}

/** 宽松对象判定（磁盘内容一律先过这里再取字段）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `unknown` → message 文本（错误文本里不出现 `[object Object]`）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 远端缺 `inputSchema` 时的空骨架（新建，避免共享引用）。 */
function emptyInputSchema(): Record<string, unknown> {
	return { type: "object", properties: {} };
}

/** 磁盘上的工具数组 → {@link RemoteTool}[]：坏条目静默跳过，整项非数组则 `undefined`（丢弃该箱）。 */
function parseTools(raw: unknown): RemoteTool[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const tools: RemoteTool[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const name = entry["name"];
		if (typeof name !== "string" || name === "") continue;
		const description = entry["description"];
		const inputSchema = entry["inputSchema"];
		tools.push({
			name,
			description: typeof description === "string" ? description : undefined,
			inputSchema: isRecord(inputSchema) ? inputSchema : emptyInputSchema(),
		});
	}
	return tools;
}

/** 单个缓存条目：字段不全就整条丢弃（不拿半条缓存去注册工具）。 */
function parseCachedTemplate(raw: unknown): CachedTemplate | undefined {
	if (!isRecord(raw)) return undefined;
	const serverInfoVersion = raw["serverInfoVersion"];
	if (typeof serverInfoVersion !== "string") return undefined;
	const fetchedAt = raw["fetchedAt"];
	if (typeof fetchedAt !== "string" || Number.isNaN(Date.parse(fetchedAt))) return undefined;
	const tools = parseTools(raw["tools"]);
	if (tools === undefined) return undefined;
	const entry: CachedTemplate = { serverInfoVersion, fetchedAt, tools };
	const templateId = raw["templateId"];
	if (typeof templateId === "string") entry.templateId = templateId;
	const templateVersion = raw["templateVersion"];
	if (typeof templateVersion === "string") entry.templateVersion = templateVersion;
	return entry;
}

/**
 * 读缓存：任何异常（文件不存在 / 非法 JSON / 结构不兼容）都退化成空缓存，**不 throw**。
 * 单条条目坏掉只丢那一箱，其余箱继续可用。
 */
export function readCache(readText: ReadTextFn, file: string): TemplateCache {
	let text: string;
	try {
		text = readText(file);
	} catch {
		return createEmptyTemplateCache();
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return createEmptyTemplateCache();
	}
	if (!isRecord(raw)) return createEmptyTemplateCache();
	if (raw["version"] !== TEMPLATE_CACHE_VERSION) return createEmptyTemplateCache();
	const boxesRaw = raw["boxes"];
	if (!isRecord(boxesRaw)) return createEmptyTemplateCache();
	const boxes = emptyBoxes();
	for (const [box, value] of Object.entries(boxesRaw)) {
		if (box === "") continue;
		const entry = parseCachedTemplate(value);
		if (entry !== undefined) boxes[box] = entry;
	}
	return { version: TEMPLATE_CACHE_VERSION, boxes };
}

/**
 * 写缓存：失败只 `warn`，**不 throw**（缓存是加速层，写不进去不影响本次会话）。
 * 返回是否写成功（调用方只用于诊断，不据此改变行为）。
 */
export function writeCache(
	writeText: WriteTextFn,
	file: string,
	cache: TemplateCache,
	warn?: WarnFn,
): boolean {
	try {
		writeText(file, `${JSON.stringify(cache, null, 2)}\n`);
		return true;
	} catch (error) {
		warn?.(`template cache write failed (${file}): ${messageOf(error)}`);
		return false;
	}
}

/** 默认读：`node:fs` 同步读文本（ENOENT 等异常由 {@link readCache} 兜住）。 */
export const nodeReadText: ReadTextFn = (file) => fs.readFileSync(file, "utf8");

/**
 * 默认写：`mkdir -p` + 同目录临时文件 + `rename`（原子替换，读者永远看不到半份 JSON）。
 * 失败时尽力删掉临时文件再抛，由 {@link writeCache} 降级成 `warn`。
 */
export const nodeWriteText: WriteTextFn = (file, text) => {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const temp = path.join(dir, `${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
	try {
		fs.writeFileSync(temp, text, "utf8");
		fs.renameSync(temp, file);
	} catch (error) {
		try {
			fs.rmSync(temp, { force: true });
		} catch {
			// 清理是尽力而为：真正的失败原因下面照原样抛出
		}
		throw error;
	}
};

/** 默认文件系统（`node:fs`）；单测一律注入内存实现。 */
export const nodeTemplateFileSystem: TemplateFileSystem = { readText: nodeReadText, writeText: nodeWriteText };

/** 远端 `initialize` 结果 → 缓存版本键（缺 `serverInfo.version` 时记空串：此时只靠 TTL 刷新）。 */
function serverVersionOf(result: InitializeResult): string {
	const version = result.serverInfo?.version;
	return typeof version === "string" ? version : "";
}

/** 失败结果（统一处）：有旧缓存就一并返回，无旧缓存时不带 `stale` 键。 */
function failure(error: string, stale: CachedTemplate | undefined): TemplateEnsureFailure {
	return stale === undefined ? { ok: false, error } : { ok: false, error, stale };
}

/** 拉取失败时的错误文本（带 box，便于 debug 日志与现状对照）。 */
function fetchFailure(box: string, error: unknown, stale: CachedTemplate | undefined): TemplateEnsureFailure {
	return failure(`failed to fetch remote template for ${box}: ${messageOf(error)}`, stale);
}

/** 取消判定（包成函数：跨 `await` 后仍能重新读到 `aborted`，不被前一次检查收窄成 `false`）。 */
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** 取消时的失败结果。 */
function abortFailure(box: string, stale: CachedTemplate | undefined): TemplateEnsureFailure {
	return failure(`template refetch for ${box} aborted by caller`, stale);
}

/**
 * 实现：内存缓存 + 磁盘单点（`paths.templateCacheFile`）。
 *
 * 磁盘只在首次访问时读一次（惰性），之后以内存为准；每次成功拉取都整体重写一次
 * （文件只有几 KB，整体重写免掉合并逻辑与半写风险）。
 */
class FileTemplateStore implements TemplateStore {
	private readonly clientFactory: TemplateClientFactory;
	private readonly fs: TemplateFileSystem;
	private readonly clock: ClockFn;
	private readonly ttlMs: number;
	private readonly warn: WarnFn | undefined;
	private readonly cacheFile: string;
	private cache: TemplateCache | undefined;

	constructor(options: TemplateStoreOptions) {
		this.clientFactory = options.clientFactory;
		this.fs = options.fs ?? nodeTemplateFileSystem;
		this.clock = options.clock ?? Date.now;
		this.ttlMs = options.ttlMs ?? DEFAULT_TEMPLATE_TTL_MS;
		this.warn = options.warn;
		this.cacheFile = options.paths.templateCacheFile;
	}

	get(box: string): CachedTemplate | undefined {
		const { boxes } = this.load();
		// hasOwn：`constructor` / `toString` 等原型成员不该被当成命中
		return Object.hasOwn(boxes, box) ? boxes[box] : undefined;
	}

	async ensure(box: string, options: TemplateEnsureOptions = {}): Promise<TemplateEnsureResult> {
		const cached = this.get(box);
		if (isAborted(options.signal)) return abortFailure(box, cached);
		// 每次 ensure 都握手一次：版本校验的唯一可靠来源是远端 `serverInfo.version`
		let client: RemoteClient;
		let handshakeVersion: string;
		try {
			client = this.clientFactory(box);
			const initialized = await client.initialize();
			if (isAborted(options.signal)) return abortFailure(box, cached);
			handshakeVersion = serverVersionOf(initialized);
		} catch (error) {
			// 握手失败保留旧缓存（不写盘、不改内存），让调用方还能用上次的 schema 降级
			this.warn?.(`template ensure failed for ${box}: ${messageOf(error)}`);
			return fetchFailure(box, error, cached);
		}
		// 显式传入的版本优先于握手值（调用方已确定版本时以它为准）
		const knownVersion = options.serverVersion ?? handshakeVersion;
		if (cached !== undefined && !isStale(cached, this.clock(), this.ttlMs) && !needsRefetch(cached, knownVersion)) {
			return { ok: true, template: cached, refetched: false };
		}
		let tools: RemoteTool[];
		try {
			tools = await client.listTools(options.signal);
		} catch (error) {
			this.warn?.(`template ensure failed for ${box}: ${messageOf(error)}`);
			return fetchFailure(box, error, cached);
		}
		const entry: CachedTemplate = {
			// 缓存版本键只记握手得到的真实版本（显式 `serverVersion` 只参与上面的判定）
			serverInfoVersion: handshakeVersion,
			templateId: options.templateId ?? cached?.templateId,
			templateVersion: options.templateVersion ?? cached?.templateVersion,
			fetchedAt: new Date(this.clock()).toISOString(),
			tools,
		};
		const cache = this.load();
		cache.boxes[box] = entry;
		writeCache(this.fs.writeText, this.cacheFile, cache, this.warn);
		return { ok: true, template: entry, refetched: true };
	}

	/** 惰性加载：磁盘坏 / 缺失都退化成空缓存，不 warn、不 throw（缓存只是加速层）。 */
	private load(): TemplateCache {
		if (this.cache === undefined) {
			this.cache = readCache(this.fs.readText, this.cacheFile);
		}
		return this.cache;
	}
}

/** 建一个 per-box 模板缓存（单会话一实例，持有内存副本并写 `paths.templateCacheFile`）。 */
export function createTemplateStore(options: TemplateStoreOptions): TemplateStore {
	return new FileTemplateStore(options);
}
