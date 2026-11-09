/**
 * @inobit/pi-instabox — per-box 远端客户端池 + 唤醒链（方案 §4.4 D4、§4.7、§5.1、T11）。
 *
 * 契约：
 * - **一台 box 一个连接**：池里的客户端只要还活着（`!isDead()`）就复用；`dead` 或不在池里
 *   才新建。复用不查 `ls`：状态只在确实要建连时读一次（否则每次工具调用都多一轮 CLI）。
 *   `remote.ts` 的客户端是「单次连接一实例、终态不自动重连」，重建责任在本模块。
 * - **先看状态，再唤醒，最后建连**（用户裁决的取舍：不依赖服务端在请求里唤醒）：
 *   `get` 先 `listBoxes({ force: true })` 查一次状态，`state === "running"` 直接建连；
 *   其余（`suspended` / `suspending` / `resuming` / 未知态）才进唤醒链。
 * - **唤醒链 `wake` → `start` → `resume`**：`wake` 覆盖自动暂停（实测 6s 左右成功）；
 *   用户手动 suspend/stop 的箱 `wake` 会**退出码 0 但 stderr 自报**
 *   `machine_not_running` / `start it with …`（`cli.ts` 已按 stderr 判失败）→ 退 `start`，
 *   再失败退 `resume`。每步之前 `onProgress("正在唤醒 <box>…")`，预算取 `timeouts.wakeMs`
 *   （`wake`）/ `timeouts.startMs`（`start`、`resume`），失败都把该步 `stderr` 尾部带进错误文本。
 * - **每步之后都确认 `running`**（方案 §4.4 / R4）：命令退 0 也可能只是「已提交」，服务端状态
 *   才是判据。因此以 {@link WAKE_POLL_INTERVAL_MS}（1s）间隔、带 `force: true` 重查 `ls`，直到
 *   `state === "running"`。**命令成功时**的确认预算沿用该步预算（`wakeMs` / `startMs`），超时就把
 *   当时的 `state` 带进失败记录并继续下一命令；**命令已报失败时只做一次即时采样**（不空等整步
 *   预算——用户手动暂停的箱 `wake` 会立刻报 `machine_not_running`，空等 `wakeMs` 只会拖慢退到
 *   `start`），采样到 `running` 仍算成功。确认通过后才建连。
 * - **`allowWake === false`（`session_start` 的后台路径）**：非 `running` 时**不跑**
 *   `wake`/`start`/`resume`，直接回 `{ ok: false, error }`（内部带 `reason: "not-running"`，
 *   供 {@link Pool.get} 判断能否让后来允许唤醒的调用重跑），也不报唤醒进度。
 * - **冷却期不可自愈**：平台文案是
 *   `sandbox X is cooling down until <RFC3339>; try again after cooldown`，命中
 *   {@link COOLDOWN_RE}（`is cooling down until`）时**不换下一条命令、也不重试连接**，直接报错
 *   并保留原文时间戳（stderr 里若另有 `retryAfterSeconds`/`Retry-After` 也一并透出）。
 * - **网关唤醒中的兜底**：SSH 网关自己只等 15 秒，没等到就拒连并回
 *   `machine … is waking up; try again in a few seconds`。正常路径下先 `wake` 已避免它，但状态
 *   与网关仍可能不同步，因此命中 {@link WAKING_UP_RE} 时按 {@link WAKE_RETRY_DELAYS_MS}
 *   （5s/10s/15s，共 3 次）**退避重试连接**；其余建连失败原样报握手失败。
 * - 状态与箱名**只来自注入的 `listBoxes`**（T15 传 `createBoxLister(...).list`，其签名天然
 *   可赋值）；本模块不读配置、不自己跑 `ls`。`ls` 失败/箱不存在都回错误，不猜状态。
 * - 建客户端后立刻 `initialize(signal)`，**只在握手成功时入池**：失败即 `close()` 丢弃并返回
 *   错误，下次 `get` 重建（失败驱逐）。建连期间被 `dispose` 的连接同样丢弃（per-box 代数
 *   校验），不留孤儿进程。
 * - 同一 box 的并发 `get` 共享同一个 in-flight Promise（先到者的 `opts` 决定
 *   `signal`/`allowWake`/`onProgress`），不会为同一 box 起两条 ssh。唯一例外：共享到的结果
 *   是 `reason: "not-running"` 而本次 `allowWake !== false` 时，本次自己重跑一遍——否则
 *   后台拉取的「不唤醒」结论会劫持本该唤醒的工具调用。
 * - `dispose` 先 `close()` 再删表，且**不抛**（`close()` 的异常被吞掉：关停不是用户可见失败）。
 *   它**不是终态**：池之后照常可用，也**不清**在飞的 `get`——在飞的那次连接靠代数校验发现
 *   自己被抛弃，`close()` 后回 `{ ok: false, error: "… pool was disposed while connecting" }`。
 *   因此 `dispose` 之后的第一次 `get` 可能立刻拿到这个 doomed 结果，重试即成功。
 *   `size()` 只数已握手入池的连接（在飞的不计），`dispose` 后为 0。
 * - 绝不 throw 到会话层：所有失败都是 `{ ok: false, error }`。
 * - 注入面：`exec` / `listBoxes` / `clientFactory` / `clock` / `sleep` / `onProgress` 全部可替；
 *   单测不 spawn 真进程、不碰真实 CLI、不等真实时间。
 */

