/**
 * @inobit/pi-instabox — `cli.ts` 单测：argv 逐字拼装、超时预算、非 0 退出、stderr 截尾、
 * 异常不外抛、`exec --timeout` 上限钳制、失败 `reason` 三分（missing/timeout/error，探测与 `ls`）。
 *
 * 全部走注入的假 `ExecFn`（记录 command/args/opts 并回放结果），不 spawn 真进程、不联网。
 * `wake`/`start`/`resume` 的默认预算不写数字，而是断言「实际透传的 `timeout` ===
 * `DEFAULT_CONFIG.timeouts` 对应字段」（方案 §4.4：wake 50s / start·resume 120s）。
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

	it("生命周期预算单点在 config.ts（wake 50s / start·resume 120s，不另存一份数字）", () => {
		expect(DEFAULT_CONFIG.timeouts.wakeMs).toBe(50_000);
		expect(DEFAULT_CONFIG.timeouts.startMs).toBe(120_000);
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

	it("wake 失败（人工暂停的箱）返回 ok:false，stderr 尾部保留", async () => {
		const { exec } = recordingExec(failResult(1, "sandbox is suspended; use resume or start\n"));
		const result: CliOutcome = await wake(exec, "libretv");
		if (result.ok) throw new Error(`expected wake to fail, got ${JSON.stringify(result)}`);
		expect(result.error).toContain("instabox wake libretv");
		expect(result.error).toContain("code 1");
		expect(result.stderrTail).toBe("sandbox is suspended; use resume or start");
	});

	it("成功时也保留非空 stderr 尾部（进度信息不丢）", async () => {
		const { exec } = recordingExec(okResult("", "waking libretv...\n"));
		expect(await start(exec, "libretv")).toEqual({ ok: true, stderrTail: "waking libretv..." });
	});

	it("stderr 尾部最多 500 字符且取的是尾部", async () => {
		const noisy = `${"a".repeat(600)}ROOT-CAUSE`;
		const { exec } = recordingExec(failResult(3, noisy));
		const result = await wake(exec, "agent");
		if (result.ok) throw new Error(`expected wake to fail, got ${JSON.stringify(result)}`);
		expect(result.stderrTail).toHaveLength(STDERR_TAIL_LIMIT);
		expect(result.stderrTail?.endsWith("ROOT-CAUSE")).toBe(true);
	});

	it("抛异常转 ok:false，不外抛", async () => {
		const { exec } = recordingExec(new Error("ssh: connect timed out"));
		expect(await resume(exec, "agent")).toEqual({
			ok: false,
			error: "instabox resume agent failed: ssh: connect timed out",
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
