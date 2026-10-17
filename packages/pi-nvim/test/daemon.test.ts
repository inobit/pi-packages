/**
 * @inobit/pi-nvim — daemon.ts 纯逻辑单测：socket 路径消毒、Vim 转义、互斥队列。
 * daemon 真机行为（spawn/探活/轮询）不进单测，靠冒烟验证。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

/** bridge.lua 绝对路径（结构断言＋加载校验共用） */
const BRIDGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lua", "bridge.lua");

describe("bridge.lua 请求登记时序（abort 认领前提）", () => {
	// abort 靠已在册的 _current/_reqs[id] 认领，故 reg_request 必须早于 wait_attach：
	// 晚登记则 attach 窗口内到达的 abort 被丢弃，随后被 reg_request 的 _aborted=false 抹掉，
	// format 会在用户已中断后照常写盘（TS 侧却已回 partial，磁盘与模型认知相悖）。
	// 该顺序 bug 无法靠冒烟稳定复现（需卡进启动窗口按 esc），
	// 且不违反"daemon 真机行为不进单测"（只读源码断言，不跑 nvim），故用结构断言防回归。
	const bridgeSrc = fs.readFileSync(BRIDGE_PATH, "utf8");

	/** 取 PiNvim.<name> 的函数体（到下一个顶层 function PiNvim. 为止） */
	function fnBody(name: string): string {
		const start = bridgeSrc.indexOf(`function PiNvim.${name}(`);
		expect(start, `bridge.lua 缺少 PiNvim.${name}`).toBeGreaterThanOrEqual(0);
		const next = bridgeSrc.indexOf("\nfunction PiNvim.", start + 1);
		return bridgeSrc.slice(start, next === -1 ? bridgeSrc.length : next);
	}

	for (const fn of ["diagnose", "format"]) {
		it(`${fn}：reg_request 早于 wait_attach`, () => {
			const body = fnBody(fn);
			const reg = body.indexOf("reg_request(req.id)");
			const wait = body.indexOf("wait_attach(");
			expect(reg, `${fn} 缺 reg_request`).toBeGreaterThanOrEqual(0);
			expect(wait, `${fn} 缺 wait_attach`).toBeGreaterThanOrEqual(0);
			expect(reg).toBeLessThan(wait);
		});
	}

	// abort 状态必须按请求分桶（P2-4）：TS 收到 signal 即抛错，可能在 Lua 仍在处理
	// 上一个请求时就发起下一个，全局标记会让孤儿请求提前退出等待、随后它的
	// abort_cleanup 删掉新请求正在用的同名 buffer，新请求 collect 失败记 bridge error。
	it("abort 状态按请求分桶，无全局 _aborted/_current", () => {
		expect(bridgeSrc, "不得再用全局 abort 标记").not.toMatch(/PiNvim\._aborted/);
		expect(bridgeSrc, "不得再用全局在途 id").not.toMatch(/PiNvim\._current/);
		// 等待循环读每请求标记，且 id 由调用方传入
		expect(bridgeSrc).toMatch(/local function aborted\(id\)/);
		expect(bridgeSrc).toMatch(/wait_attach\(entries, budget_ms, method, req_id\)/);
		expect(bridgeSrc).toMatch(/aborted\(req_id\)/);
	});
});

