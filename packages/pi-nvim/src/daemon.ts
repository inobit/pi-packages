/**
 * @inobit/pi-nvim — 常驻 daemon 生命周期＋请求传输（Phase 1：CLI 通道）。
 *
 * 契约（方案 §四/§六/§九）：
 * - per-(session,pid) socket：`<base>/pi-nvim-<session>-<pid>/nvim.sock`，
 *   base＝XDG_RUNTIME_DIR 回退 os.tmpdir()（sockDir 配置可覆盖），目录权限 0700。
 * - 探活：`net.connect(sock)` 通即复用；ENOENT/ECONNREFUSED 视为无/僵，unlink 后重起。
 * - 就绪双条件：`<sockdir>/ready` 存在＋connect 通。
 * - 请求：写 `<sockdir>/req-<n>.json`（{files}＋budgets）→ 短命 sender
 *   `nvim --server sock --remote-send ":lua PiNvim.<fn>('<req>','<res>')<CR>"`
 *   （sender 失败一次即判 daemon 死）→ 50ms 轮询 `<sockdir>/res-<n>.json`
 *   （有界＋signal 中断回 partial）→ 读后 unlink 两文件。
 * - spawn 成功后 GC 同 session 兄弟目录（仅删 connect 已死的）。
 * - 同一 daemon 对内互斥队列串行（对外靠工具 executionMode sequential）。
 * - 卡死覆盖：请求超时→SIGTERM→2s→SIGKILL→unlink→重起（下次 ensure）。
 *
 * daemon 真机行为不进单测（靠冒烟）；纯逻辑（路径消毒、Vim 转义、互斥）可单测。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { NvimConfig } from "./config.ts";
import { ERROR_TEXT_LIMIT, truncateError } from "./result.ts";

/** daemon 启动日志文件名（stderr 重定向，启动健康检查用） */
export const DAEMON_LOG_NAME = "daemon.log";

/** 启动健康只看日志尾部行数（有界读取，防大日志） */
export const DAEMON_LOG_TAIL_LINES = 20;

/** 启动错误行匹配（nvim 配置报错特征；命中即 degraded，不 throw） */
export const DAEMON_LOG_ERROR_RE = /Error detected while processing|^E\d+:/;

/**
 * 日志尾部 degraded 行提取（纯函数，可单测）：取末 tailN 行，命中错误正则的逐行走错误截断。
 * 调用方读文件后调此函数；文件缺失/为空即 []（healthy）。
 */
export function degradedLinesFromLog(logText: string, tailN: number = DAEMON_LOG_TAIL_LINES, cap: number = ERROR_TEXT_LIMIT): string[] {
	if (!logText) return [];
	const lines = logText.split("\n");
	const tail = lines.slice(Math.max(0, lines.length - tailN));
	return tail.filter((l) => DAEMON_LOG_ERROR_RE.test(l)).map((l) => truncateError(l, cap));
}

/**
 * degraded 下次 ensure 是否强制 fresh 重起（纯函数，可单测）：瘸配置修完即生效，
 * 修不好则每次重起后仍 degraded（调用方照常 surface degraded，不隐藏）。
 */
export function shouldForceFresh(prevDegraded: boolean): boolean {
	return prevDegraded;
}

