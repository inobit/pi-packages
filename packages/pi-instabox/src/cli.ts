/**
 * @inobit/pi-instabox — `instabox` CLI 薄封装（注入 `ExecFn`，零第三方依赖）。
 *
 * 契约（方案 §4.7 D7、§4.4 D4、§5.1）：
 * - 只覆盖**一次性命令**：`version` / `ls --json` / `wake` / `start` / `resume` / `exec`。
 *   遥控长连接（远端 MCP）必须走 `remote.ts` 的 spawn 客户端——`pi.exec` 没有双工流。
 * - 超时不自建计时器：毫秒预算**透传**给注入的 `ExecFn` 的 `timeout` 选项（宿主 `pi.exec`
 *   内部实现超时并回 `killed: true`），因此整套逻辑可离线单测。探测/列表/`exec` 的预算在
 *   本文件顶部单点维护；`wake`/`start`/`resume` 的生命周期预算单点取自 `config.ts` 的
 *   `DEFAULT_CONFIG.timeouts`（`wakeMs` / `startMs`，方案 §4.4），本文件不另存数字。
 *   调用方一律可用 `opts.timeout` 覆盖——准备阶段（`pool.ts`）传的就是**钳制后的**值
 *   （单步上限与剩余预算取小），日志里的 `timeoutMs` 记的就是实际生效的那个数。
 * - 一参数一元素：所有子命令都用 argv 数组传给 `ExecFn`（不拼 shell 字符串），
 *   `exec` 的远端预算用 `--timeout <秒>` 显式传，上限 600 秒。
 * - 失败归一：任何非 0 退出 / `killed` / 抛异常都转成 `{ ok: false, error }`，**绝不 throw**
 *   到会话层；stderr 保留尾部最多 {@link STDERR_TAIL_LIMIT} 字符便于排障。`probeVersion` 与
 *   `listBoxesRaw` 的失败额外给出 {@link CliFailureReason}，让调用方把「超时」与「没装 CLI」分开处理。
 * - 退出码 0 不算成功凭据：`wake`/`start`/`resume` 还要求 stderr 里没有 CLI 自报错误
 *   （实测 `wake` 对人工暂停的箱退出码 0 + `instabox: error machine_not_running`）。
 * - 结果类型是可辨识联合（`ok: true` 与 `ok: false` 两个分支，失败分支必带 `error`），
 *   调用方靠 `if (!result.ok)` 收窄，不写 `error?: string` 之类的可选字段。
 */

import { DEFAULT_CONFIG } from "./config.ts";
import { logEvent } from "./log.ts";

/**
 * 加载期 `version` 探测预算：不得拖慢会话启动（方案 R8）。
 * 取 3 秒而不是更短：本机 `instabox version` 实测 803–1178ms（pnpm shim → node 冷启动），
 * 而 pi 加载期并发初始化会再叠加启动开销；1200ms 实测 5 次里 2 次被误杀，导致扩展
 * 整个自禁用（约 30–40% 冷启动误判）。正常情况约 1 秒即返回，只有真正变慢时才吃满预算。
 */
export const PROBE_VERSION_TIMEOUT_MS = 3_000;

/**
 * `ls --json` 预算。取 10 秒而不是更短：`instabox ls` 先付 CLI 冷启动成本（pnpm shim → node，
 * 与 `version` 同一量级：实测 803–1178ms），再走远端 API 拉箱列表；真实加载里连续 6 次有 2 次
 * 被 3000ms 杀掉（用户看到「桌面工具尚未注册（cannot list boxes: instabox ls was killed after
 * 3000ms）」）。`ls` 只在后台/唤醒链路径跑（不阻塞工具调用），10 秒不会拖住会话；
 * `session_start` 后台拉取的总体时效由调用方自己的预算把关。
 */
export const LIST_BOXES_TIMEOUT_MS = 10_000;

/** `instabox exec --timeout` 的单位是秒，CLI 侧上限 600 秒。 */
export const EXEC_TIMEOUT_MAX_SECONDS = 600;

