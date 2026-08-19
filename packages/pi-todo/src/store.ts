/**
 * @inobit/pi-todo — 会话槽位 store 与分支重放。
 *
 * 状态按 session id 分区（子会话互不污染）；分支重放是 /reload、compaction、
 * /tree 切换后的恢复机制。本模块不 import pi 运行时类型。
 */

import type { TaskSnapshot, TaskState } from "./state.ts";
import { createEmptyState, fromSnapshot } from "./state.ts";

/** tool result details 快照结构（评审点 3 方案 A：tasks 为瘦身结构，description 不携带） */
export interface TodoDetails {
	action: string;
	tasks: TaskSnapshot[];
	nextId: number;
	/** 仅错误路径携带：成功后不写非空 error，且错误时 tasks/nextId 缺席（不写快照） */
	error?: string;
}

/** 会话隔离：Map<sessionId, TaskState> */
export class TodoStore {
	private readonly slots = new Map<string, TaskState>();

	get(sid: string): TaskState | undefined {
		return this.slots.get(sid);
	}

	getOrCreate(sid: string): TaskState {
		let state = this.slots.get(sid);
		if (!state) {
			state = createEmptyState();
			this.slots.set(sid, state);
		}
		return state;
	}

	set(sid: string, state: TaskState): void {
		this.slots.set(sid, state);
	}

	delete(sid: string): void {
		this.slots.delete(sid);
	}

	clear(): void {
		this.slots.clear();
	}
}

/** 分支条目最小结构类型（与 SessionEntry 结构兼容，避免依赖 pi 类型） */
export interface BranchEntryLike {
	readonly type: string;
	readonly message?: {
		readonly role: string;
		readonly toolName?: string;
		readonly details?: unknown;
	};
}

export function isTodoDetails(value: unknown): value is TodoDetails {
	if (typeof value !== "object" || value === null) return false;
	const d = value as Record<string, unknown>;
	return typeof d.action === "string" && Array.isArray(d.tasks) && typeof d.nextId === "number" && d.error === undefined;
}

/**
 * 扫描分支中本工具的 toolResult，取最新一个成功快照重建内存态。
 * 错误路径的 details 只有 error、无 tasks，天然被跳过；
 * 无任何成功快照（如 fork 到早期点）返回 undefined（调用方按空态处理）。
 */
export function replayFromBranch(branch: readonly BranchEntryLike[]): TaskState | undefined {
	let latest: TodoDetails | undefined;
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (!m || m.role !== "toolResult" || m.toolName !== "todo") continue;
		if (isTodoDetails(m.details)) latest = m.details;
	}
	return latest ? fromSnapshot(latest.tasks, latest.nextId) : undefined;
}