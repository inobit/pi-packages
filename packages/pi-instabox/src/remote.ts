/**
 * @inobit/pi-instabox — 远端 stdio MCP 客户端（方案 §4.7 D7）。
 *
 * 契约：
 * - 只做 **stdio** 双工：调用方给命令（如 `instabox ssh <box> -- instabox-computer-use mcp`），
 *   本模块负责 `spawn`、JSON-RPC 2.0 请求表、超时、abort、dead 标记。它不认识 box，
 *   也不做 JSON-RPC over HTTP。
 * - 分帧：**读出侧同时容忍两种形态**——换行分隔 JSON（MCP stdio 标准）与
 *   `Content-Length: N\r\n\r\n{...}` 头（LSP 风格）；首个字节决定模式并锁定，未定前只缓冲。
 *   写入侧固定「单行 JSON + `\n`」（MCP stdio 标准）。T10 spike 实测（`instabox ssh general --
 *   instabox-computer-use mcp`）：首帧是以 `{"id":1,"jsonrpc":"2.0","result":…}` 开头的
 *   单行 JSON + `\n`，**没有** `Content-Length` 头；头帧容忍作为后备保留。
 * - 握手：`initialize`（`protocolVersion`/`capabilities`/`clientInfo`）→ `notifications/initialized`
 *   （**无 id**）→ 之后每个请求 `id` 从 1 起单调自增。
 * - 失败：超时 / 子进程 `close`/`error` / `signal` abort → reject **全部** pending 并置 `dead`；
 *   调用方（`pool.ts`）据 `isDead()` 重建。abort 对**建连与握手期**同样生效
 *   （`initialize(signal)` 把 signal 透传到 `initialize` 请求），否则 abort 后仍要白等
 *   connect + initialize 两段预算。任何异常只以 {@link RemoteError} 出现，
 *   绝不 throw 到会话层（由调用方转成工具结果 `isError: true`）。
 * - 注入面：`spawn` / `clock` / `now` 全部可替，单测用内存假流，**不 spawn 真进程**。
 */

import { spawn as nodeSpawn } from "node:child_process";

/**
 * 请求的 MCP 协议版本。取 T10 spike 实测的远端版本（`open-computer-use` 0.3.6-instabox.1
 * 回 `2025-03-26`）；远端总是回自己的版本，本客户端不校验版本号，只按返回体行事。
 */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

/** `initialize` 的 `clientInfo`（`version` 仅作排障标识，不参与协议协商）。 */
export const CLIENT_INFO = { name: "@inobit/pi-instabox", version: "0.1.0" } as const;

/** 单次连接的预算表（毫秒），语义见各字段。 */
export interface RemoteTimeouts {
	/** spawn 到「远端进程吐出第一个字节」（ssh 挂住/认证失败都在这里暴露） */
	connect: number;
	/** `initialize` 请求发出到响应 */
	initialize: number;
	/** `tools/list` 请求发出到响应 */
	listTools: number;
	/** `tools/call` 请求发出到响应（桌面操作本身可能很慢） */
	callTool: number;
}

/**
 * 默认预算（方案 §4.7 ⑤）。
 *
 * 本模块只认这张表与调用方显式传入的 `timeouts` 覆盖；**配置不在这里读**——T11 接入时由
 * `config.timeouts`（`connectMs`/`initializeMs`/`listToolsMs`/`callMs`）单向喂入
 * `createRemoteClient({ timeouts })`，方向只有配置 → 客户端。
 */
export const DEFAULT_TIMEOUTS: RemoteTimeouts = {
	connect: 15_000,
	initialize: 20_000,
	listTools: 20_000,
	callTool: 120_000,
};

/** 错误分类：调用方据此决定「重连 / 报取消 / 报远端错误」。 */
export type RemoteErrorCode = "spawn" | "protocol" | "timeout" | "closed" | "aborted" | "rpc";

/** 本模块唯一抛出的错误类型（带 `code`，绝不裸 Error/字符串）。 */
export class RemoteError extends Error {
	readonly code: RemoteErrorCode;

	constructor(message: string, code: RemoteErrorCode) {
		super(message);
		this.name = "RemoteError";
		this.code = code;
	}
}

/** spawn 选项（只带本模块用得到的字段）。 */
export interface SpawnOptions {
	/** 子进程环境变量（整表替换，用于给 `instabox` 注入 PATH） */
	env?: Record<string, string>;
}

