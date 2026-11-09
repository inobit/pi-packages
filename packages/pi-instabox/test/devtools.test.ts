/**
 * @inobit/pi-instabox — `src/devtools.ts` 单测：helper 脚本内容（`set -eu`、stdout 纯净、
 * 先 `wake`/`start` 再检查、`--env PATH=`、ssh 形式、autoInstall 两种分支、单引号转义、
 * 脚本预算 < per-request timeout）、写盘幂等/`chmod`/失败只 warn、
 * `registerMcpServer` 参数（`exposure`/`timeout`/`description`/显式 box 覆盖）。全程内存文件系统，不落盘。
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolvePaths } from "../src/config.ts";
import { createMemoryLogger, setLogger } from "../src/log.ts";
import {
	buildHelperScript,
	buildMcpServerConfig,
	ensureHelperScript,
	type EnsureHelperScriptResult,
	type HelperScriptFileSystem,
} from "../src/devtools.ts";

const REMOTE_PATH = "/opt/npm/bin:/usr/local/bin:/usr/bin:/bin";
const AGENT_DIR = path.join(path.sep, "tmp", "agent");
const PATHS = resolvePaths(AGENT_DIR);

/** 拉起箱的那一行：先把箱弄运行，失败不阻断（让后面的检查/ssh 自然报错）。 */
const WAKE_LINE = 'instabox wake "$box" >/dev/null 2>&1 || instabox start "$box" >/dev/null 2>&1 || true';

/** 唤醒的现实上界（秒，真机实测）：running 箱 2 秒，suspended 箱 ≥45 秒放弃后还得 `start` 约 10–60 秒。 */
const WAKE_TIMEOUT_SECONDS = 45;
const START_TIMEOUT_SECONDS = 60;

/** 记录全部调用的内存文件系统；`failOn` 指哪一步抛错（模拟无权限/磁盘满） */
function fakeFileSystem(failOn?: "ensureDir" | "writeText" | "setMode") {
	const calls: string[] = [];
	const dirs: string[] = [];
	const files = new Map<string, string>();
	const modes = new Map<string, number>();
	const fail = (step: string): void => {
		if (failOn === step) throw new Error(`${step}: EACCES`);
	};
	const io: HelperScriptFileSystem = {
		ensureDir: (dir) => {
			calls.push("ensureDir");
			fail("ensureDir");
			dirs.push(dir);
		},
		writeText: (file, text) => {
			calls.push("writeText");
			fail("writeText");
			files.set(file, text);
		},
		setMode: (file, mode) => {
			calls.push("setMode");
			fail("setMode");
			modes.set(file, mode);
		},
	};
	return { io, calls, dirs, files, modes };
}

function linesOf(script: string): string[] {
	return script.split("\n");
}