/** `exec` 远端命令默认预算（对齐 D7 的 `tools/call` 120 秒）。 */
export const EXEC_REMOTE_TIMEOUT_MS = 120_000;

/** 本地等待相对远端预算的余量：让 CLI 先超时，本地只做兜底。 */
export const EXEC_LOCAL_GRACE_MS = 5_000;

/** 失败原因里保留的 stderr 尾部字符数。 */
export const STDERR_TAIL_LIMIT = 500;

/** CLI 可执行文件名（argv[0]，不经 shell）。 */
const INSTABOX_BIN = "instabox";

/** 与宿主 `pi.exec` 兼容的选项子集（宿主 `ExecOptions` 的超集方向可赋值）。 */
export interface ExecOptionsLike {
	/** 超时毫秒数，由 `ExecFn` 实现方执行 */
	timeout?: number;
	/** 取消信号 */
	signal?: AbortSignal;
	/** 工作目录 */
	cwd?: string;
	/** 输出字节上限 */
	maxBuffer?: number;
}

/**
 * 与宿主 `pi.exec` 兼容的返回子集：`stdout`/`stderr`/`code` 必有，
 * `killed`/`truncated` 可选（宿主 `ExecResult` 两个都带，因此仍可赋值）。
 */
export interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
	/** 被宿主终止（超时 / abort / 输出超 `maxBuffer`） */
	killed?: boolean;
	/** 输出超 `maxBuffer`，内容不完整 */
	truncated?: boolean;
}

/**
 * 注入的执行函数：签名与宿主 `pi.exec` 一致（少用字段全部可选），
 * 装配处可直接传 `(command, args, opts) => pi.exec(command, args, opts)`。
 */
export type ExecFn = (command: string, args: string[], opts?: ExecOptionsLike) => Promise<ExecResultLike>;

/**
 * 一次性命令的失败分类——决定调用方能不能据此禁用/放弃重试：
 * - `missing`：命令不可用（ENOENT / not found），可直接判定「没装 CLI」；
 * - `timeout`：被宿主杀掉（`killed: true`，超时/abort）。**不等于**没装 CLI，通常值得重试一次；
 * - `not-running`：生命周期命令确认箱根本没跑起来（实测 `wake` 对人工暂停的箱退出码 0，
 *   只在 stderr 自报 `machine_not_running`）——只能靠 `start`/`resume` 补救，重试同一命令没用；
 *   只有 `wake`/`start`/`resume` 会产出该值，探测与 `ls` 永远不返回它；
 * - `error`：CLI 在，但非 0 退出 / 输出不可用 / 注入实现抛了别的异常。
 */
export type CliFailureReason = "missing" | "timeout" | "not-running" | "error";

/** `probeVersion` 结果：成功必带版本串，失败必带原因文本与可分支处理的 {@link CliFailureReason}。 */
export type ProbeVersionResult =
	| { ok: true; version: string }
	| { ok: false; error: string; reason: CliFailureReason };

/**
 * `listBoxesRaw` 结果：JSON 解析交给 `boxes.ts`，本层只保证是合法 JSON 值。
 * 失败分支带 {@link CliFailureReason}：`timeout` 表示「慢」而不是「箱列表不对」，调用方可重试。
 */
export type ListBoxesRawResult =
	| { ok: true; json: unknown }
	| { ok: false; error: string; reason: CliFailureReason };

/**
 * `wake` / `start` / `resume` 的统一结果（失败**不 throw**）。
 * `stderrTail` 两个分支都可能存在（成功时的进度信息不丢），最多 {@link STDERR_TAIL_LIMIT} 字符；
 * 失败分支必带 {@link CliFailureReason}（其中 `not-running` 只可能来自这三个命令）。
 */
export type CliOutcome =
	| { ok: true; stderrTail?: string }
	| { ok: false; error: string; reason: CliFailureReason; stderrTail?: string };

/** `execRemote` 结果：额外带回远端 stdout（失败时保留已产生的部分输出）。 */
export type RemoteExecOutcome =
	| { ok: true; stdout: string; stderrTail?: string }
	| { ok: false; error: string; stdout?: string; stderrTail?: string };

