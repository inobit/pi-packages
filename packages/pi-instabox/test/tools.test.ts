/**
 * @inobit/pi-instabox — `src/tools.ts` 单测：远端 `tools/list` → pi 工具定义（名字/label/exposure/
 * namespace）、`box` 只加在顶层 `properties`、成功首行 `[box=…]`、远端 `content`（含 image）原样透传、
 * `isError` 透传 + 修复建议、解析失败不降级也不调池、`signal` 透传、一切异常转 `isError`。
 *
 * 全部走假 `pool` / 假 `resolve` / 假 `listBoxes`：不 spawn 真进程、不联网、不读盘。
 */

import type { AgentToolResult, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { BoxInfo } from "../src/boxes.ts";
import { createMemoryLogger, setLogger } from "../src/log.ts";
import type { Pool, PoolGetOptions } from "../src/pool.ts";
import type { CallToolResult, InitializeResult, RemoteClient, RemoteTool } from "../src/remote.ts";
import type { ResolveResult } from "../src/resolve.ts";
import { jsonSchemaToTypeBox } from "../src/schema.ts";
import {
	BOX_PARAM,
	DESKTOP_NAMESPACE_ALIASES,
	DESKTOP_NAMESPACE_NAME,
	buildToolDefinitions,
	desktopToolLabel,
	desktopToolName,
} from "../src/tools.ts";

/** 9 个远端桌面工具（名字按 instabox-computer-use 的形态构造，条数与 plan 口径一致）。 */
const REMOTE_NAMES = [
	"screenshot",
	"click",
	"double_click",
	"type_text",
	"press_key",
	"scroll",
	"drag",
	"list_apps",
	"launch_app",
] as const;

/** 只带 object schema 的远端工具（`inputSchema` 是 `box` 注入的落点）。 */
function remoteTool(name: string, extra: Partial<RemoteTool> = {}): RemoteTool {
	return {
		name,
		description: `remote ${name}`,
		inputSchema: {
			type: "object",
			properties: { x: { type: "number" }, y: { type: "number" } },
			required: ["x", "y"],
		},
		...extra,
	};
}

const REMOTE_TOOLS: RemoteTool[] = REMOTE_NAMES.map((name) => remoteTool(name));

/** `TSchema` 是 typebox 的空接口；断言 schema 内容前转成键值视图。 */
function jsonOf(schema: unknown): Record<string, unknown> {
	return schema as Record<string, unknown>;
}

function propertiesOf(schema: unknown): Record<string, unknown> {
	const properties = jsonOf(schema)["properties"];
	return typeof properties === "object" && properties !== null ? (properties as Record<string, unknown>) : {};
}

/** 假客户端：记录 `callTool` 的入参，结果由测试脚本化（返回值或抛错）。 */
class FakeClient implements RemoteClient {
	readonly calls: { name: string; args: Record<string, unknown> | undefined; signal: AbortSignal | undefined }[] = [];
	private readonly outcome: () => Promise<CallToolResult>;

	constructor(outcome: () => Promise<CallToolResult>) {
		this.outcome = outcome;
	}

	async initialize(): Promise<InitializeResult> {
		return {};
	}

	async listTools(): Promise<RemoteTool[]> {
		return [];
	}

	async callTool(
		name: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		this.calls.push({ name, args, signal });
		return this.outcome();
	}

	close(): void {}

	isDead(): boolean {
		return false;
	}
}

interface FakePoolOptions {
	client?: RemoteClient;
	/** 池返回 `{ ok: false, error }` */
	failWith?: string;
	/** 池自己抛错（防御：池不再 throw，但工具层仍须兜住） */
	throwWith?: Error;
}

/** 假池：记录每次 `get` 的 box 与选项，客户端由测试给定。 */
function fakePool(options: FakePoolOptions = {}) {
	const gets: { box: string; opts: PoolGetOptions | undefined }[] = [];
	const pool: Pool = {
		get: async (box, opts) => {
			gets.push({ box, opts });
			if (options.throwWith !== undefined) throw options.throwWith;
			if (options.failWith !== undefined) return { ok: false, error: options.failWith };
			const client = options.client ?? new FakeClient(async () => ({ content: [] }));
			return { ok: true, client };
		},
		dispose: () => {},
		disposeAll: () => {},
		size: () => 0,
	};
	return { pool, gets };
}

interface BuildOptions {
	remoteTools?: RemoteTool[];
	pool?: Pool;
	resolve?: (paramBox?: string) => Promise<ResolveResult>;
	listBoxes?: () => Promise<{ boxes: BoxInfo[] }>;
	warn?: (message: string) => void;
}

/** 默认成功链路：解析到 `agent`、池可用、`ls` 有一台箱。 */
function build(options: BuildOptions = {}): { tools: ToolDefinition[]; warnings: string[] } {
	const warnings: string[] = [];
	const tools = buildToolDefinitions({
		remoteTools: options.remoteTools ?? REMOTE_TOOLS,
		pool: options.pool ?? fakePool().pool,
		resolve: options.resolve ?? (async () => ({ ok: true, box: "agent", source: "param" })),
		listBoxes: options.listBoxes ?? (async () => ({ boxes: [{ name: "agent" } as BoxInfo] })),
		warn: (message) => {
			warnings.push(message);
			options.warn?.(message);
		},
	});
	return { tools, warnings };
}

/** 取第 `index` 个工具定义（按远端名查，避免依赖数组顺序）。 */
function toolNamed(tools: ToolDefinition[], remoteName: string): ToolDefinition {
	const found = tools.find((tool) => tool.name === desktopToolName(remoteName));
	if (found === undefined) throw new Error(`no tool for remote ${remoteName}`);
	return found;
}

/** 直接调 `execute`（工具不使用 ctx，给一个空对象即可）。 */
function run(
	tool: ToolDefinition,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	updates?: AgentToolResult<unknown>[],
): Promise<AgentToolResult<unknown>> {
	const context = {} as unknown as ExtensionToolContext;
	return tool.execute(
		"call-1",
		params,
		signal,
		updates === undefined ? undefined : (partial) => updates.push(partial),
		context,
	);
}

describe("工具定义形状", () => {
	it("9 个远端工具 → 9 个 pi 工具，名字唯一且带 instabox_desktop_ 前缀", () => {
		const { tools } = build();
		expect(tools).toHaveLength(REMOTE_NAMES.length);
		expect(tools.map((tool) => tool.name)).toEqual(REMOTE_NAMES.map((name) => `instabox_desktop_${name}`));
		expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
	});

	it("label 必填、唯一、`instabox desktop <remote_name>`", () => {
		const { tools } = build();
		for (const tool of tools) {
			expect(tool.label).toBe(`instabox desktop ${tool.name.slice("instabox_desktop_".length)}`);
			expect(tool.label.length).toBeGreaterThan(0);
		}
		expect(new Set(tools.map((tool) => tool.label)).size).toBe(tools.length);
		expect(desktopToolLabel("click")).toBe("instabox desktop click");
	});

	it("exposure 全为 codemode，且共享同一 namespace（name/aliases/description/instructions）", () => {
		const { tools } = build();
		const first = tools[0]?.namespace;
		expect(first).toBeDefined();
		for (const tool of tools) {
			expect(tool.exposure).toBe("codemode");
			expect(tool.namespace).toBe(first);
			expect(tool.namespace?.name).toBe(DESKTOP_NAMESPACE_NAME);
			expect(tool.namespace?.aliases).toEqual([...DESKTOP_NAMESPACE_ALIASES]);
			expect(tool.namespace?.description).toContain("instabox");
			expect(tool.namespace?.instructions).toContain("[box=");
		}
		expect(DESKTOP_NAMESPACE_NAME).toBe("instabox-desktop");
	});

	it("description 透传远端文案；远端没有描述时给兜底（不留空）", () => {
		const { tools } = build({ remoteTools: [remoteTool("click"), { name: "screenshot", inputSchema: { type: "object" } }] });
		expect(toolNamed(tools, "click").description).toBe("remote click");
		const fallback = toolNamed(tools, "screenshot").description;
		expect(fallback).toContain("screenshot");
		expect(fallback.trim().length).toBeGreaterThan(0);
	});

	it("remoteTools 为空 → 零工具（无 CLI / 无缓存即不注册）", () => {
		expect(build({ remoteTools: [] }).tools).toEqual([]);
	});

	it("同名远端工具 → 只保留第一个并 warn 一次", () => {
		const { tools, warnings } = build({
			remoteTools: [remoteTool("click"), remoteTool("click", { description: "duplicate click" }), remoteTool("scroll")],
		});

		expect(tools.map((tool) => tool.name)).toEqual(["instabox_desktop_click", "instabox_desktop_scroll"]);
		expect(toolNamed(tools, "click").description).toBe("remote click");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("more than once");
		expect(warnings[0]).toContain("click");
	});
});

describe("box 参数注入", () => {
	it("box 只出现在顶层 properties，且不进 required", () => {
		const nested = remoteTool("click", {
			inputSchema: {
				type: "object",
				properties: {
					target: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
				},
				required: ["target"],
			},
		});
		const { tools } = build({ remoteTools: [nested] });
		const parameters = toolNamed(tools, "click").parameters;
		const properties = propertiesOf(parameters);
		expect(properties[BOX_PARAM]).toBeDefined();
		expect(jsonOf(parameters)["required"]).toEqual(["target"]);
		// 嵌套对象里没有 box：注入只发生在顶层
		const target = properties["target"];
		expect(propertiesOf(target)[BOX_PARAM]).toBeUndefined();
	});

	it("远端自带 box → 不注入、只 warn 一次（parameters 与远端 schema 一致）", () => {
		const conflicting = remoteTool("click", {
			inputSchema: {
				type: "object",
				properties: { [BOX_PARAM]: { type: "string", description: "remote box" }, x: { type: "number" } },
				required: [BOX_PARAM],
			},
		});
		const { tools, warnings } = build({ remoteTools: [conflicting] });
		const tool = toolNamed(tools, "click");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("box");
		expect(tool.parameters).toEqual(jsonSchemaToTypeBox(conflicting.inputSchema));
		expect(jsonOf(tool.parameters)["required"]).toEqual([BOX_PARAM]);
	});

	it("顶层不是 object schema → 不注入、warn 一次", () => {
		const scalar = remoteTool("press_key", { inputSchema: { type: "string" } });
		const { tools, warnings } = build({ remoteTools: [scalar] });
		expect(warnings).toHaveLength(1);
		expect(tools[0]?.parameters).toEqual(jsonSchemaToTypeBox(scalar.inputSchema));
	});

	it("无冲突时不发 warning", () => {
		expect(build().warnings).toEqual([]);
	});

	it("`injected === false` 时 `params.box` 仍被消费：解析链第 1 级生效、`forwardArgs` 仍剥掉 `box`", async () => {
		const seen: (string | undefined)[] = [];
		const client = new FakeClient(async () => ({ content: [] }));
		const conflicting = remoteTool("click", {
			inputSchema: {
				type: "object",
				properties: { [BOX_PARAM]: { type: "string", description: "remote box" }, x: { type: "number" } },
				required: [],
			},
		});
		const scalar = remoteTool("press_key", { inputSchema: { type: "string" } });
		const { tools, warnings } = build({
			remoteTools: [conflicting, scalar],
			pool: fakePool({ client }).pool,
			resolve: async (paramBox) => {
				seen.push(paramBox);
				return { ok: true, box: paramBox ?? "agent", source: "param" };
			},
		});

		const conflictResult = await run(toolNamed(tools, "click"), { [BOX_PARAM]: "general", x: 1 });
		const scalarResult = await run(toolNamed(tools, "press_key"), { [BOX_PARAM]: "general" });

		// 两次都走参数级：`resolve` 收到 `box`，显式目标生效
		expect(seen).toEqual(["general", "general"]);
		expect(conflictResult.content[0]).toEqual({ type: "text", text: "[box=general]" });
		expect(scalarResult.content[0]).toEqual({ type: "text", text: "[box=general]" });
		// 远端实参里都没有 `box`（本层参数不透传，包括远端自带的那份）
		expect(client.calls[0]?.args).toEqual({ x: 1 });
		expect(client.calls[1]?.args).toEqual({});
		// 未注入本身仍各报一次（两种降级原因不同）
		expect(warnings).toHaveLength(2);
	});
});

describe("execute：转发与回显", () => {
	it("成功时首行是 [box=<name>]，远端 content 原样透传（含 image）", async () => {
		const remoteText = { type: "text", text: "screenshot taken" };
		const remoteImage = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
		const client = new FakeClient(async () => ({ content: [remoteText, remoteImage] }));
		const { tools } = build({ pool: fakePool({ client }).pool });

		const result = await run(toolNamed(tools, "screenshot"), {});

		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "[box=agent]" }, remoteText, remoteImage]);
		expect(result.content[1]).toBe(remoteText);
		expect(result.content[2]).toBe(remoteImage);
	});

	it("box 参数不进远端实参，其余参数原样转发", async () => {
		const client = new FakeClient(async () => ({ content: [{ type: "text", text: "ok" }] }));
		const { tools } = build({ pool: fakePool({ client }).pool });

		await run(toolNamed(tools, "click"), { [BOX_PARAM]: "agent", x: 10, y: 20 });

		expect(client.calls).toHaveLength(1);
		expect(client.calls[0]?.name).toBe("click");
		expect(client.calls[0]?.args).toEqual({ x: 10, y: 20 });
	});

	it("box 参数交给 resolve；未传时 resolve 收到 undefined", async () => {
		const seen: (string | undefined)[] = [];
		const resolve = async (paramBox?: string): Promise<ResolveResult> => {
			seen.push(paramBox);
			return { ok: true, box: "agent", source: "param" };
		};
		const { tools } = build({ resolve });

		await run(toolNamed(tools, "click"), { [BOX_PARAM]: "general" });
		await run(toolNamed(tools, "click"), {});
		await run(toolNamed(tools, "click"), { [BOX_PARAM]: "   " });

		expect(seen).toEqual(["general", undefined, undefined]);
	});

	it("首行回显的是解析结果（不是参数里的原始名字）", async () => {
		const client = new FakeClient(async () => ({ content: [] }));
		const { tools } = build({
			pool: fakePool({ client }).pool,
			resolve: async () => ({ ok: true, box: "agent", source: "session" }),
		});

		const result = await run(toolNamed(tools, "click"), {});

		expect(result.content[0]).toEqual({ type: "text", text: "[box=agent]" });
	});

	it("远端 content 缺失/非数组时不崩，仍回显 box", async () => {
		const client = new FakeClient(async () => ({}));
		const { tools } = build({ pool: fakePool({ client }).pool });

		const result = await run(toolNamed(tools, "click"), {});

		expect(result.content).toEqual([{ type: "text", text: "[box=agent]" }]);
		expect(result.isError).toBeUndefined();
	});

	it("signal 透传给 pool.get 与 client.callTool", async () => {
		const controller = new AbortController();
		const client = new FakeClient(async () => ({ content: [] }));
		const { pool, gets } = fakePool({ client });
		const { tools } = build({ pool });

		await run(toolNamed(tools, "click"), {}, controller.signal);

		expect(gets[0]?.opts?.signal).toBe(controller.signal);
		expect(client.calls[0]?.signal).toBe(controller.signal);
	});

	it("唤醒进度经 onProgress → onUpdate 透出", async () => {
		const updates: AgentToolResult<unknown>[] = [];
		const client = new FakeClient(async () => ({ content: [] }));
		const pool: Pool = {
			get: async (_box, opts) => {
				opts?.onProgress?.("正在唤醒 agent…");
				return { ok: true, client };
			},
			dispose: () => {},
			disposeAll: () => {},
			size: () => 0,
		};
		const { tools } = build({ pool });

		await run(toolNamed(tools, "click"), {}, undefined, updates);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.content).toEqual([{ type: "text", text: "正在唤醒 agent…" }]);
	});
});