import type { BoxInfo, ListBoxesResult } from "./boxes.ts";
import { type CliOutcome, type ExecFn, resume, start, wake } from "./cli.ts";
import type { InstaboxTimeouts } from "./config.ts";
import { logEvent } from "./log.ts";
import { type RemoteClient, createRemoteClient } from "./remote.ts";

/** CLI 可执行文件名（与 `cli.ts` 一致，argv[0]，不经 shell）。 */
const INSTABOX_BIN = "instabox";

/** 远端桌面工具 MCP server 的可执行文件名（`instabox ssh <box> -- <它> mcp`）。 */
const COMPUTER_USE_BIN = "instabox-computer-use";

/** `ls` 的 `state` 里唯一可用的值；其余（含空串＝未知态）都算「还没起来」。 */
const RUNNING_STATE = "running";

/** 唤醒命令成功后确认 `running` 的轮询间隔（方案 §4.4：1s 间隔重新 `ls`）。 */
export const WAKE_POLL_INTERVAL_MS = 1_000;

/**
 * 网关唤醒中的重试间隔（毫秒）：5s / 10s / 15s，共 3 次，退避合计 30s（≤45s 的总预算）。
 * 每次重试都是一次完整的新连接（`initialize`），成功即入池；耗尽才报错。
 */
export const WAKE_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 15_000];

/**
 * 「网关还在唤醒」的可重试错误：SSH 网关的自动唤醒**只等 15 秒**，没等到就拒连并回
 * `machine … is waking up; try again in a few seconds`。正常路径先 `wake` 已避免它，这里只是
 * 状态与网关不同步时的兜底：不 `start`、不 `resume`，退避重试连接。
 */
const WAKING_UP_RE = /is waking up|try again in a few seconds/i;

/**
 * 冷却期：真实文案是 `sandbox X is cooling down until <RFC3339>; try again after cooldown`。
 * 不可自愈——换下一条命令与重连都白费，只报错并保留原文时间。
 */
const COOLDOWN_RE = /is cooling down until/i;

/** `retryAfterSeconds` 的两种出现形态：JSON 字段，或 `retry after 30`/`Retry-After: 30` 文本。 */
const RETRY_AFTER_JSON_RE = /"retryAfterSeconds"\s*:\s*(\d+)/i;
const RETRY_AFTER_TEXT_RE = /retry[- ]?after\s*(?:seconds?\s*)?[:=]?\s*(\d+)/i;

/** 内部失败标记：只有 `allowWake === false` 的「箱不在 running」带它，供 `get` 决定是否重跑。 */
const NOT_RUNNING_REASON = "not-running";

