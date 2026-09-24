import { describe, expect, it, vi, afterEach } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import factory, { WIDGET_ID } from "../src/index.ts";
import type { TodoDetails } from "../src/store.ts";

afterEach(() => {
	vi.useRealTimers();
});

type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface WidgetCall {
	key: string;
	content: unknown;
	options?: unknown;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	const widgetCalls: WidgetCall[] = [];
	return {
		hasUI: true,
		mode: "tui" as const,
		ui: {
			setWidget: (key: string, content: unknown, options?: unknown) => {
				widgetCalls.push({ key, content, options });
			},
			notify: () => {},
			custom: async () => {},
		},
		sessionManager: {
			getSessionId: () => "test-session",
			getBranch: () => [],
		},
		widgetCalls,
		...overrides,
	};
}

function makePi() {
	const handlers = new Map<string, EventHandler[]>();
	const tools = new Map<string, { description: string; parameters: unknown }>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const shortcuts = new Map<string, { description: string; handler: (ctx: unknown) => Promise<void> }>();
	return {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (def: { name: string; description: string; parameters: unknown }) => {
			tools.set(def.name, def);
		},
		registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, opts);
		},
		registerShortcut: (shortcut: string, opts: { description: string; handler: (ctx: unknown) => Promise<void> }) => {
			shortcuts.set(shortcut, opts);
		},
		emit: async (event: string, payload: unknown, ctx: unknown) => {
			let result: unknown;
			for (const h of handlers.get(event) ?? []) {
				result = await h(payload, ctx);
			}
			return result;
		},
		handlers,
		tools,
		commands,
		shortcuts,
	};
}

