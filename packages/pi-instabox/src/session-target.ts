/**
 * @inobit/pi-instabox — 会话当前目标箱的 entry 读写（纯函数，不 import pi 运行时类型）。
 *
 * 目标箱是会话级状态：`/instabox-use <box>` 把它写成一条 CustomEntry
 * （`customType === TARGET_ENTRY`），不进 LLM 上下文，重载会话后从会话条目重建。
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

/** 会话条目的最小形态：只声明本模块用到的字段 */
export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** 是否为本次目标 entry（仅认 type=custom + customType，不做其它推断） */
export function isTargetEntry(entry: unknown): boolean {
	const e = entry as SessionEntryLike | null | undefined;
	return typeof e === "object" && e !== null && e.type === "custom" && e.customType === TARGET_ENTRY;
}

/** 构造 entry data；`at` 缺省取当前时刻，测试可显式传入以获得确定性 */
export function targetEntryData(box: string, at?: string): TargetEntryData {
	return { box, at: at ?? new Date().toISOString() };
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
