/**
 * @inobit/pi-instabox — `src/index.ts` 装配单测（T15）。
 *
 * 用手写假 `pi`（记录 `registerTool`/`registerCommand`/`registerEntryRenderer`/`registerMcpServer`/
 * `on`/`appendEntry`/`setActiveTools`/`getAllTools`/`getActiveTools`/`getMcpServers`/`exec`）验证：
 * - 无 CLI：零工具/零命令/零 MCP、无运行期目录（`templates.json` / `bin/`），只落一条
 *   `cli.probe`（`ok:false`）日志，`session_start` 恰一条 warning；
 * - 有 CLI + 缓存命中：加载期即注册（且**不跑 `ls`**）、2 个命令、1 个 renderer、2 个事件；
 * - **`setActiveTools` 从未被调用**（裁决 V2；每个用例的 teardown 都断言一次）；
 * - `session_start` **不 await** 后台拉取（fire-and-forget），后台完成后才注册/提示；
 * - 解析链第 2 级「本轮最后一条 user 消息」**在每次工具调用时实时读分支**（两次调用之间追加
 *   一条 user 消息，第二次的目标随之改变）；
 * - codemode 三分支（已激活不提示 / 未激活提示一次 / 无条目提示不可用）+ 有 codemode-exposure
 *   MCP server 时不提示（含 `exposure` 缺省即 codemode 的情形）；
 * - `devToolsBox` 空 → 不注册 MCP、不写 helper；非空 → 注册 + 写真实 helper 文件（临时 agentDir）；
 * - `/instabox-use` 无效名拒绝、有效名写 entry、空参数列目标与候选、**冷启动闭环**
 *   （无缓存 + suspended → 唤醒 → 拉模板 → 注册）；
 * - 后台拉取失败给一条可操作提示，且全程零唤醒；
 * - `session_tree` 后（实时读分支）目标更新；
 * - `/instabox-status` 打印配置/目标/工具声明来源/codemode 三态/MCP server；
 * - 文件日志的接线：**探测之前**就按 `<agentDir>/logs/pi-instabox` 建 logger（日志级别随
 *   `PI_INSTABOX_DEBUG`），因此 `cli.probe` 先于 `load.assembled` 落盘；无 CLI 时同样只写探测记录、
 *   不建运行期目录；`VITEST` 下默认不建；`session_shutdown` 后复位。
 *
 * 全部离线：`pi.exec` 是假实现（只回答 `version` / `ls` / `start`），远端 `RemoteClient` 由
 * `deps.clientFactory` 注入假实现（**绝不 spawn**），临时目录取代真实的 `<agentDir>`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	McpServerConfig,
	RegisteredMcpServer,
	SessionEntry,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/** `node:child_process` 的守卫记录：本文件任何一次真 spawn 都会失败并留痕。 */
const spawnGuard = vi.hoisted(() => ({ calls: [] as unknown[][] }));

// 装配层唯一会 spawn 的地方是 `remote.ts` 的默认客户端；单测一律注入假客户端，
// 这里把真 spawn 变成显式失败（而不是「靠时序侥幸不触发」）。
vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => {
		spawnGuard.calls.push(args);
		throw new Error("index.test.ts must not spawn real processes: inject deps.clientFactory");
	},
}));

import type { ExecResultLike } from "../src/cli.ts";
import instaboxExtension, { type InstaboxLoggerOptions } from "../src/index.ts";
import { createFileLogger, createMemoryLogger, logEvent, setLogger } from "../src/log.ts";
import type { CallToolResult, InitializeResult, RemoteClient, RemoteTool } from "../src/remote.ts";
import { TARGET_ENTRY } from "../src/session-target.ts";

/** 事件处理器（一个事件可以有多个，假 `pi` 按名字存数组）。 */
type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

/** 命令处理器（`registerCommand` 的 `handler`）。 */
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** 一条被记录的 UI 通知。 */
interface Notification {
	message: string;
	type: string | undefined;
}

/** 假 `instabox` 的 `ls` 条目（只保留 `boxes.ts` 读取的字段）。 */
interface FakeBoxSpec {
	name: string;
	state?: string;
	desiredState?: string;
}

/** 脚本化的 `instabox version` 结果（按调用顺序取，用完后保持最后一项）。 */
type VersionOutcome = "ok" | "timeout" | "missing" | "error";

interface FakeExecOptions {
	/** 等价于 `versionPlan: ["missing"]`（命令根本装不上） */
	cli?: boolean;
	/** `instabox version` 的逐次结果：`timeout` = 被宿主杀掉（`killed: true`） */
	versionPlan?: readonly VersionOutcome[];
	/** `instabox ls` 的返回内容 */
	boxes?: FakeBoxSpec[];
	/** 每次 `ls` 之前 await 它：用来把后台拉取卡在可控位置（fire-and-forget 断言用） */
	beforeList?: () => Promise<void> | undefined;
	/** 第 `attempt` 次（0 起）`version` 之前 await 它：用来把重试探测卡住（不阻塞断言用） */
	beforeVersion?: (attempt: number) => Promise<void> | undefined;
	/** 本地状态机：`instabox wake` / `instabox start` 成功后把该箱记为 running（唤醒闭环用） */
	trackStart?: boolean;
	/** `instabox wake` 报「箱没在跑」（退出码 0 + stderr 自报，实测行为）：用来验证退到 `start` */
	wakeFails?: boolean;
	/** `instabox ls` 直接失败（非 0 退出）：用来验证「没有可用沙箱」提示 */
	lsFails?: boolean;
}

/**
 * 假 `pi.exec`：`version` / `ls` / `wake` / `start` 可脚本化，`resume`/其它子命令一律失败。
 * 记录每次调用的 argv，供「只跑过 version」「先 wake 再 start」「零唤醒」这类断言用。
 */
function createFakeExec(options: FakeExecOptions = {}) {
	const calls: string[][] = [];
	const started = new Set<string>();
	const boxState = (box: FakeBoxSpec): FakeBoxSpec => {
		if (options.trackStart === true && started.has(box.name)) return { ...box, state: "running", desiredState: "running" };
		return box;
	};
	/** 与 `calls` 同下标的超时预算（断言「重试用更长预算」用） */
	const timeouts: (number | undefined)[] = [];
	let versionAttempts = 0;
	const exec = async (
		command: string,
		args: string[],
		opts?: { timeout?: number },
	): Promise<ExecResultLike> => {
		calls.push([command, ...args]);
		timeouts.push(opts?.timeout);
		if (command !== "instabox") {
			return { stdout: "", stderr: `unexpected command: ${command}`, code: 127, killed: false, truncated: false };
		}
		const subcommand = args[0] ?? "";
		if (subcommand === "version") {
			const attempt = versionAttempts;
			const plan = options.versionPlan ?? (options.cli === false ? ["missing"] : ["ok"]);
			const outcome = plan[Math.min(attempt, plan.length - 1)] ?? "ok";
			versionAttempts += 1;
			await options.beforeVersion?.(attempt);
			if (outcome === "timeout") return { stdout: "", stderr: "", code: 0, killed: true, truncated: false };
			if (outcome === "missing") {
				return { stdout: "", stderr: "instabox: command not found", code: 127, killed: false, truncated: false };
			}
			if (outcome === "error") return { stdout: "", stderr: "instabox: boom", code: 1, killed: false, truncated: false };
			return { stdout: "instabox 1.2.3\n", stderr: "", code: 0, killed: false, truncated: false };
		}
		if (subcommand === "ls") {
			await options.beforeList?.();
			if (options.lsFails === true) {
				return { stdout: "", stderr: "instabox ls: boom", code: 1, killed: false, truncated: false };
			}
			const boxes = (options.boxes ?? []).map((box) => {
				const resolved = boxState(box);
				return {
					name: resolved.name,
					state: resolved.state ?? "running",
					desiredState: resolved.desiredState ?? "running",
					template: { id: "agent-browser", version: "2026-10-25.23" },
				};
			});
			return { stdout: JSON.stringify(boxes), stderr: "", code: 0, killed: false, truncated: false };
		}
		const box = args[1] ?? "";
		if (subcommand === "wake" && options.wakeFails === true) {
			// 真实行为：退出码 0，但 stderr 自报 machine_not_running（`cli.ts` 据此判失败）
			return {
				stdout: "",
				stderr: `instabox: error machine_not_running: machine is suspended; start it first [request id]\nhint: start it with \`instabox start ${box}\``,
				code: 0,
				killed: false,
				truncated: false,
			};
		}
		if ((subcommand === "wake" || subcommand === "start") && options.trackStart === true) {
			started.add(box);
			return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
		}
		return { stdout: "", stderr: `instabox ${subcommand}: unsupported in this test`, code: 1, killed: false, truncated: false };
	};
	return { exec, calls, timeouts, started };
}

