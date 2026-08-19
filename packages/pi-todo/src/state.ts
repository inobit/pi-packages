/**
 * @inobit/pi-todo — 任务状态模型与纯函数 reducer。
 *
 * 本模块不 import pi 运行时类型（结构类型注入），便于单测。
 * 状态机：pending → in_progress → completed；任意态经 delete 变 deleted（tombstone，防 id 重用）。
 * completed 仅由模型显式设置，扩展不做自动推断。
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	/** 进行中标签（present-continuous），仅 in_progress 任务持有 */
	activeForm?: string;
	status: TaskStatus;
}

export interface TaskState {
	/** 含 tombstone，渲染时过滤 */
	tasks: Task[];
	/** 会话内递增，从 1 起 */
	nextId: number;
}

/** 快照中的瘦身结构（评审点 3 方案 A：description 不随快照走，属易失字段） */
export interface TaskSnapshot {
	id: number;
	subject: string;
	status: TaskStatus;
	activeForm?: string;
}

/** 外部可见状态枚举（不含 deleted tombstone） */
export const PUBLIC_STATUSES = ["pending", "in_progress", "completed"] as const;
export type PublicStatus = (typeof PUBLIC_STATUSES)[number];

/** 合法迁移表：仅前向推进；同态视为 no-op 允许 */
const LEGAL_TRANSITIONS: Record<PublicStatus, readonly PublicStatus[]> = {
	pending: ["in_progress", "completed"],
	in_progress: ["completed"],
	completed: [],
};

export function createEmptyState(): TaskState {
	return { tasks: [], nextId: 1 };
}

export function toSnapshot(state: TaskState): TaskSnapshot[] {
	return state.tasks.map((t) => ({
		id: t.id,
		subject: t.subject,
		status: t.status,
		...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
	}));
}

/** 从快照重建内存态；description 无来源（易失，方案 A 的既有代价） */
export function fromSnapshot(tasks: TaskSnapshot[], nextId: number): TaskState {
	return {
		tasks: tasks.map((t) => ({
			id: t.id,
			subject: t.subject,
			status: t.status,
			...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
		})),
		nextId,
	};
}

/** 变更类请求（list/get 为只读，由调用方直接用查询函数处理） */
export type TodoRequest =
	| { action: "create"; subject: string; description?: string }
	| {
			action: "update";
			id: number;
			subject?: string;
			description?: string;
			status?: PublicStatus;
			activeForm?: string;
	  }
	| { action: "delete"; id: number }
	| { action: "clear" };

export interface TodoApplyResult {
	/** 新状态；error 时与原状态相同（错误路径不写快照，重放回退到上次成功快照） */
	state: TaskState;
	/** 失败原因；无则成功 */
	error?: string;
	/** 受影响任务（create/update/delete） */
	changed?: Task;
}

export function applyTodoAction(current: TaskState, req: TodoRequest): TodoApplyResult {
	switch (req.action) {
		case "create": {
			const subject = req.subject.trim();
			if (!subject) return { state: current, error: "subject is required for create" };
			const task: Task = {
				id: current.nextId,
				subject,
				status: "pending",
				...(req.description !== undefined && req.description !== "" ? { description: req.description } : {}),
			};
			return {
				state: { tasks: [...current.tasks, task], nextId: current.nextId + 1 },
				changed: task,
			};
		}

		case "update": {
			const task = current.tasks.find((t) => t.id === req.id);
			if (!task || task.status === "deleted") {
				return { state: current, error: `Task #${req.id} not found` };
			}
			const targetStatus: PublicStatus = req.status ?? task.status;
			if (targetStatus !== task.status && !LEGAL_TRANSITIONS[task.status].includes(targetStatus)) {
				return {
					state: current,
					error: `Cannot move task #${req.id} from ${task.status} to ${targetStatus}`,
				};
			}
			if (req.subject !== undefined && !req.subject.trim()) {
				return { state: current, error: "subject cannot be empty" };
			}
			const updated: Task = {
				id: task.id,
				subject: req.subject !== undefined ? req.subject.trim() : task.subject,
				status: targetStatus,
				// description：显式提供则替换（空串清除）；未提供则保留
				...(req.description !== undefined
					? req.description !== ""
						? { description: req.description }
						: {}
					: task.description !== undefined
						? { description: task.description }
						: {}),
			};
			// activeForm：仅 in_progress 任务持有；离开 in_progress 时清除
			if (targetStatus === "in_progress") {
				if (req.activeForm !== undefined) {
					const activeForm = req.activeForm.trim();
					if (activeForm) updated.activeForm = activeForm;
				} else if (task.activeForm !== undefined) {
					updated.activeForm = task.activeForm;
				}
			}
			return {
				state: {
					tasks: current.tasks.map((t) => (t.id === req.id ? updated : t)),
					nextId: current.nextId,
				},
				changed: updated,
			};
		}

		case "delete": {
			const task = current.tasks.find((t) => t.id === req.id);
			if (!task || task.status === "deleted") {
				return { state: current, error: `Task #${req.id} not found` };
			}
			const tombstone: Task = { ...task, status: "deleted" };
			delete tombstone.activeForm;
			return {
				state: { tasks: current.tasks.map((t) => (t.id === req.id ? tombstone : t)), nextId: current.nextId },
				changed: tombstone,
			};
		}

		case "clear":
			return { state: createEmptyState() };
	}
}

/** 查询：过滤含 tombstone 的任务，可选按状态过滤 */
export function listTasks(state: TaskState, status?: PublicStatus): Task[] {
	return state.tasks.filter((t) => t.status !== "deleted" && (status === undefined || t.status === status));
}

/** 查询：单任务（tombstone 视为不存在） */
export function getTask(state: TaskState, id: number): Task | undefined {
	const t = state.tasks.find((x) => x.id === id);
	return t && t.status !== "deleted" ? t : undefined;
}

/** 查询：按状态计数（不含 tombstone） */
export function countByStatus(state: TaskState): Record<PublicStatus, number> {
	const counts: Record<PublicStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
	for (const t of state.tasks) {
		if (t.status !== "deleted") counts[t.status as PublicStatus]++;
	}
	return counts;
}