import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register, { COMMAND_NAME, parseArgs } from "../src/index.ts";

/**
 * 入口冒烟：扩展工厂能被加载并注册 `/subagent-presets`。
 * 真实 `pi -ne -e ./packages/pi-subagent-presets` 会走同一条模块图。
 */
interface RegisteredCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => unknown;
}

function fakePi() {
	const commands: RegisteredCommand[] = [];
	const shortcuts: string[] = [];
	const messages: { customType: string; content: string; display?: boolean }[] = [];
	return {
		commands,
		shortcuts,
		messages,
		api: {
			registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
				commands.push({ name, ...options });
			},
			registerShortcut(id: string) {
				shortcuts.push(id);
			},
			sendMessage(message: { customType: string; content: string; display?: boolean }) {
				messages.push(message);
				return Promise.resolve();
			},
			on() {},
			registerTool() {},
			appendEntry() {},
			sendUserMessage() {},
		},
	};
}

/** headless 上下文：`hasUI: false` ⇒ `ui.notify` 是空实现（与 print / RPC 模式一致）。 */
function headlessCtx() {
	return { ui: { notify: () => {} }, cwd: process.cwd(), hasUI: false, mode: "print" };
}

describe("扩展入口", () => {
	// headless 回落分支会往 stdout 写（print 模式下的真实行为），测试里静音。
	// 必须在每个用例前重新挂：afterEach 会把上一个的 spy 恢复掉。
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("默认导出是工厂函数，注册且只注册一个 /subagent-presets 命令", () => {
		expect(typeof register).toBe("function");
		const { api, commands } = fakePi();
		register(api as never);
		expect(commands.map((c) => c.name)).toEqual([COMMAND_NAME]);
		expect(COMMAND_NAME).toBe("subagent-presets");
		expect(commands[0]?.description).toBeTruthy();
	});

	it("handler 是异步函数", () => {
		const { api, commands } = fakePi();
		register(api as never);
		expect(typeof commands[0]?.handler).toBe("function");
	});

	it("参数补全只在 --from 前缀下给出 profile 名字", () => {
		const { api, commands } = fakePi();
		register(api as never);
		const complete = commands[0]?.getArgumentCompletions;
		expect(complete?.("--from")).not.toBeNull();
		expect(complete?.("rev")).toBeNull();
	});

	it("非法参数 ⇒ 报错并列出可用 profile，不进入矩阵", async () => {
		const { api, commands, messages } = fakePi();
		register(api as never);
		await commands[0]?.handler("--from ../escape", headlessCtx());
		const texts = messages.map((m) => m.content);
		expect(texts.some((t) => t.includes("Invalid profile name"))).toBe(true);
		expect(messages.every((m) => m.customType === "pi-subagent-presets" && m.display === true)).toBe(true);
	});

	it("未知参数 ⇒ 报错", async () => {
		const { api, commands, messages } = fakePi();
		register(api as never);
		await commands[0]?.handler("--bogus", headlessCtx());
		expect(messages.some((m) => m.content.includes("Unexpected argument"))).toBe(true);
	});

	it("headless 下 `ui.notify` 是空实现，但摘要仍经 sendMessage 送达（§5）", async () => {
		const { api, commands, messages } = fakePi();
		register(api as never);
		// 非法参数这条路径不碰文件系统，最接近真实 headless 行为且不会写盘
		await commands[0]?.handler("--nope", headlessCtx());
		expect(messages.length).toBeGreaterThan(0);
		for (const message of messages) {
			expect(message.customType).toBe("pi-subagent-presets");
			expect(message.display).toBe(true);
		}
	});

	it("参数解析的边界", () => {
		expect(parseArgs("--from work").from).toBe("work");
		expect(parseArgs("--from=work.json").from).toBe("work");
		expect(parseArgs("")).toEqual({ errors: [] });
		expect(vi.isMockFunction(parseArgs)).toBe(false);
	});
});