/** 假远端客户端：`listTools` 返回构造时给的远端工具，`callTool` 回一条 text。 */
class FakeRemoteClient implements RemoteClient {
	readonly callToolCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
	/** 握手次数：`template.ts` 依赖「重复 initialize 幂等」，这里只统计不报错 */
	initializeCalls = 0;
	/** 是否被 `close()`（`session_shutdown` → `pool.disposeAll()` 的观察点） */
	closed = false;

	constructor(private readonly tools: readonly RemoteTool[]) {}

	async initialize(): Promise<InitializeResult> {
		this.initializeCalls += 1;
		return { protocolVersion: "2025-03-26", serverInfo: { name: "instabox-computer-use", version: "0.3.6-instabox.1" } };
	}

	async listTools(): Promise<RemoteTool[]> {
		return [...this.tools];
	}

	async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
		this.callToolCalls.push({ name, args });
		return { content: [{ type: "text", text: `ok:${name}` }] };
	}

	close(): void {
		this.closed = true;
	}

	isDead(): boolean {
		return this.closed;
	}
}

/** 注入给 `pool` 的假客户端工厂（每个 box 一个实例，按名字建远端工具）。 */
function createFakeClientFactory(
	remoteNames: readonly string[] = ["click", "screenshot"],
	options: { failInitialize?: boolean } = {},
) {
	const clients = new Map<string, FakeRemoteClient>();
	const factory = (box: string): RemoteClient => {
		const client = new FakeRemoteClient(
			remoteNames.map((name) => ({ name, description: `${box} ${name}`, inputSchema: { type: "object", properties: {} } })),
		);
		if (options.failInitialize === true) {
			client.initialize = async () => {
				throw new Error("ssh: authentication failed");
			};
		}
		clients.set(box, client);
		return client;
	};
	return { factory, clients };
}

/** 默认假远端工具名（`createFakeClientFactory` 的默认值，这里显式写出便于阅读）。 */
const DEFAULT_REMOTE_NAMES = ["click", "screenshot"] as const;

/**
 * 装配入口：**永远**注入假远端客户端，并按需返回它。
 *
 * `template.ensure()` 每次都会建客户端握手取 `serverInfo.version`（**缓存命中也要**），
 * 所以不注入就会真的 `spawn("instabox ssh …")`。`node:child_process` 在本文件顶部被
 * mock 成「一 spawn 就抛」，双保险。
 */
async function assembleExtension(
	pi: FakePi,
	remoteNames: readonly string[] = DEFAULT_REMOTE_NAMES,
): Promise<{ clients: Map<string, FakeRemoteClient> }> {
	const { factory, clients } = createFakeClientFactory(remoteNames);
	await instaboxExtension(pi.asAPI(), { clientFactory: factory });
	return { clients };
}

/** 每个用例创建的假 `pi`：teardown 统一断言 `setActiveTools` 未被调用（裁决 V2）。 */
const createdPis: FakePi[] = [];

/** 手写假 `ExtensionAPI`：只记录，不做事。 */
class FakePi {
	readonly tools: ToolDefinition[] = [];
	readonly commands: { name: string; description?: string }[] = [];
	readonly commandHandlers = new Map<string, CommandHandler>();
	readonly renderers = new Map<string, EntryRenderer<unknown>>();
	readonly registeredServers: { name: string; config: McpServerConfig }[] = [];
	/** 额外的 MCP server（模拟 `mcp.json` 或别的扩展注册的）；`exposure` 可缺省 */
	extraServers: McpServerConfig[] = [];
	readonly handlers = new Map<string, Handler[]>();
	readonly entries: { customType: string; data: unknown }[] = [];
	readonly setActiveToolsCalls: string[][] = [];
	activeTools: string[] = [];
	allTools: string[] = [];
	/** 置 true 后 `registerTool` 抛错：用来验证「装配失败」路径的文案与状态 */
	failOnRegisterTool = false;

	constructor(
		readonly exec: (command: string, args: string[], opts?: { timeout?: number }) => Promise<ExecResultLike>,
	) {
		createdPis.push(this);
	}

	/** 与宿主一致：同名工具是**替换**（`extension.tools.set(name, …)`），不是追加。 */
	registerTool(tool: ToolDefinition): void {
		if (this.failOnRegisterTool) throw new Error("registerTool exploded");
		const existing = this.tools.findIndex((candidate) => candidate.name === tool.name);
		if (existing === -1) this.tools.push(tool);
		else this.tools[existing] = tool;
	}

	registerCommand(name: string, options: { description?: string; handler: CommandHandler }): void {
		this.commands.push({ name, description: options.description });
		this.commandHandlers.set(name, options.handler);
	}

	registerEntryRenderer(customType: string, renderer: EntryRenderer<unknown>): void {
		this.renderers.set(customType, renderer);
	}

	registerMcpServer(name: string, config: McpServerConfig): void {
		this.registeredServers.push({ name, config });
	}

	on(event: string, handler: Handler): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {
			this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
		};
	}

	/** 触发某事件（按注册顺序逐个 await 全部处理器）。 */
	async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
		for (const handler of [...(this.handlers.get(event) ?? [])]) await handler(payload, ctx);
	}

	eventNames(): string[] {
		return [...this.handlers.keys()];
	}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ customType, data });
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	/** 装配层只读 `name`，其余字段对判定无意义（`sourceInfo` 等用不到）。 */
	getAllTools(): ToolInfo[] {
		return this.allTools.map((name) => ({ name }) as unknown as ToolInfo);
	}

	setActiveTools(names: string[]): void {
		this.setActiveToolsCalls.push(names);
	}

	getMcpServers(): RegisteredMcpServer[] {
		const registered = this.registeredServers.map((server) => ({ ...server, extensionPath: "test" }));
		const extra = this.extraServers.map((config) => ({ name: "external", config, extensionPath: "external" }));
		return [...registered, ...extra];
	}

	asAPI(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}

	toolNames(): string[] {
		return this.tools.map((tool) => tool.name).sort();
	}
}

/** 假 `ExtensionContext`：只实现装配层会用到的几样（notify / getBranch / signal）。 */
function createFakeContext(branch: SessionEntry[]) {
	const state = { branch };
	const notifications: Notification[] = [];
	const ctx = {
		ui: { notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }) },
		sessionManager: { getBranch: () => state.branch },
		signal: undefined,
		hasUI: true,
		mode: "tui",
	} as unknown as ExtensionContext;
	return {
		ctx,
		commandCtx: ctx as unknown as ExtensionCommandContext,
		toolCtx: ctx as unknown as ExtensionToolContext,
		notifications,
		setBranch: (next: SessionEntry[]): void => {
			state.branch = next;
		},
		appendUserMessage: (text: string): void => {
			state.branch = [...state.branch, userMessageEntry(text)];
		},
	};
}

/** 分支上的一条目标 entry（`session-target.ts` 唯一认的形状）。 */
function targetEntry(box: string): SessionEntry {
	return {
		type: "custom",
		customType: TARGET_ENTRY,
		data: { box, at: "2026-01-01T00:00:00.000Z" },
		id: `entry-${box}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
	};
}

/** 分支上的一条 user 消息（解析链第 2 级的输入）。 */
function userMessageEntry(text: string): SessionEntry {
	return {
		type: "message",
		message: { role: "user", content: text },
		id: `msg-${text}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
	} as unknown as SessionEntry;
}

