import { describe, expect, it } from "vitest";
import {
	applyTodoAction,
	countByStatus,
	createEmptyState,
	fromSnapshot,
	getTask,
	listTasks,
	toSnapshot,
	type Task,
} from "../src/state.ts";

function task(id: number, subject: string, status: Task["status"], activeForm?: string): Task {
	return activeForm ? { id, subject, status, activeForm } : { id, subject, status };
}

describe("applyTodoAction", () => {
	it("create：id 从 1 递增分配", () => {
		const r1 = applyTodoAction(createEmptyState(), { action: "create", subject: "setup vitest" });
		expect(r1.error).toBeUndefined();
		expect(r1.state.tasks).toHaveLength(1);
		expect(r1.state.nextId).toBe(2);
		expect(r1.changed).toMatchObject({ id: 1, subject: "setup vitest", status: "pending" });

		const r2 = applyTodoAction(r1.state, { action: "create", subject: "write tests" });
		expect(r2.changed?.id).toBe(2);
		expect(r2.state.nextId).toBe(3);
	});

	it("create：subject 空白时报错，状态不变", () => {
		const r = applyTodoAction(createEmptyState(), { action: "create", subject: "   " });
		expect(r.error).toBe("subject is required for create");
		expect(r.state).toEqual(createEmptyState());
	});

	it("create：description 携带，空串不存", () => {
		const r1 = applyTodoAction(createEmptyState(), { action: "create", subject: "a", description: "long" });
		expect(r1.state.tasks[0]?.description).toBe("long");
		const r2 = applyTodoAction(createEmptyState(), { action: "create", subject: "a", description: "" });
		expect(r2.state.tasks[0]?.description).toBeUndefined();
	});

	it("update：合法迁移 pending → in_progress → completed", () => {
		const base = { tasks: [task(1, "a", "pending")], nextId: 2 };
		const r1 = applyTodoAction(base, { action: "update", id: 1, status: "in_progress", activeForm: "writing tests" });
		expect(r1.error).toBeUndefined();
		expect(r1.changed).toMatchObject({ id: 1, status: "in_progress", activeForm: "writing tests" });

		const r2 = applyTodoAction(r1.state, { action: "update", id: 1, status: "completed" });
		expect(r2.error).toBeUndefined();
		expect(r2.changed).toMatchObject({ id: 1, status: "completed" });
		// 离开 in_progress 时 activeForm 被清除
		expect(r2.changed?.activeForm).toBeUndefined();
	});

	it("update：非法迁移 completed → in_progress 被拒绝", () => {
		const base = { tasks: [task(1, "a", "completed")], nextId: 2 };
		const r = applyTodoAction(base, { action: "update", id: 1, status: "in_progress" });
		expect(r.error).toMatch(/Cannot move task #1 from completed to in_progress/);
		expect(r.state).toBe(base); // 同一引用：内存态不变
	});

	it("update：非法迁移 in_progress → pending 被拒绝", () => {
		const base = { tasks: [task(1, "a", "in_progress")], nextId: 2 };
		const r = applyTodoAction(base, { action: "update", id: 1, status: "pending" });
		expect(r.error).toMatch(/Cannot move task #1 from in_progress to pending/);
	});

	it("update：同态迁移（completed → completed）视为 no-op 允许", () => {
		const base = { tasks: [task(1, "a", "completed")], nextId: 2 };
		const r = applyTodoAction(base, { action: "update", id: 1, status: "completed" });
		expect(r.error).toBeUndefined();
		expect(r.changed?.status).toBe("completed");
	});

	it("update：改标题 / 改 description（空串清除）", () => {
		const base: import("../src/state.ts").TaskState = {
			tasks: [{ id: 1, subject: "a", status: "pending", description: "old" }],
			nextId: 2,
		};
		const r1 = applyTodoAction(base, { action: "update", id: 1, subject: "  b  ", description: "new" });
		expect(r1.changed).toMatchObject({ subject: "b", description: "new" });
		const r2 = applyTodoAction(base, { action: "update", id: 1, description: "" });
		expect(r2.changed?.description).toBeUndefined();
	});

	it("update：in_progress 任务单独更新 activeForm", () => {
		const base = { tasks: [task(1, "a", "in_progress", "writing")], nextId: 2 };
		const r = applyTodoAction(base, { action: "update", id: 1, activeForm: "refactoring" });
		expect(r.error).toBeUndefined();
		expect(r.changed?.activeForm).toBe("refactoring");
	});

	it("update：更新的 activeForm 空白等价清除", () => {
		const base = { tasks: [task(1, "a", "in_progress", "writing")], nextId: 2 };
		const r = applyTodoAction(base, { action: "update", id: 1, activeForm: "  " });
		expect(r.changed?.activeForm).toBeUndefined();
	});

	it("update：任务不存在或已删除 → not found", () => {
		const base = { tasks: [task(1, "a", "pending")], nextId: 2 };
		expect(applyTodoAction(base, { action: "update", id: 99, status: "completed" }).error).toBe("Task #99 not found");
		const deleted = applyTodoAction(base, { action: "delete", id: 1 });
		expect(deleted.error).toBeUndefined();
		expect(applyTodoAction(deleted.state, { action: "update", id: 1, status: "completed" }).error).toBe("Task #1 not found");
	});

	it("delete：置 tombstone，保留在 tasks 里防止 id 重用", () => {
		const base = { tasks: [task(1, "a", "pending")], nextId: 2 };
		const r = applyTodoAction(base, { action: "delete", id: 1 });
		expect(r.error).toBeUndefined();
		expect(r.state.tasks[0]).toMatchObject({ id: 1, status: "deleted" });
		expect(r.state.nextId).toBe(2); // id 不复用
		// 重复 delete 报错
		expect(applyTodoAction(r.state, { action: "delete", id: 1 }).error).toBe("Task #1 not found");
	});

	it("clear：清空任务并重置 nextId 为 1（tombstone 一并清空）", () => {
		const base = { tasks: [task(1, "a", "completed"), task(2, "b", "in_progress")], nextId: 3 };
		const r = applyTodoAction(base, { action: "clear" });
		expect(r.error).toBeUndefined();
		expect(r.state).toEqual(createEmptyState());
	});
});

describe("查询函数", () => {
	it("listTasks：排除 tombstone，可按状态过滤", () => {
		const state = {
			tasks: [task(1, "a", "pending"), task(2, "b", "in_progress"), task(3, "c", "completed"), task(4, "d", "deleted")],
			nextId: 5,
		};
		expect(listTasks(state)).toHaveLength(3);
		expect(listTasks(state, "in_progress").map((t) => t.id)).toEqual([2]);
	});

	it("getTask：tombstone 视为不存在", () => {
		const state = { tasks: [task(1, "a", "deleted")], nextId: 2 };
		expect(getTask(state, 1)).toBeUndefined();
	});

	it("countByStatus：不含 tombstone", () => {
		const state = {
			tasks: [task(1, "a", "pending"), task(2, "b", "in_progress"), task(3, "c", "completed"), task(4, "d", "deleted")],
			nextId: 5,
		};
		expect(countByStatus(state)).toEqual({ pending: 1, in_progress: 1, completed: 1 });
	});
});

describe("快照往返", () => {
	it("toSnapshot 仅携带 id/subject/status/activeForm（无 description）", () => {
		const state: import("../src/state.ts").TaskState = {
			tasks: [{ id: 1, subject: "a", status: "in_progress", description: "secret", activeForm: "writing" }],
			nextId: 2,
		};
		expect(toSnapshot(state)).toEqual([{ id: 1, subject: "a", status: "in_progress", activeForm: "writing" }]);
	});

	it("fromSnapshot 重建内存态，description 丢失（方案 A 代价）", () => {
		const rebuilt = fromSnapshot([{ id: 3, subject: "b", status: "completed" }], 4);
		expect(rebuilt).toEqual({ tasks: [{ id: 3, subject: "b", status: "completed" }], nextId: 4 });
	});
});