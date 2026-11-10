/**
 * @inobit/pi-instabox — `cli.ts` 单测：argv 逐字拼装、超时预算、非 0 退出、stderr 截尾、
 * 异常不外抛、`exec --timeout` 上限钳制、失败 `reason` 三分（missing/timeout/error，探测与 `ls`）。
 *
 * 全部走注入的假 `ExecFn`（记录 command/args/opts 并回放结果），不 spawn 真进程、不联网。
 * `wake`/`start`/`resume` 的默认预算不写数字，而是断言「实际透传的 `timeout` ===
 * `DEFAULT_CONFIG.timeouts` 对应字段」（方案 §4.4：wake 20s / start·resume 30s，都是单步上限）。
 */

import { describe, expect, it } from "vitest";
import {
	type CliOutcome,
	EXEC_LOCAL_GRACE_MS,
	type ExecFn,
	type ExecOptionsLike,
	type ExecResultLike,
	execRemote,
	LIST_BOXES_TIMEOUT_MS,
	listBoxesRaw,
	PROBE_VERSION_TIMEOUT_MS,
	probeVersion,
	resume,
	remoteTimeoutSeconds,
	STDERR_TAIL_LIMIT,
	start,
	wake,
} from "../src/cli.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createMemoryLogger, setLogger } from "../src/log.ts";

/** 一次假调用的快照（逐字断言 command/args/opts）。 */
interface RecordedCall {
	command: string;
	args: string[];
	opts?: ExecOptionsLike;
}

/** 假 ExecFn：记录每次调用，回放固定结果（`Error` 表示抛异常）。 */
function recordingExec(reply: ExecResultLike | Error): { exec: ExecFn; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const exec: ExecFn = async (command, args, opts) => {
		calls.push({ command, args, opts });
		if (reply instanceof Error) throw reply;
		return reply;
	};
	return { exec, calls };
}

/** 成功结果：默认空输出、exit 0。 */
function okResult(stdout = "", stderr = ""): ExecResultLike {
	return { stdout, stderr, code: 0, killed: false, truncated: false };
}

/** 失败结果：非 0 退出。 */
function failResult(code: number, stderr = ""): ExecResultLike {
	return { stdout: "", stderr, code, killed: false, truncated: false };
}

describe("超时预算常量", () => {
	it("探测/ls/本地余量/stderr 截尾与实测对齐", () => {
		// 3s：`instabox version` 冷启动实测 803–1178ms，1200ms 预算会误杀（见 cli.ts 常量注释）
		expect(PROBE_VERSION_TIMEOUT_MS).toBe(3000);
		// 10s：`instabox ls` 还要走远端 API，3s 实测 6 次里 2 次被误杀（见 cli.ts 常量注释）
		expect(LIST_BOXES_TIMEOUT_MS).toBe(10_000);
		expect(EXEC_LOCAL_GRACE_MS).toBe(5000);
		expect(STDERR_TAIL_LIMIT).toBe(500);
	});

	it("生命周期预算单点在 config.ts（wake 20s / start·resume 30s，不另存一份数字）", () => {
		expect(DEFAULT_CONFIG.timeouts.wakeMs).toBe(20_000);
		expect(DEFAULT_CONFIG.timeouts.startMs).toBe(30_000);
		// 两者都是**单步上限**，整段准备阶段的上界是 prepareMs（见 config.test.ts）
		expect(DEFAULT_CONFIG.timeouts.prepareMs).toBe(60_000);
	});
});