const TEMPLATE_TOOL_NAMES = ["screenshot", "click", "type_text", "list_apps"] as const;

interface TemplateCacheOptions {
	/** 远端 schema 自带 `box`：`injectBoxParam` 拒绝注入 → `buildToolDefinitions` 走一次 warn */
	boxConflict?: boolean;
	/** 逐箱覆盖 `fetchedAt`（ISO 串）：用来构造「最近拉取的那台」 */
	fetchedAt?: Record<string, string>;
}

/** 写 per-box 模板缓存（`<agentDir>/pi-instabox/templates.json`），`fetchedAt` 取当前时刻故 TTL 内。 */
function writeTemplateCache(
	agentDir: string,
	boxes: Record<string, readonly string[]>,
	options: TemplateCacheOptions = {},
): void {
	const inputSchema = options.boxConflict === true
		? { type: "object", properties: { box: { type: "string" } } }
		: { type: "object", properties: {} };
	const dir = path.join(agentDir, "pi-instabox");
	fs.mkdirSync(dir, { recursive: true });
	const entries: Record<string, unknown> = {};
	for (const [box, names] of Object.entries(boxes)) {
		entries[box] = {
			serverInfoVersion: "0.3.6-instabox.1",
			templateId: "agent-browser",
			templateVersion: "2026-10-25.23",
			fetchedAt: options.fetchedAt?.[box] ?? new Date().toISOString(),
			tools: names.map((name) => ({
				name,
				description: `remote ${name}`,
				inputSchema,
			})),
		};
	}
	fs.writeFileSync(path.join(dir, "templates.json"), JSON.stringify({ version: 1, boxes: entries }, null, 2), "utf8");
}

/** 每条通知的文本（断言用）。 */
function messagesOf(notifications: readonly Notification[]): string[] {
	return notifications.map((notification) => notification.message);
}

/** 一条落盘记录（JSONL 解析后的形状，只取断言要用的字段）。 */
interface LogFileRecord {
	level: string;
	event: string;
	fields?: Record<string, unknown>;
}