describe("execute：失败路径（一律 isError，绝不 throw）", () => {
	it("解析失败：不调用 pool，错误文本含 message 与候选", async () => {
		const { pool, gets } = fakePool();
		const { tools } = build({
			pool,
			resolve: async () => ({ ok: false, kind: "invalid-param", message: 'unknown box "nope"', candidates: [] }),
			listBoxes: async () => ({ boxes: [{ name: "agent" } as BoxInfo, { name: "general" } as BoxInfo] }),
		});

		const result = await run(toolNamed(tools, "click"), { [BOX_PARAM]: "nope" });

		expect(result.isError).toBe(true);
		expect(gets).toHaveLength(0);
		expect(result.content[0]).toEqual({
			type: "text",
			text: 'unknown box "nope"\navailable boxes: agent, general',
		});
	});

	it("解析失败的 message 已含候选时不重复列", async () => {
		const message = 'unknown box "nope"; available boxes: agent';
		const { tools } = build({
			resolve: async () => ({ ok: false, kind: "invalid-param", message, candidates: ["agent"] }),
			listBoxes: async () => {
				throw new Error("listBoxes should not be needed");
			},
		});

		const result = await run(toolNamed(tools, "click"), { [BOX_PARAM]: "nope" });

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: message }]);
	});

	it("硬错误不降级：即便 ls 里有别的箱，也不调池、不换箱执行", async () => {
		const client = new FakeClient(async () => ({ content: [{ type: "text", text: "should not run" }] }));
		const { pool, gets } = fakePool({ client });
		const { tools } = build({
			pool,
			resolve: async () => ({ ok: false, kind: "invalid-session", message: 'session target "gone" is not an existing box', candidates: ["agent"] }),
		});

		const result = await run(toolNamed(tools, "click"), {});

		expect(result.isError).toBe(true);
		expect(gets).toHaveLength(0);
		expect(client.calls).toHaveLength(0);
	});

	it("listBoxes 抛错时仍只有 message（不外抛）", async () => {
		const { tools } = build({
			resolve: async () => ({ ok: false, kind: "no-boxes", message: "instabox ls returned no boxes", candidates: [] }),
			listBoxes: async () => {
				throw new Error("ls failed");
			},
		});

		const result = await run(toolNamed(tools, "click"), {});

		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "instabox ls returned no boxes" });
	});

	it("池失败 → isError，带池的错误文本（含箱名）", async () => {
		const { tools } = build({ pool: fakePool({ failWith: 'box "agent" is "suspended", not running' }).pool });

		const result = await run(toolNamed(tools, "click"), {});

		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: 'instabox: cannot use box "agent": box "agent" is "suspended", not running',
		});
	});

	it("远端 isError 保留，并追加一行修复建议（远端内容不变）", async () => {
		const remoteText = { type: "text", text: "app not found" };
		const client = new FakeClient(async () => ({ content: [remoteText], isError: true }));
		const { tools } = build({ pool: fakePool({ client }).pool });

		const result = await run(toolNamed(tools, "launch_app"), { app: "nope" });

		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "[box=agent]" });
		expect(result.content[1]).toBe(remoteText);
		const remedy = result.content[2];
		expect(remedy?.type).toBe("text");
		expect(remedy?.type === "text" ? remedy.text : "").toContain('pass box="<name>"');
		expect(result.content).toHaveLength(3);
	});

	it("resolve / pool.get / callTool 抛错都转 isError，不外抛", async () => {
		const throwingResolve = build({
			resolve: async () => {
				throw new Error("boom-resolve");
			},
		});
		const resolved = await run(toolNamed(throwingResolve.tools, "click"), {});
		expect(resolved.isError).toBe(true);
		expect(resolved.content[0]).toEqual({ type: "text", text: "instabox: box resolution failed: boom-resolve" });

		const throwingPool = build({ pool: fakePool({ throwWith: new Error("boom-pool") }).pool });
		const pooled = await run(toolNamed(throwingPool.tools, "click"), {});
		expect(pooled.isError).toBe(true);
		expect(pooled.content[0]).toEqual({ type: "text", text: 'instabox: cannot use box "agent": boom-pool' });

		const throwingClient = new FakeClient(async () => {
			throw new Error("boom-call");
		});
		const calling = build({ pool: fakePool({ client: throwingClient }).pool });
		const called = await run(toolNamed(calling.tools, "click"), {});
		expect(called.isError).toBe(true);
		expect(called.content[0]).toEqual({
			type: "text",
			text: 'instabox: click on box "agent" failed: boom-call',
		});
	});

	it("abort 后的 client 错误原样转 isError（不吞 abort）", async () => {
		const controller = new AbortController();
		const client = new FakeClient(async () => {
			throw new Error('callTool aborted: code "aborted"');
		});
		const { tools } = build({ pool: fakePool({ client }).pool });

		controller.abort();
		const result = await run(toolNamed(tools, "click"), {}, controller.signal);

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(JSON.stringify(result.content)).toContain("aborted");
	});
});

