/**
 * @inobit/pi-instabox — 会话级目标 entry 的读写（纯函数，不 import pi 运行时类型）。
 *
 * 两处会话级目标都用 CustomEntry 存（不进 LLM 上下文，重载会话后从会话条目重建）：
 * - {@link TARGET_ENTRY}：桌面工具的当前目标箱，由 `/instabox-use <box>` 写入；
 * - {@link DEVTOOLS_TARGET_ENTRY}：DevTools MCP 的会话绑定箱，由 `/instabox-devtools on <box>` 写入。
 *
 * 唯一合法的读取来源是 `ctx.sessionManager.getBranch()`：`getEntries()` 会带上被
 * `/tree` 放弃的分支，读到那里的目标会把「切分支后目标回到未设置」这条承诺破掉。
 * 因此本模块只接受调用方传入的分支条目，不自己碰会话管理器。
 */

/** 目标 entry 的 customType，写入与识别的唯一依据 */
export const TARGET_ENTRY = "instabox-target";

/** 目标 entry 的 data 形状（`at` 为写入时刻的 ISO 时间串，仅供排查） */
export interface TargetEntryData {
	box: string;
	at: string;
}

/** DevTools 会话绑定 entry 的 customType，写入与识别的唯一依据 */
export const DEVTOOLS_TARGET_ENTRY = "instabox-devtools-target";

/**
 * DevTools 绑定 entry 的 data 形状。
 *
 * `reset: true` 是一条**清除标记**（`box` 恒为空串）：它只终止向后扫描，让更早的绑定失效，
 * 但不清除任何已注册的 MCP server——开关状态与注册都归装配层管，entry 只表达「box 绑到哪台」。
 */
export interface DevtoolsTargetEntryData {
	box: string;
	at: string;
	reset?: true;
}

/** 会话条目的最小形态：只声明本模块用到的字段 */
export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** 是否为某个 customType 的 custom entry（仅认 type=custom + customType，不做其它推断） */
function isEntryOf(entry: unknown, customType: string): boolean {
	const e = entry as SessionEntryLike | null | undefined;
	return typeof e === "object" && e !== null && e.type === "custom" && e.customType === customType;
}

/** 是否为本次目标 entry（仅认 type=custom + customType） */
export function isTargetEntry(entry: unknown): boolean {
	return isEntryOf(entry, TARGET_ENTRY);
}

/** 构造 entry data；`at` 缺省取当前时刻，测试可显式传入以获得确定性 */
export function targetEntryData(box: string, at?: string): TargetEntryData {
	return { box, at: at ?? new Date().toISOString() };
}

/**
 * 构造 DevTools 绑定 entry data：`box` 为空串且 `reset: true` 时是清除标记。
 * `at` 缺省取当前时刻，测试可显式传入以获得确定性。
 */
export function devtoolsTargetEntryData(box: string, at?: string): DevtoolsTargetEntryData {
	const data: DevtoolsTargetEntryData = { box, at: at ?? new Date().toISOString() };
	if (box === "") data.reset = true;
	return data;
}

/**
 * 从分支条目末尾向前扫，返回最近一次写入的目标箱名；无目标 entry 时返回 undefined。
 * `entries` 必须是 `getBranch()` 的结果（调用方负责），被放弃分支上的旧目标读不到。
 */
export function readTarget(entries: readonly SessionEntryLike[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isTargetEntry(entry)) continue;
		const box = (entry?.data as Partial<TargetEntryData> | undefined)?.box;
		if (typeof box === "string" && box.length > 0) return box;
	}
	return undefined;
}

/**
 * 从分支条目末尾向前扫，返回最近一次的 DevTools 绑定箱名。
 *
 * `reset: true` 的清除标记**终止**扫描并返回 undefined：它之后的绑定才算数，更早的绑定已失效。
 * 无绑定（或最近一条是清除标记）时返回 undefined，调用方据此回退到 flag / config。
 */
export function readDevtoolsTarget(entries: readonly SessionEntryLike[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isEntryOf(entry, DEVTOOLS_TARGET_ENTRY)) continue;
		const data = entry?.data as Partial<DevtoolsTargetEntryData> | undefined;
		if (data?.reset === true) return undefined;
		const box = data?.box;
		if (typeof box === "string" && box.length > 0) return box;
	}
	return undefined;
}