describe("buildHelperScript 骨架", () => {
	const script = buildHelperScript({ remotePath: REMOTE_PATH, autoInstall: true });

	it("首行 `#!/bin/sh`、`set -eu`、用法注释、末尾换行", () => {
		expect(linesOf(script)[0]).toBe("#!/bin/sh");
		expect(script).toContain("\nset -eu\n");
		expect(script).toContain("# 用法: devtools-connect.sh <box> [chrome-devtools-mcp args...]");
		expect(script.endsWith("\n")).toBe(true);
	});

	it("box 与 args：取 $1、shift、缺参时 stderr 报用法并退出 2", () => {
		expect(script).toContain('if [ "$#" -lt 1 ]; then');
		expect(script).toContain('box="$1"');
		expect(script).toContain("\nshift\n");
		expect(script).toContain("exit 2");
	});

	it("stdout 纯净：每条 printf 都重定向到 stderr", () => {
		const printfLines = linesOf(script).filter((line) => line.includes("printf"));
		expect(printfLines.length).toBe(3);
		for (const line of printfLines) expect(line.trimEnd().endsWith(">&2")).toBe(true);
	});

	it("先 wake（失败再 start）拉起箱，失败不阻断，且该行不写 stdout", () => {
		expect(script).toContain(`\n${WAKE_LINE}\n`);
		const wakeLine = linesOf(script).find((line) => line.startsWith("instabox wake"));
		// stdout 纯净：唤醒的输出（包括 `start` 那一支）全部丢到 /dev/null，一个字节也不留
		expect(wakeLine?.endsWith("|| true")).toBe(true);
		expect(wakeLine).not.toContain(">&2");
		expect(wakeLine).not.toContain("printf");
		expect((wakeLine?.match(/>\/dev\/null 2>&1/g) ?? []).length).toBe(2);
	});

	it("唤醒/拉起在安装检查之前，紧跟在 PATH 定义之后且在 if 块之外", () => {
		const code = linesOf(script);
		const wakeIndex = code.findIndex((line) => line.startsWith("instabox wake"));
		const checkIndex = code.findIndex((line) => line.startsWith("if ! instabox exec"));
		const pathIndex = code.findIndex((line) => line.startsWith("remote_path="));
		expect(pathIndex).toBeGreaterThan(-1);
		expect(wakeIndex).toBeGreaterThan(pathIndex);
		expect(checkIndex).toBeGreaterThan(wakeIndex);
		// 顶层语句：唤醒行不能缩进（缩进意味着被包进了 if 块）
		expect(code[wakeIndex]).toBe(WAKE_LINE);
	});

	it("安装检查用 `instabox exec --env PATH=…`，结果丢弃、不阻断", () => {
		expect(script).toContain(`instabox exec "$box" --env "PATH=$remote_path" --timeout 10 --`);
		expect(script).toContain("sh -c 'command -v chrome-devtools-mcp >/dev/null 2>&1'");
		expect(script).toContain("sh -c 'command -v chrome-devtools-mcp >/dev/null 2>&1' >/dev/null 2>&1; then");
	});

	it("最后一段是 ssh 形式的 exec，参数原样透传", () => {
		const execLine = 'exec instabox ssh "$box" -- env "PATH=$remote_path" chrome-devtools-mcp "$@"';
		expect(script).toContain(execLine);
		const lastCodeLine = linesOf(script)
			.filter((line) => line.trim() !== "")
			.at(-1);
		expect(lastCodeLine).toBe(execLine);
	});

	it("PATH 来自参数：脚本里钉的是传入值，不是 DEFAULT_CONFIG", () => {
		expect(script).toContain(`remote_path='${REMOTE_PATH}'`);
		const custom = buildHelperScript({ remotePath: "/custom/bin", autoInstall: true });
		expect(custom).toContain("remote_path='/custom/bin'");
		expect(custom).toContain('--env "PATH=$remote_path"');
		expect(custom).not.toContain(DEFAULT_CONFIG.remotePath);
	});

	it("同一入参两次生成完全一致（幂等覆盖的前提）", () => {
		expect(buildHelperScript({ remotePath: REMOTE_PATH, autoInstall: true })).toBe(script);
	});
});

describe("buildHelperScript 的 autoInstall 分支", () => {
	it("true：装一次 `sudo -n env PATH=… npm i -g chrome-devtools-mcp`，40 秒、失败不阻断", () => {
		const script = buildHelperScript({ remotePath: REMOTE_PATH, autoInstall: true });
		expect(script).toContain(`sudo -n env "PATH=${REMOTE_PATH}" npm i -g chrome-devtools-mcp`);
		expect(script).toContain('--env "PATH=$remote_path" --timeout 40 --');
		expect(script).toContain(
			`sh -c 'sudo -n env "PATH=${REMOTE_PATH}" npm i -g chrome-devtools-mcp' >&2 2>&1 || true`,
		);
		expect(script).toContain("installing chrome-devtools-mcp on %s");
		expect(script).not.toContain("auto-install disabled");
	});

	it("false：不装、不超时 40，只在 stderr 说明原因", () => {
		const script = buildHelperScript({ remotePath: REMOTE_PATH, autoInstall: false });
		expect(script).not.toContain("sudo");
		expect(script).not.toContain("--timeout 40");
		expect(script).toContain("auto-install disabled (autoInstallDevTools=false)");
		// 唤醒、检查与 ssh 段不随开关变化
		expect(script).toContain(WAKE_LINE);
		expect(script).toContain("--timeout 10 --");
		expect(script).toContain('exec instabox ssh "$box" -- env "PATH=$remote_path" chrome-devtools-mcp "$@"');
	});

	it("安装命令里的 PATH 也走单引号转义，不破出 `sh -c` 的字面量", () => {
		const script = buildHelperScript({ remotePath: "/opt/it's/bin", autoInstall: true });
		expect(script).toContain(String.raw`sh -c 'sudo -n env "PATH=/opt/it'\''s/bin" npm i -g chrome-devtools-mcp'`);
	});
});