describe("埋点：tool.call", () => {
	it("每次 execute 恰好一条（成功 / 远端 isError / 解析失败 / 抛错四条路径都在 finally 落账）", async () => {
		const logger = createMemoryLogger();
		setLogger(logger);
		try {
			const success = build({ pool: fakePool({ client: new FakeClient(async () => ({ content: [] })) }).pool });
			await run(toolNamed(success.tools, "click"), {});

			const remoteError = build({
				pool: fakePool({ client: new FakeClient(async () => ({ content: [], isError: true })) }).pool,
			});
			await run(toolNamed(remoteError.tools, "screenshot"), {});

			const unresolved = build({
				resolve: async () => ({ ok: false, kind: "no-boxes", message: "instabox ls returned no boxes", candidates: [] }),
			});
			await run(toolNamed(unresolved.tools, "click"), {});

			const throwing = build({ pool: fakePool({ throwWith: new Error("boom-pool") }).pool });
			await run(toolNamed(throwing.tools, "press_key"), {});
		} finally {
			setLogger(undefined);
		}

		const calls = logger.records.filter((record) => record.event === "tool.call");
		expect(calls).toHaveLength(4);
		expect(calls.every((record) => record.level === "info")).toBe(true);

		expect(calls[0]?.fields).toMatchObject({
			tool: "click",
			box: "agent",
			ok: true,
			isError: false,
		});
		expect(calls[1]?.fields).toMatchObject({ tool: "screenshot", box: "agent", ok: false, isError: true });
		// 解析失败：没拿到箱，`box` 字段整个缺席（只留命中 0 的结论）
		expect(calls[2]?.fields).not.toHaveProperty("box");
		expect(calls[2]?.fields).toMatchObject({ ok: false, isError: true });
		expect(calls[3]?.fields).toMatchObject({ ok: false, isError: true });
		// 耗时是一个非负数字（不记参数与结果内容）
		for (const call of calls) {
			expect(typeof call.fields?.["ms"]).toBe("number");
			expect(Number(call.fields?.["ms"])).toBeGreaterThanOrEqual(0);
		}
	});
});