/** 一次性命令的通用可选项。 */
export interface CliRunOptions {
	/** 覆盖该函数自己的超时预算（毫秒） */
	timeout?: number;
	/** 透传给 `ExecFn` 的取消信号 */
	signal?: AbortSignal;
}

/** `execRemote` 可选项：远端秒级预算与本地毫秒级兜底分开写。 */
export interface ExecRemoteOptions {
	/** 远端命令预算（毫秒），默认 {@link EXEC_REMOTE_TIMEOUT_MS}；转整数秒并钳制到 [1, 600] */
	timeoutMs?: number;
	/** 本地等待上限（毫秒），默认「钳制后的远端秒数 × 1000 + {@link EXEC_LOCAL_GRACE_MS}」 */
	execTimeoutMs?: number;
	/** 透传给 `ExecFn` 的取消信号 */
	signal?: AbortSignal;
}

/** 单次 `ExecFn` 调用：抛异常在这里被收成 `ok: false`。 */
type CliCall = { ok: true; result: ExecResultLike } | { ok: false; error: string };

/**
 * 「命令不可用」的文本特征：宿主 `pi.exec` 把 spawn 失败收成 `code: 1` +
 * `stderr: "spawn instabox ENOENT"`（`core/exec.js` 的 child-process 错误分支），
 * 而注入的其它实现可能直接抛同样文本的异常——两种都要认。
 *
 * 取舍（两个方向的代价不对称）：误判 `missing` 会让调用方**直接自禁用**整个扩展，而误判
 * `error` 顶多多走一次慢探测 / 一次会话内重试。所以这里只认**真正的 spawn / 查找失败形态**，
 * 不收裸的 `no such file or directory`（业务输出里很常见，例如「配置文件 … no such file or
 * directory」），也不收裸的 `not found`。
 *
 * 认的形态：`ENOENT`（宿主 `spawn instabox ENOENT` / 注入实现抛的同文本）、`command not found`、
 * `spawn <cmd> EACCES|ENOENT`、`errno -2/-13`（EACCES 也是「跑不起来」）。
 */
const MISSING_BIN_RE = /\bENOENT\b|command not found|spawn .* (ENOENT|EACCES)|errno -(2|13)\b/i;

/**
 * CLI 自己的错误信封：`instabox: error <code>: <message> [request …]`（本轮实测的 `wake` 输出）。
 * 二进制里只有一个这样的格式化串（`instabox: error %s`），所以三个生命周期命令共用。
 */
const CLI_ERROR_LINE_RE = /^instabox: error /m;

/**
 * 「箱没在跑」的证据串。实测 `instabox wake <box>`（用户手动 suspend）：**退出码 0**，stderr 为
 * `instabox: error machine_not_running: machine is suspended; start it first [request …]`
 * + `hint: start it with \`instabox start <sandbox>\``，而沙箱状态不变。
 * 两项任一命中即判失败（关键词兼做信封被包装/缩进时的兜底）。
 */
const NOT_RUNNING_RE = /machine_not_running|start it with/i;

/**
 * `instabox exec` 的 `--timeout` 秒数：向上取整、下限 1 秒、上限 {@link EXEC_TIMEOUT_MAX_SECONDS}。
 * 非有限值（NaN/Infinity）按上限处理，绝不把非法秒数交给 CLI。
 */
export function remoteTimeoutSeconds(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs)) return EXEC_TIMEOUT_MAX_SECONDS;
	const seconds = Math.ceil(timeoutMs / 1000);
	return Math.min(EXEC_TIMEOUT_MAX_SECONDS, Math.max(1, seconds));
}

/**
 * 加载期探活：`instabox version`，默认 {@link PROBE_VERSION_TIMEOUT_MS}。
 * CLI 不存在（ENOENT）/ 非 0 / 超时都返回 `ok: false`，**不抛**；失败按 {@link CliFailureReason} 分类。
 *
 * 调用方注意：**探测超时不等于没装 CLI**。`instabox version` 走 pnpm shim → node 冷启动，
 * 加载期并发初始化下可能吃满预算；只有 `reason === "missing"` 才能直接判定「未找到 instabox CLI」，
 * `reason === "timeout"` 时应（用同一份 `exec`）**重试一次**再决定是否禁用扩展，否则慢一次启动就
 * 整个扩展自禁用。
 */