/** 读真实日志文件（`<agentDir>/logs/pi-instabox/pi-instabox.jsonl`）；不存在则空数组。 */
function readLogRecords(agentDir: string): LogFileRecord[] {
	const file = path.join(agentDir, "logs", "pi-instabox", "pi-instabox.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as LogFileRecord);
}

/** 不设 `config.defaultBox`（空串＝未配置）。 */
function noDefaultBox(): void {
	vi.stubEnv("INSTABOX_MCP_DEFAULT_BOX", "");
}

/**
 * 让出到宏任务并跑完其后的微任务链：`session_start` 的后台任务被推迟一个宏任务启动
 * （`startBackgroundSessionStart`），而这些 cache-hit 场景的后台体不含定时器，所以一次
 * 5ms 的等待就够它跑完（含 gate 的场景仍用 {@link waitFor}）。
 */
function settleBackground(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

/** 轮询等待某个条件成立（后台任务的断言不能靠固定 sleep）。 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("@inobit/pi-instabox 装配", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-instabox-index-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("INSTABOX_MCP_DEFAULT_BOX", "general");
	});

	afterEach(() => {
		try {
			// 裁决 V2：任何用例都不允许激活/改写工具选择集
			for (const pi of createdPis) expect(pi.setActiveToolsCalls).toEqual([]);
			// H3：任何用例都不允许 spawn 真进程（`instabox ssh` 一律走注入的假客户端）
			expect(spawnGuard.calls).toEqual([]);
		} finally {
			createdPis.length = 0;
			spawnGuard.calls.length = 0;
			setLogger(undefined); // 日志单例不能跨用例遗留（装配层会写它）
			vi.unstubAllEnvs();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	describe("无 instabox CLI", () => {
		it("零工具/零命令/零 MCP、无运行期目录，只落一条 cli.probe（ok:false），session_start 恰一条 warning", async () => {
			const { exec } = createFakeExec({ cli: false });
			const pi = new FakePi(exec);
			// 注入真实文件 logger（只跳过 `VITEST` 的默认短路）：这条路径唯一允许的落盘证据就是它
			await instaboxExtension(pi.asAPI(), { loggerFactory: createFileLogger });

			expect(pi.tools).toHaveLength(0);
			expect(pi.commands).toHaveLength(0);
			expect(pi.registeredServers).toHaveLength(0);
			expect(pi.renderers.size).toBe(0);
			expect(pi.eventNames()).toEqual(["session_start"]);
			// 运行期目录一律不建：没有 templates.json、没有 bin/，连状态目录都不出现
			expect(fs.existsSync(path.join(agentDir, "pi-instabox"))).toBe(false);

			const { ctx, notifications } = createFakeContext([]);
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

			expect(messagesOf(notifications)).toEqual(["未找到 instabox CLI，instabox 扩展已禁用"]);
			expect(notifications[0]?.type).toBe("warning");
			// 探测失败同样留证：恰好一条 `cli.probe`，且 `session_start` 的提示不再追加记录
			const records = readLogRecords(agentDir);
			expect(records.map((record) => record.event)).toEqual(["cli.probe"]);
			expect(records[0]?.fields).toMatchObject({ ok: false, reason: "missing" });
		});
	});

	describe("后台声明来源（成功一律静默）", () => {
		/**
		 * 有缓存时的三级优先级：会话目标 → `config.defaultBox` → 最近拉取的那台。
		 * 缓存里的箱**故意不在** `ls` 的返回里：这样「声明来源来自缓存」与「来自 live 列表」
		 * 可区分（握手阶段 pool 仍会查一次状态，但那不是选源）。
		 */
		const OLD = "2026-11-01T00:00:00.000Z";
		const MID = "2026-11-05T00:00:00.000Z";
		const NEW = "2026-11-09T00:00:00.000Z";

		function writeThreeCaches(): void {
			writeTemplateCache(
				agentDir,
				{ alpha: ["click"], beta: ["screenshot"], gamma: ["list_apps"] },
				{ fetchedAt: { alpha: OLD, beta: MID, gamma: NEW } },
			);
		}

		/**
		 * 跑一次 `session_start` 的后台判定。codemode 一律设为「已激活」：本 describe 只关心
		 * 同步来源与静默性，不让无关的 codemode 提示混进 `notifications`。
		 */
		async function startBackground(branch: SessionEntry[] = []) {
			const { exec, calls } = createFakeExec({ boxes: [{ name: "live-box", state: "running" }] });
			const pi = new FakePi(exec);
			pi.activeTools = ["codemode"];
			pi.allTools = ["codemode"];
			const { clients } = await assembleExtension(pi);
			const fake = createFakeContext(branch);
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, fake.ctx);
			await waitFor(() => pi.tools.length > 0 || fake.notifications.length > 0, "background decision");
			await settleBackground();
			return { pi, calls, clients, ...fake };
		}


		it("1 级：会话目标有缓存 → 用会话目标的缓存", async () => {
			noDefaultBox();
			writeThreeCaches();
			const { pi, commandCtx, notifications } = await startBackground([targetEntry("alpha")]);

			// 加载期已经按「最近拉取」声明过一份（gamma）；后台应改判到会话目标 alpha
			expect(pi.toolNames()).toContain("instabox_desktop_click");
			expect(messagesOf(notifications)).toEqual([]); // 后台成功静默
			await invokeCommand(pi, "instabox-status", "", commandCtx);
			expect(messagesOf(notifications).at(-1)).toContain('box "alpha"');
		});

		it("2 级：会话目标无缓存 → 用 config.defaultBox 的缓存", async () => {
			vi.stubEnv("INSTABOX_MCP_DEFAULT_BOX", "beta");
			writeThreeCaches();
			const { pi, commandCtx, notifications } = await startBackground([targetEntry("ghost")]);

			expect(pi.toolNames()).toContain("instabox_desktop_screenshot");
			expect(messagesOf(notifications)).toEqual([]);
			await invokeCommand(pi, "instabox-status", "", commandCtx);
			expect(messagesOf(notifications).at(-1)).toContain('box "beta"');
		});

		it("3 级：都没配 → 用最近拉取的那台缓存", async () => {
			noDefaultBox();
			writeThreeCaches();
			const { pi, commandCtx, notifications } = await startBackground();

			expect(pi.toolNames()).toContain("instabox_desktop_list_apps");
			expect(messagesOf(notifications)).toEqual([]);
			await invokeCommand(pi, "instabox-status", "", commandCtx);
			expect(messagesOf(notifications).at(-1)).toContain('box "gamma"');
		});

		it("无缓存 + 有 running → 用第一台 running（跳过前面的 suspended），零唤醒", async () => {
			noDefaultBox();
			const { exec, calls } = createFakeExec({
				boxes: [
					{ name: "alpha", state: "suspended", desiredState: "suspended" },
					{ name: "beta", state: "running" },
				],
			});
			const pi = new FakePi(exec);
			pi.activeTools = ["codemode"];
			pi.allTools = ["codemode"];
			const { clients } = await assembleExtension(pi);
			const { ctx, notifications } = createFakeContext([]);

			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			await waitFor(() => pi.tools.length > 0, "background declaration");

			expect(pi.toolNames()).toEqual(["instabox_desktop_click", "instabox_desktop_screenshot"]);
			expect([...clients.keys()]).toEqual(["beta"]);
			expect(calls.some((call) => ["wake", "start", "resume"].includes(call[1] ?? ""))).toBe(false);
			// 成功一律不提示
			expect(messagesOf(notifications)).toEqual([]);
		});

		it("无缓存 + 全是 suspended → 用列表第一台并 `wake` 唤醒（不传 onProgress）", async () => {
			noDefaultBox();
			const { exec, calls } = createFakeExec({
				boxes: [
					{ name: "alpha", state: "suspended", desiredState: "suspended" },
					{ name: "beta", state: "suspended", desiredState: "suspended" },
				],
				trackStart: true,
			});
			const pi = new FakePi(exec);
			pi.activeTools = ["codemode"];
			pi.allTools = ["codemode"];
			const { clients } = await assembleExtension(pi);
			const { ctx, notifications } = createFakeContext([]);

			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			await waitFor(() => pi.tools.length > 0, "background wake + declaration");

			// 自动暂停的箱由 `wake` 拉起：只对列表第一台动手，且不跑 `start`/`resume`
			expect(calls).toContainEqual(["instabox", "wake", "alpha"]);
			expect(calls.some((call) => call[2] === "beta")).toBe(false);
			expect(calls.some((call) => ["start", "resume"].includes(call[1] ?? ""))).toBe(false);
			expect([...clients.keys()]).toEqual(["alpha"]);
			expect(pi.toolNames()).toEqual(["instabox_desktop_click", "instabox_desktop_screenshot"]);
			// 唤醒进度没往会话里塞提示（后台不传 onProgress），成功也不提示
			expect(messagesOf(notifications)).toEqual([]);
		});

		it("ls 返回空 → 一条「没有可用沙箱」warning（每会话一次）", async () => {
			noDefaultBox();
			const { exec } = createFakeExec({ boxes: [] });
			const pi = new FakePi(exec);
			await assembleExtension(pi);
			const { ctx, notifications } = createFakeContext([]);

			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			await waitFor(() => notifications.length > 0, "no-box notice");

			expect(messagesOf(notifications)).toHaveLength(1);
			expect(messagesOf(notifications)[0]).toContain("没有可用沙箱");
			expect(pi.tools).toHaveLength(0);
		});

		it("ls 失败 → 同样一条「没有可用沙箱」warning", async () => {
			noDefaultBox();
			const { exec } = createFakeExec({ boxes: [{ name: "alpha" }], lsFails: true });
			const pi = new FakePi(exec);
			await assembleExtension(pi);
			const { ctx, notifications } = createFakeContext([]);

			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			await waitFor(() => notifications.length > 0, "no-box notice");

			expect(messagesOf(notifications)).toEqual([
				"instabox: 没有可用沙箱（instabox ls 返回空或失败），桌面工具未注册；请检查 instabox CLI 与沙箱状态",
			]);
			expect(pi.tools).toHaveLength(0);
		});

		it("拉取失败（握手失败）→ 恰一条带 /instabox-use 的 warning", async () => {
			noDefaultBox();
			const { exec } = createFakeExec({ boxes: [{ name: "general", state: "running" }] });
			const pi = new FakePi(exec);
			const { factory } = createFakeClientFactory(["click"], { failInitialize: true });
			await instaboxExtension(pi.asAPI(), { clientFactory: factory });
			const { ctx, notifications } = createFakeContext([]);

			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			await waitFor(() => notifications.length > 0, "sync failure notice");

			expect(messagesOf(notifications)).toHaveLength(1);
			expect(messagesOf(notifications)[0]).toContain("未能同步沙箱");
			expect(messagesOf(notifications)[0]).toContain("/instabox-use general");
			expect(pi.tools).toHaveLength(0);
		});
	});

	describe("内部日志开关", () => {
		it("默认完全静音：后台失败也不写任何日志", async () => {
			noDefaultBox();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const { exec } = createFakeExec({ boxes: [] });
				const pi = new FakePi(exec);
				await assembleExtension(pi);
				const { ctx, notifications } = createFakeContext([]);
				await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
				await waitFor(() => notifications.length > 0, "no-box notice");

				expect(warn.mock.calls).toEqual([]);
			} finally {
				warn.mockRestore();
			}
		});

		it("PI_INSTABOX_DEBUG=1 时才写日志", async () => {
			vi.stubEnv("PI_INSTABOX_DEBUG", "1");
			noDefaultBox();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const { exec } = createFakeExec({ boxes: [] });
				const pi = new FakePi(exec);
				await assembleExtension(pi);
				const { ctx, notifications } = createFakeContext([]);
				await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
				await waitFor(() => notifications.length > 0, "no-box notice");

				expect(warn.mock.calls.some(([line]) => String(line).startsWith("[pi-instabox]"))).toBe(true);
			} finally {
				warn.mockRestore();
			}
		});
	});

	describe("加载期探测超时（≠ 没有 CLI）", () => {
		it("不禁用：session_start 用更长预算重试成功后走完整装配，并补跑当次会话的后台拉取", async () => {
			vi.stubEnv("INSTABOX_MCP_DEVTOOLS_BOX", "agent");
			noDefaultBox();
			// **故意不写模板缓存**：这样加载期装配声明不了任何工具，工具只能来自
			// 「重试成功后在**本次会话**补跑的后台拉取」——这就是「补跑确实发生了」的证据
			const { exec, calls, timeouts } = createFakeExec({
				boxes: [{ name: "general" }],
				versionPlan: ["timeout", "ok"],
			});
			const pi = new FakePi(exec);
			const { clients } = await assembleExtension(pi); // 假远端的 tools/list = click + screenshot

			// 加载期只被超时击杀：零注册、零写盘、零 ssh，只挂一个等重试的 session_start
			expect(pi.tools).toHaveLength(0);
			expect(pi.commands).toHaveLength(0);
			expect(pi.registeredServers).toHaveLength(0);
			expect(pi.eventNames()).toEqual(["session_start"]);
			expect(calls.some((argv) => argv[1] === "ls")).toBe(false);

			const { ctx, notifications } = createFakeContext([]);
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			await waitFor(() => pi.tools.length > 0, "in-session background fetch");

			// 工具来自本次会话的后台拉取（缓存原本不存在，装配本身声明不了工具）
			expect(pi.toolNames()).toEqual(["instabox_desktop_click", "instabox_desktop_screenshot"]);
			expect(calls.some((argv) => argv[1] === "ls")).toBe(true);
			expect(clients.get("general")?.initializeCalls).toBeGreaterThan(0);
			expect(fs.existsSync(path.join(agentDir, "pi-instabox", "templates.json"))).toBe(true);

			// 完整装配的其余部分：命令 / renderer / DevTools MCP / 三个事件
			expect(pi.commands.map((command) => command.name)).toEqual(["instabox-use", "instabox-status"]);
			expect([...pi.renderers.keys()]).toEqual([TARGET_ENTRY]);
			expect(pi.registeredServers.map((server) => server.name)).toEqual(["instabox-devtools"]);
			expect(pi.eventNames()).toEqual(["session_start", "session_tree", "session_shutdown"]);
			// 没有「无 CLI」warning（超时不是「没有 CLI」）
			expect(messagesOf(notifications)).toEqual([]);

			// 两次探测：加载期用默认预算，会话内重试用 5000ms
			const probes = calls
				.map((argv, index) => ({ argv, timeout: timeouts[index] }))
				.filter((probe) => probe.argv[1] === "version");
			expect(probes).toHaveLength(2);
			expect(probes[1]?.timeout).toBe(5000);

			// 之后的会话由装配注册的处理器接管：不重复探测、不再提示、工具还在
			const later = createFakeContext([]);
			await pi.emit("session_start", { type: "session_start", reason: "resume" }, later.ctx);
			await settleBackground();
			expect(messagesOf(later.notifications)).toEqual([]);
			expect(calls.filter((argv) => argv[1] === "version")).toHaveLength(2);
			expect(pi.toolNames()).toEqual(["instabox_desktop_click", "instabox_desktop_screenshot"]);
		});

		it("重试探测卡住时 session_start 立即返回（不阻塞会话启动）", async () => {
			noDefaultBox();
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const versionAttempts: number[] = [];
			const { exec } = createFakeExec({
				boxes: [{ name: "general" }],
				versionPlan: ["timeout", "ok"],
				beforeVersion: (attempt) => {
					versionAttempts.push(attempt);
					return attempt === 1 ? gate : undefined;
				},
			});
			const pi = new FakePi(exec);
			const { clients } = await assembleExtension(pi);
			const { ctx } = createFakeContext([]);

			// 第二次（重试）探测卡在 gate 上：处理器必须已经返回
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			expect(versionAttempts).toEqual([0, 1]);
			expect(pi.tools).toHaveLength(0);
			expect(pi.commands).toHaveLength(0);
			expect(clients.size).toBe(0);

			release?.();
			await waitFor(() => pi.tools.length > 0, "assembly after gated retry probe");
			expect(pi.commands).toHaveLength(2);
		});

		it("重试成功但装配抛错 → 报「初始化失败」而不是「未找到 CLI」，且不再重试", async () => {
			noDefaultBox();
			// 有缓存 → 装配里的「加载期注册工具」就会执行，`failOnRegisterTool` 因此能在 `assemble()` 内炸
			writeTemplateCache(agentDir, { general: ["click"] });
			const { exec, calls } = createFakeExec({
				boxes: [{ name: "general" }],
				versionPlan: ["timeout", "ok"],
			});
			const pi = new FakePi(exec);
			pi.failOnRegisterTool = true; // 装配在 registerTool 处炸
			await assembleExtension(pi);

			const first = createFakeContext([]);
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, first.ctx);
			await waitFor(() => first.notifications.length > 0, "assembly failure notice");

			expect(messagesOf(first.notifications)[0]).toContain("instabox 扩展初始化失败");
			expect(messagesOf(first.notifications)[0]).toContain("registerTool exploded");
			expect(messagesOf(first.notifications)[0]).not.toContain("未找到 instabox CLI");

			// 后续会话：仍是准确文案，且不再探测（一次性）
			const second = createFakeContext([]);
			await pi.emit("session_start", { type: "session_start", reason: "resume" }, second.ctx);
			expect(messagesOf(second.notifications)[0]).toContain("instabox 扩展初始化失败");
			expect(calls.filter((argv) => argv[1] === "version")).toHaveLength(2);
		});

		it("ui.notify 抛错时重试失败路径不产生未处理 rejection", async () => {
			vi.stubEnv("PI_INSTABOX_DEBUG", "1"); // 断言那条 debug 兜底日志
			const { exec } = createFakeExec({
				boxes: [{ name: "general" }],
				versionPlan: ["timeout", "timeout"],
			});
			const pi = new FakePi(exec);
			await assembleExtension(pi);

			const rejections: unknown[] = [];
			const onRejection = (reason: unknown): void => {
				rejections.push(reason);
			};
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			process.on("unhandledRejection", onRejection);
			try {
				const { ctx } = createFakeContext([]);
				(ctx.ui as unknown as { notify: () => void }).notify = () => {
					throw new Error("ui is gone");
				};

				// 处理器本身不能 reject（`notifyQuietly` 把 UI 异常收成一条 debug 日志）
				await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
				await settleBackground();
				await new Promise((resolve) => setTimeout(resolve, 20)); // 让潜在 rejection 浮出来

				expect(rejections).toEqual([]);
				expect(warn.mock.calls.some(([line]) => String(line).includes("ui.notify failed"))).toBe(true);
			} finally {
				process.off("unhandledRejection", onRejection);
				warn.mockRestore();
			}
		});

		it("超时且重试仍超时 → 一条 warning、零注册，且不再重试", async () => {
			const { exec, calls } = createFakeExec({
				boxes: [{ name: "general" }],
				versionPlan: ["timeout", "timeout"],
			});
			const pi = new FakePi(exec);
			await assembleExtension(pi);

			const first = createFakeContext([]);
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, first.ctx);
			await waitFor(() => first.notifications.length > 0, "disabled notice");

			expect(messagesOf(first.notifications)).toEqual(["未找到 instabox CLI，instabox 扩展已禁用"]);
			expect(pi.tools).toHaveLength(0);
			expect(pi.commands).toHaveLength(0);

			// 第二个会话：只提示，不再探测（一次性标记）
			const second = createFakeContext([]);
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, second.ctx);
			expect(messagesOf(second.notifications)).toEqual(["未找到 instabox CLI，instabox 扩展已禁用"]);
			expect(calls.filter((argv) => argv[1] === "version")).toHaveLength(2);
		});

		it("ENOENT（missing）→ 直接零注册，不在会话里重试", async () => {
			const { exec, calls } = createFakeExec({ cli: false, boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			await assembleExtension(pi);

			expect(pi.tools).toHaveLength(0);
			expect(pi.commands).toHaveLength(0);
			expect(pi.eventNames()).toEqual(["session_start"]);

			const { ctx, notifications } = createFakeContext([]);
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

			expect(messagesOf(notifications)).toEqual(["未找到 instabox CLI，instabox 扩展已禁用"]);
			expect(calls.filter((argv) => argv[1] === "version")).toHaveLength(1);
		});
	});

	describe("有 CLI + 模板缓存命中", () => {
		async function assemble() {
			writeTemplateCache(agentDir, { general: TEMPLATE_TOOL_NAMES });
			const { exec, calls } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			await assembleExtension(pi);
			return { pi, calls };
		}

		it("加载期即注册工具/命令/renderer/两事件，且只调过 instabox version（不跑 ls）", async () => {
			const { pi, calls } = await assemble();

			expect(pi.toolNames()).toEqual(TEMPLATE_TOOL_NAMES.map((name) => `instabox_desktop_${name}`).sort());
			expect(pi.tools.every((tool) => tool.exposure === "codemode")).toBe(true);
			expect(pi.commands.map((command) => command.name)).toEqual(["instabox-use", "instabox-status"]);
			expect([...pi.renderers.keys()]).toEqual([TARGET_ENTRY]);
			expect(pi.eventNames()).toEqual(["session_start", "session_tree", "session_shutdown"]);
			expect(calls).toEqual([["instabox", "version"]]);
		});

		it("从未调用 setActiveTools", async () => {
			const { pi } = await assemble();
			const { ctx } = createFakeContext([]);
			pi.activeTools = [];
			pi.allTools = ["codemode"];
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			expect(pi.setActiveToolsCalls).toEqual([]);
		});
	});

	describe("session_start 的后台任务", () => {
		it("不 await 拉取：处理器先返回，后台完成后才注册", async () => {
			noDefaultBox();
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const { exec, calls } = createFakeExec({
				boxes: [{ name: "general" }],
				beforeList: () => gate,
			});
			const pi = new FakePi(exec);
			await assembleExtension(pi);
			const { ctx, notifications } = createFakeContext([]);

			expect(pi.tools).toHaveLength(0);
			// 处理器必须立刻 resolve：后台 `ls` 还卡在 gate 上
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			expect(pi.tools).toHaveLength(0);
			expect(messagesOf(notifications)).toEqual([]);

			release?.();
			await waitFor(() => pi.tools.length > 0, "background registration");
			expect(pi.toolNames()).toEqual(["instabox_desktop_click", "instabox_desktop_screenshot"]);
			// 后台路径：只看过 ls（探活一次 version），没有任何唤醒命令
			expect(calls.some((call) => ["wake", "start", "resume"].includes(call[1] ?? ""))).toBe(false);
		});

		it("同步段不启动后台：emit 返回时零 ls、零提示，宏任务之后才开始", async () => {
			noDefaultBox();
			const { exec, calls } = createFakeExec({
				boxes: [{ name: "agent", state: "suspended", desiredState: "suspended" }],
			});
			const pi = new FakePi(exec);
			await assembleExtension(pi);
			const { ctx, notifications } = createFakeContext([]);

			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

			// 同步段只有内存操作：探活之后就再没有 exec（`TemplateStore`/`readCache` 的同步读盘
			// 与 `ls` 都还没发生），也没有任何提示
			expect(calls).toEqual([["instabox", "version"]]);
			expect(messagesOf(notifications)).toEqual([]);

			await settleBackground();
			expect(calls.some((call) => call[1] === "ls")).toBe(true);
			await waitFor(() => notifications.length > 0, "background failure notice");
		});

		it("加载期 notifyOnce 无 UI 出口 → 入队，session_start 后恰好发一次", async () => {
			// 远端 schema 自带 `box` → `injectBoxParam` 拒绝注入、`buildToolDefinitions` warn 一次；
			// 那次 warn 发生在加载期（还没有 ctx），不能算「已通知」
			writeTemplateCache(agentDir, { general: ["click"] }, { boxConflict: true });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			// codemode 已激活：本用例只关心「加载期排队的那条 warn」，不让 codemode 提示掺进来
			pi.activeTools = ["codemode"];
			pi.allTools = ["codemode"];
			await assembleExtension(pi);
			const { ctx, notifications } = createFakeContext([]);

			expect(pi.tools).toHaveLength(1);
			expect(messagesOf(notifications)).toEqual([]);

			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			expect(messagesOf(notifications)).toHaveLength(1);
			expect(messagesOf(notifications)[0]).toContain('instabox desktop tool "click"');

			// 后台重新注册会再 warn 一次：去重键已在 drain 时置位，不重复提示
			await settleBackground();
			expect(messagesOf(notifications)).toHaveLength(1);
		});
	});

	describe("session_shutdown", () => {
		it("收掉本实例的远端连接，之后的调用会重新建连", async () => {
			noDefaultBox();
			writeTemplateCache(agentDir, { general: ["click"] });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			const { clients } = await assembleExtension(pi, ["click"]);
			const { ctx, toolCtx } = createFakeContext([]);
			const tool = pi.tools.find((candidate) => candidate.name === "instabox_desktop_click");

			await runTool(tool, {}, toolCtx);
			const first = clients.get("general");
			expect(first?.callToolCalls).toHaveLength(1);
			expect(first?.closed).toBe(false);

			await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
			expect(first?.closed).toBe(true);

			// 池不是终态：换会话后第一次调用重新建连（`disposeAll` 只驱逐、不封池）
			await runTool(tool, {}, toolCtx);
			const second = clients.get("general");
			expect(second).not.toBe(first);
			expect(second?.closed).toBe(false);
			expect(second?.callToolCalls).toHaveLength(1);
		});
	});

	describe("codemode 只读判定", () => {
		async function startSession(options: {
			activeTools: string[];
			allTools: string[];
			extraServers?: McpServerConfig[];
		}) {
			writeTemplateCache(agentDir, { general: TEMPLATE_TOOL_NAMES });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			pi.activeTools = options.activeTools;
			pi.allTools = options.allTools;
			pi.extraServers = options.extraServers ?? [];
			await assembleExtension(pi);
			const { ctx, notifications } = createFakeContext([]);
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
			await settleBackground();
			return { pi, notifications };
		}

		it("已激活 → 不提示", async () => {
			const { notifications } = await startSession({ activeTools: ["codemode", "read"], allTools: ["codemode"] });
			expect(messagesOf(notifications)).toEqual([]);
		});

		it("有条目但未激活 → 每会话提示一次补救命令", async () => {
			const { notifications } = await startSession({ activeTools: [], allTools: ["codemode"] });
			expect(messagesOf(notifications)).toEqual([
				'instabox 桌面工具需要 codemode 处于激活状态：pi --tools +codemode，或在 settings 里设 defaultTools: ["+codemode"]',
			]);
			expect(notifications[0]?.type).toBe("warning");
		});

		it("没有 codemode 条目 → 提示本会话不可调用", async () => {
			const { notifications } = await startSession({ activeTools: [], allTools: [] });
			expect(messagesOf(notifications)).toEqual([
				"本会话没有 codemode 工具，instabox 桌面工具不可调用；请允许 codemode（--tools +codemode 或内置扩展）",
			]);
		});

		it("有 codemode exposure 的 MCP server → 不提示（pi 连接时会自动激活）", async () => {
			vi.stubEnv("INSTABOX_MCP_DEVTOOLS_BOX", "agent");
			const { pi, notifications } = await startSession({ activeTools: [], allTools: ["codemode"] });
			expect(pi.registeredServers.map((server) => server.name)).toEqual(["instabox-devtools"]);
			expect(messagesOf(notifications)).toEqual([]);
		});

		it("exposure 缺省的 server 视为 codemode → 也不提示", async () => {
			const { notifications } = await startSession({
				activeTools: [],
				allTools: ["codemode"],
				extraServers: [{ command: "/usr/bin/other-mcp" }],
			});
			expect(messagesOf(notifications)).toEqual([]);
		});

		it("enabled:false 且无其它 server → 照常提示", async () => {
			const { notifications } = await startSession({
				activeTools: [],
				allTools: ["codemode"],
				extraServers: [{ command: "/usr/bin/other-mcp", enabled: false }],
			});
			expect(messagesOf(notifications)).toHaveLength(1);
			expect(messagesOf(notifications)[0]).toContain("instabox 桌面工具需要 codemode 处于激活状态");
		});
	});

	describe("DevTools MCP", () => {
		it("devToolsBox 为空 → 不注册 MCP、不写 helper", async () => {
			writeTemplateCache(agentDir, { general: TEMPLATE_TOOL_NAMES });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			await assembleExtension(pi);

			expect(pi.registeredServers).toEqual([]);
			expect(fs.existsSync(path.join(agentDir, "pi-instabox", "bin"))).toBe(false);
		});

		it("devToolsBox 非空 → 写 helper 并注册 instabox-devtools", async () => {
			vi.stubEnv("INSTABOX_MCP_DEVTOOLS_BOX", "agent");
			writeTemplateCache(agentDir, { general: TEMPLATE_TOOL_NAMES });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			await assembleExtension(pi);

			const helper = path.join(agentDir, "pi-instabox", "bin", "devtools-connect.sh");
			expect(fs.readFileSync(helper, "utf8")).toContain("set -eu");
			expect(fs.statSync(helper).mode & 0o777).toBe(0o755);

			expect(pi.registeredServers).toHaveLength(1);
			const server = pi.registeredServers[0];
			expect(server?.name).toBe("instabox-devtools");
			expect(server?.config.exposure).toBe("codemode");
			expect(server?.config.timeout).toBe(180);
			const config = server?.config;
			expect(config).toMatchObject({ command: helper });
			// stdio 配置的 `args` = [devToolsBox, ...DEFAULT_CONFIG.devToolsArgs]
			expect(config !== undefined && "command" in config ? config.args?.slice(0, 2) : undefined).toEqual(["agent", "--headless"]);
		});
	});

	describe("/instabox-use", () => {
		async function assemble() {
			writeTemplateCache(agentDir, { general: TEMPLATE_TOOL_NAMES });
			const { exec, calls } = createFakeExec({ boxes: [{ name: "general" }, { name: "agent" }] });
			const pi = new FakePi(exec);
			await assembleExtension(pi);
			return { pi, calls, ...createFakeContext([]) };
		}

		it("无效名 → 拒绝且不写 entry", async () => {
			const { pi, commandCtx, notifications } = await assemble();
			await invokeCommand(pi, "instabox-use", "no-such", commandCtx);

			expect(pi.entries).toEqual([]);
			expect(messagesOf(notifications)[0]).toContain('unknown box "no-such"');
			expect(messagesOf(notifications)[0]).toContain("target unchanged");
		});

		it("有效名 → 写目标 entry，已有工具时不走唤醒链", async () => {
			const { pi, calls, commandCtx, notifications } = await assemble();
			await invokeCommand(pi, "instabox-use", "agent", commandCtx);

			expect(pi.entries).toHaveLength(1);
			expect(pi.entries[0]?.customType).toBe(TARGET_ENTRY);
			expect(pi.entries[0]?.data).toMatchObject({ box: "agent" });
			expect(messagesOf(notifications)).toEqual(["instabox target: agent"]);
			expect(calls.some((call) => ["wake", "start", "resume"].includes(call[1] ?? ""))).toBe(false);
		});

		it("空参数 → 列出当前目标 + 候选", async () => {
			const { pi, commandCtx, notifications, setBranch } = await assemble();
			setBranch([targetEntry("general")]);
			await invokeCommand(pi, "instabox-use", "  ", commandCtx);

			expect(messagesOf(notifications)).toEqual(["instabox target: general\ncandidates: general, agent"]);
		});

		it("冷启动闭环：无缓存 + suspended → `wake` 报没在跑 → `start` → 拉模板 → 注册", async () => {
			noDefaultBox();
			const { exec, calls } = createFakeExec({
				boxes: [{ name: "agent", state: "suspended", desiredState: "suspended" }],
				trackStart: true,
				wakeFails: true,
			});
			const pi = new FakePi(exec);
			const { clients } = await assembleExtension(pi);
			const { commandCtx, notifications } = createFakeContext([]);

			expect(pi.tools).toHaveLength(0);
			expect(fs.existsSync(path.join(agentDir, "pi-instabox", "templates.json"))).toBe(false);

			await invokeCommand(pi, "instabox-use", "agent", commandCtx);

			// 用户手动暂停的箱：`wake` 自报 machine_not_running → 退到 `start` → 唤醒成功后拉模板
			expect(calls).toContainEqual(["instabox", "wake", "agent"]);
			expect(calls).toContainEqual(["instabox", "start", "agent"]);
			expect(calls.findIndex((call) => call[1] === "wake")).toBeLessThan(
				calls.findIndex((call) => call[1] === "start"),
			);
			expect(calls.filter((call) => call[1] === "start")).toHaveLength(1);
			expect(pi.entries[0]?.data).toMatchObject({ box: "agent" });
			expect(pi.toolNames()).toEqual(["instabox_desktop_click", "instabox_desktop_screenshot"]);
			expect(messagesOf(notifications)).toContain('instabox: registered 2 desktop tool(s) for box "agent"');
			// per-box 缓存写盘（下次启动零 ssh 即可声明工具）
			expect(fs.existsSync(path.join(agentDir, "pi-instabox", "templates.json"))).toBe(true);
			expect(clients.get("agent")?.callToolCalls).toEqual([]);
		});

		it("冷启动闭环：`wake` 成功即注册，不再跑 `start`（自动暂停的箱）", async () => {
			noDefaultBox();
			const { exec, calls } = createFakeExec({
				boxes: [{ name: "agent", state: "suspended", desiredState: "suspended" }],
				trackStart: true,
			});
			const pi = new FakePi(exec);
			await assembleExtension(pi);
			const { commandCtx, notifications } = createFakeContext([]);

			await invokeCommand(pi, "instabox-use", "agent", commandCtx);

			expect(calls).toContainEqual(["instabox", "wake", "agent"]);
			expect(calls.some((call) => ["start", "resume"].includes(call[1] ?? ""))).toBe(false);
			expect(pi.toolNames()).toEqual(["instabox_desktop_click", "instabox_desktop_screenshot"]);
			expect(messagesOf(notifications)).toContain('instabox: registered 2 desktop tool(s) for box "agent"');
		});
	});

	describe("/instabox-status", () => {
		it("打印配置摘要、解析目标、工具声明来源、active tools、codemode 与 MCP server", async () => {
			writeTemplateCache(agentDir, { general: ["click"] });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }, { name: "agent" }] });
			const pi = new FakePi(exec);
			pi.activeTools = ["codemode", "read"];
			pi.allTools = ["codemode"];
			await assembleExtension(pi);
			const { commandCtx, notifications } = createFakeContext([]);

			await invokeCommand(pi, "instabox-status", "", commandCtx);

			const lines = messagesOf(notifications)[0]?.split("\n") ?? [];
			expect(lines[0]).toContain("config: defaultBox=general");
			expect(lines).toContain("session target: (not set)");
			expect(lines).toContain("resolved target: general (via config)");
			expect(lines).toContain("tools: instabox_desktop_click (codemode)");
			expect(lines).toContain(
				'tool declarations: from the cached template of box "general" (the per-call target is resolved at call time)',
			);
			expect(lines).toContain("active tools: codemode, read");
			expect(lines).toContain("codemode: active");
			expect(lines).toContain("mcp servers: (none)");
		});

		it("codemode 已激活且存在 codemode-exposure server → `active (auto via MCP)`", async () => {
			vi.stubEnv("INSTABOX_MCP_DEVTOOLS_BOX", "agent");
			writeTemplateCache(agentDir, { general: ["click"] });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			pi.activeTools = ["codemode"];
			pi.allTools = ["codemode"];
			await assembleExtension(pi);
			const { commandCtx, notifications } = createFakeContext([]);

			await invokeCommand(pi, "instabox-status", "", commandCtx);

			expect(messagesOf(notifications)[0]?.split("\n")).toContain("codemode: active (auto via MCP)");
			expect(messagesOf(notifications)[0]?.split("\n")).toContain("mcp servers: instabox-devtools");
		});
	});

	describe("目标解析（实时读分支）", () => {
		it("解析链第 2 级在每次工具调用时重读：先 agent，追加含 general 的消息后变 general", async () => {
			noDefaultBox();
			writeTemplateCache(agentDir, { general: ["click"] });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }, { name: "agent" }] });
			const pi = new FakePi(exec);
			const { clients } = await assembleExtension(pi, ["click"]);
			const { toolCtx, appendUserMessage, setBranch } = createFakeContext([userMessageEntry("please use agent")]);

			const tool = pi.tools.find((candidate) => candidate.name === "instabox_desktop_click");
			expect(tool).toBeDefined();
			const first = await runTool(tool, {}, toolCtx);
			expect(first.content[0]).toEqual({ type: "text", text: "[box=agent]" });

			// 本轮又来了 user 消息：解析链必须立刻看到它（不能复会话开始时的快照）
			appendUserMessage("no, use general");
			const second = await runTool(tool, {}, toolCtx);
			expect(second.content[0]).toEqual({ type: "text", text: "[box=general]" });

			expect([...clients.keys()].sort()).toEqual(["agent", "general"]);
			expect(pi.entries).toEqual([]);
			setBranch([]);
		});

		it("session_tree 之后目标回到新分支：不写 entry、不发消息", async () => {
			writeTemplateCache(agentDir, { general: TEMPLATE_TOOL_NAMES });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }, { name: "agent" }] });
			const pi = new FakePi(exec);
			await assembleExtension(pi);
			const { ctx, commandCtx, notifications, setBranch } = createFakeContext([targetEntry("general")]);

			setBranch([targetEntry("agent")]);
			await pi.emit("session_tree", { type: "session_tree", newLeafId: "entry-agent", oldLeafId: "entry-general" }, ctx);
			expect(pi.entries).toEqual([]);

			await invokeCommand(pi, "instabox-use", "", commandCtx);
			expect(messagesOf(notifications).at(-1)).toContain("instabox target: agent");
		});
	});

	describe("埋点", () => {
		it("load.assembled / devtools.register / session.start / session.tree / session.shutdown 各落一条", async () => {
			vi.stubEnv("INSTABOX_MCP_DEVTOOLS_BOX", "agent");
			writeTemplateCache(agentDir, { general: ["click"] });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			pi.activeTools = ["codemode"];
			pi.allTools = ["codemode"];
			const logger = createMemoryLogger();

			setLogger(logger);
			try {
				await assembleExtension(pi, ["click"]);
				const { ctx } = createFakeContext([targetEntry("general")]);
				await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
				await waitFor(() => pi.tools.length > 0, "background declaration");
				await settleBackground();
				await pi.emit("session_tree", { type: "session_tree", newLeafId: "entry-general", oldLeafId: null }, ctx);
				await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
			} finally {
				setLogger(undefined);
			}

			const find = (event: string) => logger.records.filter((record) => record.event === event);

			// 日志在探测前就接上：`cli.probe` 必须出现在 `load.assembled` 之前
			const eventNames = logger.records.map((record) => record.event);
			expect(eventNames.indexOf("cli.probe")).toBeGreaterThanOrEqual(0);
			expect(eventNames.indexOf("cli.probe")).toBeLessThan(eventNames.indexOf("load.assembled"));

			// 加载期用缓存声明：cacheHit / 声明的箱 / 工具数
			const assembled = find("load.assembled");
			expect(assembled).toHaveLength(1);
			expect(assembled[0]?.fields).toEqual({ cacheHit: true, box: "general", tools: 1 });

			// 假设层不记 helper 内容（那是 devtools.helper），只记注册结果
			expect(find("devtools.helper")[0]?.fields).toMatchObject({ ok: true });
			expect(find("devtools.register")[0]?.fields).toEqual({ box: "agent", ok: true });

			// `source` = session_start 的 reason；`target` 是会话已有目标；`mode` 来自 ctx
			expect(find("session.start")[0]?.fields).toEqual({ target: "general", source: "startup", mode: "tui" });
			expect(find("session.tree")[0]?.level).toBe("debug");
			expect(find("session.tree")[0]?.fields).toEqual({ target: "general" });
			expect(find("session.shutdown")[0]?.fields).toMatchObject({ open: expect.any(Number) });

			// codemode 埋点把内部三态 `unavailable` 记成 `missing`；本会话已激活 → `active`
			const codemode = find("codemode");
			expect(codemode.length).toBeGreaterThan(0);
			expect(codemode[0]?.level).toBe("debug");
			expect(codemode[0]?.fields).toEqual({ state: "active", server: true });
		});
	});

	describe("文件日志接线", () => {
		/**
		 * 注入替身：记下装配层给的构造参数，返回内存 logger。
		 * 注入即跳过「`VITEST` 不建」的短路，因此可以断言 `dir` / `level`，全程不碰真实磁盘。
		 */
		function captureLogger() {
			const options: InstaboxLoggerOptions[] = [];
			const logger = createMemoryLogger();
			const loggerFactory = (given: InstaboxLoggerOptions): ReturnType<typeof createMemoryLogger> => {
				options.push(given);
				return logger;
			};
			return { options, logger, loggerFactory };
		}

		it("装配成功 → 按 <agentDir>/logs/pi-instabox 建 logger（默认 info），探测与装配埋点都落到它上", async () => {
			writeTemplateCache(agentDir, { general: ["click"] });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			const { factory } = createFakeClientFactory(["click"]);
			const { options, logger, loggerFactory } = captureLogger();

			await instaboxExtension(pi.asAPI(), { clientFactory: factory, loggerFactory });

			expect(options).toHaveLength(1);
			expect(options[0]?.dir).toBe(path.join(agentDir, "logs", "pi-instabox"));
			expect(options[0]?.level).toBe("info");
			// 不只是「工厂被调了一次」：探测与装配的埋点真的落到了这个 logger 上，且顺序正确
			const events = logger.records.map((record) => record.event);
			expect(events.indexOf("cli.probe")).toBeGreaterThanOrEqual(0);
			expect(events.indexOf("cli.probe")).toBeLessThan(events.indexOf("load.assembled"));
			// 替身接管后再没别的写入面：日志目录没有被建出来
			expect(fs.existsSync(path.join(agentDir, "logs"))).toBe(false);
		});

		it("PI_INSTABOX_DEBUG=1 → debug 级别（记 `debug` 事件）", async () => {
			vi.stubEnv("PI_INSTABOX_DEBUG", "1");
			writeTemplateCache(agentDir, { general: ["click"] });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			const { factory } = createFakeClientFactory(["click"]);
			const { options, loggerFactory } = captureLogger();

			await instaboxExtension(pi.asAPI(), { clientFactory: factory, loggerFactory });

			expect(options[0]?.level).toBe("debug");
		});

		it("VITEST 下默认不建 logger：不替换已注册的那个，也不建日志目录", async () => {
			const logger = createMemoryLogger();
			setLogger(logger);
			writeTemplateCache(agentDir, { general: ["click"] });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);

			await assembleExtension(pi); // 不注入 loggerFactory

			// 已注册的 logger 还在，且埋点还是落在它上面（装配层没拿文件 logger 顶上）
			expect(logger.records.map((record) => record.event)).toContain("load.assembled");
			expect(fs.existsSync(path.join(agentDir, "logs"))).toBe(false);
		});

		it("无 instabox CLI → logger 仍在探测前建好，只落一条 cli.probe（ok:false）", async () => {
			const { exec } = createFakeExec({ cli: false });
			const pi = new FakePi(exec);
			const { options, logger, loggerFactory } = captureLogger();

			await instaboxExtension(pi.asAPI(), { loggerFactory });

			expect(options).toHaveLength(1);
			const probes = logger.records.filter((record) => record.event === "cli.probe");
			expect(probes).toHaveLength(1);
			expect(probes[0]?.fields).toMatchObject({ ok: false, reason: "missing" });
			expect(logger.records.map((record) => record.event)).not.toContain("load.assembled");
		});

		it("session_shutdown → 复位 logger，之后的事件不再落盘", async () => {
			writeTemplateCache(agentDir, { general: ["click"] });
			const { exec } = createFakeExec({ boxes: [{ name: "general" }] });
			const pi = new FakePi(exec);
			const { factory } = createFakeClientFactory(["click"]);
			const { logger, loggerFactory } = captureLogger();

			await instaboxExtension(pi.asAPI(), { clientFactory: factory, loggerFactory });
			const { ctx } = createFakeContext([]);
			await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);

			expect(logger.records.map((record) => record.event)).toContain("session.shutdown");
			const before = logger.records.length;
			logEvent("after.shutdown");
			expect(logger.records).toHaveLength(before);
		});
	});
});

/** 直接调注册好的工具 `execute`（工具只用 ctx 读分支，其它字段用不到）。 */
function runTool(
	tool: ToolDefinition | undefined,
	params: Record<string, unknown>,
	ctx: ExtensionToolContext,
): Promise<{ content: unknown[]; isError?: boolean }> {
	if (tool === undefined) throw new Error("tool not registered");
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

/** 调 `/instabox-*` 命令处理器（假 `pi` 只记录名字，处理器从真注册表里取）。 */
async function invokeCommand(
	pi: FakePi,
	name: string,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const registered = pi.commandHandlers.get(name);
	if (registered === undefined) throw new Error(`command not registered: ${name}`);
	await registered(args, ctx);
}