describe("脚本预算与 MCP per-request timeout", () => {
	// pi 的 MCP 客户端对 `initialize` 也计时，而 helper 的唤醒/检查/安装都在 `initialize` 应答之前跑完，
	// 所以三段之和必须小于注册配置的 `timeout`，否则冷箱唤醒或安装会被提前报死。
	it("autoInstall=true 时 `--timeout` 之和 < 注册的 per-request timeout", () => {
		const script = buildHelperScript({ remotePath: REMOTE_PATH, autoInstall: true });
		const budgets = [...script.matchAll(/--timeout (\d+) --/g)].map((match) => Number(match[1]));
		// 两段：检查 + 安装（最后一段 `instabox ssh` 不设 `--timeout`）
		expect(budgets).toEqual([10, 40]);
		const checked = budgets.reduce((sum, seconds) => sum + seconds, 0);
		// 唤醒/拉起没有 `--timeout` 可设，只能按实测上界算进 preamble
		const preambleWorstCase = WAKE_TIMEOUT_SECONDS + START_TIMEOUT_SECONDS + checked;
		expect(preambleWorstCase).toBe(155);
		expect(preambleWorstCase).toBeLessThan(
			buildMcpServerConfig({ ...DEFAULT_CONFIG, devToolsBox: "agent" }, PATHS).config.timeout,
		);
	});
});

