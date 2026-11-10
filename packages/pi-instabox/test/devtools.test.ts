/**
 * @inobit/pi-instabox — `src/devtools.ts` 单测。
 *
 * 两段契约：
 * - `buildMcpServerConfig`：注册参数**逐字**（`command: "instabox"`、
 *   `args: ["ssh", <box>, "--", "env", "PATH=…", "chrome-devtools-mcp", ...]`）＋ `exposure` /
 *   `timeout` / 自解释的 `description`。没有脚本、没有中间层，等价于手写 `mcp.json`。
 * - `prepareDevTools`（注册前的普通函数调用）：前半步委托注入的 `ensureReady`（唤醒链的唯一
 *   实现，见 `pool.test.ts`），本模块只做后半步——远端 `chrome-devtools-mcp` 的检查/安装。
 *   这里用假 `ensureReady` 断言「只负责 install 部分」：箱没准备好就整体失败、不再发远端命令；
 *   缺包且 `autoInstallDevTools` 时装一次，装失败只 warn、不阻断。
 *
 * 全程离线：`exec` 与 `ensureReady` 都是假实现，不 spawn 真进程、不等真实时间。
 */

import { describe, expect, it } from "vitest";
import type { ExecResultLike } from "../src/cli.ts";
import { DEFAULT_CONFIG, type InstaboxConfig } from "../src/config.ts";
import { buildMcpServerConfig, prepareDevTools } from "../src/devtools.ts";
import { createMemoryLogger, setLogger } from "../src/log.ts";
import type { EnsureReadyResult, Pool, PoolGetOptions } from "../src/pool.ts";

const REMOTE_PATH = "/opt/npm/bin:/usr/local/bin:/usr/bin:/bin";
const DEVTOOLS_BIN = "chrome-devtools-mcp";

/** 成功的 `pi.exec` 结果。 */
const OK_RESULT: ExecResultLike = { stdout: "", stderr: "", code: 0, killed: false, truncated: false };

/** 远端命令失败（非 0 退出）。 */
const FAILED_RESULT: ExecResultLike = { stdout: "", stderr: "boom", code: 1, killed: false, truncated: false };

/** 被测配置：`remotePath` 钉死成好断言的字面量，`devToolsBox` 给一台默认箱。 */
function config(overrides: Partial<InstaboxConfig> = {}): InstaboxConfig {
	return { ...DEFAULT_CONFIG, remotePath: REMOTE_PATH, devToolsBox: "agent", ...overrides };
}

interface FakeExecOptions {
	/** 远端有没有 `chrome-devtools-mcp`（`command -v` 的结果），默认有 */
	hasBinary?: boolean;
	/** 安装命令是否成功（默认成功） */
	installOk?: boolean;
}

/**
 * 假 `instabox`：DevTools 准备阶段只发 `instabox exec …`，按 argv 分辨「检查」与「安装」。
 * 记录每次调用的 argv 与超时预算供逐字断言（唤醒链不在这里——那是 `pool.ensureReady` 的事）。
 */
function createFakeExec(options: FakeExecOptions = {}) {
	const calls: string[][] = [];
	const timeouts: (number | undefined)[] = [];
	const exec = async (command: string, args: string[], opts?: { timeout?: number }): Promise<ExecResultLike> => {
		calls.push([command, ...args]);
		timeouts.push(opts?.timeout);
		if (command !== "instabox" || args[0] !== "exec") return FAILED_RESULT;
		const remote = args.slice(args.indexOf("--") + 1);
		if (remote.includes("npm")) return options.installOk === false ? FAILED_RESULT : OK_RESULT;
		return options.hasBinary === false ? FAILED_RESULT : OK_RESULT;
	};
	return { exec, calls, timeouts };
}