export async function probeVersion(exec: ExecFn, opts: CliRunOptions = {}): Promise<ProbeVersionResult> {
	const startedAt = Date.now();
	const timeout = opts.timeout ?? PROBE_VERSION_TIMEOUT_MS;
	const label = "instabox version";
	const call = await runOnce(exec, label, ["version"], { timeout, signal: opts.signal });
	if (!call.ok) {
		const reason = classifyFailure(call.error, false);
		logEvent("cli.probe", { ok: false, reason, ms: Date.now() - startedAt }, "warn");
		return { ok: false, error: call.error, reason };
	}
	const { result } = call;
	// 宿主对超时/abort 回 `killed: true`（`code` 可能仍是 0）→ 归为 timeout，不当作「CLI 有问题」
	if (failed(result)) {
		const error = describeFailure(label, result, timeout);
		const reason = classifyFailure(error, result.killed === true);
		logEvent("cli.probe", { ok: false, reason, ms: Date.now() - startedAt }, "warn");
		return { ok: false, error, reason };
	}
	const version = firstLine(result.stdout);
	if (!version) {
		logEvent("cli.probe", { ok: false, reason: "error", ms: Date.now() - startedAt }, "warn");
		return { ok: false, error: `${label} printed no version text`, reason: "error" };
	}
	logEvent("cli.probe", { ok: true, version, ms: Date.now() - startedAt });
	return { ok: true, version };
}

/**
 * `instabox ls --json`，默认 {@link LIST_BOXES_TIMEOUT_MS}。
 * 只保证「命令成功 + 输出是合法 JSON」；结构与字段校验属 `boxes.ts`。
 * 失败按 {@link CliFailureReason} 分类：`timeout`（被 `killed`）应重试，不是箱列表坏了。
 */
export async function listBoxesRaw(exec: ExecFn, opts: CliRunOptions = {}): Promise<ListBoxesRawResult> {
	const startedAt = Date.now();
	const timeout = opts.timeout ?? LIST_BOXES_TIMEOUT_MS;
	const label = "instabox ls";
	const call = await runOnce(exec, label, ["ls", "--json"], { timeout, signal: opts.signal });
	if (!call.ok) {
		const reason = classifyFailure(call.error, false);
		logEvent("cli.ls", { ok: false, count: 0, reason, ms: Date.now() - startedAt, timeoutMs: timeout });
		return { ok: false, error: call.error, reason };
	}
	const { result } = call;
	if (failed(result)) {
		const error = describeFailure(label, result, timeout);
		const reason = classifyFailure(error, result.killed === true);
		logEvent("cli.ls", { ok: false, count: 0, reason, ms: Date.now() - startedAt, timeoutMs: timeout });
		return { ok: false, error, reason };
	}
	try {
		const json: unknown = JSON.parse(result.stdout);
		// 顶层数组长度就是箱数；非数组（结构不对）记 0，解析容错仍由 `boxes.ts` 负责
		logEvent("cli.ls", { ok: true, count: Array.isArray(json) ? json.length : 0, ms: Date.now() - startedAt, timeoutMs: timeout });
		return { ok: true, json };
	} catch {
		logEvent("cli.ls", { ok: false, count: 0, reason: "error", ms: Date.now() - startedAt, timeoutMs: timeout });
		return {
			ok: false,
			error: `instabox ls --json returned invalid JSON: ${tail(result.stdout)}`,
			reason: "error",
		};
	}
}

/**
 * `instabox wake <box>`：只唤「自己暂停」的箱，默认预算 {@link DEFAULT_CONFIG.timeouts.wakeMs}
 * （20 秒，是**单步上限**；整段准备阶段的上界由 `prepareMs` 的截止时间管）。
 * 人工 `suspend`/`stop` 的箱必然失败 → 由 `pool.ts` 退到 `start`/`resume`。
 * 注意：这条失败是**退出码 0 + stderr 自报**（见 {@link reportedFailure}），所以不能只看退出码。
 */