describe("probeVersion", () => {
	it("命令与参数逐字为 instabox version，超时默认透传 3000ms", async () => {
		const { exec, calls } = recordingExec(okResult("instabox 0.4.2\n"));
		const result = await probeVersion(exec);
		expect(result).toEqual({ ok: true, version: "instabox 0.4.2" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("instabox");
		expect(calls[0]?.args).toEqual(["version"]);
		expect(calls[0]?.opts?.timeout).toBe(3000);
	});

	it("可覆盖超时并透传 signal", async () => {
		const { exec, calls } = recordingExec(okResult("0.4.2\n"));
		const controller = new AbortController();
		await probeVersion(exec, { timeout: 300, signal: controller.signal });
		expect(calls[0]?.opts?.timeout).toBe(300);
		expect(calls[0]?.opts?.signal).toBe(controller.signal);
	});

	it("非 0 退出返回 ok:false（含退出码与 stderr 尾部、reason=error），不抛", async () => {
		const { exec } = recordingExec(failResult(2, "instabox: permission denied\n"));
		const result = await probeVersion(exec);
		if (result.ok) throw new Error(`expected probeVersion to fail, got ${JSON.stringify(result)}`);
		expect(result).not.toHaveProperty("version");
		expect(result.reason).toBe("error");
		expect(result.error).toContain("instabox version");
		expect(result.error).toContain("code 2");
		expect(result.error).toContain("permission denied");
	});

	it("被宿主杀掉（即便 code 为 0）归为 reason=timeout 并写明超时毫秒数", async () => {
		const { exec } = recordingExec({ stdout: "", stderr: "", code: 0, killed: true, truncated: false });
		const result = await probeVersion(exec);
		if (result.ok) throw new Error(`expected killed probe to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("timeout");
		expect(result.error).toContain("killed after 3000ms");
	});

	it("timeout 可覆盖时失败文本与 reason 同样用覆盖后的预算", async () => {
		const { exec } = recordingExec({ stdout: "", stderr: "", code: 0, killed: true, truncated: false });
		const result = await probeVersion(exec, { timeout: 15_000 });
		if (result.ok) throw new Error(`expected killed probe to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("timeout");
		expect(result.error).toContain("killed after 15000ms");
	});

	it("宿主形态的 ENOENT（code 1 + stderr）归为 reason=missing", async () => {
		const { exec } = recordingExec(failResult(1, "spawn instabox ENOENT\n"));
		const result = await probeVersion(exec);
		if (result.ok) throw new Error(`expected missing CLI to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("missing");
		expect(result.error).toContain("ENOENT");
	});

	it("注入实现直接抛 ENOENT 也归为 reason=missing，异常不外抛", async () => {
		const { exec } = recordingExec(new Error("spawn instabox ENOENT"));
		const result = await probeVersion(exec);
		expect(result).toEqual({
			ok: false,
			error: "instabox version failed: spawn instabox ENOENT",
			reason: "missing",
		});
	});

	it("普通业务错误里的 not found 不误判成 missing（误判 missing 会直接禁用扩展）", async () => {
		const { exec } = recordingExec(failResult(1, "config key not found: devToolsBox\n"));
		const result = await probeVersion(exec);
		if (result.ok) throw new Error(`expected business error to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("error");
	});

	it("业务文案里的 `no such file or directory` 不误判成 missing（宽泛形态已从正则移除）", async () => {
		const { exec } = recordingExec(
			failResult(1, "instabox: failed to read /opt/app/config.yaml: no such file or directory\n"),
		);
		const result = await probeVersion(exec);
		if (result.ok) throw new Error(`expected business error to fail, got ${JSON.stringify(result)}`);
		// 误判 missing 会直接自禁用扩展；判 error 只是多重试一次
		expect(result.reason).toBe("error");
	});

	it("spawn 失败里的 EACCES 也算 missing（命令跑不起来）", async () => {
		const { exec } = recordingExec(failResult(1, "spawn instabox EACCES\n"));
		const result = await probeVersion(exec);
		if (result.ok) throw new Error(`expected missing CLI to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("missing");
	});

	it("注入实现抛其它异常归为 reason=error（不误判成没装 CLI）", async () => {
		const { exec } = recordingExec(new Error("spawn EBUSY"));
		const result = await probeVersion(exec);
		if (result.ok) throw new Error(`expected thrown exec to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("error");
		expect(result.error).toBe("instabox version failed: spawn EBUSY");
	});

	it("exit 0 但没有版本文本也算失败（reason=error，不假装探活成功）", async () => {
		const { exec } = recordingExec(okResult("\n  \n"));
		const result = await probeVersion(exec);
		if (result.ok) throw new Error(`expected empty version to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("error");
		expect(result.error).toContain("no version text");
	});
});

describe("listBoxesRaw", () => {
	it("命令与参数逐字为 instabox ls --json，超时默认透传 10000ms", async () => {
		const { exec, calls } = recordingExec(okResult('[{"name":"agent"}]\n'));
		const result = await listBoxesRaw(exec);
		expect(result).toEqual({ ok: true, json: [{ name: "agent" }] });
		expect(calls[0]?.command).toBe("instabox");
		expect(calls[0]?.args).toEqual(["ls", "--json"]);
		expect(calls[0]?.opts?.timeout).toBe(10_000);
	});

	it("被宿主杀掉归为 reason=timeout（慢不是错，可重试）", async () => {
		const { exec } = recordingExec({ stdout: "", stderr: "", code: 0, killed: true, truncated: false });
		const result = await listBoxesRaw(exec);
		if (result.ok) throw new Error(`expected killed ls to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("timeout");
		expect(result.error).toContain("killed after 10000ms");
	});

	it("非 0 退出返回 ok:false（带退出码、reason=error）", async () => {
		const { exec } = recordingExec(failResult(1, "not logged in\n"));
		const result = await listBoxesRaw(exec);
		if (result.ok) throw new Error(`expected failed ls to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("error");
		expect(result.error).toContain("code 1");
		expect(result.error).toContain("not logged in");
	});

	it("宿主形态的 ENOENT（code 1 + stderr）归为 reason=missing", async () => {
		const { exec } = recordingExec(failResult(1, "spawn instabox ENOENT\n"));
		const result = await listBoxesRaw(exec);
		if (result.ok) throw new Error(`expected missing CLI to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("missing");
	});

	it("输出不是合法 JSON 时返回 ok:false（含原文尾部、reason=error）", async () => {
		const { exec } = recordingExec(okResult("Error: not logged in"));
		const result = await listBoxesRaw(exec);
		if (result.ok) throw new Error(`expected invalid JSON to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("error");
		expect(result.error).toContain("invalid JSON: Error: not logged in");
	});

	it("抛异常转 ok:false（reason=error），不外抛", async () => {
		const { exec } = recordingExec(new Error("boom"));
		const result = await listBoxesRaw(exec);
		expect(result).toEqual({ ok: false, error: "instabox ls failed: boom", reason: "error" });
	});
});

describe("wake / start / resume", () => {
	it("wake 逐字为 instabox wake <box>，默认预算取 DEFAULT_CONFIG.timeouts.wakeMs", async () => {
		const { exec, calls } = recordingExec(okResult());
		const result = await wake(exec, "libretv");
		expect(result).toEqual({ ok: true });
		expect(calls[0]?.command).toBe("instabox");
		expect(calls[0]?.args).toEqual(["wake", "libretv"]);
		expect(calls[0]?.opts?.timeout).toBe(DEFAULT_CONFIG.timeouts.wakeMs);
	});

	it("start 逐字为 instabox start <box>，默认预算取 DEFAULT_CONFIG.timeouts.startMs", async () => {
		const { exec, calls } = recordingExec(okResult());
		expect(await start(exec, "agent")).toEqual({ ok: true });
		expect(calls[0]?.args).toEqual(["start", "agent"]);
		expect(calls[0]?.opts?.timeout).toBe(DEFAULT_CONFIG.timeouts.startMs);
	});

	it("resume 逐字为 instabox resume <box>，默认预算取 DEFAULT_CONFIG.timeouts.startMs", async () => {
		const { exec, calls } = recordingExec(okResult());
		expect(await resume(exec, "agent")).toEqual({ ok: true });
		expect(calls[0]?.args).toEqual(["resume", "agent"]);
		expect(calls[0]?.opts?.timeout).toBe(DEFAULT_CONFIG.timeouts.startMs);
	});

	it("wake 非 0 退出返回 ok:false（reason=error），stderr 尾部保留", async () => {
		const { exec } = recordingExec(failResult(1, "sandbox is suspended; use resume or start\n"));
		const result: CliOutcome = await wake(exec, "libretv");
		if (result.ok) throw new Error(`expected wake to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("error");
		expect(result.error).toContain("instabox wake libretv");
		expect(result.error).toContain("code 1");
		expect(result.stderrTail).toBe("sandbox is suspended; use resume or start");
	});

	it("wake 退出码 0 但 stderr 报 machine_not_running → 失败 + reason=not-running（实测形态）", async () => {
		// 实测：用户手动 suspend 的箱，`instabox wake libretv` 退出码 0，沙箱状态不变
		const measured =
			"instabox: error machine_not_running: machine is suspended; start it first [request 0193a4f2-7e11]\n" +
			"hint: start it with `instabox start <sandbox>`\n";
		const { exec } = recordingExec(okResult("", measured));
		const result = await wake(exec, "libretv");
		if (result.ok) throw new Error(`exit 0 with stderr error must fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("not-running");
		expect(result.error).toContain("instabox wake libretv reported an error");
		expect(result.error).toContain("machine_not_running");
		// stderr 尾部原样保留（含 request id 与 hint 行），便于排障
		expect(result.stderrTail).toBe(measured.trim());
	});

	it("只命中 machine_not_running（无错误信封）也判 not-running", async () => {
		const { exec } = recordingExec(okResult("", "machine_not_running: machine is suspended\n"));
		const result = await wake(exec, "libretv");
		if (result.ok) throw new Error(`expected not-running, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("not-running");
	});

	it("只命中 hint 行（start it with）也判 not-running（单引号变体）", async () => {
		const { exec } = recordingExec(okResult("", "hint: start it with 'instabox start <sandbox>'\n"));
		const result = await wake(exec, "libretv");
		if (result.ok) throw new Error(`expected not-running, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("not-running");
	});

	it("start/resume 退出码 0 + 错误信封 → 同样判失败（信封是 CLI 全局唯一的）", async () => {
		const { exec } = recordingExec(okResult("", "instabox: error machine_stopped: cannot resume now [request 12]\n"));
		const started = await start(exec, "agent");
		if (started.ok) throw new Error(`expected start to fail, got ${JSON.stringify(started)}`);
		expect(started.reason).toBe("error");
		expect(started.error).toContain("machine_stopped");

		const { exec: exec2 } = recordingExec(okResult("", "instabox: error internal: boom [request 13]\n"));
		const resumed = await resume(exec2, "agent");
		if (resumed.ok) throw new Error(`expected resume to fail, got ${JSON.stringify(resumed)}`);
		expect(resumed.reason).toBe("error");
	});

	it("wake 被宿主杀掉（超时）→ reason=timeout", async () => {
		const { exec } = recordingExec({ stdout: "", stderr: "", code: 0, killed: true, truncated: false });
		const result = await wake(exec, "agent");
		if (result.ok) throw new Error(`expected killed wake to fail, got ${JSON.stringify(result)}`);
		expect(result.reason).toBe("timeout");
	});

	it("成功时也保留非空 stderr 尾部（进度信息不丢，不会误判失败）", async () => {
		const { exec } = recordingExec(okResult("", "waking libretv...\n"));
		expect(await start(exec, "libretv")).toEqual({ ok: true, stderrTail: "waking libretv..." });
	});

	it("自动休眠的箱 exit 0、stderr 无错误串 → 成功", async () => {
		// 实测：`instabox wake agent` 退出码 0，6s 后真的 running（stderr 只有进度行）
		const { exec } = recordingExec(okResult("", "waking agent…\nstate: starting → running\n"));
		expect(await wake(exec, "agent")).toEqual({ ok: true, stderrTail: "waking agent…\nstate: starting → running" });
	});

	it("stderr 尾部最多 500 字符且取的是尾部", async () => {
		const noisy = `${"a".repeat(600)}ROOT-CAUSE`;
		const { exec } = recordingExec(failResult(3, noisy));
		const result = await wake(exec, "agent");
		if (result.ok) throw new Error(`expected wake to fail, got ${JSON.stringify(result)}`);
		expect(result.stderrTail).toHaveLength(STDERR_TAIL_LIMIT);
		expect(result.stderrTail?.endsWith("ROOT-CAUSE")).toBe(true);
	});

	it("覆盖后的 timeout 原样透传（准备阶段传的就是 clamp 后的值）", async () => {
		const { exec, calls } = recordingExec(okResult());
		await start(exec, "agent", { timeout: 41_000 });
		expect(calls[0]?.opts?.timeout).toBe(41_000);
	});

	it("抛异常转 ok:false（reason=error），不外抛", async () => {
		const { exec } = recordingExec(new Error("ssh: connect timed out"));
		expect(await resume(exec, "agent")).toEqual({
			ok: false,
			error: "instabox resume agent failed: ssh: connect timed out",
			reason: "error",
		});
	});
});

describe("execRemote", () => {
	it("argv 逐字拼装：exec <box> --timeout <秒> -- <argv...>（不拼 shell 字符串）", async () => {
		const { exec, calls } = recordingExec(okResult('{"ok":true}'));
		const result = await execRemote(exec, "agent", ["instabox-computer-use", "mcp"]);
		expect(result).toEqual({ ok: true, stdout: '{"ok":true}' });
		expect(calls[0]?.command).toBe("instabox");
		expect(calls[0]?.args).toEqual(["exec", "agent", "--timeout", "120", "--", "instabox-computer-use", "mcp"]);
		// 本地等待 = 远端 120s + 余量，保证先让 CLI 超时
		expect(calls[0]?.opts?.timeout).toBe(120_000 + EXEC_LOCAL_GRACE_MS);
	});

	it("带空格/分号的参数原样作为单个 argv 元素（无 shell 注入面）", async () => {
		const { exec, calls } = recordingExec(okResult());
		await execRemote(exec, "agent", ["sh", "-lc", "echo hi; rm -rf /tmp/x"]);
		expect(calls[0]?.args).toEqual([
			"exec",
			"agent",
			"--timeout",
			"120",
			"--",
			"sh",
			"-lc",
			"echo hi; rm -rf /tmp/x",
		]);
	});

	it("envPath 加 `--env PATH=<值>`，位置在 `--timeout` 之前（DevTools 准备阶段的远端检查）", async () => {
		const { exec, calls } = recordingExec(okResult());
		await execRemote(exec, "agent", ["sh", "-c", "command -v chrome-devtools-mcp"], {
			timeoutMs: 20_000,
			envPath: "/opt/npm/bin:/usr/bin",
		});
		expect(calls[0]?.args).toEqual([
			"exec",
			"agent",
			"--env",
			"PATH=/opt/npm/bin:/usr/bin",
			"--timeout",
			"20",
			"--",
			"sh",
			"-c",
			"command -v chrome-devtools-mcp",
		]);
	});

	it("timeoutMs 向上取整成秒并钳制到 600 秒上限", async () => {
		const { exec, calls } = recordingExec(okResult());
		await execRemote(exec, "agent", ["true"], { timeoutMs: 900_000 });
		expect(calls[0]?.args).toEqual(["exec", "agent", "--timeout", "600", "--", "true"]);
		expect(calls[0]?.opts?.timeout).toBe(600_000 + EXEC_LOCAL_GRACE_MS);
	});

	it("timeoutMs 小于 1 秒时钳到 1 秒（CLI 不收 0）", async () => {
		const { exec, calls } = recordingExec(okResult());
		await execRemote(exec, "agent", ["true"], { timeoutMs: 400 });
		expect(calls[0]?.args?.[3]).toBe("1");
	});

	it("execTimeoutMs 可显式覆盖本地兜底超时", async () => {
		const { exec, calls } = recordingExec(okResult());
		await execRemote(exec, "agent", ["true"], { timeoutMs: 30_000, execTimeoutMs: 31_000 });
		expect(calls[0]?.args?.[3]).toBe("30");
		expect(calls[0]?.opts?.timeout).toBe(31_000);
	});

	it("非 0 退出返回 ok:false，并保留 stdout/stderr 尾部", async () => {
		const { exec } = recordingExec({ stdout: "partial", stderr: "exit 1 from remote", code: 7, killed: false });
		const result = await execRemote(exec, "agent", ["instabox-computer-use", "mcp"]);
		if (result.ok) throw new Error(`expected execRemote to fail, got ${JSON.stringify(result)}`);
		expect(result.error).toContain("instabox exec agent");
		expect(result.error).toContain("code 7");
		expect(result.stdout).toBe("partial");
		expect(result.stderrTail).toBe("exit 1 from remote");
	});

	it("本地兜底超时（killed）返回 ok:false，并写明本地预算毫秒数", async () => {
		const { exec, calls } = recordingExec({ stdout: "partial", stderr: "still running\n", code: 0, killed: true });
		const result = await execRemote(exec, "agent", ["true"], { timeoutMs: 30_000, execTimeoutMs: 31_000 });
		expect(calls[0]?.opts?.timeout).toBe(31_000);
		if (result.ok) throw new Error(`expected local timeout to fail, got ${JSON.stringify(result)}`);
		expect(result.error).toBe("instabox exec agent was killed after 31000ms: still running");
		expect(result.stdout).toBe("partial");
		expect(result.stderrTail).toBe("still running");
	});

	it("抛异常转 ok:false，不外抛", async () => {
		const { exec } = recordingExec(new Error("signal aborted"));
		expect(await execRemote(exec, "agent", ["true"])).toEqual({
			ok: false,
			error: "instabox exec agent failed: signal aborted",
		});
	});
});

describe("remoteTimeoutSeconds", () => {
	it("向上取整、下限 1、上限 600", () => {
		expect(remoteTimeoutSeconds(1)).toBe(1);
		expect(remoteTimeoutSeconds(120_000)).toBe(120);
		expect(remoteTimeoutSeconds(120_500)).toBe(121);
		expect(remoteTimeoutSeconds(600_000)).toBe(600);
		expect(remoteTimeoutSeconds(600_001)).toBe(600);
		expect(remoteTimeoutSeconds(0)).toBe(1);
	});

	it("非有限值按上限处理（不把 NaN/Infinity 交给 CLI）", () => {
		expect(remoteTimeoutSeconds(Number.NaN)).toBe(600);
		expect(remoteTimeoutSeconds(Number.POSITIVE_INFINITY)).toBe(600);
	});
});

describe("埋点（logEvent）", () => {
	it("probeVersion 成功记一条 cli.probe（ok/version/ms）", async () => {
		const logger = createMemoryLogger();
		setLogger(logger);
		try {
			const { exec } = recordingExec(okResult("0.4.2\n"));
			await probeVersion(exec);
		} finally {
			setLogger(undefined);
		}

		const probes = logger.records.filter((record) => record.event === "cli.probe");
		expect(probes).toHaveLength(1);
		expect(probes[0]?.level).toBe("info");
		expect(probes[0]?.fields).toMatchObject({ ok: true, version: "0.4.2" });
		expect(typeof probes[0]?.fields?.["ms"]).toBe("number");
	});

	it("cli.lifecycle 带实际生效的 timeoutMs（成功与失败都记）", async () => {
		const logger = createMemoryLogger();
		setLogger(logger);
		try {
			await wake(recordingExec(okResult()).exec, "agent", { timeout: 12_000 });
			await start(recordingExec(failResult(1, "boom")).exec, "agent", { timeout: 7_500 });
		} finally {
			setLogger(undefined);
		}

		const records = logger.records.filter((record) => record.event === "cli.lifecycle");
		expect(records).toHaveLength(2);
		expect(records[0]?.fields).toMatchObject({ command: "wake", ok: true, timeoutMs: 12_000 });
		expect(records[1]?.fields).toMatchObject({ command: "start", ok: false, timeoutMs: 7_500 });
	});

	it("cli.ls 带实际生效的 timeoutMs（覆盖值与默认预算各一条）", async () => {
		const logger = createMemoryLogger();
		setLogger(logger);
		try {
			await listBoxesRaw(recordingExec(okResult("[]")).exec, { timeout: 9_000 });
			await listBoxesRaw(recordingExec(failResult(1, "boom")).exec);
		} finally {
			setLogger(undefined);
		}

		const records = logger.records.filter((record) => record.event === "cli.ls");
		expect(records).toHaveLength(2);
		expect(records[0]?.fields).toMatchObject({ ok: true, timeoutMs: 9_000 });
		expect(records[1]?.fields).toMatchObject({ ok: false, timeoutMs: LIST_BOXES_TIMEOUT_MS });
	});
});
