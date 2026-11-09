/**
 * @inobit/pi-instabox — per-box 远端客户端池 + 唤醒链（方案 §4.4 D4、§4.7、§5.1、T11）。
 *
 * 契约：
 * - **一台 box 一个连接**：池里的客户端只要还活着（`!isDead()`）就复用；`dead` 或不在池里
 *   才新建。复用不再查 `ls`：状态只在确实要建连时读一次（否则每次工具调用都多一轮 CLI）。
 *   `remote.ts` 的客户端是「单次连接一实例、终态不自动重连」，重建责任在本模块。
 * - **`allowWake === false`（`session_start` 的后台路径）绝不执行 `wake`/`start`/`resume`**：
 *   箱不在 `running` 就直接回 `{ ok: false, error }`（该结果内部带 `reason: "not-running"`，
 *   供 {@link Pool.get} 判断能否让后来允许唤醒的调用重跑），也不报唤醒进度。
 * - `allowWake !== false`（桌面工具调用 / 用户显式 `/instabox-use`）才进唤醒链，按 `ls` 的
 *   `desiredState` 分流：`suspended`（用户手动 suspend/stop，`wake` 对它必然失败）→
 *   `start`，失败退 `resume`；其余（自动暂停，`desiredState` 仍是 `running`）→ `wake`，
 *   失败退 `resume`。每步之前 `onProgress("正在唤醒 <box>…")`，预算取
 *   `timeouts.startMs` / `timeouts.wakeMs`。任一步失败都把该步的 `stderr` 尾部带进错误文本
 *   （`cli.ts` 已把尾部拼进 `error`，这里只负责不吞掉它）。
 * - **唤醒成功后必须确认**（方案 §4.4 / R4）：命令退出 0 时箱子可能仍在启动，此时直接建连
 *   只会拿到 `remote MCP handshake failed`，与「远端真的坏了」无法区分。因此以
 *   {@link WAKE_POLL_INTERVAL_MS}（1s）间隔、带 `force: true` 重查 `ls`，直到
 *   `state === "running"` 才建连。确认阶段的总预算是**固定** {@link WAKE_CONFIRM_TIMEOUT_MS}
 *   （20s）：`wake`/`start` 自己已经等过主预算（`wakeMs`/`startMs`），这里只兜尾部。
 *   始终不到 → `{ ok: false, error }` 带箱子当时的 `state`。
 * - 状态与期望状态**只来自注入的 `listBoxes`**（T15 传 `createBoxLister(...).list`，其签名
 *   天然可赋值）；本模块不读配置、不自己跑 `ls`。
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
import { type RemoteClient, createRemoteClient } from "./remote.ts";

/** CLI 可执行文件名（与 `cli.ts` 一致，argv[0]，不经 shell）。 */
const INSTABOX_BIN = "instabox";

/** 远端桌面工具 MCP server 的可执行文件名（`instabox ssh <box> -- <它> mcp`）。 */
const COMPUTER_USE_BIN = "instabox-computer-use";

/** `ls` 的 `state` 里唯一可用的值；其余（含空串＝未知态）都算「不可用」。 */
const RUNNING_STATE = "running";

/** `ls` 的 `desiredState`：该值表示「用户手动挂起/停止」，`wake` 拉不起来。 */
const SUSPENDED_DESIRED_STATE = "suspended";

/** 唤醒命令成功后确认 `running` 的轮询间隔（方案 §4.4：1s 间隔重新 `ls`）。 */
export const WAKE_POLL_INTERVAL_MS = 1_000;

/**
 * 确认阶段的总预算（毫秒）：`wake 50s` / `start 120s` 已经由整型命令自身等过，
 * 这里只兜「命令返回了但箱子还没拿到 `running`」的尾部，20s 够 `start` 收尾。
 */
export const WAKE_CONFIRM_TIMEOUT_MS = 20_000;

/** 内部失败标记：只有 `allowWake === false` 的「箱不在 running」带它，供 `get` 决定是否重跑。 */
const NOT_RUNNING_REASON = "not-running";

/** 唤醒链的两个命令；第二个恒为兜底 `resume`。 */
type WakeCommand = "wake" | "start" | "resume";

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
 * `listBoxes` 的选项：`force` 跳过 `ls` 缓存（确认阶段必须带，否则 5s TTL 会看到陈旧状态），
 * `signal` 是建议字段（`createBoxLister(...).list` 忽略它；本模块自己每轮都自查 abort）。
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
	/** 注入的 CLI 执行函数（只用于唤醒链的 `wake`/`start`/`resume`） */
	exec: ExecFn;
	/** 注入的 box 列表（T15 传 `createBoxLister(...).list`）；失败即本模块失败，不降级 */
	listBoxes: ListBoxesFn;
	/** 唤醒链预算：`wakeMs` 给 `wake`，`startMs` 给 `start`/`resume` */
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
	/** 取某 box 的可用客户端：复用 / 唤醒 / 建连三选一，失败回 `{ ok: false, error }` */
	get(box: string, opts?: PoolGetOptions): Promise<PoolGetResult>;
	/** 关停并移除某 box 的连接（不给参数时等于 {@link Pool.disposeAll}） */
	dispose(box?: string): void;
	/** 关停并移除所有连接 */
	disposeAll(): void;
	/** 当前池里可用（已握手）的连接数 */
	size(): number;
}

