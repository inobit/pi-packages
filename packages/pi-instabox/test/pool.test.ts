/**
 * @inobit/pi-instabox — `src/pool.ts` 单测：先看状态（`ls --json`）、非 `running` 才 `wake` →
 * `start` → `resume` 且每步之后确认 `running`、`is cooling down until` 不可自愈、`is waking up`
 * 退避重连、`allowWake: false` 零唤醒、复用 / dead 重建 / 握手失败驱逐、in-flight 共享（含
 * 「不唤醒」结论不劫持唤醒调用）、`dispose`（含建连期间 dispose）。
 *
 * 全部走注入的假 `ExecFn` / 假 `listBoxes` / 假 `sleep` / 假客户端：不 spawn 真进程、
 * 不联网、不等真实时间、不碰真箱。
 */

import { describe, expect, it } from "vitest";
import { type BoxInfo, type ListBoxesResult, createBoxLister } from "../src/boxes.ts";
import type { ExecFn, ExecResultLike } from "../src/cli.ts";
import type { InstaboxTimeouts } from "../src/config.ts";
import { createMemoryLogger, setLogger } from "../src/log.ts";
import {
	type ListBoxesFn,
	type Pool,
	type PoolDeps,
	WAKE_POLL_INTERVAL_MS,
	WAKE_RETRY_DELAYS_MS,
	createPool,
} from "../src/pool.ts";
import type { CallToolResult, InitializeResult, RemoteClient, RemoteTool } from "../src/remote.ts";

/** 与 `DEFAULT_CONFIG.timeouts` 故意取不同值：断言预算来自注入的 `timeouts`，不是内置默认。 */
const TIMEOUTS: InstaboxTimeouts = {
	wakeMs: 5_000,
	startMs: 9_000,
	connectMs: 1_500,
	initializeMs: 2_000,
	listToolsMs: 2_500,
	callMs: 12_000,
};

/** 假客户端的构造选项。 */
interface FakeClientOptions {
	/** 握手时抛的错误（`undefined` = 握手成功） */
	handshakeError?: Error;
	/** `close()` 抛异常（断言 `dispose` 不抛） */
	throwOnClose?: boolean;
	/** 握手挂起，直到测试调用 `settleHandshake()`（建连期间 dispose 用） */
	deferHandshake?: boolean;
}

/** 假客户端：记录 `initialize`/`close` 次数，握手结果在构造时固定，`dead` 由测试手动翻转。 */
class FakeClient implements RemoteClient {
	/** 该客户端服务的 box（工厂入参，仅用于排查） */
	readonly name: string;
	dead = false;
	closed = 0;
	initializeCalls = 0;
	/** `initialize` 收到的 signal（断言透传） */
	readonly signals: (AbortSignal | undefined)[] = [];
	private readonly handshakeError: Error | undefined;
	private readonly throwOnClose: boolean;
	private readonly handshake: { promise: Promise<void>; settle: () => void } | undefined;

	constructor(name: string, options: FakeClientOptions) {
		this.name = name;
		this.handshakeError = options.handshakeError;
		this.throwOnClose = options.throwOnClose === true;
		if (options.deferHandshake === true) {
			let settle = (): void => {};
			const promise = new Promise<void>((resolve) => {
				settle = () => resolve();
			});
			this.handshake = { promise, settle };
		}
	}

	async initialize(signal?: AbortSignal): Promise<InitializeResult> {
		this.initializeCalls += 1;
		this.signals.push(signal);
		// 与 `remote.ts` 一致：已 abort 的连接不会真去建链，立刻 reject
		if (signal?.aborted === true) throw new Error("initialize aborted by caller");
		if (this.handshake !== undefined) await this.handshake.promise;
		if (this.handshakeError !== undefined) throw this.handshakeError;
		return { serverInfo: { name: "instabox-computer-use", version: "0.3.6-instabox.1" } };
	}

	async listTools(): Promise<RemoteTool[]> {
		return [];
	}

	async callTool(): Promise<CallToolResult> {
		return { content: [] };
	}

	close(): void {
		this.closed += 1;
		this.dead = true;
		if (this.throwOnClose) throw new Error("close exploded");
	}

