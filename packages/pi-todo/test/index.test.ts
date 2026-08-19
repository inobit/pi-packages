import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import factory, { WIDGET_ID } from "../src/index.ts";
import type { TodoDetails } from "../src/store.ts";

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

describe("index.ts 工厂装配", () => {
	it("注册 todo 工具、/todos 命令、ctrl+shift+t 快捷键", () => {
		const pi = makePi();
		factory(pi as never);
		expect(pi.tools.has("todo")).toBe(true);
		expect(pi.tools.get("todo")?.description).toContain("Actions: create / update");
		expect(pi.commands.has("todos")).toBe(true);
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
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: snapshot("create", [{ id: 1, subject: "setup", status: "pending" }], 2),
				},
			},
		];
		const ctx = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } });
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const lines = widgetText(ctx);
		expect(lines?.[0]).toContain("Todos (0/1)");
		expect(lines?.join("\n")).toContain("setup");
		expect(lines?.join("\n")).not.toContain("#"); // 无数字序号
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

	it("tool_execution_end：本轮置完成的任务展示，agent_start 后隐藏；无关调用不点亮", async () => {
		const pi = makePi();
		factory(pi as never);
		const ctx = makeCtx({
			sessionManager: {
				getSessionId: () => "test-session",
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "todo",
							details: snapshot("update", [
								{ id: 1, subject: "setup", status: "completed" },
								{ id: 2, subject: "other", status: "completed" },
							], 3),
						},
					},
				],
			},
		});
		await pi.emit("session_start", { type: "session_start" }, ctx);
		// session_start 后：全部 completed ⇒ 面板卸载
		expect(ctx.widgetCalls.at(-1)?.content).toBeUndefined();
		// 本轮把 #1 update→completed：start 记录参数，end 揭示该 id（#2 未被揭示保持隐藏）
		await pi.emit(
			"tool_execution_start",
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "todo", args: { id: 1, status: "completed" } },
			ctx,
		);
		await pi.emit(
			"tool_execution_end",
			{ type: "tool_execution_end", toolCallId: "t1", toolName: "todo", isError: false, result: { details: snapshot("update", [{ id: 1, subject: "setup", status: "completed" }, { id: 2, subject: "other", status: "completed" }], 3) } },
			ctx,
		);
		let lines = (widgetText(ctx) ?? []).join("\n");
		expect(lines).toContain("setup");
		expect(lines).not.toContain("other"); // 本轮未揭示的其它已完成任务不点亮
		expect(widgetText(ctx)?.[0]).toContain("Todos (2/2)");
		// 无关调用（create 新任务，无 status）不会点亮已完成行，也不清除本轮揭示
		await pi.emit(
			"tool_execution_start",
			{ type: "tool_execution_start", toolCallId: "t2", toolName: "todo", args: { action: "create", subject: "x" } },
			ctx,
		);
		await pi.emit(
			"tool_execution_end",
			{ type: "tool_execution_end", toolCallId: "t2", toolName: "todo", isError: false, result: { details: snapshot("create", [{ id: 1, subject: "setup", status: "completed" }, { id: 2, subject: "other", status: "completed" }, { id: 3, subject: "x", status: "pending" }], 4) } },
			ctx,
		);
		lines = (widgetText(ctx) ?? []).join("\n");
		expect(lines).toContain("setup"); // 揭示集合未被无关调用清除
		expect(lines).not.toContain("other");
		// 下一轮开始 → 隐藏全部完成项
		await pi.emit("agent_start", { type: "agent_start" }, ctx);
		expect(ctx.widgetCalls.at(-1)?.content).toBeUndefined();
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

	it("ctrl+shift+t 切换折叠态", async () => {
		const pi = makePi();
		factory(pi as never);
		const branch = [
			{
				type: "message",
				message: { role: "toolResult", toolName: "todo", details: snapshot("create", [{ id: 1, subject: "a", status: "pending" }, { id: 2, subject: "b", status: "pending" }], 3) },
			},
		];
		const ctx = makeCtx({ sessionManager: { getSessionId: () => "test-session", getBranch: () => branch } });
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const expanded = widgetText(ctx);
		expect(expanded?.length).toBeGreaterThan(2);

		const toggle = pi.shortcuts.get("ctrl+shift+t")!;
		await toggle.handler(ctx as never);
		const collapsed = widgetText(ctx);
		expect(collapsed?.length).toBe(2);
		expect(collapsed?.[1]).toContain("ctrl+shift+t");

		await toggle.handler(ctx as never);
		expect(widgetText(ctx)?.length).toBeGreaterThan(2);
	});

	it("/todos 命令：TUI 模式打开全屏列表（按状态分组）", async () => {
		const pi = makePi();
		factory(pi as never);
		let captured: unknown;
		const ctx = makeCtx({
			mode: "tui",
			sessionManager: {
				getSessionId: () => "test-session",
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "todo",
							details: snapshot("create", [
								{ id: 1, subject: "pending task", status: "pending" },
								{ id: 2, subject: "doing task", status: "in_progress", activeForm: "coding" },
								{ id: 3, subject: "done task", status: "completed" },
							], 4),
						},
					},
				],
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

	it("session_shutdown 清空该会话槽位", async () => {
		const pi = makePi();
		factory(pi as never);
		// 先建好状态
		const branch = [
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: snapshot("create", [{ id: 1, subject: "a", status: "pending" }], 2) } },
		];
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