describe("buildMcpServerConfig", () => {
	const cfg = config();
	const registration = buildMcpServerConfig(cfg);

	it("server 名固定为 instabox-devtools（只允许这一种拼写）", () => {
		expect(registration.name).toBe("instabox-devtools");
	});

	it("command 是 `instabox`，args 就是 `ssh <box> -- env PATH=… chrome-devtools-mcp …`", () => {
		expect(registration.config.command).toBe("instabox");
		expect(registration.config.args).toEqual([
			"ssh",
			"agent",
			"--",
			"env",
			`PATH=${REMOTE_PATH}`,
			DEVTOOLS_BIN,
			...DEFAULT_CONFIG.devToolsArgs,
		]);
		// 不与配置共享数组引用：改配置不影响已构造的注册参数
		expect(registration.config.args).not.toBe(cfg.devToolsArgs);
	});

	it("exposure 钉 codemode、timeout 180（每请求秒数）", () => {
		expect(registration.config.exposure).toBe("codemode");
		expect(registration.config.timeout).toBe(180);
	});

	it("description 自解释：带 box 名、fixed box 语义与 describeNamespace 发现路径", () => {
		const description = registration.config.description;
		expect(description).toContain("instabox 'agent'");
		expect(description).toContain("(fixed box)");
		expect(description).toContain('describeNamespace("mcp__instabox_devtools")');
		expect(description).toContain('searchTools("devtools")');
		// 命名空间由 server 名派生，只允许一种拼写
		expect(description.split("instabox_devtools").length).toBe(2);
	});

	it("显式 box 参数覆盖 cfg.devToolsBox（flag / `/instabox-devtools on` 的动态路径）", () => {
		const dynamic = buildMcpServerConfig(cfg, "libretv");
		expect(dynamic.config.args.slice(0, 2)).toEqual(["ssh", "libretv"]);
		expect(dynamic.config.description).toContain("instabox 'libretv'");
		// cfg 本身不被写回：同一份配置可以反复构造不同 box 的注册
		expect(cfg.devToolsBox).toBe("agent");
		expect(buildMcpServerConfig(cfg).config.args[1]).toBe("agent");
	});

	it("PATH 来自 cfg.remotePath，不硬编码", () => {
		const custom = buildMcpServerConfig(config({ remotePath: "/custom/bin" }));
		expect(custom.config.args[4]).toBe("PATH=/custom/bin");
		expect(custom.config.args).not.toContain(`PATH=${REMOTE_PATH}`);
	});
});

/** 假 `ensureReady`：记录调用参数，返回给定结果（默认成功）。 */
function createFakeEnsureReady(result: EnsureReadyResult = { ok: true }) {
	const calls: { box: string; opts?: PoolGetOptions }[] = [];
	const ensureReady: Pool["ensureReady"] = async (box, opts) => {
		calls.push({ box, opts });
		return result;
	};
	return { ensureReady, calls };
}