export function wake(exec: ExecFn, box: string, opts: CliRunOptions = {}): Promise<CliOutcome> {
	return runLifecycle(exec, "wake", box, DEFAULT_CONFIG.timeouts.wakeMs, opts);
}

/** `instabox start <box>`：人工 `suspend`/`stop` 后的箱（`wake` 不覆盖），默认预算 `startMs`。 */
export function start(exec: ExecFn, box: string, opts: CliRunOptions = {}): Promise<CliOutcome> {
	return runLifecycle(exec, "start", box, DEFAULT_CONFIG.timeouts.startMs, opts);
}

/** `instabox resume <box>`：与 `start` 同预算（`startMs`）。 */
export function resume(exec: ExecFn, box: string, opts: CliRunOptions = {}): Promise<CliOutcome> {
	return runLifecycle(exec, "resume", box, DEFAULT_CONFIG.timeouts.startMs, opts);
}

/**
 * `instabox exec <box> --timeout <秒> -- <argv...>`：在目标箱里跑一条命令。
 * argv 逐元素透传（不经 shell 拼接），时间和 `signal` 见 {@link ExecRemoteOptions}。
 */
export async function execRemote(
	exec: ExecFn,
	box: string,
	argv: readonly string[],
	opts: ExecRemoteOptions = {},
): Promise<RemoteExecOutcome> {
	const startedAt = Date.now();
	const seconds = remoteTimeoutSeconds(opts.timeoutMs ?? EXEC_REMOTE_TIMEOUT_MS);
	const localTimeout = opts.execTimeoutMs ?? seconds * 1000 + EXEC_LOCAL_GRACE_MS;
	const label = `instabox exec ${box}`;
	const args = ["exec", box, "--timeout", String(seconds), "--", ...argv];
	const call = await runOnce(exec, label, args, { timeout: localTimeout, signal: opts.signal });
	if (!call.ok) {
		logEvent("cli.exec", { box, timeoutSec: seconds, ok: false, ms: Date.now() - startedAt });
		return { ok: false, error: call.error };
	}
	const stderrTail = tailOrUndefined(call.result.stderr);
	if (failed(call.result)) {
		logEvent("cli.exec", { box, timeoutSec: seconds, ok: false, ms: Date.now() - startedAt });
		return { ok: false, error: describeFailure(label, call.result, localTimeout), stderrTail, stdout: call.result.stdout };
	}
	logEvent("cli.exec", { box, timeoutSec: seconds, ok: true, ms: Date.now() - startedAt });
	return { ok: true, stdout: call.result.stdout, stderrTail };
}

/** `wake`/`start`/`resume` 共用实现：只有子命令与默认预算不同。 */
async function runLifecycle(
	exec: ExecFn,
	subcommand: "wake" | "start" | "resume",
	box: string,
	defaultTimeoutMs: number,
	opts: CliRunOptions,
): Promise<CliOutcome> {
	const startedAt = Date.now();
	const timeout = opts.timeout ?? defaultTimeoutMs;
	const label = `instabox ${subcommand} ${box}`;
	const call = await runOnce(exec, label, [subcommand, box], { timeout, signal: opts.signal });
	if (!call.ok) {
		const reason = classifyLifecycleFailure(call.error, false);
		logEvent("cli.lifecycle", {
			command: subcommand,
			box,
			ok: false,
			reason,
			ms: Date.now() - startedAt,
			timeoutMs: timeout,
		});
		return { ok: false, error: call.error, reason };
	}
	const { result } = call;
	const stderrTail = tailOrUndefined(result.stderr);
	// 退出码 0 不等于成功：CLI 会用 stderr 自报错误（实测 `wake` 对人工暂停的箱）
	const reported = reportedFailure(result.stderr);
	if (failed(result) || reported !== undefined) {
		const error =
			reported === undefined ? describeFailure(label, result, timeout) : `${label} reported an error: ${tail(reported)}`;
		const reason = classifyLifecycleFailure(error, result.killed === true);
		logEvent("cli.lifecycle", {
			command: subcommand,
			box,
			ok: false,
			reason,
			ms: Date.now() - startedAt,
			timeoutMs: timeout,
		});
		return { ok: false, error, reason, stderrTail };
	}
	logEvent("cli.lifecycle", {
		command: subcommand,
		box,
		ok: true,
		ms: Date.now() - startedAt,
		timeoutMs: timeout,
	});
	return { ok: true, stderrTail };
}