/**
 * 唤醒链：`wake`（自动暂停）→ `start`（手动 suspend/stop）→ `resume`（兜底）。
 * 顺序固定，每步失败都退到下一条。
 */
const WAKE_COMMANDS = ["wake", "start", "resume"] as const;

/** 唤醒链的一步。 */
type WakeCommand = (typeof WAKE_COMMANDS)[number];

/** `get` 的结果：失败分支必带可直接展示的 `error`（绝不 throw）。 */
export type PoolGetResult = { ok: true; client: RemoteClient } | { ok: false; error: string };

/**
 * 内部结果：比 {@link PoolGetResult} 多一个 `reason`。
 * 只用于 `get` 区分「后台路径拒绝唤醒」与其它失败；对外返回类型仍是 `PoolGetResult`。
 */
type ConnectResult =
	| { ok: true; client: RemoteClient }
	| { ok: false; error: string; reason?: typeof NOT_RUNNING_REASON };

/** 单次 `get` 的选项。 */
export interface PoolGetOptions {
	/** 取消信号：透传给唤醒链的 CLI 命令、确认轮询与 `initialize` */
	signal?: AbortSignal;
	/** 本次的唤醒进度回调（覆盖 {@link PoolDeps.onProgress}，用于工具的 `onUpdate`） */
	onProgress?: (message: string) => void;
	/** `false` = `session_start` 路径：**绝不**唤醒，箱不在 `running` 就报错（默认允许唤醒） */
	allowWake?: boolean;
}

/**
 * `listBoxes` 的选项：`force` 跳过 `ls` 缓存（开头的状态查询与确认阶段都必须带，否则 5s TTL
 * 会看到陈旧状态），`signal` 是建议字段（`createBoxLister(...).list` 忽略它；本模块每轮自查 abort）。
 */
export interface PoolListOptions {
	force?: boolean;
	signal?: AbortSignal;
}

/** 注入的 box 列表来源；`createBoxLister(...).list` 的签名天然可赋值。 */
export type ListBoxesFn = (opts?: PoolListOptions) => Promise<ListBoxesResult>;

/** 注入的等待函数（毫秒）；默认真实 `setTimeout`，单测换成即时返回，绝不等真实时间。 */
export type SleepFn = (ms: number) => Promise<void>;

/** 池的注入面。 */
export interface PoolDeps {
	/** per-box 客户端工厂；默认 {@link createRemoteClient} + `instabox ssh <box> -- … mcp` */
	clientFactory?: (box: string) => RemoteClient;
	/** 注入的 CLI 执行函数（唤醒链的 `wake`/`start`/`resume`） */
	exec: ExecFn;
	/** 注入的 box 列表（T15 传 `createBoxLister(...).list`）；失败即本模块失败，不降级 */
	listBoxes: ListBoxesFn;
	/** 唤醒链预算：`wakeMs` 给 `wake`，`startMs` 给 `start`/`resume`；确认轮询沿用同一步的预算 */
	timeouts: InstaboxTimeouts;
	/** 注入的时钟（毫秒）：确认阶段的预算判定 + 错误文本里的耗时；默认 `Date.now` */
	clock?: () => number;
	/** 注入的等待（确认轮询的 1s 间隔）；默认真实 `setTimeout` */
	sleep?: SleepFn;
	/** 默认唤醒进度出口（被单次 `get` 的 `onProgress` 覆盖） */
	onProgress?: (message: string) => void;
}

/** per-box 客户端池。 */
export interface Pool {
	/** 取某 box 的可用客户端：复用 / 查状态唤醒 / 建连三选一，失败回 `{ ok: false, error }` */
	get(box: string, opts?: PoolGetOptions): Promise<PoolGetResult>;
	/** 关停并移除某 box 的连接（不给参数时等于 {@link Pool.disposeAll}） */
	dispose(box?: string): void;
	/** 关停并移除所有连接 */
	disposeAll(): void;
	/** 当前池里可用（已握手）的连接数 */
	size(): number;
}