/** 同步读日志尾 degraded 行（文件缺失即 healthy，不抛错） */
export function readDegradedLines(logPath: string, tailN: number = DAEMON_LOG_TAIL_LINES, cap: number = ERROR_TEXT_LIMIT): string[] {
	try {
		// 有界尾读：只读最后 64KB（病态刷屏日志不进内存），再取尾 tailN 行
		const fd = fs.openSync(logPath, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const start = Math.max(0, size - 65536);
			const buf = Buffer.alloc(size - start);
			fs.readSync(fd, buf, 0, buf.length, start);
			return degradedLinesFromLog(buf.toString("utf8"), tailN, cap);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return [];
	}
}

/** daemon 日志路径（随 socket 目录，GC/退出时同目录回收） */
export function logPathFor(sockDir: string): string {
	return path.join(sockDir, DAEMON_LOG_NAME);
}

/** 请求种类（桥接入口名一一对应） */
export type BridgeFn = "diagnose" | "format";

/** daemon 请求体（随 req-<n>.json 落盘） */
export interface DaemonRequest {
	files: string[];
	attachMs: number;
	diagMs: number;
}

/** 请求计数器（req/res 文件名后缀，进程内单调） */
let reqCounter = 0;

/** session id 目录消毒：uuidv7 本就是 [A-Za-z0-9._-] 安全集，此处做防御性替换 */
export function sanitizeSessionId(session: string): string {
	const clean = session.replaceAll(/[^A-Za-z0-9._-]/g, "_");
	return clean === "" ? "unknown" : clean;
}

/** socket 父目录基址：配置覆盖 → XDG_RUNTIME_DIR → os.tmpdir() */
export function sockBaseDir(cfg: Pick<NvimConfig, "sockDir">): string {
	if (cfg.sockDir !== "") return cfg.sockDir;
	const xdg = process.env.XDG_RUNTIME_DIR;
	if (xdg && xdg !== "") return xdg;
	return os.tmpdir();
}

/** per-(session,pid) socket 目录 */
export function socketDirFor(base: string, session: string, pid: number): string {
	return path.join(base, `pi-nvim-${sanitizeSessionId(session)}-${pid}`);
}

/** socket 文件路径（恒名 nvim.sock，评审 P2-6 钉死项） */
export function sockPathFor(sockDir: string): string {
	return path.join(sockDir, "nvim.sock");
}

/** 同 session 兄弟目录前缀（GC 扫描用） */
export function siblingPrefix(session: string): string {
	return `pi-nvim-${sanitizeSessionId(session)}-`;
}

/**
 * Lua 单引号字符串转义：`\` → `\\`，`'` → `\'`。
 * 请求路径经 --remote-send 按键式 `:lua PiNvim.f('<req>','<res>')` 传入，
 * 反斜杠原样进 cmdline 再由 Lua 解析，故此处按 Lua 字面量转义。
 */
export function vimEscapeLuaString(s: string): string {
	return s.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

/** 拼 remote-send 按键串（短命 sender 用；sender 失败一次即判 daemon 死） */
export function remoteSendKeys(fn: BridgeFn, reqPath: string, resPath: string): string {
	return `:lua PiNvim.${fn}('${vimEscapeLuaString(reqPath)}','${vimEscapeLuaString(resPath)}')<CR>`;
}

/** daemon 自检互斥队列：同一 daemon 的并发请求串行（对外另有 sequential） */
export class DaemonMutex {
	private tail: Promise<void> = Promise.resolve();

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function unlinkIfExists(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {
		// 不存在即达到目的
	}
}

/** connect 探活：通＝有活监听者；ENOENT/ECONNREFUSED＝无/僵 */
export function probeSocket(sockPath: string, timeoutMs = 2000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(sockPath);
		let done = false;
		const finish = (alive: boolean): void => {
			if (done) return;
			done = true;
			try {
				socket.destroy();
			} catch {
				// 忽略
			}
			resolve(alive);
		};
		socket.on("connect", () => finish(true));
		socket.on("error", () => finish(false));
		socket.setTimeout(timeoutMs, () => finish(false));
	});
}

export interface DaemonHandles {
	cfg: NvimConfig;
	packageRoot: string;
	bridgePath: string;
	/** 当前 session 的 socket 目录（session_start 备好，懒启动前无进程） */
	sockDir: string;
	sockPath: string;
	readyPath: string;
	pidPath: string;
	/** daemon stderr 日志（启动健康检查读尾 20 行） */
	logPath: string;
	/** 启动健康 degraded 行（healthy 为空；content 头行＋details 同源，走错误截断） */
	degradedLines?: string[];
	childPid?: number;
}

export interface EnsureOptions {
	sessionId: string;
	cwd: string;
}

/**
 * Daemon 管理器：单 session 单实例（index.ts 持有），对内互斥串行。
 * spawn 细节（nvim 二进制、env、GC）见方法内注释；真机行为靠冒烟验证。
 */
export class DaemonManager {
	private readonly mutex = new DaemonMutex();
	private handles?: DaemonHandles;
	private ensuredKey?: string;
	/** 上次 ensure 是否 degraded（degraded 下次 ensure 强制 fresh 重起，瘸配置修完即生效） */
	private prevDegraded = false;

	constructor(
		private cfg: NvimConfig,
		private readonly packageRoot: string,
		private readonly bridgePath: string,
	) {}

	/** 配置热更新（session_start 刷新后调用；路径按新配置重算） */
	setConfig(cfg: NvimConfig): void {
		this.cfg = cfg;
		this.handles = undefined;
		this.ensuredKey = undefined;
		this.prevDegraded = false;
	}

	getConfig(): NvimConfig {
		return this.cfg;
	}

	/** session_start 调用：只备好路径，不 spawn（懒启动） */
	prepare(sessionId: string): DaemonHandles {
		const key = `${sessionId}:${process.pid}`;
		if (this.handles && this.ensuredKey === key) return this.handles;
		const sockDir = socketDirFor(sockBaseDir(this.cfg), sessionId, process.pid);
		this.handles = {
			cfg: this.cfg,
			packageRoot: this.packageRoot,
			bridgePath: this.bridgePath,
			sockDir,
			sockPath: sockPathFor(sockDir),
			readyPath: path.join(sockDir, "ready"),
			pidPath: path.join(sockDir, "daemon.pid"),
			logPath: logPathFor(sockDir),
			degradedLines: undefined,
			childPid: undefined,
		};
		this.ensuredKey = key;
		return this.handles;
	}

	/** 互斥入口：诊断/格式化请求走此串行 */
	runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		return this.mutex.runExclusive(fn);
	}

/**
	 * ensure 三档：healthy（就绪＋日志干净）／degraded（就绪但日志尾 20 行命中报错特征，
	 * surface 给模型，不 throw）／failed（spawn 失败 throw 不变）。
	 * connect 通即复用（复用也要读日志定档）；degraded 下次 ensure 强制 fresh 重起。
	 */
	async ensure(opts: EnsureOptions): Promise<DaemonHandles> {
		const h = this.prepare(opts.sessionId);
		if (shouldForceFresh(this.prevDegraded)) {
			// 上次 degraded：强制 fresh（瘸配置修完即生效；修不好则本次仍 degraded，照常 surface）
			await this.killStuck(h).catch(() => undefined);
			unlinkIfExists(h.sockPath);
			await this.spawnDaemon(h, opts.cwd);
			await this.waitReady(h);
			await this.gcSiblings(opts.sessionId, h.sockDir).catch(() => undefined);
			this.refreshHealth(h);
			return h;
		}
		if (await probeSocket(h.sockPath)) {
			this.refreshHealth(h);
			return h;
		}
		// 僵尸或从未启动：unlink 后重起（pid 复用撞名天然覆盖）
		unlinkIfExists(h.sockPath);
		await this.spawnDaemon(h, opts.cwd);
		await this.waitReady(h);
		// spawn 成功后 GC 同 session 兄弟目录（connect 已死的才整目录删）
		await this.gcSiblings(opts.sessionId, h.sockDir).catch(() => undefined);
		this.refreshHealth(h);
		return h;
	}

	/** 就绪后读日志尾 20 行定档（healthy/degraded；failed 走 throw 不经此） */
	private refreshHealth(h: DaemonHandles): void {
		const lines = readDegradedLines(h.logPath, DAEMON_LOG_TAIL_LINES, this.cfg.errorCap);
		h.degradedLines = lines.length > 0 ? lines : undefined;
		this.prevDegraded = lines.length > 0;
	}

	private async spawnDaemon(h: DaemonHandles, cwd: string): Promise<void> {
		fs.mkdirSync(h.sockDir, { recursive: true, mode: 0o700 });
		try {
			fs.chmodSync(h.sockDir, 0o700);
		} catch {
			// 非 POSIX 平台忽略
		}
		unlinkIfExists(h.readyPath);
		unlinkIfExists(h.pidPath);
		// stderr 重定向进 daemon.log（启动健康读尾 20 行；随 socket 目录 GC/退出回收）
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_NVIM_SOCK_DIR: h.sockDir,
			PI_NVIM_IDLE_MS: String(this.cfg.idleMs),
			PI_NVIM_PARENT_POLL_MS: String(this.cfg.parentPollMs),
			PI_NVIM_ATTACH_MS: String(this.cfg.timeouts.attachMs),
			PI_NVIM_DIAG_MS: String(this.cfg.timeouts.diagMs),
		};
		const args = [
			"--headless",
			"-n",
			"-i",
			"NONE",
			"--listen",
			h.sockPath,
			"-c",
			`luafile ${h.bridgePath.replaceAll(" ", "\\ ")}`,
		];
		await new Promise<void>((resolve, reject) => {
			let logFd = -1;
			try {
				// P1-1：必须 "w"（fresh 日志）：append 会让修好配置后的 daemon 仍读到旧报错，degraded 恒真、每次 ensure 强制重起
			logFd = fs.openSync(h.logPath, "w");
			} catch {
				logFd = -1;
			}
			const closeLogFd = (): void => {
				if (logFd >= 0) {
					try {
						fs.closeSync(logFd);
					} catch {
						// 忽略
					}
					logFd = -1;
				}
			};
			const child = spawn(this.cfg.nvimPath, args, {
				cwd,
				env,
				detached: true,
				stdio: logFd >= 0 ? ["ignore", "ignore", logFd] : ["ignore", "ignore", "ignore"],
			});
			child.on("error", (err) => {
				closeLogFd();
				// spawn 失败 throw 不变（failed 档）；异常文走错误截断（非结构化、前重后轻）
				reject(new Error(truncateError(`@inobit/pi-nvim: daemon spawn 失败：${err.message}`, this.cfg.errorCap)));
			});
			// 先等 spawn 成功再 resolve：否则 ENOENT 类错误在 resolve 后触发即被吞。
			child.on("spawn", () => {
				closeLogFd();
				resolve();
			});
			// 启动即脱离：stdio EOF 级联回收靠 :qa!，spawn 侧 unref 不留守
			child.unref();
			h.childPid = child.pid;
			resolve();
		});
	}

	private async waitReady(h: DaemonHandles): Promise<void> {
		const deadline = Date.now() + this.cfg.timeouts.spawnMs;
		for (;;) {
			const ready = fs.existsSync(h.readyPath);
			if (ready && (await probeSocket(h.sockPath))) return;
			if (Date.now() >= deadline) {
				throw new Error(
					truncateError(
						`@inobit/pi-nvim: daemon 启动超时（${this.cfg.timeouts.spawnMs}ms，sock=${h.sockPath}）；` +
							"请确认 nvim 可用且用户配置可 headless 加载。",
						this.cfg.errorCap,
					),
				);
			}
			await sleep(this.cfg.timeouts.pollMs);
		}
	}

	/**
	 * 请求往返：写 req → 短命 sender 发按键 → 轮询 res（50ms，有界＋signal 中断）→ 读后 unlink。
	 * sender spawn 失败一次即判 daemon 死（抛错，下次 ensure 重起）。
	 */
	async request(
		h: DaemonHandles,
		fn: BridgeFn,
		files: string[],
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		reqCounter += 1;
		const n = reqCounter;
		const reqPath = path.join(h.sockDir, `req-${n}.json`);
		const resPath = path.join(h.sockDir, `res-${n}.json`);
		const body: DaemonRequest = {
			files,
			attachMs: this.cfg.timeouts.attachMs,
			diagMs: this.cfg.timeouts.diagMs,
		};
		fs.writeFileSync(reqPath, JSON.stringify(body), "utf8");
		unlinkIfExists(resPath);
		try {
			await this.kickDaemon(h, fn, reqPath, resPath);
			const raw = await this.waitResult(resPath, signal);
			const parsed: unknown = JSON.parse(raw);
			// Lua 侧异常／关闭中：{ error } 结果转抛错（绝不误报 clean；信封文走错误截断）
			if (parsed && typeof parsed === "object" && "error" in parsed) {
				const msg = (parsed as { error?: unknown }).error;
				throw new Error(
					truncateError(`@inobit/pi-nvim: daemon 回错：${typeof msg === "string" ? msg : "unknown"}`, this.cfg.errorCap),
				);
			}
			return parsed;
		} finally {
			// P2-6 已知残留：中断后 Lua 侧无中断通道，会续写完 res 文件（孤儿重建，有界；同 session GC 与退出删目录时回收）
			unlinkIfExists(reqPath);
			unlinkIfExists(resPath);
		}
	}

	private async kickDaemon(
		h: DaemonHandles,
		fn: BridgeFn,
		reqPath: string,
		resPath: string,
	): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				this.cfg.nvimPath,
				["--server", h.sockPath, "--remote-send", remoteSendKeys(fn, reqPath, resPath)],
				{ stdio: ["ignore", "ignore", "ignore"] },
			);
			child.on("error", (err) => {
				reject(
					new Error(
						truncateError(
							`@inobit/pi-nvim: sender 发起失败（判 daemon 死）：${err.message}；下次调用将重起 daemon。`,
						),
					),
				);
			});
			child.on("exit", (code) => {
				if (code === 0) resolve();
				else
					reject(
						new Error(
							truncateError(`@inobit/pi-nvim: sender 退出码 ${String(code)}（判 daemon 死）；下次调用将重起 daemon。`, this.cfg.errorCap),
						),
					);
			});
		});
	}

	private async waitResult(resPath: string, signal: AbortSignal | undefined): Promise<string> {
		const deadline = Date.now() + this.cfg.timeouts.requestMs;
		for (;;) {
			if (signal?.aborted) {
				throw new DaemonAbortedError(truncateError("请求被中断（signal aborted），返回 partial。"));
			}
			try {
				// P2-8 已知残留：writefile 与 readFileSync 理论有部分读窗口；小文件风险极低，JSON.parse 失败抛错可重试
				return fs.readFileSync(resPath, "utf8");
			} catch {
				// 结果未到，继续轮询
			}
			if (Date.now() >= deadline) {
				throw new DaemonTimeoutError(
					truncateError(`daemon 请求超时（${this.cfg.timeouts.requestMs}ms）；已判卡死，下次调用将杀重建。`, this.cfg.errorCap),
				);
			}
			await sleep(this.cfg.timeouts.pollMs);
		}
	}

	/** 卡死覆盖：SIGTERM→2s→SIGKILL→unlink（调用方在请求超时后调，下次 ensure 重起） */
	async killStuck(h: DaemonHandles): Promise<void> {
		let pid: number | undefined = h.childPid;
		try {
			const raw = fs.readFileSync(h.pidPath, "utf8").trim();
			const parsed = Number.parseInt(raw, 10);
			if (Number.isFinite(parsed)) pid = parsed;
		} catch {
			// 无 pid 文件就只清 socket 标记
		}
		if (pid !== undefined) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// 已死即达到目的
			}
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline) {
				try {
					process.kill(pid, 0);
				} catch {
					pid = undefined;
					break;
				}
				await sleep(50);
			}
			if (pid !== undefined) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// 忽略
				}
			}
		}
		unlinkIfExists(h.sockPath);
		unlinkIfExists(h.readyPath);
		unlinkIfExists(h.pidPath);
		h.childPid = undefined;
	}

	/**
	 * GC 同 session 兄弟目录：扫 base 下 `pi-nvim-<session>-*`，
	 * 自家跳过；connect 已死的整目录删、活的跳过（同 session 双开永不互删）；
	 * 别家 session 碰都不碰。
	 */
	async gcSiblings(sessionId: string, selfDir: string): Promise<void> {
		const base = sockBaseDir(this.cfg);
		const prefix = siblingPrefix(sessionId);
		let entries: string[];
		try {
			entries = fs.readdirSync(base);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.startsWith(prefix)) continue;
			const dir = path.join(base, entry);
			if (dir === selfDir) continue;
			let stat: fs.Stats;
			try {
				stat = fs.statSync(dir);
			} catch {
				continue;
			}
			if (!stat.isDirectory()) continue;
			const sock = sockPathFor(dir);
			const alive = await probeSocket(sock);
			if (alive) continue;
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// 删不掉留给下次
			}
		}
	}

	/**
	 * session_shutdown 分流后的关闭动作（reload 已在上层跳过）：
	 * fire-and-forget 发 `:lua PiNvim.begin_shutdown()`，不等落子；
	 * socket 已断则 no-op。
	 */
	async beginShutdown(h: DaemonHandles): Promise<void> {
		const alive = await probeSocket(h.sockPath);
		if (!alive) return;
		const child = spawn(
			this.cfg.nvimPath,
			["--server", h.sockPath, "--remote-send", ":lua PiNvim.begin_shutdown()<CR>"],
			{ stdio: ["ignore", "ignore", "ignore"] },
		);
		child.on("error", () => {});
		child.unref();
	}
}

/** 中断即 partial（调用方据此返回已得结果，不抛给模型看作失败） */
export class DaemonAbortedError extends Error {}

/** 请求超时（调用方据此 killStuck 后抛给模型） */
export class DaemonTimeoutError extends Error {}