/** 子进程最小接口：只声明本模块用到的成员，便于注入内存假流。 */
export interface RemoteChild {
	/** 写入端（协议帧一律单行 JSON + `\n`） */
	readonly stdin: { write(chunk: string): unknown } | null;
	/** 读出端（`data` 可能给 Buffer 或 string，分帧器两种都收） */
	readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
	/** 诊断端（只用于把失败原因带进错误文本） */
	readonly stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
	on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	kill?(signal?: string): unknown;
}

/** 注入的 spawn：默认 {@link defaultSpawn}（`node:child_process`），单测一律替换。 */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => RemoteChild;

/** 注入的定时器：默认全局 `setTimeout`/`clearTimeout`，单测用假时钟。 */
export interface RemoteClock {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** 远端工具（`tools/list` 的一项，schema 原样透传，不在本模块转 TypeBox）。 */
export interface RemoteTool {
	name: string;
	description?: string;
	/** 远端 `inputSchema` 原样；远端缺省时给空 object schema，调用方仍能拿到参数骨架 */
	inputSchema: Record<string, unknown>;
}

/** `tools/call` 结果原样（`content`/`isError` 由调用方渲染，本模块不改写）。 */
export interface CallToolResult extends Record<string, unknown> {
	content?: unknown[];
	isError?: boolean;
}

/** `initialize` 结果原样（`serverInfo.version` 进 per-box 模板缓存的版本比对）。 */
export interface InitializeResult extends Record<string, unknown> {
	protocolVersion?: string;
	capabilities?: Record<string, unknown>;
	serverInfo?: { name?: string; version?: string };
}

/** 远端 MCP 客户端（单次连接一实例；失效后由 `pool.ts` 丢弃重建）。 */
export interface RemoteClient {
	/**
	 * 握手（幂等：重复调用共享同一次握手）；返回远端 `initialize` 结果原样。
	 *
	 * `signal` 只作用于**真正发起握手的那一次**调用：握手进行中 abort 会立即 reject
	 * （`code: "aborted"`）并置 dead，不必等 connect/initialize 预算耗尽。
	 */
	initialize(signal?: AbortSignal): Promise<InitializeResult>;
	/** `tools/list`，返回 `{ name, description?, inputSchema }[]` */
	listTools(signal?: AbortSignal): Promise<RemoteTool[]>;
	/** `tools/call`，返回远端结果原样（含 `content`/`isError`） */
	callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
	/** 主动关停：reject 全部 pending、杀子进程、置 dead */
	close(): void;
	/** 连接是否已失效（失效后任何请求立即 rejected，调用方应重建） */
	isDead(): boolean;
}

/** `createRemoteClient` 的入参。 */
export interface RemoteClientOptions {
	/** 要 spawn 的可执行文件（如 `instabox`） */
	command: string;
	/** argv（如 `["ssh", box, "--", "instabox-computer-use", "mcp"]`） */
	args?: readonly string[];
	/** 子进程环境变量（默认继承当前进程） */
	env?: Record<string, string>;
	/** 注入的 spawn，默认 `node:child_process.spawn` */
	spawn?: SpawnFn;
	/** 注入的定时器，默认全局 */
	clock?: RemoteClock;
	/** 注入的时钟（毫秒），只用于错误文本里的耗时描述 */
	now?: () => number;
	/** 覆盖 {@link DEFAULT_TIMEOUTS} 的部分字段 */
	timeouts?: Partial<RemoteTimeouts>;
	/** 诊断回调（坏帧/无法解析的行只在这里报，不 throw） */
	debug?: (message: string) => void;
}

/** 单帧解析完成后的回调。 */
export type FrameHandler = (message: unknown) => void;

/** 无法成帧/无法解析时的回调（`raw` 已截断，仅供排查）。 */
export type BadFrameHandler = (raw: string, error: unknown) => void;

/** `content-length:` 前缀（模式探测用，小写比较）。 */
const CONTENT_LENGTH_PREFIX = "content-length:";

/** 头块无终止符时的容忍上限（超过即判坏帧并重新探测模式）。 */
const HEADER_BLOCK_LIMIT = 65_536;

/** 坏帧/坏行进 debug 文本时的截断长度。 */
const BAD_FRAME_RAW_LIMIT = 200;

/** stderr 尾部保留字符数（失败原因用）。 */
const STDERR_TAIL_CHARS = 2_000;

/** stderr 尾部最多带几行进错误文本。 */
const STDERR_TAIL_LINES = 10;

/**
 * stdio 分帧器：把任意切分的字节流还原成 JSON 帧。
 *
 * - 模式由**首个字节**决定：缓冲以 `content-length:` 开头（大小写不敏感）→ 头帧；
 *   否则出现 `\n` → 行帧。判定前只缓冲，不猜。
 * - 模式锁定后不再回退（同一连接只用一种分帧）。
 * - 半行/半帧留在缓冲里，等下一 chunk 拼接；截断位置可以落在多字节 UTF-8 字符中间
 *   （全程按字节处理，只有成帧后才 decode）。
 * - 坏帧（JSON 解析失败、头块缺 `Content-Length`）只回调 `onBadFrame`，**不中断连接**。
 */
export class StdioFramer {
	private mode: "unknown" | "lines" | "headers" = "unknown";
	private buffer: Buffer = Buffer.alloc(0);
	private readonly onFrame: FrameHandler;
	private readonly onBadFrame: BadFrameHandler | undefined;