describe("prepareDevTools", () => {
	it("先 `ensureReady(box, { allowWake: true })`，成功后只做远端检查（没有唤醒链）", async () => {
		const { exec, calls } = createFakeExec();
		const { ensureReady, calls: readyCalls } = createFakeEnsureReady();

		expect(await prepareDevTools({ exec, ensureReady, box: "agent", cfg: config() })).toEqual({ ok: true });
		expect(readyCalls).toEqual([{ box: "agent", opts: { allowWake: true, signal: undefined } }]);
		// 唤醒链在 `pool.ensureReady` 里，这里只有那一条远端检查
		expect(calls.map((call) => call[1])).toEqual(["exec"]);
	});

	it("远端检查就是 `instabox exec <box> --env PATH=… --timeout 20 -- sh -c 'command -v chrome-devtools-mcp'`", async () => {
		const { exec, calls } = createFakeExec();
		const { ensureReady } = createFakeEnsureReady();

		await prepareDevTools({ exec, ensureReady, box: "agent", cfg: config() });
		expect(calls).toContainEqual([
			"instabox",
			"exec",
			"agent",
			"--env",
			`PATH=${REMOTE_PATH}`,
			"--timeout",
			"20",
			"--",
			"sh",
			"-c",
			`command -v ${DEVTOOLS_BIN}`,
		]);
	});

	it("`ensureReady` 失败 → 整体 ok:false 且沿用它的 error，零远端命令", async () => {
		const { exec, calls } = createFakeExec();
		const { ensureReady } = createFakeEnsureReady({
			ok: false,
			error: 'could not wake box "agent": instabox wake agent reported an error: machine_not_running',
		});

		const result = await prepareDevTools({ exec, ensureReady, box: "agent", cfg: config() });

		expect(result).toEqual({
			ok: false,
			error: 'could not wake box "agent": instabox wake agent reported an error: machine_not_running',
		});
		expect(calls).toEqual([]);
	});

	it("`ensureReady` 抛错 → ok:false，不外抛", async () => {
		const { exec } = createFakeExec();
		const ensureReady: Pool["ensureReady"] = async () => {
			throw new Error("pool exploded");
		};

		expect(await prepareDevTools({ exec, ensureReady, box: "agent", cfg: config() })).toEqual({
			ok: false,
			error: "pool exploded",
		});
	});

	it("远端缺包且 autoInstallDevTools → 装一次 `sudo -n env PATH=… npm i -g chrome-devtools-mcp`（60 秒）", async () => {
		const { exec, calls, timeouts } = createFakeExec({ hasBinary: false });
		const { ensureReady } = createFakeEnsureReady();

		expect(await prepareDevTools({ exec, ensureReady, box: "agent", cfg: config() })).toEqual({ ok: true });
		expect(calls).toContainEqual([
			"instabox",
			"exec",
			"agent",
			"--env",
			`PATH=${REMOTE_PATH}`,
			"--timeout",
			"60",
			"--",
			"sudo",
			"-n",
			"env",
			`PATH=${REMOTE_PATH}`,
			"npm",
			"i",
			"-g",
			DEVTOOLS_BIN,
		]);
		// 本地兜底超时比远端 60 秒宽（先让 CLI 自己超时）
		expect(timeouts[calls.findIndex((call) => call.includes("npm"))]).toBeGreaterThan(60_000);
	});

	it("autoInstallDevTools=false → 缺包也不装，只 warn（结果仍 ok）", async () => {
		const { exec, calls } = createFakeExec({ hasBinary: false });
		const { ensureReady } = createFakeEnsureReady();
		const warnings: string[] = [];

		const result = await prepareDevTools({
			exec,
			ensureReady,
			box: "agent",
			cfg: config({ autoInstallDevTools: false }),
			warn: (message) => warnings.push(message),
		});
		expect(result).toEqual({ ok: true });
		expect(calls.some((call) => call.includes("npm"))).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(DEVTOOLS_BIN);
		expect(warnings[0]).toContain("autoInstallDevTools=false");
	});

	it("安装失败 → 只 warn，结果仍是 ok（不阻断注册）", async () => {
		const { exec } = createFakeExec({ hasBinary: false, installOk: false });
		const { ensureReady } = createFakeEnsureReady();
		const warnings: string[] = [];

		const result = await prepareDevTools({
			exec,
			ensureReady,
			box: "agent",
			cfg: config(),
			warn: (message) => warnings.push(message),
		});
		expect(result).toEqual({ ok: true });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("安装");
		expect(warnings[0]).toContain("boom");
	});

	it("埋点：devtools.prepare 一次一条（ok/ms/error），安装另记 devtools.install", async () => {
		const logger = createMemoryLogger();
		setLogger(logger);
		try {
			const ok = createFakeExec({ hasBinary: false });
			const okReady = createFakeEnsureReady();
			await prepareDevTools({ exec: ok.exec, ensureReady: okReady.ensureReady, box: "agent", cfg: config() });

			const failing = createFakeExec();
			const failingReady = createFakeEnsureReady({ ok: false, error: "box is not usable" });
			await prepareDevTools({
				exec: failing.exec,
				ensureReady: failingReady.ensureReady,
				box: "agent",
				cfg: config(),
			});
		} finally {
			setLogger(undefined);
		}

		const prepare = logger.records.filter((record) => record.event === "devtools.prepare");
		expect(prepare).toHaveLength(2);
		expect(prepare[0]?.fields).toMatchObject({ box: "agent", ok: true });
		expect(prepare[0]?.fields?.error).toBeUndefined();
		expect(prepare[1]?.level).toBe("warn");
		expect(prepare[1]?.fields).toMatchObject({ box: "agent", ok: false, error: "box is not usable" });
		expect(logger.records.some((record) => record.event === "devtools.install")).toBe(true);
	});
});
