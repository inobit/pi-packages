/**
 * @inobit/pi-nvim — daemon.ts 纯逻辑单测：socket 路径消毒、Vim 转义、互斥队列。
 * daemon 真机行为（spawn/探活/轮询）不进单测，靠冒烟验证。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	DaemonMutex,
	degradedLinesFromLog,
	logPathFor,
	readDegradedLines,
	remoteSendKeys,
	sanitizeSessionId,
	shouldForceFresh,
	siblingPrefix,
	sockBaseDir,
	socketDirFor,
	sockPathFor,
	vimEscapeLuaString,
} from "../src/daemon.ts";

describe("sanitizeSessionId", () => {
	it("uuidv7 原样通过", () => {
		expect(sanitizeSessionId("0193409a-9c9e-7f5a-b7e8-1d2c3b4a5968")).toBe(
			"0193409a-9c9e-7f5a-b7e8-1d2c3b4a5968",
		);
	});
	it("路径穿越字符替换为下划线", () => {
		expect(sanitizeSessionId("../../etc/passwd")).toBe(".._.._etc_passwd");
		expect(sanitizeSessionId("a/b")).toBe("a_b");
	});
	it("空串回退 unknown", () => {
		expect(sanitizeSessionId("")).toBe("unknown");
	});
});

describe("socket 路径", () => {
	it("per-(session,pid) 目录＋恒名 nvim.sock", () => {
		const dir = socketDirFor("/run/user/1000", "sess-1", 1234);
		expect(dir).toBe("/run/user/1000/pi-nvim-sess-1-1234");
		expect(sockPathFor(dir)).toBe("/run/user/1000/pi-nvim-sess-1-1234/nvim.sock");
	});
	it("sockBaseDir：配置覆盖优先", () => {
		expect(sockBaseDir({ sockDir: "/tmp/x" })).toBe("/tmp/x");
	});
	it("sockBaseDir：XDG 回退 tmpdir", () => {
		const prev = process.env.XDG_RUNTIME_DIR;
		process.env.XDG_RUNTIME_DIR = "/run/user/7";
		expect(sockBaseDir({ sockDir: "" })).toBe("/run/user/7");
		if (prev === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = prev;
	});
	it("siblingPrefix 仅匹配同 session", () => {
		expect(siblingPrefix("abc")).toBe("pi-nvim-abc-");
		expect("pi-nvim-abc-123".startsWith(siblingPrefix("abc"))).toBe(true);
		expect("pi-nvim-abcd-123".startsWith(siblingPrefix("abc"))).toBe(false);
	});
});

describe("vimEscapeLuaString", () => {
	it("单引号转义", () => {
		expect(vimEscapeLuaString("/tmp/a'b/req-1.json")).toBe("/tmp/a\\'b/req-1.json");
	});
	it("反斜杠先转义（Windows 路径）", () => {
		expect(vimEscapeLuaString("C:\\tmp\\x")).toBe("C:\\\\tmp\\\\x");
	});
	it("remoteSendKeys 拼出 :lua 按键串", () => {
		expect(remoteSendKeys("diagnose", "/s/req-1.json", "/s/res-1.json")).toBe(
			":lua PiNvim.diagnose('/s/req-1.json','/s/res-1.json')<CR>",
		);
	});
});

describe("DaemonMutex", () => {
	it("并发请求串行执行", async () => {
		const m = new DaemonMutex();
		const order: number[] = [];
		await Promise.all(
			[1, 2, 3].map((n) =>
				m.runExclusive(async () => {
					order.push(n);
					await new Promise((r) => setTimeout(r, 5));
				}),
			),
		);
		expect(order).toEqual([1, 2, 3]);
	});
	it("前任务抛错不堵队列", async () => {
		const m = new DaemonMutex();
		await expect(
			m.runExclusive(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		const out = await m.runExclusive(async () => 42);
		expect(out).toBe(42);
	});
});

describe("degradedLinesFromLog（启动健康纯函数）", () => {
	it("空日志即 healthy", () => {
		expect(degradedLinesFromLog("")).toEqual([]);
		expect(degradedLinesFromLog("ready\nlistening\n")).toEqual([]);
	});
	it("Error detected while processing 命中", () => {
		const out = degradedLinesFromLog("ok\nError detected while processing init.lua:42\nok\n");
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("Error detected while processing");
	});
	it("^E\\d+: 命中（E123/E492 等）", () => {
		const out = degradedLinesFromLog("ok\nE492: Not an editor command\n");
		expect(out).toEqual(["E492: Not an editor command"]);
	});
	it("只看尾 20 行（旧报错不翻旧账）", () => {
		const head = "Error detected while processing early\n";
		const tail = Array.from({ length: 25 }, () => "ok line\n").join("");
		expect(degradedLinesFromLog(head + tail)).toEqual([]);
	});
	it("尾 20 行内命中照常 surface", () => {
		const filler = Array.from({ length: 25 }, () => "ok line\n").join("");
		expect(degradedLinesFromLog(filler + "E123: late boom\n")).toHaveLength(1);
	});
	it("超长 degraded 行走错误截断", () => {
		const out = degradedLinesFromLog(`E1: ${"x".repeat(2500)}\n`);
		expect(out[0]).toContain("…(truncated ");
	});
});

describe("shouldForceFresh（degraded 重起语义）", () => {
	it("degraded 下次 ensure 强制 fresh", () => {
		expect(shouldForceFresh(true)).toBe(true);
	});
	it("healthy 复用（不强制重起）", () => {
		expect(shouldForceFresh(false)).toBe(false);
	});
});

describe("启动健康 IO", () => {
	it("logPath 随 socket 目录", () => {
		expect(logPathFor("/s/pi-nvim-a-1")).toBe("/s/pi-nvim-a-1/daemon.log");
	});
	it("缺失日志文件即 healthy（不抛错）", () => {
		expect(readDegradedLines("/definitely/missing/pi-nvim-daemon.log")).toEqual([]);
	});
	it("大日志只读尾部（有界，不整文件进内存）", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nvim-biglog-"));
		const log = path.join(dir, "daemon.log");
		const filler = "x".repeat(100000);
		fs.writeFileSync(log, filler + "\nError detected while processing BufReadPost\n");
		expect(readDegradedLines(log)).toHaveLength(1);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
