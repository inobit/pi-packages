import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { GLYPHS, glyphFor, renderTodoCall, renderTodoResult, truncateSubject } from "../src/render.ts";
import type { TodoDetails } from "../src/store.ts";

/** 假主题：fg 包装为 `{color}:{text}`，bold 包装为 `*{text}*`，便于断言 */
const fakeTheme = {
	fg: (color: string, text: string) => `${color}:${text}`,
	bold: (text: string) => `*${text}*`,
} as unknown as Theme;

function renderText(cb: (theme: Theme) => Text): string {
	// Text.render 每行右侧补空格到宽度，断言前去尾
	return cb(fakeTheme).render(200).map((l) => l.trimEnd()).join("\n");
}

function details(action: string, tasks: TodoDetails["tasks"], nextId: number, error?: string): TodoDetails {
	return error ? ({ action, error } as TodoDetails) : { action, tasks, nextId };
}

describe("行格式工具", () => {
	it("glyphFor：pending/in_progress/completed 映射，deleted 占位", () => {
		expect(glyphFor("pending")).toBe(GLYPHS.pending);
		expect(glyphFor("in_progress")).toBe(GLYPHS.in_progress);
		expect(glyphFor("completed")).toBe(GLYPHS.completed);
		expect(glyphFor("deleted")).toBe(" ");
	});

	it("truncateSubject：超长截断加省略号", () => {
		expect(truncateSubject("short title", 80)).toBe("short title");
		const long = truncateSubject("y".repeat(100), 10);
		expect(long.length).toBeLessThanOrEqual(11);
		expect(long.endsWith("…")).toBe(true);
	});
});

describe("renderTodoCall", () => {
	it("折叠行：todo <action>，create 带 subject，update/get/delete 带 #id", () => {
		expect(renderText((t) => renderTodoCall({ action: "create", subject: "write tests" }, t))).toBe(
			"toolTitle:*todo *muted:create dim:\"write tests\"",
		);
		expect(renderText((t) => renderTodoCall({ action: "update", id: 3 }, t))).toBe(
			"toolTitle:*todo *muted:update accent:#3",
		);
	});

	it("args 未完整（streaming 早期/undefined）不显示 undefined，退化为 todo …", () => {
		// 回归：tool_execution_start 后 renderCall 可能收到 partial args
		expect(renderText((t) => renderTodoCall(undefined, t))).toBe("toolTitle:*todo *muted:…");
		expect(renderText((t) => renderTodoCall({} as never, t))).toBe("toolTitle:*todo *muted:…");
	});
});

describe("renderTodoResult", () => {
	const ctx = { action: "update", id: 1 };

	it("error → 错误行", () => {
		const text = renderText((t) =>
			renderTodoResult(
				{ content: [{ type: "text", text: "Error: boom" }], details: details("update", [], 1, "boom") },
				ctx,
				t,
			),
		);
		expect(text).toBe("error:Error: boom");
	});

	it("create → Added #id: subject", () => {
		const text = renderText((t) =>
			renderTodoResult(
				{ content: [{ type: "text", text: "Added #1: a" }], details: details("create", [{ id: 1, subject: "a", status: "pending" }], 2) },
				{ action: "create" },
				t,
			),
		);
		expect(text).toBe("success:✓ Added accent:#1 muted:a");
	});

	it("update → Updated #id: subject → status (activeForm)", () => {
		const text = renderText((t) =>
			renderTodoResult(
				{
					content: [{ type: "text", text: "Updated #1: a → in_progress" }],
					details: details("update", [{ id: 1, subject: "a", status: "in_progress" }], 2),
				},
				{ action: "update", id: 1, status: "in_progress", activeForm: "writing" },
				t,
			),
		);
		expect(text).toContain("success:✓ Updated");
		expect(text).toContain("warning:→ muted:in_progress");
		expect(text).toContain("dim:(writing)");
	});

	it("delete → Deleted #id（tombstone 仍在快照中可展示标题）", () => {
		const text = renderText((t) =>
			renderTodoResult(
				{
					content: [{ type: "text", text: "Deleted #1: a" }],
					details: details("delete", [{ id: 1, subject: "a", status: "deleted" }], 2),
				},
				{ action: "delete", id: 1 },
				t,
			),
		);
		expect(text).toContain("success:✓ Deleted");
		expect(text).toContain("accent:#1");
	});

	it("clear → 用 content 文本", () => {
		const text = renderText((t) =>
			renderTodoResult(
				{ content: [{ type: "text", text: "Cleared 2 task(s)" }], details: details("clear", [], 1) },
				{ action: "clear" },
				t,
			),
		);
		expect(text).toBe("success:✓ muted:Cleared 2 task(s)");
	});

	it("get → 直接展示 content 单条全量（含 description）", () => {
		const text = renderText((t) =>
			renderTodoResult(
				{
					content: [{ type: "text", text: "#3 [in_progress] a\nlong description" }],
					details: details("get", [{ id: 3, subject: "a", status: "in_progress", activeForm: "writing" }], 4),
				},
				{ action: "get", id: 3 },
				t,
			),
		);
		expect(text).toContain("#3 [in_progress] a\nlong description");
	});

	it("list → 数量概要", () => {
		const text = renderText((t) =>
			renderTodoResult(
				{ content: [{ type: "text", text: "3 task(s): 1 pending, 1 in_progress, 1 completed" }], details: details("list", [], 1) },
				{ action: "list" },
				t,
			),
		);
		expect(text).toContain("3 task(s)");
	});
});