describe("buildHelperScript 的 sh 引号转义", () => {
	it("PATH 里的单引号写成 '\\''，不破出字面量", () => {
		const script = buildHelperScript({ remotePath: "/opt/it's/bin", autoInstall: true });
		expect(script).toContain(String.raw`remote_path='/opt/it'\''s/bin'`);
	});

	it("转义后的行引号成对（POSIX 单引号字面量可闭合）", () => {
		const script = buildHelperScript({ remotePath: "/a'b'c", autoInstall: true });
		const line = linesOf(script).find((candidate) => candidate.startsWith("remote_path="));
		expect(line).toBe(String.raw`remote_path='/a'\''b'\''c'`);
		// 引号总数成对，字面量能闭合
		expect((line?.match(/'/g) ?? []).length % 2).toBe(0);
	});

	it("`$` 与反引号不会被脚本解释（单引号内原样）", () => {
		const script = buildHelperScript({ remotePath: "/opt/$HOME/`id`/bin", autoInstall: true });
		expect(script).toContain("remote_path='/opt/$HOME/`id`/bin'");
		// 唯一的使用点仍然走变量，不做二次展开
		expect(script).toContain('--env "PATH=$remote_path"');
	});
});

describe("ensureHelperScript", () => {
	const file = PATHS.helperScript;

	it("写到 <agentDir>/pi-instabox/bin/devtools-connect.sh，mkdir -p + 写 + chmod 0o755", () => {
		expect(file).toBe(path.join(path.sep, "tmp", "agent", "pi-instabox", "bin", "devtools-connect.sh"));
		const { io, calls, dirs, files, modes } = fakeFileSystem();
		const result = ensureHelperScript({ paths: PATHS, remotePath: REMOTE_PATH, autoInstall: true, fs: io });
		expect(result).toEqual({ ok: true });
		expect(calls).toEqual(["ensureDir", "writeText", "setMode"]);
		expect(dirs).toEqual([path.dirname(file)]);
		expect(files.get(file)).toBe(buildHelperScript({ remotePath: REMOTE_PATH, autoInstall: true }));
		expect(modes.get(file)).toBe(0o755);
	});

	it("幂等：连调两次得到同一份内容与同一权限位", () => {
		const { io, calls, files, modes } = fakeFileSystem();
		ensureHelperScript({ paths: PATHS, remotePath: REMOTE_PATH, autoInstall: true, fs: io });
		const first = files.get(file);
		const again = ensureHelperScript({ paths: PATHS, remotePath: REMOTE_PATH, autoInstall: true, fs: io });
		expect(again).toEqual({ ok: true });
		expect(files.get(file)).toBe(first);
		expect(modes.get(file)).toBe(0o755);
		expect(calls.filter((call) => call === "writeText").length).toBe(2);
	});

	it("autoInstall 透传到脚本内容", () => {
		const { io, files } = fakeFileSystem();
		ensureHelperScript({ paths: PATHS, remotePath: REMOTE_PATH, autoInstall: false, fs: io });
		expect(files.get(file)).toBe(buildHelperScript({ remotePath: REMOTE_PATH, autoInstall: false }));
	});

	for (const step of ["ensureDir", "writeText", "setMode"] as const) {
		it(`${step} 失败：只 warn 一次并返回 { ok: false }，不抛异常`, () => {
			const warnings: string[] = [];
			const { io } = fakeFileSystem(step);
			let result: EnsureHelperScriptResult = { ok: true };
			expect(() => {
				result = ensureHelperScript({
					paths: PATHS,
					remotePath: REMOTE_PATH,
					autoInstall: true,
					fs: io,
					warn: (message) => warnings.push(message),
				});
			}).not.toThrow();
			expect(result.ok).toBe(false);
			expect(result.error).toBe(`${step}: EACCES`);
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain(file);
			expect(warnings[0]).toContain(`${step}: EACCES`);
		});
	}

	it("没注入 warn 时失败依然静默返回（不替代调用方报错）", () => {
		const { io } = fakeFileSystem("writeText");
		expect(ensureHelperScript({ paths: PATHS, remotePath: REMOTE_PATH, autoInstall: true, fs: io })).toEqual({
			ok: false,
			error: "writeText: EACCES",
		});
	});

	it("埋点：写盘成功/失败各一条 devtools.helper，带 path 与 error", () => {
		const logger = createMemoryLogger();
		const okIo = fakeFileSystem();
		const failingIo = fakeFileSystem("setMode");
		setLogger(logger);
		try {
			ensureHelperScript({ paths: PATHS, remotePath: REMOTE_PATH, autoInstall: true, fs: okIo.io });
			ensureHelperScript({ paths: PATHS, remotePath: REMOTE_PATH, autoInstall: true, fs: failingIo.io });
		} finally {
			setLogger(undefined);
		}

		const records = logger.records.filter((record) => record.event === "devtools.helper");
		expect(records).toHaveLength(2);
		expect(records[0]?.fields).toEqual({ ok: true, path: file });
		expect(records[1]?.fields).toEqual({ ok: false, path: file, error: "setMode: EACCES" });
	});
});

describe("buildMcpServerConfig", () => {
	const cfg = { ...DEFAULT_CONFIG, devToolsBox: "agent" };
	const registration = buildMcpServerConfig(cfg, PATHS);

	it("server 名固定为 instabox-devtools（只允许这一种拼写）", () => {
		expect(registration.name).toBe("instabox-devtools");
	});

	it("command 是 helper 绝对路径，args = [box, ...devToolsArgs]", () => {
		expect(registration.config.command).toBe(PATHS.helperScript);
		expect(registration.config.args).toEqual(["agent", ...DEFAULT_CONFIG.devToolsArgs]);
		// 不与配置共享数组引用：改配置不影响已构造的注册参数
		expect(registration.config.args).not.toBe(cfg.devToolsArgs);
		expect(registration.config.args.length).toBe(DEFAULT_CONFIG.devToolsArgs.length + 1);
	});

	it("exposure 钉 codemode、timeout 180（每请求秒数，覆盖唤醒 + 检查 + 安装）", () => {
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

	it("换 box 只改 args[0]，其余字段不变", () => {
		const other = buildMcpServerConfig({ ...cfg, devToolsBox: "libretv" }, PATHS);
		expect(other.name).toBe(registration.name);
		expect(other.config.args[0]).toBe("libretv");
		expect(other.config.command).toBe(registration.config.command);
		expect(other.config.description).not.toBe(registration.config.description);
		expect(other.config.description).toContain("instabox 'libretv'");
	});

	it("显式 box 参数覆盖 cfg.devToolsBox（flag / `/instabox-devtools on` 的动态路径）", () => {
		const dynamic = buildMcpServerConfig(cfg, PATHS, "libretv");
		expect(dynamic.name).toBe(registration.name);
		expect(dynamic.config.args).toEqual(["libretv", ...DEFAULT_CONFIG.devToolsArgs]);
		expect(dynamic.config.description).toContain("instabox 'libretv'");
		// cfg 本身不被写回：同一份配置可以反复构造不同 box 的注册
		expect(cfg.devToolsBox).toBe("agent");
		expect(buildMcpServerConfig(cfg, PATHS).config.args[0]).toBe("agent");
	});
});
