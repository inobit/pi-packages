/**
 * @inobit/pi-instabox — `src/pool.ts` 单测：唤醒链 6 态矩阵、唤醒后的 `running` 确认轮询、
 * `session_start` 零唤醒、复用 / dead 重建 / 握手失败驱逐、in-flight 共享（含「不唤醒」结论
 * 不劫持唤醒调用）、`dispose`（含建连期间 dispose）。
 *
 * 全部走注入的假 `ExecFn` / 假 `listBoxes` / 假 `sleep` / 假客户端：不 spawn 真进程、
 * 不联网、不等真实时间。
 */

import { describe, expect, it } from "vitest";
import { type BoxInfo, type ListBoxesResult, createBoxLister } from "../src/boxes.ts";
import type { ExecFn, ExecResultLike } from "../src/cli.ts";
import type { InstaboxTimeouts } from "../src/config.ts";
import {
	type ListBoxesFn,
	type Pool,
	type PoolDeps,
	WAKE_CONFIRM_TIMEOUT_MS,
	WAKE_POLL_INTERVAL_MS,
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

interface FakeClientOptions {
	/** 预置的握手失败（按 `initialize` 调用顺序消费） */
	handshakeErrors: Error[];
	/** `close()` 抛异常（断言 `dispose` 不抛） */
	throwOnClose: boolean;
	/** 握手挂起，直到测试调用 `settleHandshake()`（建连期间 dispose 用） */
	deferHandshake: boolean;
}

/** 假客户端：记录 `initialize`/`close` 次数，可脚本化握手失败/挂起，`dead` 由测试手动翻转。 */
class FakeClient implements RemoteClient {
	/** 该客户端服务的 box（工厂入参，仅用于排查） */
	readonly name: string;
	dead = false;
	closed = 0;
	initializeCalls = 0;
	/** `initialize` 收到的 signal（断言透传） */
	readonly signals: (AbortSignal | undefined)[] = [];
	private readonly handshakeErrors: Error[];
	private readonly throwOnClose: boolean;
	private readonly handshake: { promise: Promise<InitializeResult>; settle: () => void } | undefined;

	constructor(name: string, options: FakeClientOptions) {
		this.name = name;
		this.handshakeErrors = options.handshakeErrors;
		this.throwOnClose = options.throwOnClose;
		if (options.deferHandshake) {
			let settle = (): void => {};
			const promise = new Promise<InitializeResult>((resolve) => {
				settle = () => resolve({ serverInfo: { name: "instabox-computer-use", version: "0.3.6-instabox.1" } });
			});
			this.handshake = { promise, settle };
		}
	}

	async initialize(signal?: AbortSignal): Promise<InitializeResult> {
		this.initializeCalls += 1;
		this.signals.push(signal);
		const error = this.handshakeErrors.shift();
		if (error) throw error;
		if (this.handshake !== undefined) return this.handshake.promise;
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

/** `BoxInfo` 工厂：只填本模块消费的 4 个字段。 */
function box(name: string, state: string, desiredState: string): BoxInfo {
	return { name, state, desiredState, templateId: "agent-browser", templateVersion: "2026-10-25.23" };
}

function running(name: string): BoxInfo {
	return box(name, "running", "running");
}

/** 改某台箱的 `state`（模拟唤醒后真的跑起来了）。 */
function withState(boxes: readonly BoxInfo[], name: string, state: string): BoxInfo[] {
	return boxes.map((entry) => (entry.name === name ? { ...entry, state } : entry));
}

/** 唤醒链的脚本：按子命令决定 CLI 结果（缺省成功）。 */
type ExecReply = (args: readonly string[]) => ExecResultLike;

interface SetupOptions {
	boxes?: BoxInfo[];
	reply?: ExecReply;
	handshakeErrors?: Error[];
	throwOnClose?: boolean;
	deferHandshake?: boolean;
	/** 唤醒命令成功后，前 N 次**强制**查询仍报 `suspended`（模拟「命令返回了但箱子还在启动」） */
	awakeDelayPolls?: number;
	/** 唤醒命令成功后箱状态永不变化（模拟「箱子起不来」） */
	staysAsleep?: boolean;
	/** 每次 `sleep` 都挂起，直到测试调用 `releaseSleep()`（断言轮询中途的行为） */
	deferSleep?: boolean;
	/** 覆盖任意注入项（如 `exec`、`listBoxes`） */
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
	/** 每次 `sleep` 的毫秒数（确认轮询的 1s 间隔） */
	sleeps: number[];
	setBoxes(boxes: BoxInfo[]): void;
	listCalls(): number;
	/** 带 `force: true` 的 `listBoxes` 次数（确认轮询） */
	forcedListCalls(): number;
	/** 放行一次挂起的 `sleep`（配合 `deferSleep`） */
	releaseSleep(): void;
}

/**
 * 组装一个全注入的池：默认一台 `running` 的 `agent` 箱、CLI 恒成功。
 *
 * 假 `ls` 会模拟真实的时延语义：唤醒命令**成功**后，箱状态要经过 `awakeDelayPolls` 次
 * **强制**查询才变成 `running`（默认 0 次，即命令返回时已经好了）；`staysAsleep` 则永不变化。
 * 假 `sleep` 只推进假时钟，绝不占用真实时间。
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
	const handshakeErrors = [...(options.handshakeErrors ?? [])];
	const reply = options.reply ?? (() => execOk());

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
		if (result.code === 0 && isLifecycle && target !== "" && options.staysAsleep !== true) {
			pendingAwake = { box: target, pollsLeft: options.awakeDelayPolls ?? 0 };
		}
		return result;
	};

	const pool = createPool({
		exec,
		listBoxes,
		timeouts: TIMEOUTS,
		clientFactory: (name) => {
			const client = new FakeClient(name, {
				handshakeErrors,
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
		setBoxes: (next) => {
			boxes = next;
		},
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

/** 唤醒链里执行过的子命令序列（如 `["wake", "resume"]`）。 */
function commands(calls: readonly ExecCall[]): string[] {
	return calls.map((call) => call.args[0] ?? "");
}

/** 跑完当前已排队的微任务（等挂起的握手/建连推进到下一步），不推进真实时间。 */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("createPool.get — 唤醒链分流（方案 §4.4 D4）", () => {
	it("running 箱：直接建连，一条唤醒命令都不跑，也不做确认轮询", async () => {
		const h = setup({ boxes: [running("agent")] });

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(true);
		expect(clientOf(result).initializeCalls).toBe(1);
		expect(h.execCalls).toHaveLength(0);
		expect(h.progress).toHaveLength(0);
		expect(h.listCalls()).toBe(1);
		expect(h.forcedListCalls()).toBe(0);
		expect(h.pool.size()).toBe(1);
	});

	it("suspended + desiredState=suspended（人工挂起）：先 start，预算 startMs", async () => {
		const h = setup({ boxes: [box("libretv", "suspended", "suspended")] });

		const result = await h.pool.get("libretv");

		expect(result.ok).toBe(true);
		expect(commands(h.execCalls)).toEqual(["start"]);
		expect(h.execCalls[0]?.args).toEqual(["start", "libretv"]);
		expect(h.execCalls[0]?.timeout).toBe(TIMEOUTS.startMs);
		expect(h.progress).toEqual(["正在唤醒 libretv…"]);
	});

	it("paused + desiredState=running（自动暂停）：走 wake，预算 wakeMs", async () => {
		const h = setup({ boxes: [box("agent", "paused", "running")] });

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(true);
		expect(commands(h.execCalls)).toEqual(["wake"]);
		expect(h.execCalls[0]?.args).toEqual(["wake", "agent"]);
		expect(h.execCalls[0]?.timeout).toBe(TIMEOUTS.wakeMs);
	});

	it("start 失败：退到 resume（预算 startMs）并报两次进度", async () => {
		const h = setup({
			boxes: [box("libretv", "suspended", "suspended")],
			reply: (args) => (args[0] === "start" ? execFail("start refused") : execOk()),
		});

		const result = await h.pool.get("libretv");

		expect(result.ok).toBe(true);
		expect(commands(h.execCalls)).toEqual(["start", "resume"]);
		expect(h.execCalls[1]?.timeout).toBe(TIMEOUTS.startMs);
		expect(h.progress).toEqual(["正在唤醒 libretv…", "正在唤醒 libretv…"]);
	});

	it("wake 失败：退到 resume（方案 §4.4 / docs §5.3 的兜底）", async () => {
		const h = setup({
			boxes: [box("agent", "paused", "running")],
			reply: (args) => (args[0] === "wake" ? execFail("wake refused") : execOk()),
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(true);
		expect(commands(h.execCalls)).toEqual(["wake", "resume"]);
		expect(h.execCalls[1]?.timeout).toBe(TIMEOUTS.startMs);
		expect(clientOf(result).initializeCalls).toBe(1);
	});

	it.each([
		// state, desiredState, 期望的子命令序列
		["running", "running", []],
		["suspended", "suspended", ["start"]],
		["suspended", "running", ["wake"]],
		["paused", "running", ["wake"]],
		["stopped", "suspended", ["start"]],
		["", "running", ["wake"]],
	])("6 态矩阵：state=%s desiredState=%s → %j", async (state, desiredState, expected) => {
		const h = setup({ boxes: [box("matrix", state, desiredState)] });

		const result = await h.pool.get("matrix");

		expect(result.ok).toBe(true);
		expect(commands(h.execCalls)).toEqual(expected);
	});

	it("唤醒命令全失败：错误带两侧 stderr 尾部，且不建客户端", async () => {
		const h = setup({
			boxes: [box("libretv", "suspended", "suspended")],
			reply: (args) => execFail(args[0] === "start" ? "start: sandbox is locked" : "resume: quota exceeded"),
			staysAsleep: true,
		});

		const result = await h.pool.get("libretv");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('could not wake box "libretv"');
		expect(result.error).toContain("start: sandbox is locked");
		expect(result.error).toContain("resume: quota exceeded");
		expect(h.created).toHaveLength(0);
		expect(h.pool.size()).toBe(0);
	});

	it("`signal` 透传给唤醒命令，也透传给 initialize", async () => {
		const controller = new AbortController();
		const h = setup({ boxes: [box("libretv", "suspended", "suspended")] });

		const result = await h.pool.get("libretv", { signal: controller.signal });

		expect(h.execCalls[0]?.signal).toBe(controller.signal);
		expect(clientOf(result).signals[0]).toBe(controller.signal);
	});

	it("已 abort：一个唤醒命令都不跑", async () => {
		const controller = new AbortController();
		controller.abort();
		const h = setup({ boxes: [box("libretv", "suspended", "suspended")] });

		const result = await h.pool.get("libretv", { signal: controller.signal });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("cancelled by caller");
		expect(h.execCalls).toHaveLength(0);
		expect(h.created).toHaveLength(0);
	});

	it("单次 get 的 onProgress 覆盖池级回调", async () => {
		const messages: string[] = [];
		const h = setup({ boxes: [box("libretv", "suspended", "suspended")] });

		await h.pool.get("libretv", { onProgress: (message) => messages.push(message) });

		expect(messages).toEqual(["正在唤醒 libretv…"]);
		expect(h.progress).toHaveLength(0);
	});
});

describe("createPool.get — 唤醒成功后的 running 确认（方案 §4.4 / R4）", () => {
	it("命令退出 0 但仍 suspended、下一轮才 running：等到 running 才建连", async () => {
		const h = setup({ boxes: [box("libretv", "suspended", "suspended")], awakeDelayPolls: 1 });

		const result = await h.pool.get("libretv");

		expect(result.ok).toBe(true);
		// 1 次状态查询 + 2 次强制确认（第一次仍 suspended、第二次 running）
		expect(h.forcedListCalls()).toBe(2);
		expect(h.sleeps).toEqual([WAKE_POLL_INTERVAL_MS]);
		expect(clientOf(result).initializeCalls).toBe(1);
	});

	it("确认轮询带 force: true（绕开 5s TTL 缓存），成功后立刻建连", async () => {
		const h = setup({ boxes: [box("agent", "paused", "running")] });

		await h.pool.get("agent");

		expect(h.listCalls()).toBe(2);
		expect(h.forcedListCalls()).toBe(1);
		expect(h.sleeps).toHaveLength(0);
	});

	it("始终不到 running：报错带当前 state，不建客户端，轮询 1s 间隔、20s 封顶", async () => {
		const h = setup({ boxes: [box("libretv", "suspended", "suspended")], staysAsleep: true });

		const result = await h.pool.get("libretv");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(`did not reach "running" within ${WAKE_CONFIRM_TIMEOUT_MS}ms`);
		expect(result.error).toContain('(state "suspended")');
		expect(h.created).toHaveLength(0);
		expect(h.pool.size()).toBe(0);
		expect(h.sleeps).toHaveLength(WAKE_CONFIRM_TIMEOUT_MS / WAKE_POLL_INTERVAL_MS);
		expect(h.sleeps.every((ms) => ms === WAKE_POLL_INTERVAL_MS)).toBe(true);
	});

	it("确认阶段被 abort：下一次轮询立刻报取消，不再等预算耗尽", async () => {
		const controller = new AbortController();
		const h = setup({ boxes: [box("libretv", "suspended", "suspended")], staysAsleep: true, deferSleep: true });

		const pending = h.pool.get("libretv", { signal: controller.signal });
		await flush();
		expect(h.sleeps).toEqual([WAKE_POLL_INTERVAL_MS]);

		controller.abort();
		h.releaseSleep();
		const result = await pending;

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("cancelled by caller");
		expect(h.sleeps).toHaveLength(1);
	});
});

describe("createPool.get — allowWake=false（session_start 路径）", () => {
	it("非 running 箱：报错且零唤醒调用", async () => {
		const h = setup({ boxes: [box("libretv", "suspended", "suspended")] });

		const result = await h.pool.get("libretv", { allowWake: false });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('is "suspended", not running');
		expect(result.error).toContain("/instabox-use libretv");
		expect(h.execCalls).toHaveLength(0);
		expect(h.progress).toHaveLength(0);
		expect(h.created).toHaveLength(0);
	});

	it("running 箱：照常建连", async () => {
		const h = setup({ boxes: [running("agent")] });

		const result = await h.pool.get("agent", { allowWake: false });

		expect(result.ok).toBe(true);
		expect(h.execCalls).toHaveLength(0);
	});

	it("未知态（state 为空串）：报错且零唤醒调用", async () => {
		const h = setup({ boxes: [box("agent", "", "running")] });

		const result = await h.pool.get("agent", { allowWake: false });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("is unknown, not running");
		expect(h.execCalls).toHaveLength(0);
	});

	it("后台路径的 in-flight「不唤醒」结论不劫持允许唤醒的调用（后者自己重跑）", async () => {
		const h = setup({ boxes: [box("libretv", "suspended", "suspended")] });

		const background = h.pool.get("libretv", { allowWake: false });
		const tool = h.pool.get("libretv");
		const [bgResult, toolResult] = await Promise.all([background, tool]);

		expect(bgResult.ok).toBe(false);
		expect(toolResult.ok).toBe(true);
		expect(commands(h.execCalls)).toEqual(["start"]);
		expect(h.created).toHaveLength(1);
		expect(h.pool.size()).toBe(1);
	});
});

describe("createPool.get — 状态查询失败/箱不存在", () => {
	it("listBoxes 返回失败：不唤醒、不建客户端", async () => {
		const h = setup({
			deps: {
				listBoxes: async (): Promise<ListBoxesResult> => ({ ok: false, boxes: [], error: "instabox ls exited with code 127" }),
			},
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("cannot list boxes: instabox ls exited with code 127");
		expect(h.execCalls).toHaveLength(0);
		expect(h.created).toHaveLength(0);
	});

	it("listBoxes 抛异常：收成 ok:false，不外抛", async () => {
		const h = setup({
			deps: {
				listBoxes: async () => {
					throw new Error("boom");
				},
			},
		});

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("cannot list boxes: boom");
	});

	it("ls 没有任何箱：错误里明确说明，且不唤醒", async () => {
		const h = setup({ boxes: [] });

		const result = await h.pool.get("agent");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('unknown box "agent"');
		expect(result.error).toContain("instabox ls returned no boxes");
		expect(h.execCalls).toHaveLength(0);
	});

	it("箱名不存在：错误里带候选名单", async () => {
		const h = setup({ boxes: [running("agent"), running("libretv")] });

		const result = await h.pool.get("nope", { allowWake: false });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('unknown box "nope"');
		expect(result.error).toContain("available boxes: agent, libretv");
		expect(h.execCalls).toHaveLength(0);
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
		const h = setup({ boxes: [running("agent")], handshakeErrors: [new Error("initialize timed out after 2000ms")] });

		const failed = await h.pool.get("agent");

		expect(failed.ok).toBe(false);
		if (failed.ok) return;
		expect(failed.error).toContain("remote MCP handshake failed: initialize timed out after 2000ms");
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
		if (result.ok) return;
		expect(result.error).toContain("pool was disposed while connecting");
		expect(client.closed).toBe(1);
		expect(h.pool.size()).toBe(0);
	});
});