	constructor(options: { onFrame: FrameHandler; onBadFrame?: BadFrameHandler }) {
		this.onFrame = options.onFrame;
		this.onBadFrame = options.onBadFrame;
	}

	/** 喂一段字节（string 按 UTF-8 编码）；能成的帧同步回调出去。 */
	push(chunk: string | Uint8Array): void {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
		if (bytes.length === 0) return;
		this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);
		for (;;) {
			if (this.mode === "unknown") {
				const detected = this.detectMode();
				// 字节还不够判定：留缓冲等下一 chunk（"Content-Le" 既可能是头也可能是坏行）
				if (detected === "unknown") return;
				this.mode = detected;
			}
			const frame = this.mode === "headers" ? this.takeHeaderFrame() : this.takeLineFrame();
			if (frame === undefined) return; // 帧不完整
			if (frame === null) continue; // 空行/坏头已丢弃，继续找下一帧
			this.emit(frame);
		}
	}

	/** 连接失效时丢弃在途字节与已探测的模式。 */
	reset(): void {
		this.mode = "unknown";
		this.buffer = Buffer.alloc(0);
	}

	private detectMode(): "unknown" | "lines" | "headers" {
		const headLen = Math.min(this.buffer.length, CONTENT_LENGTH_PREFIX.length);
		const head = this.buffer.toString("latin1", 0, headLen).toLowerCase();
		if (CONTENT_LENGTH_PREFIX.startsWith(head)) {
			return headLen < CONTENT_LENGTH_PREFIX.length ? "unknown" : "headers";
		}
		return this.buffer.includes(0x0a) ? "lines" : "unknown";
	}

	/** 取一行（去掉行尾 `\n` 与可能的 `\r`）；`undefined` 表示帧未完整。 */
	private takeLineFrame(): Buffer | null | undefined {
		const end = this.buffer.indexOf(0x0a);
		if (end < 0) return undefined;
		let line = this.buffer.subarray(0, end);
		this.buffer = this.buffer.subarray(end + 1);
		if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
		return line.length === 0 ? null : line;
	}

	/** 按 `Content-Length` 取一帧；`undefined` 表示头或体还没收全。 */
	private takeHeaderFrame(): Buffer | null | undefined {
		const block = this.headerBlockEnd();
		if (block === undefined) {
			if (this.buffer.length <= HEADER_BLOCK_LIMIT) return undefined;
			const raw = this.buffer.toString("utf8").slice(0, BAD_FRAME_RAW_LIMIT);
			this.reset();
			this.onBadFrame?.(raw, new Error("content-length header block not terminated"));
			return null;
		}
		const headerText = this.buffer.toString("latin1", 0, block.headerEnd);
		const match = /content-length:[ \t]*(\d+)/i.exec(headerText);
		const lengthText = match?.[1];
		if (lengthText === undefined) {
			this.buffer = this.buffer.subarray(block.bodyStart);
			this.onBadFrame?.(headerText.slice(0, BAD_FRAME_RAW_LIMIT), new Error("missing content-length header"));
			return null;
		}
		const length = Number(lengthText);
		if (this.buffer.length - block.bodyStart < length) return undefined;
		const body = this.buffer.subarray(block.bodyStart, block.bodyStart + length);
		this.buffer = this.buffer.subarray(block.bodyStart + length);
		return body.length === 0 ? null : body;
	}