/** 取最后一次 widget 调用内容；factory 形式则调用其拿到 Text 并渲染 */
function widgetText(ctx: ReturnType<typeof makeCtx>, width = 120): string[] | undefined {
	const call = ctx.widgetCalls[ctx.widgetCalls.length - 1];
	if (!call) return undefined;
	const factory2 = call.content as ((tui: unknown, theme: Theme) => Text) | undefined;
	if (typeof factory2 !== "function") return undefined;
	const theme = {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
	return factory2(null as never, theme).render(width);
}

function snapshot(action: string, tasks: TodoDetails["tasks"], nextId: number): TodoDetails {
	return { action, tasks, nextId };
}

function branchWith(details: TodoDetails) {
	return [{ type: "message", message: { role: "toolResult", toolName: "todo", details } }];
}

async function completeTask(
	pi: ReturnType<typeof makePi>,
	ctx: ReturnType<typeof makeCtx>,
	toolCallId: string,
	id: number,
	details: TodoDetails,
) {
	await pi.emit(
		"tool_execution_start",
		{ type: "tool_execution_start", toolCallId, toolName: "todo", args: { id, status: "completed" } },
		ctx,
	);
	await pi.emit(
		"tool_execution_end",
		{ type: "tool_execution_end", toolCallId, toolName: "todo", isError: false, result: { details } },
		ctx,
	);
}

describe("index.ts 工厂装配", () => {
	it("注册 todo 工具、/todos 命令、alt+t 主快捷键 + ctrl+shift+t 别名", () => {
		const pi = makePi();
		factory(pi as never);
		expect(pi.tools.has("todo")).toBe(true);
		expect(pi.tools.get("todo")?.description).toContain("Actions: create / update");
		expect(pi.commands.has("todos")).toBe(true);
		expect(pi.shortcuts.has("alt+t")).toBe(true);
		expect(pi.shortcuts.has("ctrl+shift+t")).toBe(true);
	});

	it("订阅 session 生命周期与工具事件", () => {
		const pi = makePi();
		factory(pi as never);
		for (const ev of ["session_start", "session_compact", "session_tree", "session_shutdown", "tool_execution_start", "tool_execution_end", "agent_start"]) {
			expect(pi.handlers.has(ev)).toBe(true);
		}
	});

	it("session_start 从分支重放并在面板渲染", async () => {
		const pi = makePi();
		factory(pi as never);
		const branch = branchWith(snapshot("create", [{ id: 1, subject: "setup", status: "pending" }], 2));
		const ctx = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } });
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const lines = widgetText(ctx);
		expect(lines?.[0]).toContain("Todos (0/1)");
		expect(lines?.join("\n")).toContain("setup");
		expect(lines?.join("\n")).not.toContain("#"); // 无数字序号
	});

	it("create 误传无关 id：忽略该参数不崩溃（回归 P1）", async () => {
		const pi = makePi();
		factory(pi as never);
		const tool = pi.tools.get("todo")! as unknown as {
			execute(
				id: string,
				params: Record<string, unknown>,
				signal: undefined,
				onUpdate: undefined,
				ctx: unknown,
			): Promise<{ content: { type: string; text: string }[]; details: TodoDetails }>;
		};
		const res = await tool.execute("c1", { action: "create", subject: "x", id: 99 }, undefined, undefined, makeCtx());
		expect(res.content[0]?.text).toBe("Added #1: x");
		expect(res.details.tasks).toEqual([{ id: 1, subject: "x", status: "pending" }]);
	});

	it("session_start 无快照 → 卸载 widget", async () => {
		const pi = makePi();
		factory(pi as never);
		const ctx = makeCtx();
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const last = ctx.widgetCalls.at(-1);
		expect(last?.key).toBe(WIDGET_ID);
		expect(last?.content).toBeUndefined();
	});

	it("总量在软目标内 → 跨轮保留（agent_start 不再清空）", async () => {
		const pi = makePi();
		factory(pi as never);
		const branch = branchWith(
			snapshot("create", [
				{ id: 1, subject: "keep", status: "pending" },
				{ id: 2, subject: "done", status: "completed" },
			], 3),
		);
		const ctx = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } });
		await pi.emit("session_start", { type: "session_start" }, ctx);
		expect((widgetText(ctx) ?? []).join("\n")).toContain("done");
		await pi.emit("agent_start", { type: "agent_start" }, ctx);
		const lines = (widgetText(ctx) ?? []).join("\n");
		expect(lines).toContain("keep");
		expect(lines).toContain("done"); // 3 行 <= 目标 5，保留
	});

	it("agent_start 超目标 → 优先清理上一轮最旧，直到 <= 5", async () => {
		const pi = makePi();
		factory(pi as never);
		const branch = branchWith(
			snapshot("create", [
				{ id: 1, subject: "p1", status: "pending" },
				{ id: 2, subject: "p2", status: "pending" },
				{ id: 3, subject: "c1", status: "completed" },
				{ id: 4, subject: "c2", status: "completed" },
				{ id: 5, subject: "c3", status: "completed" },
				{ id: 6, subject: "c4", status: "completed" },
				{ id: 7, subject: "c5", status: "completed" },
			], 8),
		);
		const ctx = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } });
		await pi.emit("session_start", { type: "session_start" }, ctx);
		// 硬上限 7：标题 + 2 未完成 + 最近 4 已完成
		expect(widgetText(ctx)).toHaveLength(7);
		await pi.emit("agent_start", { type: "agent_start" }, ctx);
		const lines = widgetText(ctx) ?? [];
		expect(lines.length).toBeLessThanOrEqual(5);
		const joined = lines.join("\n");
		expect(joined).toContain("p1");
		expect(joined).toContain("p2"); // 未完成必留
		expect(joined).toContain("c4");
		expect(joined).toContain("c5"); // 最近保留
		expect(joined).not.toContain("c1");
		expect(joined).not.toContain("c2");
		expect(joined).not.toContain("c3"); // 最旧优先清理
	});

	it("置完成后立即可见（3s 确认窗口），3s 后剪到软目标且本轮最新保留", async () => {
		vi.useFakeTimers();
		const pi = makePi();
		factory(pi as never);
		const post = snapshot("update", [
			{ id: 2, subject: "p2", status: "pending" },
			{ id: 1, subject: "fresh", status: "completed" },
			{ id: 3, subject: "old1", status: "completed" },
			{ id: 4, subject: "old2", status: "completed" },
			{ id: 5, subject: "old3", status: "completed" },
			{ id: 6, subject: "old4", status: "completed" },
		], 7);
		const branch = branchWith(post);
		const ctx = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } });
		await pi.emit("session_start", { type: "session_start" }, ctx);
		await completeTask(pi, ctx, "t1", 1, post);
		// 确认窗口内：新完成项可见（即使超目标）
		expect((widgetText(ctx) ?? []).join("\n")).toContain("fresh");
		await vi.advanceTimersByTimeAsync(3000);
		const lines = widgetText(ctx) ?? [];
		expect(lines.length).toBeLessThanOrEqual(5);
		const joined = lines.join("\n");
		expect(joined).toContain("p2");
		expect(joined).toContain("fresh"); // 本轮最新保留
		expect(joined).toContain("old4");
		expect(joined).toContain("old3");
		expect(joined).not.toContain("old1");
		expect(joined).not.toContain("old2"); // 上一轮最旧先清理
	});

	it("3s 内发生 session 事件 → 取消清理（内容不变）", async () => {
		vi.useFakeTimers();
		const pi = makePi();
		factory(pi as never);
		const post = snapshot("update", [
			{ id: 2, subject: "p2", status: "pending" },
			{ id: 1, subject: "fresh", status: "completed" },
			{ id: 3, subject: "old1", status: "completed" },
			{ id: 4, subject: "old2", status: "completed" },
			{ id: 5, subject: "old3", status: "completed" },
			{ id: 6, subject: "old4", status: "completed" },
		], 7);
		const branch = branchWith(post);
		const ctx = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } });
		await pi.emit("session_start", { type: "session_start" }, ctx);
		await completeTask(pi, ctx, "t1", 1, post);
		await pi.emit("session_start", { type: "session_start" }, ctx); // 中途重放 → 取消 timer
		await vi.advanceTimersByTimeAsync(3000);
		const joined = (widgetText(ctx) ?? []).join("\n");
		expect(joined).toContain("old1"); // 未被清理
		expect(joined).toContain("fresh");
	});

	it("无关调用（create）不改变完成序与可见性", async () => {
		const pi = makePi();
		factory(pi as never);
		const branch = branchWith(
			snapshot("create", [
				{ id: 1, subject: "setup", status: "pending" },
				{ id: 2, subject: "done", status: "completed" },
			], 3),
		);
		const ctx = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } });
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const before = (widgetText(ctx) ?? []).join("\n");
		expect(before).toContain("done");
		await pi.emit(
			"tool_execution_start",
			{ type: "tool_execution_start", toolCallId: "t2", toolName: "todo", args: { action: "create", subject: "x" } },
			ctx,
		);
		await pi.emit(
			"tool_execution_end",
			{ type: "tool_execution_end", toolCallId: "t2", toolName: "todo", isError: false, result: { details: snapshot("create", [{ id: 1, subject: "setup", status: "pending" }, { id: 2, subject: "done", status: "completed" }, { id: 3, subject: "x", status: "pending" }], 4) } },
			ctx,
		);
		expect((widgetText(ctx) ?? []).join("\n")).toContain("done"); // 完成序未被无关调用清除
	});

	it("tool_execution_end：非 todo 工具或错误不刷新渲染目标", async () => {
		const pi = makePi();
		factory(pi as never);
		const ctx = makeCtx();
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const before = ctx.widgetCalls.length;
		await pi.emit("tool_execution_end", { type: "tool_execution_end", toolName: "bash", isError: false, result: { details: { output: "x" } } }, ctx);
		await pi.emit("tool_execution_end", { type: "tool_execution_end", toolName: "todo", isError: true, result: { details: { error: "x" } } }, ctx);
		expect(ctx.widgetCalls.length).toBe(before);
	});

	it("alt+t / ctrl+shift+t 切换折叠态（折叠为单行）", async () => {
		const pi = makePi();
		factory(pi as never);
		const branch = branchWith(
			snapshot("create", [{ id: 1, subject: "a", status: "pending" }, { id: 2, subject: "b", status: "pending" }], 3),
		);
		const ctx = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } });
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const expanded = widgetText(ctx);
		expect(expanded?.length).toBeGreaterThan(1);

		const toggle = pi.shortcuts.get("alt+t")!;
		await toggle.handler(ctx as never);
		const collapsed = widgetText(ctx);
		expect(collapsed?.length).toBe(1);
		expect(collapsed?.[0]).toContain("▸");
		expect(collapsed?.[0]).toContain("✓");
		expect(collapsed?.[0]).toContain("alt+t");

		// 别名同样 toggle 回展开
		const alias = pi.shortcuts.get("ctrl+shift+t")!;
		await alias.handler(ctx as never);
		expect(widgetText(ctx)?.length).toBeGreaterThan(1);
	});

	it("/todos 命令：TUI 模式打开全屏列表（按状态分组）", async () => {
		const pi = makePi();
		factory(pi as never);
		let captured: unknown;
		const ctx = makeCtx({
			mode: "tui",
			sessionManager: {
				getSessionId: () => "test-session",
				getBranch: () => branchWith(
					snapshot("create", [
						{ id: 1, subject: "pending task", status: "pending" },
						{ id: 2, subject: "doing task", status: "in_progress", activeForm: "coding" },
						{ id: 3, subject: "done task", status: "completed" },
					], 4),
				),
			},
			ui: {
				setWidget: () => {},
				notify: () => {},
				custom: async (factory2: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) => {
					captured = factory2(null as never, { fg: (_c: string, t: string) => t, bold: (t: string) => t, strikethrough: (t: string) => t } as never, null as never, () => {});
				},
			},
		});
		const cmd = pi.commands.get("todos")!;
		await cmd.handler("", ctx as never);
		const component = captured as { render(w: number): string[] };
		expect(component).toBeDefined();
		const lines = (component as { render(w: number): string[] }).render(120);
		const joined = lines.join("\n");
		expect(joined).toContain("Pending (1)");
		expect(joined).toContain("In Progress (1)");
		expect(joined).toContain("Completed (1)");
		expect(joined).toContain("pending task");
		expect(joined).not.toContain("#1"); // 无数字序号
		expect(joined).toContain("— coding");
	});

	it("切换会话 → 视图状态按会话隔离重置（id 碰撞不误藏）", async () => {
		const pi = makePi();
		factory(pi as never);
		// 会话 A：1 pending + 5 completed，agent_start 修剪后压制最旧 2 个
		const branchA = branchWith(
			snapshot("create", [
				{ id: 1, subject: "a-keep", status: "pending" },
				{ id: 2, subject: "a-old1", status: "completed" },
				{ id: 3, subject: "a-old2", status: "completed" },
				{ id: 4, subject: "a-new1", status: "completed" },
				{ id: 5, subject: "a-new2", status: "completed" },
				{ id: 6, subject: "a-new3", status: "completed" },
			], 7),
		);
		const ctxA = makeCtx({ sessionManager: { getSessionId: () => "session-a", getBranch: () => branchA } });
		await pi.emit("session_start", { type: "session_start" }, ctxA);
		await pi.emit("agent_start", { type: "agent_start" }, ctxA);
		expect((widgetText(ctxA) ?? []).join("\n")).not.toContain("a-old1");
		// 会话 B：独立编号的 id 2/3 均为已完成，切过去必须全部可见（不受 A 的压制集合影响）
		const branchB = branchWith(
			snapshot("create", [
				{ id: 1, subject: "b-keep", status: "pending" },
				{ id: 2, subject: "b-done1", status: "completed" },
				{ id: 3, subject: "b-done2", status: "completed" },
			], 4),
		);
		const ctxB = makeCtx({ sessionManager: { getSessionId: () => "session-b", getBranch: () => branchB } });
		await pi.emit("session_start", { type: "session_start" }, ctxB);
		const joined = (widgetText(ctxB) ?? []).join("\n");
		expect(joined).toContain("b-keep");
		expect(joined).toContain("b-done1");
		expect(joined).toContain("b-done2");
		expect(joined).not.toContain("a-old1");
	});

	it("session_shutdown 清空该会话槽位", async () => {
		const pi = makePi();
		factory(pi as never);
		// 先建好状态
		const branch = branchWith(snapshot("create", [{ id: 1, subject: "a", status: "pending" }], 2));
		const ctx = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } });
		await pi.emit("session_start", { type: "session_start" }, ctx);
		expect(widgetText(ctx)).toBeDefined();
		// 关会话 → 无 UI 更新，但槽位已清（再触发 session_start 无快照则卸载）
		await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		const ctx2 = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => [] } });
		await pi.emit("session_start", { type: "session_start" }, ctx2);
		expect(ctx2.widgetCalls.at(-1)?.content).toBeUndefined();
	});
});