	isDead(): boolean {
		return this.dead;
	}

	/** 放行挂起的握手（`deferHandshake` 模式） */
	settleHandshake(): void {
		this.handshake?.settle();
	}
}

/** 一次 CLI 调用（唤醒链只看 `instabox <subcommand> <box>`）。 */
interface ExecCall {
	command: string;
	args: string[];
	timeout: number | undefined;
	signal: AbortSignal | undefined;
}

/** 成功结果（exit 0、无 stderr）。 */
function execOk(): ExecResultLike {
	return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
}

/** 失败结果（非 0 退出 + stderr 尾部）。 */
function execFail(stderr: string): ExecResultLike {
	return { stdout: "", stderr, code: 1, killed: false, truncated: false };
}

/**
 * CLI 自报失败的形态：**退出码 0** + stderr 带错误（实测 `instabox wake` 对用户手动暂停的箱）。
 * `cli.ts` 会按 stderr 判失败，因此这里必须与 `execOk()` 区分开。
 */
function execReported(stderr: string): ExecResultLike {
	return { stdout: "", stderr, code: 0, killed: false, truncated: false };
}

/** 用户手动暂停/停止的箱在 `wake` 上的真实 stderr（`machine_not_running` + `start it with`）。 */
function wakeRefused(name: string): string {
	return `instabox: error machine_not_running: machine is suspended; start it first [request id]\nhint: start it with \`instabox start ${name}\``;
}

/** `BoxInfo` 工厂：只填本模块消费的 4 个字段。 */
function box(name: string, state: string, desiredState: string): BoxInfo {
	return { name, state, desiredState, templateId: "agent-browser", templateVersion: "2026-10-25.23" };
}

function running(name: string): BoxInfo {
	return box(name, "running", "running");
}

function suspended(name: string): BoxInfo {
	return box(name, "suspended", "suspended");
}

/** CLI `requireRunning` 对「非 running 且没有 autoSuspendAt」的真实文案（ssh/exec 同款）。 */
function pausedError(name: string): Error {
	return new Error(`sandbox ${name} is paused; run 'instabox start ${name}'`);
}

/** SSH 网关只等 15s 后的可重试错误（真实形态）。 */
function wakingUpError(name: string): Error {
	return new Error(`machine ${name} is waking up; try again in a few seconds`);
}

/** 改某台箱的 `state`（模拟唤醒后真的跑起来了）。 */
function withState(boxes: readonly BoxInfo[], name: string, state: string): BoxInfo[] {
	return boxes.map((entry) => (entry.name === name ? { ...entry, state } : entry));
}

/** 唤醒链的脚本：按子命令决定 CLI 结果（缺省成功）。 */
type ExecReply = (args: readonly string[]) => ExecResultLike;

/** 建连脚本：`attempt` 是该 box 的第几次 `initialize`（0 起）；返回错误即握手失败。 */
type ConnectReply = (box: string, attempt: number) => Error | undefined;

interface SetupOptions {
	boxes?: BoxInfo[];
	reply?: ExecReply;
	connect?: ConnectReply;
	throwOnClose?: boolean;
	deferHandshake?: boolean;
	/** 唤醒命令成功后，前 N 次**强制**查询仍报旧状态（模拟「命令返回了但箱子还在启动」） */
	awakeDelayPolls?: number;
	/** 唤醒命令成功后箱状态永不变化（模拟「怎么都起不来」） */
	staysAsleep?: boolean;
	/** 每次 `sleep` 都挂起，直到测试调用 `releaseSleep()`（断言轮询中途的行为） */
	deferSleep?: boolean;
	/** 覆盖任意注入项（如 `listBoxes`） */
	deps?: Partial<PoolDeps>;
}