	/** 头块终止位置：`\r\n\r\n` 或 `\n\n` 取更靠前者。 */
	private headerBlockEnd(): { headerEnd: number; bodyStart: number } | undefined {
		const crlf = this.buffer.indexOf("\r\n\r\n");
		const lf = this.buffer.indexOf("\n\n");
		let best: { headerEnd: number; bodyStart: number } | undefined;
		if (crlf >= 0) best = { headerEnd: crlf, bodyStart: crlf + 4 };
		if (lf >= 0 && (best === undefined || lf < best.headerEnd)) best = { headerEnd: lf, bodyStart: lf + 2 };
		return best;
	}

	private emit(body: Buffer): void {
		const text = body.toString("utf8").trim();
		if (text === "") return;
		let message: unknown;
		try {
			message = JSON.parse(text);
		} catch (error) {
			this.onBadFrame?.(text.slice(0, BAD_FRAME_RAW_LIMIT), error);
			return;
		}
		this.onFrame(message);
	}
}

/** 一次在途请求（`id` 只用于 map 键，`method` 只用于错误文本）。 */
interface PendingRequest {
	readonly method: string;
	readonly timer: unknown;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: () => void;
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: RemoteError) => void;
}

/** 默认 spawn：`node:child_process`，三根管道全开（唯一需要类型断言的地方）。 */
const defaultSpawn: SpawnFn = (command, args, options) =>
	nodeSpawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env: options.env }) as unknown as RemoteChild;

/** 默认定时器：走全局，宿主/单测都可整体替换。 */
const defaultClock: RemoteClock = {
	setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
	clearTimeout: (handle) => {
		globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
	},
};

/** `unknown` → message 文本（错误文本里不出现 `[object Object]`）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 宽松对象判定（远端结果一律先过这里再取字段）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 远端缺 `inputSchema` 时的空骨架（每次新建，避免调用方改到共享对象）。 */
function emptyInputSchema(): Record<string, unknown> {
	return { type: "object", properties: {} };
}

/** `tools/list` 数组 → {@link RemoteTool}[]（坏条目静默跳过，缺 schema 给空骨架）。 */
function toRemoteTools(entries: readonly unknown[]): RemoteTool[] {
	const tools: RemoteTool[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const name = entry["name"];
		if (typeof name !== "string" || name === "") continue;
		const description = entry["description"];
		const inputSchema = entry["inputSchema"];
		tools.push({
			name,
			description: typeof description === "string" ? description : undefined,
			inputSchema: isRecord(inputSchema) ? inputSchema : emptyInputSchema(),
		});
	}
	return tools;
}

/** JSON-RPC 错误响应 → {@link RemoteError}（只影响该请求，不置 dead）。 */
function rpcError(method: string, error: unknown): RemoteError {
	if (!isRecord(error)) return new RemoteError(`${method} failed: ${String(error)}`, "rpc");
	const code = error["code"];
	const message = error["message"];
	const detail = typeof message === "string" ? message : "unknown error";
	const label = typeof code === "number" ? `code ${code}: ` : "";
	return new RemoteError(`${method} failed: ${label}${detail}`, "rpc");
}

/**
 * 远端 stdio MCP 客户端实现。
 *
 * 状态机只有三态：未 spawn → 已 spawn（握手/可用）→ dead（终态，**不自动重连**，
 * 重连由 `pool.ts` 重建实例完成）。
 */
class RemoteStdioClient implements RemoteClient {
	private readonly spawnFn: SpawnFn;
	private readonly command: string;
	private readonly args: readonly string[];
	private readonly env: Record<string, string> | undefined;
	private readonly clock: RemoteClock;
	private readonly now: () => number;
	private readonly timeouts: RemoteTimeouts;
	private readonly debug: ((message: string) => void) | undefined;
	private readonly framer: StdioFramer;
	private readonly pending = new Map<number, PendingRequest>();
	private child: RemoteChild | undefined;
	private exited = false;
	private dead = false;
	private nextId = 1;
	private connectTimer: unknown;
	private stderrTail = "";
	private handshake: Promise<InitializeResult> | undefined;

	constructor(options: RemoteClientOptions) {
		this.spawnFn = options.spawn ?? defaultSpawn;
		this.command = options.command;
		this.args = options.args ?? [];
		this.env = options.env;
		this.clock = options.clock ?? defaultClock;
		this.now = options.now ?? Date.now;
		this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
		this.debug = options.debug;
		this.framer = new StdioFramer({
			onFrame: (message) => this.onFrame(message),
			onBadFrame: (raw, error) => this.debug?.(`discarding malformed MCP frame (${messageOf(error)}): ${raw}`),
		});
	}