describe("bridge.lua pull 语义（查询代替猜测）", () => {
	// diagnose 改走 textDocument/diagnostic 请求-响应：响应（或请求超时）即终点，
	// 不再靠“静默秒数”猜 push 是否到齐。慢 analyzer（gopls slicescontains 冷时 5~7s
	// 才 publish）在 settle 语义下必漏（冻结版设计）。以下断言钉死该语义不回退。
	const bridgeSrc = fs.readFileSync(BRIDGE_PATH, "utf8");

	it("edit 前先查存在性（不存在的文件不得被建成空 buffer 出假诊断）", () => {
		expect(bridgeSrc).toContain("filereadable");
		expect(bridgeSrc).toContain("file not found or not readable");
	});
	it("pull 请求经能力门控异步发出（buffer 间并行等待）", () => {
		expect(bridgeSrc).toContain("textDocument/diagnostic");
		expect(bridgeSrc).toContain('supports_method("textDocument/diagnostic")');
		expect(bridgeSrc).toContain("plan_entry");
		expect(bridgeSrc).toContain("issue_pull");
		expect(bridgeSrc, "旧串行汇总必须删除").not.toContain("pull_entry_diags");
	});
	it("settle 全套已删（不许回退到猜测）", () => {
		for (const dead of [
			"wait_diag_settled",
			"diag_counts",
			"counts_equal",
			"MIN_SETTLE_MS",
			"QUIET_MS",
			"snapshot_clients",
			"collect_diags",
		]) {
			expect(bridgeSrc, `${dead} 必须删除`).not.toContain(dead);
		}
		expect(bridgeSrc, "recognize 识别器必须删除").not.toMatch(/local function recognize\(/);
	});
	it("请求体用 startupMs/diagnosticMs（旧 attachMs/diagMs 字段不得再读）", () => {
		expect(bridgeSrc).toContain("req.startupMs");
		expect(bridgeSrc).toContain("req.diagnosticMs");
		expect(bridgeSrc, "旧请求字段必须删除").not.toContain("req.attachMs");
		expect(bridgeSrc, "旧请求字段必须删除").not.toContain("req.diagMs");
	});
	it("非正常状态与失败原因成形（status 三值＋客户端点名）", () => {
		expect(bridgeSrc).toContain("status = \"failed\"");
		expect(bridgeSrc).toContain("status = \"success\"");
		expect(bridgeSrc).toContain('"skipped"');
		expect(bridgeSrc).toContain("diagnostics timed out");
		expect(bridgeSrc).toContain("initialization timed out");
		for (const dead of ["unsupportedClients", "timeoutClients", "pullErrors", "push_collect", "batch_push_wait"]) {
			expect(bridgeSrc, `${dead} 必须删除`).not.toContain(dead);
		}
	});
	it("push 数据来自发布记录的诊断快照（wipe 后仍有效，无需反查 namespace）", () => {
		expect(bridgeSrc).toContain("PiNvim._publishes");
		expect(bridgeSrc).toContain("map_lsp_diags");
		expect(bridgeSrc, "旧的三级 namespace 反查已删").not.toContain("diag_client_name");
	});
	it("push 观测与 pull 共用单一等待循环", () => {
		expect(bridgeSrc).toContain("wait_diagnostics");
		expect(bridgeSrc).toContain("PUSH_QUIET");
		expect(bridgeSrc).toContain("PUSH_MIN_OBSERVE_MS");
		expect(bridgeSrc).toContain("merge_dedupe");
	});
});

describe("bridge.lua 加载校验（语法＋加载期错误）", () => {
	// Lua 语法/加载期错误在 vitest 里完全不可见：真机只表现为"daemon 启动超时 30s"，
	// 且该错误被 degraded 语义容忍、不抛给模型（改坏 bridge.lua 时实测踩过，只留下
	// 一行 E5112 在 daemon.log 里）。故用 nvim 自己做一次 luafile 校验——只验语法＋顶层
	// 执行，不起 LSP、不连 socket，不违反"daemon 真机行为不进单测"。
	// 无 nvim 时跳过（保持无 nvim 环境可跑测试）。
	const luafileProbe = (env: NodeJS.ProcessEnv): { out: string; status: number | null } | undefined => {
		const r = spawnSync("nvim", ["--headless", "-n", "-i", "NONE", "-u", "NONE", "-c", `luafile ${BRIDGE_PATH}`, "-c", "qa!"], {
			encoding: "utf8",
			timeout: 30000,
			env: { ...process.env, ...env },
		});
		// nvim 命令行 Lua 出错时退出码仍可能是 0，故以输出为判定主依据
		if (r.error !== undefined) return undefined;
		return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status };
	};

	it("无 env 也能干净加载（SOCK_DIR 空 → auto_setup 早退）", () => {
		const p = luafileProbe({});
		if (!p) return;
		expect(p.out, `bridge.lua 加载失败：\n${p.out}`).not.toMatch(/^E\d+:|Error in command line/m);
	});
	it("带 daemon env 能加载且写出 ready 标记（auto_setup 全路径）", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nvim-luachk-"));
		try {
			const p = luafileProbe({ PI_NVIM_SOCK_DIR: dir, PI_NVIM_LOG: path.join(dir, "daemon.log") });
			if (!p) return;
			expect(p.out, `bridge.lua 加载失败：\n${p.out}`).not.toMatch(/^E\d+:|Error in command line/m);
			// ready 是 ensure 的就绪双条件之一，写出即证明 auto_setup 跑通
			expect(fs.existsSync(path.join(dir, "ready"))).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