interface Setup {
	pool: Pool;
	/** `clientFactory` 每次新建的假客户端（按顺序） */
	created: FakeClient[];
	/** 唤醒链的 CLI 调用 */
	execCalls: ExecCall[];
	/** 进度回调收到的消息 */
	progress: string[];
	/** 每次 `sleep` 的毫秒数（确认轮询的 1s 间隔 / 网关退避） */
	sleeps: number[];
	listCalls(): number;
	/** 带 `force: true` 的 `listBoxes` 次数（状态查询 + 确认轮询） */
	forcedListCalls(): number;
	/** 放行一次挂起的 `sleep`（配合 `deferSleep`） */
	releaseSleep(): void;
}

/**
 * 组装一个全注入的池：默认一台 `running` 的 `agent` 箱、CLI 恒成功、连接恒成功。
 *
 * 假 `ls` 会模拟真实的时延语义：**唤醒命令真正成功**（退出码 0 且 stderr 无错误）后，箱状态要经过
 * `awakeDelayPolls` 次**强制**查询才变成 `running`（默认 0 次，即命令返回时已经好了）；
 * `staysAsleep` 则永不变化。假 `sleep` 只推进假时钟，绝不占用真实时间。
 */
function setup(options: SetupOptions = {}): Setup {
	let boxes = options.boxes ?? [running("agent")];
	let pendingAwake: { box: string; pollsLeft: number } | undefined;
	let listCalls = 0;
	let forcedListCalls = 0;
	let nowMs = 0;
	const created: FakeClient[] = [];
	const execCalls: ExecCall[] = [];
	const progress: string[] = [];
	const sleeps: number[] = [];
	const sleepReleases: (() => void)[] = [];
	const attempts = new Map<string, number>();
	const reply = options.reply ?? (() => execOk());
	const connect = options.connect ?? (() => undefined);

	const listBoxes: ListBoxesFn = async (opts) => {
		listCalls += 1;
		if (opts?.force === true) {
			forcedListCalls += 1;
			if (pendingAwake !== undefined) {
				if (pendingAwake.pollsLeft > 0) pendingAwake.pollsLeft -= 1;
				else {
					boxes = withState(boxes, pendingAwake.box, "running");
					pendingAwake = undefined;
				}
			}
		}
		return { ok: true, boxes };
	};

	const exec: ExecFn = async (command, args, opts) => {
		execCalls.push({ command, args: [...args], timeout: opts?.timeout, signal: opts?.signal });
		const result = reply(args);
		const subcommand = args[0] ?? "";
		const target = args[1] ?? "";
		const isLifecycle = subcommand === "wake" || subcommand === "start" || subcommand === "resume";
		// 「命令真的生效」= 退出码 0 且没有 CLI 自报错误（stderr 带错误即失败，见 `execReported`）
		const effective = result.code === 0 && result.stderr.trim() === "";
		if (effective && isLifecycle && target !== "" && options.staysAsleep !== true) {
			pendingAwake = { box: target, pollsLeft: options.awakeDelayPolls ?? 0 };
		}
		return result;
	};

	const pool = createPool({
		exec,
		listBoxes,
		timeouts: TIMEOUTS,
		clientFactory: (name) => {
			const attempt = attempts.get(name) ?? 0;
			attempts.set(name, attempt + 1);
			const client = new FakeClient(name, {
				handshakeError: connect(name, attempt),
				throwOnClose: options.throwOnClose === true,
				deferHandshake: options.deferHandshake === true,
			});
			created.push(client);
			return client;
		},
		clock: () => nowMs,
		sleep: async (ms) => {
			sleeps.push(ms);
			nowMs += ms;
			if (options.deferSleep === true) {
				await new Promise<void>((resolve) => sleepReleases.push(resolve));
			}
		},
		onProgress: (message) => progress.push(message),
		...options.deps,
	});
	return {
		pool,
		created,
		execCalls,
		progress,
		sleeps,
		listCalls: () => listCalls,
		forcedListCalls: () => forcedListCalls,
		releaseSleep: () => sleepReleases.shift()?.(),
	};
}

/** 取第一次 `get` 的客户端（`ok: false` 时直接炸，避免测试里出现非空断言）。 */
function clientOf(result: Awaited<ReturnType<Pool["get"]>>): FakeClient {
	if (!result.ok) throw new Error(`expected ok result, got error: ${result.error}`);
	expect(result.client).toBeInstanceOf(FakeClient);
	return result.client as FakeClient;
}