	initialize(signal?: AbortSignal): Promise<InitializeResult> {
		// 首次调用决定握手的 signal；并发调用共享同一个 Promise（幂等）
		this.handshake ??= this.runHandshake(signal);
		return this.handshake;
	}

	async listTools(signal?: AbortSignal): Promise<RemoteTool[]> {
		await this.initialize(signal);
		const result = await this.request("tools/list", {}, this.timeouts.listTools, signal);
		if (!isRecord(result) || !Array.isArray(result["tools"])) {
			throw this.protocolFailure("tools/list returned no tools array");
		}
		return toRemoteTools(result["tools"]);
	}

	async callTool(
		name: string,
		args: Record<string, unknown> = {},
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		await this.initialize(signal);
		const result = await this.request("tools/call", { name, arguments: args }, this.timeouts.callTool, signal);
		if (!isRecord(result)) throw this.protocolFailure(`tools/call ${name} returned a non-object result`);
		return result as CallToolResult;
	}

	close(): void {
		this.failAll(new RemoteError("remote client closed by caller", "closed"));
	}

	isDead(): boolean {
		return this.dead;
	}

	/**
	 * 握手：spawn → `initialize`（带自身预算）→ `notifications/initialized`（无 id）。
	 * `signal` 透传给 `initialize` 请求：建连/握手期 abort 也能立即中断。
	 */
	private async runHandshake(signal?: AbortSignal): Promise<InitializeResult> {
		if (this.dead) throw this.refuseDead("initialize");
		try {
			this.startChild();
			const result = await this.request(
				"initialize",
				{ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { ...CLIENT_INFO } },
				this.timeouts.initialize,
				signal,
			);
			if (!isRecord(result)) throw this.protocolFailure("initialize returned a non-object result");
			this.notify("notifications/initialized", {});
			return result as InitializeResult;
		} catch (error) {
			const remoteError = error instanceof RemoteError ? error : new RemoteError(messageOf(error), "protocol");
			// 握手失败即整条连接不可用：标记 dead，让 pool 下次重建
			this.failAll(remoteError);
			throw remoteError;
		}
	}

	/** 建子进程并挂上三个事件源；同时臂化 connect 预算。 */
	private startChild(): void {
		if (this.child !== undefined) return;
		let child: RemoteChild;
		try {
			child = this.spawnFn(this.command, this.args, this.env === undefined ? {} : { env: this.env });
		} catch (error) {
			const spawnError = new RemoteError(`failed to spawn ${this.command}: ${messageOf(error)}`, "spawn");
			this.failAll(spawnError);
			throw spawnError;
		}
		// 先登记再校验管道：无管道的子进程也归 `failAll` → `terminate` 收尾（kill），不泄漏
		this.child = child;
		if (child.stdin === null || child.stdout === null) {
			const pipeError = new RemoteError(`spawned ${this.command} without stdio pipes`, "spawn");
			this.failAll(pipeError);
			throw pipeError;
		}
		child.stdout.on("data", (chunk) => this.onStdout(chunk));
		child.stderr?.on("data", (chunk) => this.appendStderr(chunk));
		child.on("close", (code, signal) => this.onChildClose(code, signal));
		child.on("error", (error) => this.onChildError(error));
		this.connectTimer = this.clock.setTimeout(() => {
			this.failAll(
				new RemoteError(
					`remote process produced no output within ${this.timeouts.connect}ms (command: ${this.command})${this.stderrSummary()}`,
					"timeout",
				),
			);
		}, this.timeouts.connect);
	}

	private onStdout(chunk: Buffer | string): void {
		if (this.dead) return;
		this.clearConnectTimer();
		this.framer.push(chunk);
	}

	private onChildClose(code: number | null, signal: string | null): void {
		this.exited = true;
		if (this.dead) return;
		const detail = signal === null ? `code=${code === null ? "none" : code}` : `code=${code === null ? "none" : code}, signal=${signal}`;
		this.failAll(new RemoteError(`remote process closed (${detail})${this.stderrSummary()}`, "closed"));
	}

	private onChildError(error: Error): void {
		this.exited = true;
		if (this.dead) return;
		this.failAll(new RemoteError(`remote process error: ${error.message}`, "spawn"));
	}