/** 本次调用是否已被取消（用一个函数封装：`readonly` 字段的窄化会跨 `await` 残留）。 */
function isAborted(opts: PoolGetOptions): boolean {
	return opts.signal?.aborted === true;
}

/** 每一步命令的预算：`wake` 只等自动暂停，`start`/`resume` 是整箱冷启。 */
function commandTimeoutMs(command: WakeCommand, timeouts: InstaboxTimeouts): number {
	return command === "wake" ? timeouts.wakeMs : timeouts.startMs;
}

/** 唤醒链单步：转调 `cli.ts` 的同名薄封装（不在这里拼 argv）。 */
function runWakeCommand(
	exec: ExecFn,
	command: WakeCommand,
	box: string,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<CliOutcome> {
	if (command === "wake") return wake(exec, box, { timeout, signal });
	if (command === "start") return start(exec, box, { timeout, signal });
	return resume(exec, box, { timeout, signal });
}

/** `unknown` → message 文本（错误文本里不出现 `[object Object]`）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `state` 的展示形式：空串是「未知」，其余加引号（错误文本用）。 */
function stateLabel(state: string): string {
	return state === "" ? "unknown" : `"${state}"`;
}

/** 候选箱名列表（错误文本用；空列表给更明确的一句话）。 */
function availableBoxes(boxes: readonly BoxInfo[]): string {
	const names = boxes.map((box) => box.name).filter((name) => name !== "");
	return names.length > 0 ? `available boxes: ${names.join(", ")}` : "instabox ls returned no boxes";
}

/** 从失败文本里取 `retryAfterSeconds`（没有就 `undefined`，错误文本里也就不提数字）。 */
function retryAfterSeconds(text: string): number | undefined {
	const match = RETRY_AFTER_JSON_RE.exec(text) ?? RETRY_AFTER_TEXT_RE.exec(text);
	if (match === null) return undefined;
	const seconds = Number(match[1]);
	return Number.isFinite(seconds) ? seconds : undefined;
}

/** 冷却期错误的可展示形态：原文（含 `until <RFC3339>`）原样保留，附带可透出的重试时间。 */
function cooldownError(box: string, text: string): string {
	const seconds = retryAfterSeconds(text);
	const retry = seconds === undefined ? "" : `; retryAfterSeconds=${seconds}`;
	return `box "${box}" is cooling down (not retryable, do not start)${retry}: ${text}`;
}

/** 网关唤醒重试耗尽的形态：说清「已经重试过几次」，并保留平台原文。 */
function stillWakingUp(box: string, text: string, retries: number): string {
	return `box "${box}": machine did not finish waking up after ${retries} connection retries: ${text}`;
}

/** 握手失败的统一形态（非「唤醒中」/非冷却期都走这里）。 */
function handshakeError(box: string, text: string): string {
	return `box "${box}": remote MCP handshake failed: ${text}`;
}

/** 默认等待：真实 `setTimeout`（宿主/单测都可整体替换）。 */
const defaultSleep: SleepFn = (ms) =>
	new Promise<void>((resolve) => {
		globalThis.setTimeout(resolve, ms);
	});

/**
 * 建 per-box 客户端池。
 *
 * 取连接的顺序：复用 → 查状态（非 `running` 才 `wake` → `start` → `resume`，每步确认 `running`）
 * → 建连；`allowWake === false` 时非 `running` 直接报错。
 */
export function createPool(deps: PoolDeps): Pool {
	const { exec, listBoxes, timeouts } = deps;
	const clock = deps.clock ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;
	const factory =
		deps.clientFactory ??
		((box: string): RemoteClient =>
			createRemoteClient({
				command: INSTABOX_BIN,
				args: ["ssh", box, "--", COMPUTER_USE_BIN, "mcp"],
				timeouts: {
					connect: timeouts.connectMs,
					initialize: timeouts.initializeMs,
					listTools: timeouts.listToolsMs,
					callTool: timeouts.callMs,
				},
			}));

	/** 已握手可用的连接 */
	const clients = new Map<string, RemoteClient>();
	/** 在飞的 `get`（同一 box 的并发调用共享它；`dispose` 不清它，结果由代数校验兜住） */
	const inflight = new Map<string, Promise<ConnectResult>>();
	/**
	 * per-box 代数：`dispose` 递增。建连期间代数变了说明该连接在关停之后才建好，
	 * 必须丢弃（否则 `dispose` 之后仍会泄漏一个 ssh 子进程）。
	 */
	const generation = new Map<string, number>();

	function currentGeneration(box: string): number {
		return generation.get(box) ?? 0;
	}

	function bumpGeneration(box: string): void {
		generation.set(box, currentGeneration(box) + 1);
	}

	/** `close()` 是尽力而为：关停失败不能变成用户可见错误。 */
	function closeQuietly(client: RemoteClient | undefined): void {
		if (client === undefined) return;
		try {
			client.close();
		} catch {
			// 忽略：上层已经在删表，连接对象即将失去引用
		}
	}

	/** 关停并移除某 box 的连接（幂等）。 */
	function evict(box: string): void {
		const client = clients.get(box);
		clients.delete(box);
		bumpGeneration(box);
		closeQuietly(client);
	}

	function dispose(box?: string): void {
		// 不给参数 = disposeAll：此时箱名字段缺席（`logEvent` 丢掉 `undefined`）
		logEvent("pool.dispose", { box }, "debug");
		if (box !== undefined) {
			evict(box);
			return;
		}
		for (const name of new Set([...clients.keys(), ...inflight.keys()])) evict(name);
	}

	/** 一次 `listBoxes` 调用：异常与失败都归一成 `{ ok: false, error }`。 */
	async function listBoxesOnce(opts: PoolListOptions): Promise<{ ok: true; boxes: BoxInfo[] } | { ok: false; error: string }> {
		try {
			const listed = await listBoxes(opts);
			if (!listed.ok) return { ok: false, error: `cannot list boxes: ${listed.error ?? "unknown error"}` };
			return { ok: true, boxes: listed.boxes };
		} catch (error) {
			return { ok: false, error: `cannot list boxes: ${messageOf(error)}` };
		}
	}

	/** 状态查询失败/箱不存在都回错误：不猜状态，也不静默降级到唤醒。 */
	async function resolveState(box: string): Promise<{ ok: true; info: BoxInfo } | { ok: false; error: string }> {
		const listed = await listBoxesOnce({ force: true });
		if (!listed.ok) return listed;
		const info = listed.boxes.find((candidate) => candidate.name === box);
		if (info === undefined) {
			return { ok: false, error: `unknown box "${box}"; ${availableBoxes(listed.boxes)}` };
		}
		logEvent("pool.state", { box, state: info.state, desiredState: info.desiredState }, "debug");
		return { ok: true, info };
	}

	/**
	 * 一次建连尝试：新客户端 + `initialize(signal)`。
	 * 失败即 `close()` 丢弃（失败驱逐：下次 `get` 重建），并回**原始**错误文本。
	 */
	async function attemptConnect(
		box: string,
		opts: PoolGetOptions,
	): Promise<{ ok: true; client: RemoteClient } | { ok: false; error: string }> {
		const client = factory(box);
		try {
			await client.initialize(opts.signal);
			return { ok: true, client };
		} catch (error) {
			closeQuietly(client);
			return { ok: false, error: messageOf(error) };
		}
	}

	/**
	 * 建连 + 「网关唤醒中」退避重试：`is waking up` / `try again in a few seconds` 是可重试错误
	 * （网关只等 15s），按 {@link WAKE_RETRY_DELAYS_MS} 重连，最多 3 次。
	 * 返回最后一次的原始失败文本与已重试次数；非「唤醒中」的失败**不重试**，立刻返回。
	 */
	async function connectWithWakeRetry(
		box: string,
		opts: PoolGetOptions,
	): Promise<{ ok: true; client: RemoteClient } | { ok: false; error: string; retries: number }> {
		let attempt = await attemptConnect(box, opts);
		let retries = 0;
		for (const delay of WAKE_RETRY_DELAYS_MS) {
			if (attempt.ok || !WAKING_UP_RE.test(attempt.error)) break;
			if (isAborted(opts)) return { ok: false, error: `box "${box}": connect cancelled by caller`, retries };
			await sleep(delay);
			if (isAborted(opts)) return { ok: false, error: `box "${box}": connect cancelled by caller`, retries };
			retries += 1;
			attempt = await attemptConnect(box, opts);
		}
		if (attempt.ok) return attempt;
		return { ok: false, error: attempt.error, retries };
	}

	/**
	 * 唤醒命令之后的确认（方案 §4.4 / R4）：`force: true` 每 1s 重查，直到 `running`。
	 * 第一次采样不等 1s（命令刚返回，箱子可能已经好了）；预算 `budgetMs` 沿用该步命令的预算。
	 */
	async function confirmRunning(
		box: string,
		opts: PoolGetOptions,
		budgetMs: number,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		const startedAt = clock();
		for (;;) {
			if (isAborted(opts)) return { ok: false, error: `box "${box}": wake cancelled by caller` };
			const listed = await listBoxesOnce({ force: true, signal: opts.signal });
			if (!listed.ok) return { ok: false, error: `${listed.error} (while confirming box "${box}")` };
			const info = listed.boxes.find((candidate) => candidate.name === box);
			if (info === undefined) {
				return { ok: false, error: `unknown box "${box}"; ${availableBoxes(listed.boxes)}` };
			}
			if (info.state === RUNNING_STATE) return { ok: true };
			if (clock() - startedAt >= budgetMs) {
				return {
					ok: false,
					error: `box "${box}" did not reach "${RUNNING_STATE}" within ${budgetMs}ms of the wake attempt (state ${stateLabel(info.state)})`,
				};
			}
			await sleep(WAKE_POLL_INTERVAL_MS);
		}
	}

	/** `allowWake === false` 的拒答：说清状态，并给出两条可执行补救。 */
	function notRunning(box: string, info: BoxInfo): ConnectResult {
		return {
			ok: false,
			reason: NOT_RUNNING_REASON,
			error: `box "${box}" is ${stateLabel(info.state)}, not running; this path does not wake boxes — run /instabox-use ${box} (or "instabox start ${box}") first`,
		};
	}

	/**
	 * 唤醒链：`wake` → `start` → `resume`，每步之后都确认 `running`（命令退 0 也可能只是提交成功）。
	 * 成功 → 按该步预算轮询；失败 → 只做一次即时采样（不空等，见文件头契约）。
	 * 命令失败、确认超时都记一笔并继续下一条命令；全失败才报错。冷却期直接终止（不可自愈）。
	 * 只在状态非 `running` 且 `allowWake !== false` 时调用。
	 */
	async function ensureRunning(box: string, opts: PoolGetOptions): Promise<{ ok: true } | { ok: false; error: string }> {
		const progress = opts.onProgress ?? deps.onProgress;
		const failures: string[] = [];
		for (const command of WAKE_COMMANDS) {
			if (isAborted(opts)) return { ok: false, error: `box "${box}": wake cancelled by caller` };
			const budget = commandTimeoutMs(command, timeouts);
			progress?.(`正在唤醒 ${box}…`);
			const startedAt = clock();
			const outcome = await runWakeCommand(exec, command, box, budget, opts.signal);
			// 每一步都记：`wake` → `start` → `resume` 的退化路径靠这个时间线排查
			logEvent(
				"pool.wake",
				{ box, step: command, ok: outcome.ok, ms: clock() - startedAt },
				outcome.ok ? "info" : "warn",
			);
			if (!outcome.ok) {
				// 冷却期不可自愈：不确认、不换下一条命令，直接透出原文时间
				if (COOLDOWN_RE.test(outcome.error)) return { ok: false, error: cooldownError(box, outcome.error) };
				failures.push(`${outcome.error} (after ${clock() - startedAt}ms)`);
			}
			// 成功才值得等；失败只即时采样一次，避免用户手动暂停的箱白等一整步预算
			const confirmed = await confirmRunning(box, opts, outcome.ok ? budget : 0);
			if (confirmed.ok) return { ok: true };
			if (isAborted(opts)) return confirmed;
			failures.push(confirmed.error);
		}
		return { ok: false, error: `could not wake box "${box}": ${failures.join("; ")}` };
	}

	/** 握手成功后的入池：建连期间被 `dispose` 过的连接必须丢弃（不留孤儿进程）。 */
	function adopt(box: string, stamp: number, client: RemoteClient): ConnectResult {
		if (currentGeneration(box) !== stamp) {
			closeQuietly(client);
			return { ok: false, error: `box "${box}": pool was disposed while connecting` };
		}
		clients.set(box, client);
		return { ok: true, client };
	}

	async function connectBox(box: string, opts: PoolGetOptions): Promise<ConnectResult> {
		const stamp = currentGeneration(box);
		try {
			// 先看状态：running 直接连；非 running 才进唤醒链（allowWake=false 直接拒答）
			const state = await resolveState(box);
			if (!state.ok) return state;
			if (state.info.state !== RUNNING_STATE) {
				if (opts.allowWake === false) return notRunning(box, state.info);
				const woken = await ensureRunning(box, opts);
				if (!woken.ok) return woken;
			}
			// 确认 running 之后才建连；`is waking up` 是网关侧的兜底（理论上先 wake 后不会遇到）
			const attempt = await connectWithWakeRetry(box, opts);
			if (attempt.ok) return adopt(box, stamp, attempt.client);
			if (WAKING_UP_RE.test(attempt.error)) {
				return { ok: false, error: stillWakingUp(box, attempt.error, attempt.retries) };
			}
			if (COOLDOWN_RE.test(attempt.error)) {
				return { ok: false, error: cooldownError(box, attempt.error) };
			}
			return { ok: false, error: handshakeError(box, attempt.error) };
		} catch (error) {
			// 兜底：任何意外异常都不外抛（池的失败面只有 `{ ok: false, error }`）
			return { ok: false, error: `box "${box}": ${messageOf(error)}` };
		}
	}

	/** 一次建连尝试的埋点包装：只量时长与成败，不动返回值/错误文案。 */
	async function connect(box: string, opts: PoolGetOptions): Promise<ConnectResult> {
		const startedAt = clock();
		const result = await connectBox(box, opts);
		logEvent("pool.connect", {
			box,
			ok: result.ok,
			ms: clock() - startedAt,
			error: result.ok ? undefined : result.error,
		});
		return result;
	}

	/** 起一次建连并登记为 in-flight（同一 box 的下一个调用会共享它）。 */
	function startConnect(box: string, opts: PoolGetOptions): Promise<ConnectResult> {
		const started = connect(box, opts);
		inflight.set(box, started);
		// 登记者自己也等待完成后的清理：只有还挂着「自己」时才删，不误删重跑出来的新条目
		return started.finally(() => {
			if (inflight.get(box) === started) inflight.delete(box);
		});
	}

	function get(box: string, opts: PoolGetOptions = {}): Promise<PoolGetResult> {
		const existing = clients.get(box);
		if (existing !== undefined) {
			if (!existing.isDead()) {
				logEvent("pool.reuse", { box }, "debug");
				return Promise.resolve({ ok: true, client: existing });
			}
			evict(box);
		}
		const pending = inflight.get(box);
		if (pending === undefined) return startConnect(box, opts);
		return pending.then((result) => {
			// 共享到的若是后台路径的「不唤醒」结论，而本次允许唤醒：自己重跑一遍
			if (result.ok || result.reason !== NOT_RUNNING_REASON || opts.allowWake === false) return result;
			return startConnect(box, opts);
		});
	}

	return {
		get,
		dispose,
		disposeAll: () => dispose(),
		size: () => clients.size,
	};
}
