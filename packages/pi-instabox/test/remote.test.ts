/**
 * @inobit/pi-instabox — `remote.ts` 单测：**全内存假流，绝不 spawn 真进程**。
 *
 * 覆盖方案 §4.7 D7 的验收点：握手顺序、id 单调、`notifications/initialized` 无 id、
 * 两种分帧（换行分隔 / `Content-Length` 头）解析同一字节流、半行与跨 chunk 拼接、
 * 断流 reject 全部 pending 且 dead、四类超时、abort 传播、`tools/list` 结构。
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createMemoryLogger, setLogger } from "../src/log.ts";
import {
	CLIENT_INFO,
	DEFAULT_TIMEOUTS,
	MCP_PROTOCOL_VERSION,
	StdioFramer,
	createRemoteClient,
	type RemoteChild,
	type RemoteClient,
	type RemoteClientOptions,
	type RemoteClock,
	type SpawnOptions,
} from "../src/remote.ts";

/** 假时钟：到期时间手动推进，测试不 sleep、不依赖宿主机时间。 */
class FakeClock implements RemoteClock {
	nowMs = 0;
	private seq = 0;
	private readonly timers = new Map<number, { at: number; handler: () => void }>();

	setTimeout(handler: () => void, ms: number): unknown {
		const id = ++this.seq;
		this.timers.set(id, { at: this.nowMs + ms, handler });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	now = (): number => this.nowMs;

	/** 推进 ms 毫秒，按到期顺序执行触发的定时器 */
	advance(ms: number): void {
		const target = this.nowMs + ms;
		for (;;) {
			let due: { id: number; at: number } | undefined;
			for (const [id, timer] of this.timers) {
				if (timer.at <= target && (due === undefined || timer.at < due.at)) due = { id, at: timer.at };
			}
			if (due === undefined) break;
			const timer = this.timers.get(due.id);
			this.timers.delete(due.id);
			if (timer === undefined) continue;
			this.nowMs = timer.at;
			timer.handler();
		}
		this.nowMs = target;
	}

	pendingCount(): number {
		return this.timers.size;
	}
}

/** 内存假子进程：stdout/stderr 由 `send*()` 注入，`close()/fail()` 手动触发终点事件。 */
class FakeChild implements RemoteChild {
	readonly writes: string[] = [];
	readonly killed: (string | undefined)[] = [];
	private readonly out = new EventEmitter();
	private readonly err = new EventEmitter();
	private readonly events = new EventEmitter();

	readonly stdin = {
		write: (chunk: string): boolean => {
			this.writes.push(chunk);
			return true;
		},
	};

	readonly stdout = {
		on: (event: "data", listener: (chunk: Buffer | string) => void): void => {
			this.out.on(event, listener);
		},
	};

	readonly stderr = {
		on: (event: "data", listener: (chunk: Buffer | string) => void): void => {
			this.err.on(event, listener);
		},
	};

	on(event: "close" | "error", listener: (...args: never[]) => void): void {
		this.events.on(event, listener as (...args: unknown[]) => void);
	}

	kill(signal?: string): void {
		this.killed.push(signal);
	}

	/** 远端「吐出」一段 stdout 字节 */
	send(chunk: string | Uint8Array): void {
		this.out.emit("data", typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
	}

	sendStderr(text: string): void {
		this.err.emit("data", Buffer.from(text, "utf8"));
	}

	close(code: number | null = 0): void {
		this.events.emit("close", code, null);
	}

	fail(error: Error): void {
		this.events.emit("error", error);
	}
}

/** 假子进程：`spawn` 成功但拿不到 stdio 管道（`stdin`/`stdout` 为 null）。 */
class PipeLessChild implements RemoteChild {
	readonly killed: (string | undefined)[] = [];
	readonly stdin = null;
	readonly stdout = null;
	readonly stderr = null;

	on(): void {
		throw new Error("pipe-less child must not have listeners attached");
	}