	private appendStderr(chunk: Buffer | string): void {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
	}

	private stderrSummary(): string {
		const tail = this.stderrTail.trim();
		if (tail === "") return "";
		const lines = tail.split("\n").slice(-STDERR_TAIL_LINES);
		return `; stderr: ${lines.join(" | ")}`;
	}

	/** 入站消息分流：带 number id → 请求表；其余（`notifications/*`、`$/…`、未知方法）静默丢弃。 */
	private onFrame(message: unknown): void {
		if (this.dead) return;
		if (!isRecord(message)) {
			this.debug?.("ignoring non-object MCP message");
			return;
		}
		const id = message["id"];
		if (typeof id !== "number") return;
		const pending = this.pending.get(id);
		if (pending === undefined) return; // 已超时/未知 id：丢弃
		const error = message["error"];
		if (error !== undefined && error !== null) {
			this.settle(id, pending);
			pending.reject(rpcError(pending.method, error));
			return;
		}
		this.settle(id, pending);
		pending.resolve(message["result"]);
	}

	/** 发请求：登记 pending + 预算 + abort 监听，然后写帧。 */
	private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (this.dead) return Promise.reject(this.refuseDead(method));
		if (signal?.aborted === true) {
			const aborted = new RemoteError(`${method} aborted by caller`, "aborted");
			this.failAll(aborted);
			return Promise.reject(aborted);
		}
		return new Promise<unknown>((resolve, reject) => {
			const id = this.nextId++;
			const startedAt = this.now();
			const onAbort = (): void => {
				this.failAll(new RemoteError(`${method} aborted by caller`, "aborted"));
			};
			const timer = this.clock.setTimeout(() => {
				const elapsed = this.now() - startedAt;
				this.failAll(new RemoteError(`${method} timed out after ${elapsed}ms (limit ${timeoutMs}ms)`, "timeout"));
			}, timeoutMs);
			this.pending.set(id, { method, timer, signal, onAbort, resolve, reject });
			signal?.addEventListener("abort", onAbort, { once: true });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** 发通知（无 id，双工流里不等回执）。 */
	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	/** 写一帧（单行 JSON + `\n`）；写失败即连接不可用。 */
	private write(message: unknown): void {
		const stdin = this.child?.stdin;
		if (stdin === null || stdin === undefined) {
			this.failAll(new RemoteError("remote process stdin is unavailable", "closed"));
			return;
		}
		try {
			stdin.write(`${JSON.stringify(message)}\n`);
		} catch (error) {
			this.failAll(new RemoteError(`failed to write to remote process: ${messageOf(error)}`, "closed"));
		}
	}

	/** 摘除 pending 的预算与 abort 监听（resolve/reject 前必调）。 */
	private settle(id: number, pending: PendingRequest): void {
		this.pending.delete(id);
		this.clock.clearTimeout(pending.timer);
		pending.signal?.removeEventListener("abort", pending.onAbort);
	}

	/** 终态迁移：reject 全部 pending、清缓冲、杀子进程（幂等）。 */
	private failAll(error: RemoteError): void {
		if (this.dead) return;
		this.dead = true;
		this.clearConnectTimer();
		this.framer.reset();
		const entries = [...this.pending.values()];
		this.pending.clear();
		for (const pending of entries) {
			this.clock.clearTimeout(pending.timer);
			pending.signal?.removeEventListener("abort", pending.onAbort);
			pending.reject(error);
		}
		this.terminate();
	}

	private terminate(): void {
		const child = this.child;
		this.child = undefined;
		if (child === undefined || this.exited) return;
		try {
			child.kill?.();
		} catch {
			// kill 是尽力而为：子进程可能已退出
		}
	}

	private clearConnectTimer(): void {
		if (this.connectTimer === undefined) return;
		this.clock.clearTimeout(this.connectTimer);
		this.connectTimer = undefined;
	}

	/** 协议违约（结构不符）也意味着连接状态不可信：一并置 dead。 */
	private protocolFailure(message: string): RemoteError {
		const error = new RemoteError(message, "protocol");
		this.failAll(error);
		return error;
	}

	private refuseDead(method: string): RemoteError {
		return new RemoteError(`${method} refused: remote client is dead`, "closed");
	}
}

/** 建一个远端 stdio MCP 客户端（单次连接一实例，失效后由调用方重建）。 */
export function createRemoteClient(options: RemoteClientOptions): RemoteClient {
	return new RemoteStdioClient(options);
}
