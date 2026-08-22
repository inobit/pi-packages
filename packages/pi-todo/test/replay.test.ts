import { describe, expect, it } from "vitest";
import { createEmptyState } from "../src/state.ts";
import { replayFromBranch, TodoStore, type BranchEntryLike, type TodoDetails } from "../src/store.ts";

function toolResult(details: TodoDetails): BranchEntryLike {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			details,
		},
	};
}

function snapshot(action: string, tasks: TodoDetails["tasks"], nextId: number): TodoDetails {
	return { action, tasks, nextId };
}

function errorDetails(action: string): TodoDetails {
	return { action, error: "boom" } as TodoDetails;
}

describe("replayFromBranch", () => {
	it("无快照 → undefined（调用方按空态处理）", () => {
		const branch: BranchEntryLike[] = [{ type: "message", message: { role: "user", toolName: undefined } }];
		expect(replayFromBranch(branch)).toBeUndefined();
		expect(replayFromBranch([])).toBeUndefined();
	});

	it("多个快照 → 取最新一个重建", () => {
		const branch: BranchEntryLike[] = [
			toolResult(snapshot("create", [{ id: 1, subject: "a", status: "pending" }], 2)),
			toolResult(snapshot("create", [
				{ id: 1, subject: "a", status: "pending" },
				{ id: 2, subject: "b", status: "in_progress", activeForm: "writing" },
			], 3)),
		];
		const state = replayFromBranch(branch);
		expect(state).toEqual({
			tasks: [
				{ id: 1, subject: "a", status: "pending" },
				{ id: 2, subject: "b", status: "in_progress", activeForm: "writing" },
			],
			nextId: 3,
		});
	});

	it("错误快照（只有 error）被跳过，回退到上次成功快照", () => {
		const branch: BranchEntryLike[] = [
			toolResult(snapshot("create", [{ id: 1, subject: "a", status: "pending" }], 2)),
			toolResult(errorDetails("update")),
		];
		const state = replayFromBranch(branch);
		expect(state?.tasks).toHaveLength(1);
		expect(state?.nextId).toBe(2);
	});

	it("加固：快照 nextId 异常（≤ 最大 id）时钳到 maxId+1；正常更大值保留", () => {
		const tampered = [toolResult(snapshot("create", [{ id: 5, subject: "a", status: "pending" }], 5))];
		expect(replayFromBranch(tampered)?.nextId).toBe(6);
		const healthy = [toolResult(snapshot("create", [{ id: 5, subject: "a", status: "pending" }], 9))];
		expect(replayFromBranch(healthy)?.nextId).toBe(9);
	});

	it("clear 后快照为空态 → 重放得到空态且 nextId=1", () => {
		const branch: BranchEntryLike[] = [
			toolResult(snapshot("create", [{ id: 1, subject: "a", status: "pending" }], 2)),
			toolResult(snapshot("clear", [], 1)),
		];
		const state = replayFromBranch(branch);
		expect(state).toEqual(createEmptyState());
	});

	it("非 todo 工具的 toolResult 与 custom 条目不影响重放", () => {
		const branch: BranchEntryLike[] = [
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: { output: "x" } } },
			{ type: "custom", message: undefined },
			toolResult(snapshot("create", [{ id: 1, subject: "a", status: "pending" }], 2)),
		];
		expect(replayFromBranch(branch)?.tasks[0]?.subject).toBe("a");
	});
});

describe("TodoStore 会话隔离", () => {
	it("各 session slot 互不影响（子会话/并行会话隔离）", () => {
		const store = new TodoStore();
		store.set("s1", createEmptyState());
		store.set("s2", {
			tasks: [{ id: 1, subject: "x", status: "in_progress", activeForm: "coding" }],
			nextId: 2,
		});
		expect(store.get("s1")).toEqual(createEmptyState());
		expect(store.get("s2")?.tasks[0]?.subject).toBe("x");

		// 删除 s2 不影响 s1
		store.delete("s2");
		expect(store.get("s1")).toBeDefined();
		expect(store.get("s2")).toBeUndefined();
	});

	it("getOrCreate 惰性建槽", () => {
		const store = new TodoStore();
		const a = store.getOrCreate("s");
		const b = store.getOrCreate("s");
		expect(a).toBe(b);
	});

	it("clear 清空全部槽位", () => {
		const store = new TodoStore();
		store.set("s1", createEmptyState());
		store.clear();
		expect(store.get("s1")).toBeUndefined();
	});
});