/** 失败结果的 `error`（`ok: true` 时直接炸）。 */
function errorOf(result: Awaited<ReturnType<Pool["get"]>>): string {
	if (result.ok) throw new Error("expected a failed result");
	return result.error;
}

/** 唤醒链里执行过的子命令序列（如 `["wake", "start"]`）。 */
function commands(calls: readonly ExecCall[]): string[] {
	return calls.map((call) => call.args[0] ?? "");
}

/** 跑完当前已排队的微任务（等挂起的握手/建连推进到下一步），不推进真实时间。 */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("createPool.get — 先看状态（`ls --json`）", () => {
	it("running 箱：直接建连，零 CLI 调用", async () => {
		const h = setup({ boxes: [running("agent")] });

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(true);
		expect(clientOf(result).initializeCalls).toBe(1);
		expect(h.execCalls).toHaveLength(0);
		expect(h.progress).toHaveLength(0);
		expect(h.listCalls()).toBe(1);
		expect(h.forcedListCalls()).toBe(1);
		expect(h.sleeps).toHaveLength(0);
		expect(h.pool.size()).toBe(1);
	});

	it("ls 返回失败：不唤醒、不建客户端", async () => {
		const h = setup({
			deps: {
				listBoxes: async (): Promise<ListBoxesResult> => ({ ok: false, boxes: [], error: "instabox ls exited with code 127" }),
			},
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain("cannot list boxes: instabox ls exited with code 127");
		expect(h.execCalls).toHaveLength(0);
		expect(h.created).toHaveLength(0);
	});

	it("ls 抛异常：收成 ok:false，不外抛", async () => {
		const h = setup({
			deps: {
				listBoxes: async () => {
					throw new Error("boom");
				},
			},
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain("cannot list boxes: boom");
	});

	it("ls 没有任何箱：错误里明确说明，且不唤醒", async () => {
		const h = setup({ boxes: [] });

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain('unknown box "agent"');
		expect(errorOf(result)).toContain("instabox ls returned no boxes");
		expect(h.execCalls).toHaveLength(0);
	});

	it("箱名不存在：错误里带候选名单", async () => {
		const h = setup({ boxes: [running("agent"), running("libretv")] });

		const result = await h.pool.get("nope");

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain('unknown box "nope"');
		expect(errorOf(result)).toContain("available boxes: agent, libretv");
		expect(h.execCalls).toHaveLength(0);
	});
});

describe("createPool.get — 非 running：wake → start → resume，每步确认 running", () => {
	it("suspended（自动暂停）→ wake 成功 → 确认 running → 建连（预算 wakeMs）", async () => {
		const h = setup({ boxes: [suspended("agent")] });

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(true);
		expect(commands(h.execCalls)).toEqual(["wake"]);
		expect(h.execCalls[0]?.args).toEqual(["wake", "agent"]);
		expect(h.execCalls[0]?.timeout).toBe(TIMEOUTS.wakeMs);
		expect(h.progress).toEqual(["正在唤醒 agent…"]);
		// 一次状态查询 + 一次确认（命令返回时已经 running，不睡）
		expect(h.forcedListCalls()).toBe(2);
		expect(h.sleeps).toHaveLength(0);
		expect(clientOf(result).initializeCalls).toBe(1);
		expect(h.pool.size()).toBe(1);
	});

	it("wake 报 machine_not_running（退出码 0 + stderr）→ start 成功（预算 startMs）", async () => {
		const h = setup({
			boxes: [suspended("agent")],
			reply: (args) => (args[0] === "wake" ? execReported(wakeRefused("agent")) : execOk()),
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(true);
		expect(commands(h.execCalls)).toEqual(["wake", "start"]);
		expect(h.execCalls[1]?.args).toEqual(["start", "agent"]);
		expect(h.execCalls[1]?.timeout).toBe(TIMEOUTS.startMs);
		expect(h.progress).toEqual(["正在唤醒 agent…", "正在唤醒 agent…"]);
		// 状态查询 + wake 失败后的即时采样 + start 成功后的一次确认（已经 running）
		expect(h.sleeps).toHaveLength(0);
		expect(h.forcedListCalls()).toBe(3);
		expect(h.created).toHaveLength(1);
		expect(h.pool.size()).toBe(1);
	});

	it("start 也失败 → resume（预算 startMs）", async () => {
		const h = setup({
			boxes: [suspended("agent")],
			reply: (args) =>
				args[0] === "wake"
					? execReported(wakeRefused("agent"))
					: args[0] === "start"
						? execFail("instabox: error machine_not_running: machine is suspended; start it first")
						: execOk(),
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(true);
		expect(commands(h.execCalls)).toEqual(["wake", "start", "resume"]);
		expect(h.execCalls[2]?.timeout).toBe(TIMEOUTS.startMs);
		expect(h.created).toHaveLength(1);
	});

	it("命令退出 0 但还没 running：1s 轮询到 running 才建连", async () => {
		const h = setup({ boxes: [suspended("agent")], awakeDelayPolls: 1 });

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(true);
		// 状态查询 1 次 + 确认 2 次（第一次仍 suspended、第二次 running）
		expect(h.forcedListCalls()).toBe(3);
		expect(h.sleeps).toEqual([WAKE_POLL_INTERVAL_MS]);
		expect(clientOf(result).initializeCalls).toBe(1);
	});

	it("三步全失败（stderr 自报 + 确认超时）：错误聚合，不建客户端", async () => {
		const h = setup({
			boxes: [suspended("agent")],
			staysAsleep: true,
			reply: (args) =>
				args[0] === "wake"
					? execReported(wakeRefused("agent"))
					: execFail(`instabox ${String(args[0])} ${String(args[1])} exited with code 1: refused`),
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		const error = errorOf(result);
		expect(error).toContain('could not wake box "agent"');
		expect(error).toContain("machine_not_running");
		expect(error).toContain("instabox start agent exited with code 1: refused");
		expect(error).toContain("instabox resume agent exited with code 1: refused");
		// 三条命令都失败 → 各自的确认只是一次即时采样，不空等整步预算
		expect(h.sleeps).toHaveLength(0);
		expect(h.created).toHaveLength(0);
		expect(h.pool.size()).toBe(0);
	});

	it("冷却期（`is cooling down until <RFC3339>`）：不换命令、不重试，保留原文时间", async () => {
		const h = setup({
			boxes: [suspended("agent")],
			reply: () =>
				execReported(
					"instabox: error machine_cooldown: sandbox agent is cooling down until 2026-11-09T16:00:00Z; try again after cooldown",
				),
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		const error = errorOf(result);
		expect(error).toContain("is cooling down");
		expect(error).toContain("sandbox agent is cooling down until 2026-11-09T16:00:00Z; try again after cooldown");
		expect(commands(h.execCalls)).toEqual(["wake"]);
		expect(h.sleeps).toHaveLength(0);
		expect(h.created).toHaveLength(0);
		expect(h.pool.size()).toBe(0);
	});

	it("冷却期错误里另带 retryAfterSeconds：原样透出", async () => {
		const h = setup({
			boxes: [suspended("agent")],
			reply: () =>
				execReported(
					'instabox: error machine_cooldown: sandbox agent is cooling down until 2026-11-09T16:00:00Z; try again after cooldown; stderr: {"retryAfterSeconds":42}',
				),
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain("retryAfterSeconds=42");
		expect(commands(h.execCalls)).toEqual(["wake"]);
		expect(h.created).toHaveLength(0);
	});

	it("`signal` 透传给唤醒命令，也透传给 initialize", async () => {
		const controller = new AbortController();
		const h = setup({ boxes: [suspended("agent")] });

		const result = await h.pool.get("agent", { signal: controller.signal });

		expect(result.ok).toBe(true);
		expect(h.execCalls[0]?.signal).toBe(controller.signal);
		expect(clientOf(result).signals[0]).toBe(controller.signal);
	});

	it("已 abort：一个唤醒命令都不跑、也不建客户端", async () => {
		const controller = new AbortController();
		controller.abort();
		const h = setup({ boxes: [suspended("agent")] });

		const result = await h.pool.get("agent", { signal: controller.signal });

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain("cancelled by caller");
		expect(h.execCalls).toHaveLength(0);
		expect(h.created).toHaveLength(0);
	});

	it("单次 get 的 onProgress 覆盖池级回调", async () => {
		const messages: string[] = [];
		const h = setup({ boxes: [suspended("agent")] });

		await h.pool.get("agent", { onProgress: (message) => messages.push(message) });

		expect(messages).toEqual(["正在唤醒 agent…"]);
		expect(h.progress).toHaveLength(0);
	});

	it("确认阶段 ls 失败：把失败带进错误文本，不静默成功", async () => {
		let listCalls = 0;
		const h = setup({
			boxes: [suspended("agent")],
			reply: (args) => (args[0] === "wake" ? execOk() : execFail("refused")),
			deps: {
				listBoxes: async (): Promise<ListBoxesResult> => {
					listCalls += 1;
					// 第一次（状态查询）正常，之后（确认阶段）失败
					if (listCalls === 1) return { ok: true, boxes: [suspended("agent")] };
					return { ok: false, boxes: [], error: "instabox ls exited with code 127" };
				},
			},
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain("cannot list boxes: instabox ls exited with code 127");
		expect(h.created).toHaveLength(0);
	});

	it("确认阶段被 abort：下一次轮询立刻报取消，不再等预算耗尽", async () => {
		const controller = new AbortController();
		const h = setup({ boxes: [suspended("agent")], staysAsleep: true, deferSleep: true });

		const pending = h.pool.get("agent", { signal: controller.signal });
		await flush();
		expect(h.sleeps).toEqual([WAKE_POLL_INTERVAL_MS]);

		controller.abort();
		h.releaseSleep();
		const result = await pending;

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain("cancelled by caller");
		expect(h.sleeps).toHaveLength(1);
	});
});

describe("createPool.get — allowWake=false（session_start 路径）", () => {
	it("suspended：零 wake/start/resume，直接报错并给补救命令", async () => {
		const h = setup({ boxes: [suspended("libretv")] });

		const result = await h.pool.get("libretv", { allowWake: false });

		expect(result.ok).toBe(false);
		const error = errorOf(result);
		expect(error).toContain('is "suspended", not running');
		expect(error).toContain("/instabox-use libretv");
		expect(h.execCalls).toHaveLength(0);
		expect(h.progress).toHaveLength(0);
		expect(h.created).toHaveLength(0);
		expect(h.pool.size()).toBe(0);
	});

	it("未知态（state 为空串）：同样零唤醒并报错", async () => {
		const h = setup({ boxes: [box("agent", "", "running")] });

		const result = await h.pool.get("agent", { allowWake: false });

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain("is unknown, not running");
		expect(h.execCalls).toHaveLength(0);
	});

	it("running 箱：照常建连，零唤醒", async () => {
		const h = setup({ boxes: [running("agent")] });

		const result = await h.pool.get("agent", { allowWake: false });

		expect(result.ok).toBe(true);
		expect(h.execCalls).toHaveLength(0);
		expect(h.pool.size()).toBe(1);
	});

	it("后台路径的 in-flight「不唤醒」结论不劫持允许唤醒的调用（后者自己重跑）", async () => {
		const h = setup({ boxes: [suspended("agent")] });

		const background = h.pool.get("agent", { allowWake: false });
		const tool = h.pool.get("agent");
		const [bgResult, toolResult] = await Promise.all([background, tool]);

		expect(bgResult.ok).toBe(false);
		expect(toolResult.ok).toBe(true);
		expect(commands(h.execCalls)).toEqual(["wake"]);
		expect(h.created).toHaveLength(1);
		expect(h.pool.size()).toBe(1);
	});
});

describe("createPool.get — 建连层的兜底分类", () => {
	it("状态 running 但网关报 is waking up：退避重试后成功（不 start）", async () => {
		const h = setup({
			boxes: [running("agent")],
			connect: (name, attempt) => (attempt < 2 ? wakingUpError(name) : undefined),
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(true);
		expect(h.sleeps).toEqual([WAKE_RETRY_DELAYS_MS[0], WAKE_RETRY_DELAYS_MS[1]]);
		expect(h.created).toHaveLength(3);
		expect(h.execCalls).toHaveLength(0);
		expect(h.progress).toHaveLength(0);
		expect(h.pool.size()).toBe(1);
	});

	it("is waking up 耗尽：报错且未 start", async () => {
		const h = setup({ boxes: [running("agent")], connect: (name) => wakingUpError(name) });

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		const error = errorOf(result);
		expect(error).toContain("did not finish waking up after 3 connection retries");
		expect(error).toContain("is waking up; try again in a few seconds");
		expect(h.sleeps).toEqual([...WAKE_RETRY_DELAYS_MS]);
		expect(h.created).toHaveLength(WAKE_RETRY_DELAYS_MS.length + 1);
		expect(h.execCalls).toHaveLength(0);
		expect(h.pool.size()).toBe(0);
	});

	it("建连报 cooldown：不重试、不 start，原样透出", async () => {
		const h = setup({
			boxes: [running("agent")],
			connect: () => new Error("sandbox agent is cooling down until 2026-11-09T16:00:00Z; try again after cooldown"),
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		const error = errorOf(result);
		expect(error).toContain("is cooling down");
		expect(error).toContain("2026-11-09T16:00:00Z");
		expect(h.sleeps).toHaveLength(0);
		expect(h.execCalls).toHaveLength(0);
		expect(h.created).toHaveLength(1);
	});

	it("状态 running 但建连报 paused（状态与网关不同步）：不 start，原样报握手失败", async () => {
		const h = setup({ boxes: [running("agent")], connect: (name) => pausedError(name) });

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain("remote MCP handshake failed: sandbox agent is paused");
		expect(h.execCalls).toHaveLength(0);
		expect(h.sleeps).toHaveLength(0);
		expect(h.created).toHaveLength(1);
	});

	it("认证失败：报握手失败，不 start，也不退避", async () => {
		const h = setup({ boxes: [running("agent")], connect: () => new Error("ssh: authentication failed") });

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain("remote MCP handshake failed: ssh: authentication failed");
		expect(h.execCalls).toHaveLength(0);
		expect(h.sleeps).toHaveLength(0);
		expect(h.created).toHaveLength(1);
		expect(h.created[0]?.closed).toBe(1);
		expect(h.pool.size()).toBe(0);
	});
});

describe("createPool — 状态来源的装配面（T15 传入的 `createBoxLister(...).list`）", () => {
	it("`createBoxLister(...).list` 可直接作为 `listBoxes` 注入，`force` 也招之即来", async () => {
		const lister = createBoxLister({
			exec: async () => ({ stdout: "[]", stderr: "", code: 0, killed: false, truncated: false }),
		});
		// 类型层面的契约：`createBoxLister(...).list` 可赋值给 `ListBoxesFn`（否则 T15 装配会报错）
		const listBoxes: ListBoxesFn = lister.list;

		const result = await listBoxes({ force: true });

		expect(result.ok).toBe(true);
		expect(result.boxes).toEqual([]);
	});
});

describe("createPool.get — 复用与重建", () => {
	it("存活的连接复用：不重复建连，也不再查状态", async () => {
		const h = setup({ boxes: [running("agent")] });

		const first = clientOf(await h.pool.get("agent"));
		const second = clientOf(await h.pool.get("agent"));

		expect(second).toBe(first);
		expect(h.created).toHaveLength(1);
		expect(first.initializeCalls).toBe(1);
		expect(h.listCalls()).toBe(1);
	});

	it("dead 连接被驱逐后重建：旧连接 close 一次", async () => {
		const h = setup({ boxes: [running("agent")] });
		const first = clientOf(await h.pool.get("agent"));
		first.dead = true;

		const second = clientOf(await h.pool.get("agent"));

		expect(second).not.toBe(first);
		expect(first.closed).toBe(1);
		expect(h.created).toHaveLength(2);
		expect(h.pool.size()).toBe(1);
	});

	it("握手失败：驱逐并报错，下一次 get 重建", async () => {
		const h = setup({
			boxes: [running("agent")],
			connect: (_name, attempt) => (attempt === 0 ? new Error("initialize timed out after 2000ms") : undefined),
		});

		const failed = await h.pool.get("agent");

		expect(failed.ok).toBe(false);
		expect(errorOf(failed)).toContain("remote MCP handshake failed: initialize timed out after 2000ms");
		expect(h.created[0]?.closed).toBe(1);
		expect(h.pool.size()).toBe(0);

		const retried = await h.pool.get("agent");

		expect(retried.ok).toBe(true);
		expect(h.created).toHaveLength(2);
		expect(h.pool.size()).toBe(1);
	});

	it("并发 get 同一 box：共享同一个 in-flight（一次建连、一次握手）", async () => {
		const h = setup({ boxes: [running("agent")] });

		const [first, second] = await Promise.all([h.pool.get("agent"), h.pool.get("agent")]);

		expect(clientOf(first)).toBe(clientOf(second));
		expect(h.created).toHaveLength(1);
		expect(h.created[0]?.initializeCalls).toBe(1);
		expect(h.listCalls()).toBe(1);
	});
});

describe("createPool — dispose", () => {
	it("dispose(box)：close 后移出池，之后再 get 会重建", async () => {
		const h = setup({ boxes: [running("agent")] });
		const first = clientOf(await h.pool.get("agent"));

		h.pool.dispose("agent");

		expect(first.closed).toBe(1);
		expect(h.pool.size()).toBe(0);
		const again = clientOf(await h.pool.get("agent"));
		expect(again).not.toBe(first);
		expect(h.created).toHaveLength(2);
	});

	it("disposeAll：关掉所有箱的连接", async () => {
		const h = setup({ boxes: [running("agent"), running("libretv")] });
		const a = clientOf(await h.pool.get("agent"));
		const b = clientOf(await h.pool.get("libretv"));

		h.pool.disposeAll();

		expect(a.closed).toBe(1);
		expect(b.closed).toBe(1);
		expect(h.pool.size()).toBe(0);
	});

	it("close() 抛异常时 dispose 也不抛（幂等、重复 dispose 安全）", async () => {
		const h = setup({ boxes: [running("agent")], throwOnClose: true });
		await h.pool.get("agent");

		expect(() => {
			h.pool.disposeAll();
			h.pool.dispose("agent");
			h.pool.dispose();
		}).not.toThrow();
		expect(h.pool.size()).toBe(0);
	});

	it("未知箱的 dispose 是空操作", () => {
		const h = setup();

		expect(() => h.pool.dispose("nope")).not.toThrow();
		expect(h.pool.size()).toBe(0);
	});

	it("建连期间 dispose：握手完成后丢弃连接（close 一次）并回 ok:false", async () => {
		const h = setup({ boxes: [running("agent")], deferHandshake: true });

		const pending = h.pool.get("agent");
		await flush();
		const client = h.created[0];
		if (client === undefined) throw new Error("expected a client to be created");
		expect(client.initializeCalls).toBe(1);

		h.pool.dispose("agent");
		client.settleHandshake();
		const result = await pending;

		expect(result.ok).toBe(false);
		expect(errorOf(result)).toContain("pool was disposed while connecting");
		expect(client.closed).toBe(1);
		expect(h.pool.size()).toBe(0);
	});
});

describe("埋点（logEvent）", () => {
	it("唤醒链每一步记一条 pool.wake（box/step/ok/ms）", async () => {
		const logger = createMemoryLogger();
		setLogger(logger);
		try {
			const h = setup({ boxes: [suspended("agent")] });
			await h.pool.get("agent");
		} finally {
			setLogger(undefined);
		}

		const wakes = logger.records.filter((record) => record.event === "pool.wake");
		expect(wakes).toHaveLength(1);
		expect(wakes[0]?.level).toBe("info");
		expect(wakes[0]?.fields).toMatchObject({ box: "agent", step: "wake", ok: true });
		expect(typeof wakes[0]?.fields?.["ms"]).toBe("number");
	});
});
