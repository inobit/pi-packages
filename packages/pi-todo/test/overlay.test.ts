import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildOverlayLines,
	planVisibility,
	taskRow,
	DEFAULT_MAX_LINES,
	DEFAULT_TARGET_LINES,
	type OverlayLine,
} from "../src/overlay.ts";
import { createEmptyState, type Task, type TaskState } from "../src/state.ts";

function state(tasks: Task[]): TaskState {
	return { tasks, nextId: tasks.length + 1 };
}

const pending = (id: number, subject: string): Task => ({ id, subject, status: "pending" });
const inProgress = (id: number, subject: string, activeForm?: string): Task =>
	activeForm ? { id, subject, status: "in_progress", activeForm } : { id, subject, status: "in_progress" };
const completed = (id: number, subject: string): Task => ({ id, subject, status: "completed" });
const deleted = (id: number, subject: string): Task => ({ id, subject, status: "deleted" });

function plain(lines: OverlayLine[]): string[] {
	return lines.map((l) => l.map((s) => s.text).join(""));
}

describe("预算默认值", () => {
	it("硬上限 7 / 软目标 5", () => {
		expect(DEFAULT_MAX_LINES).toBe(7);
		expect(DEFAULT_TARGET_LINES).toBe(5);
	});
});

describe("buildOverlayLines", () => {
	it("空列表 → 返回空数组（卸载 widget 的信号）", () => {
		expect(buildOverlayLines(createEmptyState(), { collapsed: false })).toEqual([]);
		expect(buildOverlayLines(createEmptyState(), { collapsed: true })).toEqual([]);
	});

	it("标题：▾ Todos (done/total)，tombstone 不计入 total", () => {
		const s = state([pending(1, "a"), completed(2, "b"), deleted(3, "z")]);
		const lines = plain(buildOverlayLines(s, { collapsed: false, completedOrder: [2] }));
		expect(lines[0]).toBe("▾ Todos (1/2)");
	});

	it("行格式：glyph + 标题（无数字序号）；in_progress 附 activeForm 标签；completed 需在完成序才显示", () => {
		const s = state([pending(1, "setup"), inProgress(2, "write tests", "writing tests"), completed(3, "done")]);
		const lines = plain(buildOverlayLines(s, { collapsed: false, completedOrder: [3] }));
		expect(lines[1]).toContain("○ setup");
		expect(lines[1]).not.toContain("#1");
		expect(lines[2]).toContain("◐ write tests — writing tests");
		expect(lines[3]).toContain("✓ done");
	});

	it("completed 行样式：整行灰色 + 标题删除线（pending/in_progress 不受影响）", () => {
		const s = state([completed(3, "done"), pending(1, "setup")]);
		const rows = buildOverlayLines(s, { collapsed: false, completedOrder: [3] }).slice(1);
		const [pendingRow, completedRow] = rows; // 显示按 id 序
		// completed：glyph 灰、标题灰 + 删除线，无序号
		expect(completedRow).toEqual([
			{ text: " ✓ ", fg: "muted" },
			{ text: "done", fg: "muted", strikethrough: true },
		]);
		// pending：不受影响（无删除线，glyph dim）
		expect(pendingRow?.some((seg) => seg.strikethrough)).toBe(false);
		expect(pendingRow).toEqual([
			{ text: " ○ ", fg: "dim" },
			{ text: "setup", fg: "text" },
		]);
	});

	it("完成项隐藏：不在完成序/suppressed 中的 completed 不渲染，但标题仍统计", () => {
		const s = state([pending(1, "a"), completed(2, "b"), completed(3, "c")]);
		const lines = plain(buildOverlayLines(s, { collapsed: false, completedOrder: [3] }));
		expect(lines).toHaveLength(3); // 标题 + a + c
		expect(lines.join("\n")).not.toContain("b");
		expect(lines.join("\n")).toContain("c");
		expect(lines[0]).toBe("▾ Todos (2/3)");
		// suppressed：即使在完成序也被隐藏
		const suppressed = plain(
			buildOverlayLines(s, { collapsed: false, completedOrder: [2, 3], suppressed: new Set([2, 3]) }),
		);
		expect(suppressed).toHaveLength(2);
		expect(suppressed[0]).toBe("▾ Todos (2/3)");
		// 无完成序：全部 completed 隐藏，仅剩标题 + pending
		const hidden = plain(buildOverlayLines(s, { collapsed: false }));
		expect(hidden).toHaveLength(2);
		expect(hidden[0]).toBe("▾ Todos (2/3)");
	});

	it("折叠态：单行 ▸ 标题 + ✓/◐/○ 明细 + alt+t 提示", () => {
		const s = state([pending(1, "a"), pending(2, "b"), completed(3, "c")]);
		const lines = plain(buildOverlayLines(s, { collapsed: true, completedOrder: [3] }));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("▸ Todos (1/3)");
		expect(lines[0]).toContain("✓ 1");
		expect(lines[0]).toContain("◐ 0");
		expect(lines[0]).toContain("○ 2");
		expect(lines[0]).toContain("alt+t");
	});

	it("溢出：硬预算内取最近已完成，未完成必留", () => {
		// 上限 4 行（含标题）→ 可用 3 行；2 pending + 3 completed（完成序 3→4→5）
		const s = state([
			pending(1, "p1"), pending(2, "p2"),
			completed(3, "c1"), completed(4, "c2"), completed(5, "c3"),
		]);
		const lines = plain(
			buildOverlayLines(s, { collapsed: false, completedOrder: [3, 4, 5], maxLines: 4 }),
		);
		// 可用 3 行，未完成占 2，剩 1 槽给最近的 c3
		expect(lines).toHaveLength(4);
		expect(lines.some((l) => l.includes("c3"))).toBe(true);
		expect(lines.some((l) => l.includes("c1"))).toBe(false);
		expect(lines.some((l) => l.includes("c2"))).toBe(false);
	});

	it("溢出：未完成独占超限则截断并提示 +N more（已完成已让位）", () => {
		// 上限 5 行（含标题）→ 可用 4 行；5 pending + 6 completed
		const s = state([
			pending(1, "p1"), pending(2, "p2"), pending(3, "p3"), pending(4, "p4"), pending(5, "p5"),
			completed(6, "c1"), completed(7, "c2"), completed(8, "c3"), completed(9, "c4"), completed(10, "c5"), completed(11, "c6"),
		]);
		const lines = plain(
			buildOverlayLines(s, { collapsed: false, completedOrder: [6, 7, 8, 9, 10, 11], maxLines: 5 }),
		);
		expect(lines).toHaveLength(5); // 标题 + 3 任务行 + more 行
		expect(lines[4]).toBe("+2 more");
		expect(lines.slice(1, 4).every((l) => l.includes("p"))).toBe(true); // 保留的都是 pending
	});

	it("taskRow：超长标题截断加省略号", () => {
		const long = "x".repeat(100);
		const row = plain([taskRow(pending(1, long))]);
		expect(row[0]!.length).toBeLessThan(100 + 20);
		expect(row[0]).toContain("…");
	});

	it("taskRow：CJK 标题 + 超长 activeForm 整行不超列预算（回归 P4）", () => {
		const row = taskRow(inProgress(1, "中".repeat(60), "写".repeat(60)));
		const width = visibleWidth(row.map((s) => s.text).join(""));
		// 内容区 80 列 + glyph 段 3 列
		expect(width).toBeLessThanOrEqual(83);
		expect(width).toBeGreaterThan(40); // 确有内容而非空行退化
	});
});

describe("planVisibility", () => {
	it("未完成必留，已完成按新→旧取剩余槽位", () => {
		const s = state([pending(1, "p1"), completed(2, "c1"), completed(3, "c2"), completed(4, "c3")]);
		// maxLines 3 → 可用 2；未完成占 1，剩 1 槽 → 最近的 c3
		const plan = planVisibility(s, { completedOrder: [2, 3, 4], maxLines: 3 });
		expect(plan.unfinished.map((t) => t.id)).toEqual([1]);
		expect(plan.completedShown.map((t) => t.id)).toEqual([4]);
		expect(plan.hiddenCompleted.map((t) => t.id).sort()).toEqual([2, 3]);
		expect(plan.renderedLines).toBe(3);
	});

	it("空态 renderedLines 为 0", () => {
		expect(planVisibility(createEmptyState(), {}).renderedLines).toBe(0);
	});
});