/** 唤醒链的分流（方案 §4.4）：首选命令 + 兜底命令。 */
function wakeChain(desiredState: string): readonly [WakeCommand, WakeCommand] {
	return desiredState === SUSPENDED_DESIRED_STATE ? ["start", "resume"] : ["wake", "resume"];
}

/** 每个唤醒命令的预算：`wake` 只等自动暂停，`start`/`resume` 是整箱冷启。 */
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

/** 默认等待：真实 `setTimeout`（宿主/单测都可整体替换）。 */
const defaultSleep: SleepFn = (ms) =>
	new Promise<void>((resolve) => {
		globalThis.setTimeout(resolve, ms);
	});

/**
 * 建 per-box 客户端池。
 *
 * 唤醒链只在 `allowWake !== false` 时执行；`allowWake === false` 时对非 `running` 箱**零唤醒调用**
 * （D4：`session_start` 的后台拉取不进唤醒链）。
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
		const listed = await listBoxesOnce({});
		if (!listed.ok) return listed;
		const info = listed.boxes.find((candidate) => candidate.name === box);
		if (info === undefined) {
			return { ok: false, error: `unknown box "${box}"; ${availableBoxes(listed.boxes)}` };
		}
		return { ok: true, info };
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
	 * 唤醒命令成功后的确认（方案 §4.4 / R4）：`force: true` 每 1s 重查，直到 `running`。
	 * 第一次采样不等 1s（命令刚返回，箱子可能已经好了）；预算见 {@link WAKE_CONFIRM_TIMEOUT_MS}。
	 */
	async function confirmRunning(box: string, opts: PoolGetOptions): Promise<{ ok: true } | { ok: false; error: string }> {
		const startedAt = clock();
		for (;;) {
			if (opts.signal?.aborted === true) return { ok: false, error: `box "${box}": wake cancelled by caller` };
			const listed = await listBoxesOnce({ force: true, signal: opts.signal });
			if (!listed.ok) return { ok: false, error: `${listed.error} (while confirming box "${box}")` };
			const info = listed.boxes.find((candidate) => candidate.name === box);
			if (info === undefined) {
				return { ok: false, error: `unknown box "${box}"; ${availableBoxes(listed.boxes)}` };
			}
			if (info.state === RUNNING_STATE) return { ok: true };
			if (clock() - startedAt >= WAKE_CONFIRM_TIMEOUT_MS) {
				return {
					ok: false,
					error: `box "${box}" did not reach "${RUNNING_STATE}" within ${WAKE_CONFIRM_TIMEOUT_MS}ms of a successful wake (state ${stateLabel(info.state)})`,
				};
			}
			await sleep(WAKE_POLL_INTERVAL_MS);
		}
	}

	/** 唤醒链：按 `desiredState` 分流，每步报进度，成功后确认 `running`，失败带 stderr 尾部。 */
	async function ensureRunning(
		box: string,
		info: BoxInfo,
		opts: PoolGetOptions,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		const progress = opts.onProgress ?? deps.onProgress;
		const failures: string[] = [];
		for (const command of wakeChain(info.desiredState)) {
			if (opts.signal?.aborted === true) {
				return { ok: false, error: `box "${box}": wake cancelled by caller` };
			}
			progress?.(`正在唤醒 ${box}…`);
			const startedAt = clock();
			const outcome = await runWakeCommand(exec, command, box, commandTimeoutMs(command, timeouts), opts.signal);
			if (outcome.ok) return confirmRunning(box, opts);
			failures.push(`${outcome.error} (after ${clock() - startedAt}ms)`);
		}
		return { ok: false, error: `could not wake box "${box}": ${failures.join("; ")}` };
	}

	async function connect(box: string, opts: PoolGetOptions): Promise<ConnectResult> {
		const stamp = currentGeneration(box);
		try {
			const state = await resolveState(box);
			if (!state.ok) return state;
			if (state.info.state !== RUNNING_STATE) {
				if (opts.allowWake === false) return notRunning(box, state.info);
				const woken = await ensureRunning(box, state.info, opts);
				if (!woken.ok) return woken;
			}
			const client = factory(box);
			try {
				await client.initialize(opts.signal);
			} catch (error) {
				closeQuietly(client);
				return { ok: false, error: `box "${box}": remote MCP handshake failed: ${messageOf(error)}` };
			}
			if (currentGeneration(box) !== stamp) {
				closeQuietly(client);
				return { ok: false, error: `box "${box}": pool was disposed while connecting` };
			}
			clients.set(box, client);
			return { ok: true, client };
		} catch (error) {
			// 兜底：任何意外异常都不外抛（池的失败面只有 `{ ok: false, error }`）
			return { ok: false, error: `box "${box}": ${messageOf(error)}` };
		}
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
			if (!existing.isDead()) return Promise.resolve({ ok: true, client: existing });
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