/**
 * 退出码 0 时仍要判失败的形态：CLI 在 stderr 上自报错误（错误信封或「箱没在跑」证据串）。
 * 成功路径的 stderr 只有进度文本（如 `waking …`），不会被误判。
 * 三个生命周期命令共用同一份判定：错误信封是 CLI 全局唯一的格式化串（`instabox: error %s`），
 * 不随子命令变化。
 */
function reportedFailure(stderr: string): string | undefined {
	const text = stderr.trim();
	if (!text) return undefined;
	return CLI_ERROR_LINE_RE.test(text) || NOT_RUNNING_RE.test(text) ? text : undefined;
}

/** 生命周期命令的失败分类：被杀 → timeout；CLI 报「箱没在跑」→ not-running；其余走通用三分。 */
function classifyLifecycleFailure(failureText: string, killed: boolean): CliFailureReason {
	if (killed) return "timeout";
	if (NOT_RUNNING_RE.test(failureText)) return "not-running";
	return classifyFailure(failureText, false);
}

/** 唯一调用 `ExecFn` 的地方：异常统一收成 `ok: false`，绝不外抛。 */
async function runOnce(
	exec: ExecFn,
	label: string,
	args: readonly string[],
	opts: ExecOptionsLike,
): Promise<CliCall> {
	try {
		const result = await exec(INSTABOX_BIN, [...args], opts);
		return { ok: true, result };
	} catch (err) {
		return { ok: false, error: `${label} failed: ${errorText(err)}` };
	}
}

/** 非 0 退出或被宿主杀掉（超时/abort/输出超限）都算失败。 */
function failed(result: ExecResultLike): boolean {
	return result.code !== 0 || result.killed === true;
}

/**
 * 失败分类（`probeVersion` 与 `listBoxesRaw` 共用）：
 * `killed` 一律归 `timeout`，否则看文本是否指向「命令不存在」，其余都是 `error`。
 */
function classifyFailure(text: string, killed: boolean): CliFailureReason {
	if (killed) return "timeout";
	return MISSING_BIN_RE.test(text) ? "missing" : "error";
}

/** 失败文本：退出码或超时说明，并附 stderr 尾部。 */
function describeFailure(label: string, result: ExecResultLike, timeoutMs: number): string {
	const what = result.killed === true ? `was killed after ${timeoutMs}ms` : `exited with code ${result.code}`;
	const stderr = tailOrUndefined(result.stderr);
	return stderr ? `${label} ${what}: ${stderr}` : `${label} ${what}`;
}

/** 保留文本尾部，最多 {@link STDERR_TAIL_LIMIT} 字符（尾部才是根因）。 */
function tail(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= STDERR_TAIL_LIMIT ? trimmed : trimmed.slice(trimmed.length - STDERR_TAIL_LIMIT);
}

/** 同上，但空文本回 `undefined`（调用方据此决定字段是否存在）。 */
function tailOrUndefined(text: string): string | undefined {
	const trimmed = text.trim();
	return trimmed ? tail(trimmed) : undefined;
}

/** 取首行（`instabox version` 只认第一行版本串）。 */
function firstLine(text: string): string | undefined {
	const line = text.split("\n")[0]?.trim();
	return line ? line : undefined;
}

/** 异常转文本（保持 `error` 可直接展示）。 */
function errorText(err: unknown): string {
	if (err instanceof Error) return err.message || err.name;
	return String(err);
}