	kill(signal?: string): void {
		this.killed.push(signal);
	}
}

interface Ctx {
	client: RemoteClient;
	child: FakeChild;
	clock: FakeClock;
	spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>;
	debugMessages: string[];
}

function setup(overrides: Partial<RemoteClientOptions> = {}): Ctx {
	const clock = new FakeClock();
	const child = new FakeChild();
	const spawned: Ctx["spawned"] = [];
	const debugMessages: string[] = [];
	const client = createRemoteClient({
		command: "instabox",
		args: ["ssh", "demo", "--", "instabox-computer-use", "mcp"],
		spawn: (command, args, options) => {
			spawned.push({ command, args, options });
			return child;
		},
		clock,
		now: clock.now,
		debug: (message) => debugMessages.push(message),
		...overrides,
	});
	return { client, child, clock, spawned, debugMessages };
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** 换行分隔帧（MCP stdio 标准写法） */
function lineFrame(message: unknown): string {
	return `${JSON.stringify(message)}\n`;
}

/** `Content-Length` 头帧（LSP 风格写法） */
function headerFrame(message: unknown): string {
	const body = JSON.stringify(message);
	return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function sentAt(ctx: Ctx, index: number): Record<string, unknown> {
	const raw = ctx.child.writes[index];
	if (raw === undefined) throw new Error(`no frame written at index ${index}`);
	return JSON.parse(raw) as Record<string, unknown>;
}

const TOOLS = [
	{
		name: "list_apps",
		description: "列出桌面应用",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{ name: "screenshot", inputSchema: { type: "object", properties: { display: { type: "integer" } } } },
];

const EXPECTED_TOOLS = [
	{
		name: "list_apps",
		description: "列出桌面应用",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "screenshot",
		description: undefined,
		inputSchema: { type: "object", properties: { display: { type: "integer" } } },
	},
];

/** 跑完握手（initialize 响应 + 初始化完成通知） */
async function handshake(ctx: Ctx): Promise<void> {
	const pending = ctx.client.initialize();
	await flush();
	ctx.child.send(
		lineFrame({
			jsonrpc: "2.0",
			id: 1,
			result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "instabox-computer-use", version: "1.0.0" } },
		}),
	);
	await expect(pending).resolves.toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION });
	await flush();
	expect(ctx.child.writes).toHaveLength(2);
}

describe("StdioFramer", () => {
	function collector(): { framer: StdioFramer; frames: unknown[]; bad: string[] } {
		const frames: unknown[] = [];
		const bad: string[] = [];
		const framer = new StdioFramer({ onFrame: (m) => frames.push(m), onBadFrame: (raw) => bad.push(raw) });
		return { framer, frames, bad };
	}

	it("换行分隔与 Content-Length 头解析出同一字节流", () => {
		const payload = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: TOOLS } });

		const asLines = collector();
		asLines.framer.push(`${payload}\n`);

		const asHeaders = collector();
		asHeaders.framer.push(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);

		expect(asHeaders.frames).toHaveLength(1);
		expect(asHeaders.frames).toEqual(asLines.frames);
		expect(asHeaders.bad).toEqual([]);
	});

	it("逐字节喂入也能成帧（含多字节 UTF-8 字符跨 chunk）", () => {
		const payload = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { message: "桌面已就绪" } });

		const lineBytes = Buffer.from(`${payload}\n`, "utf8");
		const asLines = collector();
		for (const byte of lineBytes) asLines.framer.push(Buffer.from([byte]));
		expect(asLines.frames).toHaveLength(1);
		expect((asLines.frames[0] as { params: { message: string } }).params.message).toBe("桌面已就绪");

		const headerBytes = Buffer.from(headerFrame(JSON.parse(payload) as unknown), "utf8");
		const asHeaders = collector();
		for (const byte of headerBytes) asHeaders.framer.push(Buffer.from([byte]));
		expect(asHeaders.frames).toEqual(asLines.frames);
	});

	it("一 chunk 多帧与跨 chunk 半行拼接", () => {
		const a = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
		const b = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: false } });
		const bytes = Buffer.from(`${a}\n${b}\n`, "utf8");
		const cut = bytes.indexOf(0x7b, a.length + 1) + 6;

		const whole = collector();
		whole.framer.push(bytes);
		expect(whole.frames).toHaveLength(2);

		const split = collector();
		split.framer.push(bytes.subarray(0, cut));
		expect(split.frames).toHaveLength(1);
		split.framer.push(bytes.subarray(cut));
		expect(split.frames).toHaveLength(2);
		expect(split.frames).toEqual(whole.frames);
	});

	it("头帧的头部与体分两次到达也能成帧", () => {
		const message = { jsonrpc: "2.0", id: 3, result: { tools: TOOLS } };
		const body = JSON.stringify(message);
		const ctx = collector();
		ctx.framer.push(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n`);
		expect(ctx.frames).toHaveLength(0);
		ctx.framer.push("\r\n");
		expect(ctx.frames).toHaveLength(0);
		ctx.framer.push(body.slice(0, 7));
		expect(ctx.frames).toHaveLength(0);
		ctx.framer.push(body.slice(7));
		expect(ctx.frames).toEqual([message]);
	});

	it("坏行只报 onBadFrame，后续帧照常解析", () => {
		const ctx = collector();
		ctx.framer.push("这不是 JSON\n");
		ctx.framer.push(`${JSON.stringify({ jsonrpc: "2.0", id: 5, result: {} })}\n`);
		expect(ctx.bad).toHaveLength(1);
		expect(ctx.frames).toHaveLength(1);
	});

	it("空行被丢弃，不报坏帧", () => {
		const ctx = collector();
		ctx.framer.push("\n\n\r\n");
		ctx.framer.push(`${JSON.stringify({ jsonrpc: "2.0", id: 6, result: {} })}\n`);
		expect(ctx.bad).toEqual([]);
		expect(ctx.frames).toHaveLength(1);
	});

	it("头块缺合法 Content-Length → 报坏帧并继续", () => {
		const ctx = collector();
		ctx.framer.push("Content-Length: abc\r\n\r\n");
		expect(ctx.bad).toHaveLength(1);
		ctx.framer.push(headerFrame({ jsonrpc: "2.0", id: 8, result: {} }));
		expect(ctx.frames).toHaveLength(1);
	});

	it("超长无终止头块 → 报坏帧并重新探测模式", () => {
		const ctx = collector();
		ctx.framer.push(`Content-Length: ${"9".repeat(70_000)}`);
		expect(ctx.bad).toHaveLength(1);
		ctx.framer.push(`${JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} })}\n`);
		expect(ctx.frames).toHaveLength(1);
	});
});

describe("握手", () => {
	it("spawn 参数原样透传，顺序为 initialize → notifications/initialized → tools/list", async () => {
		const ctx = setup();
		const toolsPromise = ctx.client.listTools();
		await flush();

		expect(ctx.spawned).toHaveLength(1);
		expect(ctx.spawned[0]?.command).toBe("instabox");
		expect(ctx.spawned[0]?.args).toEqual(["ssh", "demo", "--", "instabox-computer-use", "mcp"]);

		const initializeRequest = sentAt(ctx, 0);
		expect(initializeRequest["jsonrpc"]).toBe("2.0");
		expect(initializeRequest["method"]).toBe("initialize");
		expect(initializeRequest["id"]).toBe(1);
		const params = initializeRequest["params"] as Record<string, unknown>;
		expect(params["protocolVersion"]).toBe(MCP_PROTOCOL_VERSION);
		expect(params["capabilities"]).toEqual({});
		expect(params["clientInfo"]).toEqual({ ...CLIENT_INFO });
		// 响应未到前不追加任何帧
		expect(ctx.child.writes).toHaveLength(1);

		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION } }));
		await flush();

		const initialized = sentAt(ctx, 1);
		expect(initialized["method"]).toBe("notifications/initialized");
		expect("id" in initialized).toBe(false);

		const listRequest = sentAt(ctx, 2);
		expect(listRequest["method"]).toBe("tools/list");
		expect(listRequest["id"]).toBe(2);

		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } }));
		await expect(toolsPromise).resolves.toEqual(EXPECTED_TOOLS);
		expect(ctx.clock.pendingCount()).toBe(0);
		expect(ctx.client.isDead()).toBe(false);
	});

	it("initialize 幂等：重复调用共享同一次握手，不重复 spawn/发送", async () => {
		const ctx = setup();
		const first = ctx.client.initialize();
		const second = ctx.client.initialize();
		expect(second).toBe(first);
		await flush();
		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION } }));
		await expect(first).resolves.toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION });
		await flush();
		await expect(second).resolves.toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION });
		expect(ctx.child.writes).toHaveLength(2);
		expect(ctx.spawned).toHaveLength(1);
	});

	it("id 单调自增：并发请求各占一个 id", async () => {
		const ctx = setup();
		await handshake(ctx);
		const callFirst = ctx.client.callTool("list_apps", {});
		const callSecond = ctx.client.callTool("screenshot", { display: 0 });
		await flush();
		expect(sentAt(ctx, 2)["id"]).toBe(2);
		expect(sentAt(ctx, 3)["id"]).toBe(3);
		expect(sentAt(ctx, 3)["params"]).toEqual({ name: "screenshot", arguments: { display: 0 } });

		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "shot" }] } }));
		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "apps" }], isError: false } }));
		await expect(callFirst).resolves.toEqual({ content: [{ type: "text", text: "apps" }], isError: false });
		await expect(callSecond).resolves.toEqual({ content: [{ type: "text", text: "shot" }] });
	});

	it("头帧流同样走通握手与 tools/list", async () => {
		const ctx = setup();
		const toolsPromise = ctx.client.listTools();
		await flush();
		ctx.child.send(headerFrame({ jsonrpc: "2.0", id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION } }));
		await flush();
		ctx.child.send(headerFrame({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } }));
		await expect(toolsPromise).resolves.toEqual(EXPECTED_TOOLS);
	});

	it("initialize 结果带回 serverInfo（模板缓存比对版本用）", async () => {
		const ctx = setup();
		const pending = ctx.client.initialize();
		await flush();
		ctx.child.send(
			lineFrame({
				jsonrpc: "2.0",
				id: 1,
				result: { protocolVersion: "2025-06-18", serverInfo: { name: "instabox-computer-use", version: "2.3.4" } },
			}),
		);
		await expect(pending).resolves.toEqual({
			protocolVersion: "2025-06-18",
			serverInfo: { name: "instabox-computer-use", version: "2.3.4" },
		});
	});
});

describe("tools/list", () => {
	it("解析为 { name, description?, inputSchema }[]，坏条目与缺 schema 都有兜底", async () => {
		const ctx = setup();
		await handshake(ctx);
		const pending = ctx.client.listTools();
		await flush();
		ctx.child.send(
			lineFrame({
				jsonrpc: "2.0",
				id: 2,
				result: {
					tools: [
						...TOOLS,
						{ description: "无名字，应被跳过" },
						null,
						{ name: "", inputSchema: { type: "object" } },
						{ name: "no_schema" },
					],
				},
			}),
		);
		await expect(pending).resolves.toEqual([...EXPECTED_TOOLS, { name: "no_schema", description: undefined, inputSchema: { type: "object", properties: {} } }]);
	});

	it("结构不符（无 tools 数组）→ protocol 错误并 dead", async () => {
		const ctx = setup();
		await handshake(ctx);
		const pending = ctx.client.listTools();
		const rejected = expect(pending).rejects.toMatchObject({ code: "protocol" });
		await flush();
		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 2, result: {} }));
		await rejected;
		expect(ctx.client.isDead()).toBe(true);
	});
});

describe("容错与分流", () => {
	it("坏行只进 debug 回调，连接继续可用", async () => {
		const ctx = setup();
		await handshake(ctx);
		const pending = ctx.client.listTools();
		await flush();
		ctx.child.send("half a json\n");
		await flush();
		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } }));
		await expect(pending).resolves.toEqual(EXPECTED_TOOLS);
		expect(ctx.debugMessages.some((m) => m.includes("malformed MCP frame"))).toBe(true);
		expect(ctx.client.isDead()).toBe(false);
	});

	it("通知、未知方法、未知 id 静默丢弃", async () => {
		const ctx = setup();
		await handshake(ctx);
		const pending = ctx.client.callTool("list_apps", {});
		await flush();
		ctx.child.send(lineFrame({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } }));
		ctx.child.send(lineFrame({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 3 } }));
		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 99, result: { content: [] } }));
		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }], isError: true } }));
		await expect(pending).resolves.toEqual({ content: [{ type: "text", text: "ok" }], isError: true });
		expect(ctx.debugMessages).toEqual([]);
		expect(ctx.client.isDead()).toBe(false);
	});

	it("JSON-RPC error 响应只 reject 该请求，不置 dead", async () => {
		const ctx = setup();
		await handshake(ctx);
		const pending = ctx.client.callTool("list_apps", {});
		const rejected = expect(pending).rejects.toMatchObject({ code: "rpc" });
		await flush();
		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "invalid params" } }));
		await rejected;
		await expect(pending).rejects.toThrow(/tools\/call failed: code -32602: invalid params/);
		expect(ctx.client.isDead()).toBe(false);
		expect(ctx.clock.pendingCount()).toBe(0);
	});
});

describe("断流 / 关停", () => {
	it("子进程 close → reject 全部 pending、置 dead、不再 kill 已退出的进程", async () => {
		const ctx = setup();
		await handshake(ctx);
		const listPending = ctx.client.listTools();
		const callPending = ctx.client.callTool("list_apps", {});
		const listRejected = expect(listPending).rejects.toMatchObject({ code: "closed" });
		const callRejected = expect(callPending).rejects.toMatchObject({ code: "closed" });
		await flush();
		expect(ctx.child.writes).toHaveLength(4);
		ctx.child.sendStderr("ssh: connect to host general port 22: Connection refused\n");
		ctx.child.close(255);
		await listRejected;
		await callRejected;
		await expect(callPending).rejects.toThrow(/code=255/);
		await expect(callPending).rejects.toThrow(/Connection refused/);
		expect(ctx.client.isDead()).toBe(true);
		expect(ctx.child.killed).toEqual([]);
		expect(ctx.clock.pendingCount()).toBe(0);
	});

	it("close() 拒绝在途请求并杀子进程，之后不再接受新请求", async () => {
		const ctx = setup();
		await handshake(ctx);
		const pending = ctx.client.callTool("list_apps", {});
		const rejected = expect(pending).rejects.toMatchObject({ code: "closed" });
		await flush();
		ctx.client.close();
		await rejected;
		expect(ctx.client.isDead()).toBe(true);
		expect(ctx.child.killed).toEqual([undefined]);
		ctx.client.close();
		await expect(ctx.client.callTool("list_apps", {})).rejects.toMatchObject({ code: "closed" });
		await expect(ctx.client.listTools()).rejects.toMatchObject({ code: "closed" });
	});

	it("spawn 抛错 → spawn 错误并 dead", async () => {
		const ctx = setup({
			spawn: () => {
				throw new Error("ENOENT: instabox not found");
			},
		});
		await expect(ctx.client.initialize()).rejects.toMatchObject({ code: "spawn" });
		await expect(ctx.client.initialize()).rejects.toThrow(/failed to spawn instabox: ENOENT/);
		expect(ctx.client.isDead()).toBe(true);
	});

	it("子进程 error 事件 → spawn 错误并 dead", async () => {
		const ctx = setup();
		const pending = ctx.client.initialize();
		const rejected = expect(pending).rejects.toMatchObject({ code: "spawn" });
		await flush();
		ctx.child.fail(new Error("EACCES: permission denied"));
		await rejected;
		expect(ctx.client.isDead()).toBe(true);
	});

	it("env 覆盖透传给 spawn", async () => {
		const ctx = setup({ env: { PATH: "/opt/instabox/bin" } });
		void ctx.client.initialize();
		await flush();
		expect(ctx.spawned[0]?.options.env).toEqual({ PATH: "/opt/instabox/bin" });
	});

	it("spawn 出无 stdio 管道的子进程 → spawn 错误、dead 且子进程被 kill（不泄漏）", async () => {
		const child = new PipeLessChild();
		const ctx = setup({ spawn: () => child });
		await expect(ctx.client.initialize()).rejects.toMatchObject({ code: "spawn" });
		await expect(ctx.client.initialize()).rejects.toThrow(/spawned instabox without stdio pipes/);
		expect(ctx.client.isDead()).toBe(true);
		expect(child.killed).toEqual([undefined]);
		expect(ctx.clock.pendingCount()).toBe(0);
	});
});

describe("超时", () => {
	it("默认预算与方案一致（connect 15s / initialize 20s / tools-list 20s / tools-call 120s）", () => {
		expect(DEFAULT_TIMEOUTS).toEqual({ connect: 15_000, initialize: 20_000, listTools: 20_000, callTool: 120_000 });
	});

	it("connect：远端一个字节都不吐 → reject 并 dead", async () => {
		const ctx = setup();
		const pending = ctx.client.initialize();
		const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
		await flush();
		expect(ctx.clock.pendingCount()).toBe(2); // connect 预算 + initialize 预算
		ctx.clock.advance(DEFAULT_TIMEOUTS.connect);
		await rejected;
		await expect(pending).rejects.toThrow(/produced no output within 15000ms/);
		expect(ctx.client.isDead()).toBe(true);
		expect(ctx.clock.pendingCount()).toBe(0);
		expect(ctx.child.killed).toEqual([undefined]);
	});

	it("initialize：收到过字节但不回 initialize → reject 并 dead", async () => {
		const ctx = setup();
		const pending = ctx.client.initialize();
		const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
		await flush();
		ctx.child.send(lineFrame({ jsonrpc: "2.0", method: "notifications/message", params: {} }));
		await flush();
		expect(ctx.clock.pendingCount()).toBe(1); // connect 预算已被首字节清掉
		ctx.clock.advance(DEFAULT_TIMEOUTS.initialize);
		await rejected;
		await expect(pending).rejects.toThrow(/initialize timed out after 20000ms/);
		expect(ctx.client.isDead()).toBe(true);
	});

	it("tools/list 超时 → reject 并 dead", async () => {
		const ctx = setup();
		await handshake(ctx);
		const pending = ctx.client.listTools();
		const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
		await flush();
		ctx.clock.advance(DEFAULT_TIMEOUTS.listTools);
		await rejected;
		await expect(pending).rejects.toThrow(/tools\/list timed out after 20000ms/);
		expect(ctx.client.isDead()).toBe(true);
	});

	it("tools/call 超时 → reject 并 dead", async () => {
		const ctx = setup();
		await handshake(ctx);
		const pending = ctx.client.callTool("list_apps", {});
		const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
		await flush();
		ctx.clock.advance(DEFAULT_TIMEOUTS.callTool - 1);
		expect(ctx.client.isDead()).toBe(false); // 差 1ms 不该触发
		ctx.clock.advance(1);
		await rejected;
		await expect(pending).rejects.toThrow(/tools\/call timed out after 120000ms/);
		expect(ctx.client.isDead()).toBe(true);
	});

	it("超时预算可按调用点覆盖", async () => {
		const ctx = setup({ timeouts: { callTool: 500 } });
		await handshake(ctx);
		const pending = ctx.client.callTool("list_apps", {});
		const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
		await flush();
		ctx.clock.advance(500);
		await rejected;
		await expect(pending).rejects.toThrow(/limit 500ms/);
	});
});

describe("abort", () => {
	it("signal abort → reject 全部 pending、置 dead、kill 子进程", async () => {
		const ctx = setup();
		await handshake(ctx);
		const controller = new AbortController();
		const callPending = ctx.client.callTool("screenshot", {}, controller.signal);
		const listPending = ctx.client.listTools();
		const callRejected = expect(callPending).rejects.toMatchObject({ code: "aborted" });
		const listRejected = expect(listPending).rejects.toMatchObject({ code: "aborted" });
		await flush();
		expect(ctx.child.writes).toHaveLength(4);

		controller.abort();
		await callRejected;
		await listRejected;
		await expect(callPending).rejects.toThrow(/tools\/call aborted by caller/);
		expect(ctx.client.isDead()).toBe(true);
		expect(ctx.child.killed).toEqual([undefined]);
		expect(ctx.clock.pendingCount()).toBe(0);
	});

	it("已 abort 的 signal → 立即 reject 并 dead（不写帧）", async () => {
		const ctx = setup();
		await handshake(ctx);
		const controller = new AbortController();
		controller.abort();
		const pending = ctx.client.callTool("screenshot", {}, controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
		expect(ctx.child.writes).toHaveLength(2);
		await rejected;
		expect(ctx.client.isDead()).toBe(true);
	});

	it("abort 后摘除监听：成功响应不再触发 abort 分支", async () => {
		const ctx = setup();
		await handshake(ctx);
		const controller = new AbortController();
		const pending = ctx.client.callTool("list_apps", {}, controller.signal);
		await flush();
		ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
		await expect(pending).resolves.toEqual({ content: [] });
		controller.abort();
		expect(ctx.client.isDead()).toBe(false);
	});

	it("握手未完成时 abort → initialize reject aborted、置 dead、kill 子进程", async () => {
		const ctx = setup();
		const controller = new AbortController();
		const pending = ctx.client.initialize(controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
		await flush();
		expect(ctx.child.writes).toHaveLength(1); // initialize 已发出、响应未回
		expect(ctx.clock.pendingCount()).toBe(2); // connect 预算 + initialize 预算

		controller.abort();
		await rejected;
		await expect(pending).rejects.toThrow(/initialize aborted by caller/);
		expect(ctx.client.isDead()).toBe(true);
		expect(ctx.child.killed).toEqual([undefined]);
		expect(ctx.clock.pendingCount()).toBe(0);
	});

	it("listTools 的 signal 透传到握手：建连期 abort 不必白等预算", async () => {
		const ctx = setup();
		const controller = new AbortController();
		const pending = ctx.client.listTools(controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
		await flush();
		expect(ctx.child.writes).toHaveLength(1); // 只有 initialize，tools/list 未发

		controller.abort();
		await rejected;
		expect(ctx.client.isDead()).toBe(true);
		expect(ctx.child.killed).toEqual([undefined]);
		expect(ctx.clock.pendingCount()).toBe(0);
	});
});

describe("埋点（logEvent）", () => {
	it("tools/call 成功记一条 remote.call（tool/ok/isError）", async () => {
		const logger = createMemoryLogger();
		setLogger(logger);
		try {
			const ctx = setup();
			await handshake(ctx);
			const pending = ctx.client.callTool("list_apps", {});
			await flush();
			ctx.child.send(lineFrame({ jsonrpc: "2.0", id: 2, result: { content: [], isError: true } }));
			await expect(pending).resolves.toEqual({ content: [], isError: true });
		} finally {
			setLogger(undefined);
		}

		const calls = logger.records.filter((record) => record.event === "remote.call");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.fields).toMatchObject({ tool: "list_apps", ok: true, isError: true });
		expect(logger.records.some((record) => record.event === "remote.initialize")).toBe(true);
	});
});
