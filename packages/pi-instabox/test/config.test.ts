/**
 * @inobit/pi-instabox — `src/config.ts` 单测：默认值、逐层叠加、非法回落、
 * 环境变量覆盖、VITEST 短路行为、V3 四路径。
 */

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	getAgentDir,
	loadConfig,
	normalizeConfig,
	normalizeEnvOverlay,
	resolvePaths,
} from "../src/config.ts";

/** 删掉环境变量：`delete process.env[key]` 会被 `typescript/no-dynamic-delete` 拦，走 Reflect */
function unsetEnv(key: string): void {
	Reflect.deleteProperty(process.env, key);
}

/** 在指定环境变量下跑一段断言，结束后原样还原（不污染其它用例） */
function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(patch)) {
		saved.set(key, process.env[key]);
		if (value === undefined) unsetEnv(key);
		else process.env[key] = value;
	}
	try {
		fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) unsetEnv(key);
			else process.env[key] = value;
		}
	}
}

/** 内存文件系统：只认 map 里的路径 */
function memoryFs(files: Map<string, string>): { exists: (file: string) => boolean; readFile: (file: string) => string } {
	return {
		exists: (file) => files.has(file),
		readFile: (file) => {
			const text = files.get(file);
			if (text === undefined) throw new Error(`ENOENT: ${file}`);
			return text;
		},
	};
}

const AGENT_DIR = path.join(path.sep, "tmp", "agent");
const CWD = path.join(path.sep, "tmp", "proj");
const GLOBAL_FILE = path.join(AGENT_DIR, "extensions", "pi-instabox", "config.json");
const PROJECT_FILE = path.join(CWD, ".pi", "extensions", "pi-instabox", "config.json");

describe("DEFAULT_CONFIG", () => {
	it("默认值：两个 box 留空、autoInstall 开、PATH 钉死、5 条 devToolsArgs、6 段超时", () => {
		expect(DEFAULT_CONFIG.defaultBox).toBe("");
		expect(DEFAULT_CONFIG.devToolsBox).toBe("");
		expect(DEFAULT_CONFIG.autoInstallDevTools).toBe(true);
		expect(DEFAULT_CONFIG.remotePath).toBe("/opt/npm/bin:/usr/local/bin:/usr/bin:/bin");
		expect(DEFAULT_CONFIG.devToolsArgs).toEqual([
			"--headless",
			"--userDataDir=/data/home/.agent-chrome",
			"--executablePath=/usr/bin/chromium",
			"--viewport=1280x800",
			"--no-usage-statistics",
		]);
		expect(DEFAULT_CONFIG.timeouts).toEqual({
			wakeMs: 50000,
			startMs: 120000,
			connectMs: 15000,
			initializeMs: 20000,
			listToolsMs: 20000,
			callMs: 120000,
		});
	});
});

describe("resolvePaths / getAgentDir（V3 四路径）", () => {
	it("四处路径按 agentDir 展开（配置进 extensions/，状态与 helper 进 pi-instabox/）", () => {
		const paths = resolvePaths(AGENT_DIR);
		expect(paths.configFile).toBe(path.join(AGENT_DIR, "extensions", "pi-instabox", "config.json"));
		expect(paths.stateDir).toBe(path.join(AGENT_DIR, "pi-instabox"));
		expect(paths.templateCacheFile).toBe(path.join(AGENT_DIR, "pi-instabox", "templates.json"));
		expect(paths.helperScript).toBe(path.join(AGENT_DIR, "pi-instabox", "bin", "devtools-connect.sh"));
	});

	it("`PI_CODING_AGENT_DIR` 覆盖 agent 目录（helper/缓存随之移动）", () => {
		withEnv({ PI_CODING_AGENT_DIR: "/tmp/x" }, () => {
			expect(getAgentDir()).toBe("/tmp/x");
			expect(resolvePaths(getAgentDir()).configFile).toBe("/tmp/x/extensions/pi-instabox/config.json");
			expect(resolvePaths(getAgentDir()).templateCacheFile).toBe("/tmp/x/pi-instabox/templates.json");
			expect(resolvePaths(getAgentDir()).helperScript).toBe("/tmp/x/pi-instabox/bin/devtools-connect.sh");
		});
	});

	it("`PI_CODING_AGENT_DIR` 未设时回落 ~/.pi/agent", () => {
		withEnv({ PI_CODING_AGENT_DIR: undefined }, () => {
			expect(getAgentDir()).toBe(path.join(os.homedir(), ".pi", "agent"));
		});
	});
});

describe("normalizeConfig（纯函数，不 throw）", () => {
	it("缺省/非对象输入回默认值，且不与 DEFAULT_CONFIG 共享引用", () => {
		for (const raw of [undefined, null, {}, 42, "x", [1, 2]]) {
			expect(normalizeConfig(raw)).toEqual(DEFAULT_CONFIG);
		}
		const cfg = normalizeConfig(undefined);
		expect(cfg.devToolsArgs).not.toBe(DEFAULT_CONFIG.devToolsArgs);
		expect(cfg.timeouts).not.toBe(DEFAULT_CONFIG.timeouts);
		cfg.devToolsArgs.push("--mutated");
		expect(DEFAULT_CONFIG.devToolsArgs).not.toContain("--mutated");
	});

	it("合法字段全覆盖生效", () => {
		const cfg = normalizeConfig({
			defaultBox: "agent",
			devToolsBox: "libretv",
			autoInstallDevTools: false,
			remotePath: "/usr/local/bin:/usr/bin",
			devToolsArgs: ["--headless", "--viewport=1920x1080"],
			timeouts: { wakeMs: 1234, callMs: 60000 },
		});
		expect(cfg).toEqual({
			defaultBox: "agent",
			devToolsBox: "libretv",
			autoInstallDevTools: false,
			remotePath: "/usr/local/bin:/usr/bin",
			devToolsArgs: ["--headless", "--viewport=1920x1080"],
			timeouts: { ...DEFAULT_CONFIG.timeouts, wakeMs: 1234, callMs: 60000 },
		});
	});

	it("未知类型逐字段回落默认值（不污染其它字段）", () => {
		const cfg = normalizeConfig({
			defaultBox: 5,
			devToolsBox: null,
			autoInstallDevTools: "yes",
			remotePath: "",
			devToolsArgs: [1, null],
			timeouts: { wakeMs: -1, connectMs: 1.5, callMs: "60000" },
			unknownKey: "ignored",
		});
		expect(cfg).toEqual(DEFAULT_CONFIG);
		expect((cfg as unknown as Record<string, unknown>)["unknownKey"]).toBeUndefined();
	});

	it("devToolsArgs：显式 [] 表示清空", () => {
		expect(normalizeConfig({ devToolsArgs: [] }).devToolsArgs).toEqual([]);
	});

	it("timeouts：非对象与空对象都不改默认", () => {
		expect(normalizeConfig({ timeouts: "1s" }).timeouts).toEqual(DEFAULT_CONFIG.timeouts);
		expect(normalizeConfig({ timeouts: {} }).timeouts).toEqual(DEFAULT_CONFIG.timeouts);
	});
});

describe("loadConfig（逐层叠加）", () => {
	it("无任何文件层 → 默认值", () => {
		const fsMemory = memoryFs(new Map());
		expect(loadConfig({ agentDir: AGENT_DIR, cwd: CWD, env: {}, ...fsMemory })).toEqual(DEFAULT_CONFIG);
	});

	it("全局层覆盖默认值", () => {
		const fsMemory = memoryFs(new Map([[GLOBAL_FILE, JSON.stringify({ defaultBox: "agent" })]]));
		const cfg = loadConfig({ agentDir: AGENT_DIR, cwd: CWD, env: {}, ...fsMemory });
		expect(cfg.defaultBox).toBe("agent");
		expect(cfg.remotePath).toBe(DEFAULT_CONFIG.remotePath);
	});

	it("项目层仅在 trusted 时生效，且优先级高于全局层", () => {
		const fsMemory = memoryFs(
			new Map([
				[GLOBAL_FILE, JSON.stringify({ defaultBox: "agent", devToolsBox: "global-box" })],
				[PROJECT_FILE, JSON.stringify({ defaultBox: "proj-box", devToolsBox: "proj-devtools" })],
			]),
		);
		const trusted = loadConfig({ agentDir: AGENT_DIR, cwd: CWD, env: {}, isTrusted: true, ...fsMemory });
		expect(trusted.defaultBox).toBe("proj-box");
		expect(trusted.devToolsBox).toBe("proj-devtools");
		const untrusted = loadConfig({ agentDir: AGENT_DIR, cwd: CWD, env: {}, isTrusted: false, ...fsMemory });
		expect(untrusted.defaultBox).toBe("agent");
		expect(untrusted.devToolsBox).toBe("global-box");
	});

	it("嵌套 timeouts 逐字段深合并（项目层只覆盖自己写的那项）", () => {
		const fsMemory = memoryFs(
			new Map([
				[GLOBAL_FILE, JSON.stringify({ timeouts: { wakeMs: 1111 } })],
				[PROJECT_FILE, JSON.stringify({ timeouts: { callMs: 2222 } })],
			]),
		);
		const cfg = loadConfig({ agentDir: AGENT_DIR, cwd: CWD, env: {}, isTrusted: true, ...fsMemory });
		expect(cfg.timeouts).toEqual({ ...DEFAULT_CONFIG.timeouts, wakeMs: 1111, callMs: 2222 });
	});

	it("非法 JSON / 读失败的层被忽略（保留已有层值）", () => {
		const fsMemory = memoryFs(
			new Map([
				[GLOBAL_FILE, JSON.stringify({ defaultBox: "agent" })],
				[PROJECT_FILE, "{ not json"],
			]),
		);
		const cfg = loadConfig({ agentDir: AGENT_DIR, cwd: CWD, env: {}, isTrusted: true, ...fsMemory });
		expect(cfg.defaultBox).toBe("agent");

		const throwing = loadConfig({
			agentDir: AGENT_DIR,
			cwd: CWD,
			env: {},
			isTrusted: true,
			exists: () => true,
			readFile: () => {
				throw new Error("EACCES");
			},
		});
		expect(throwing).toEqual(DEFAULT_CONFIG);
	});

	it("层内未知类型字段被忽略（不会把默认值写成非法值）", () => {
		const fsMemory = memoryFs(new Map([[GLOBAL_FILE, JSON.stringify({ defaultBox: "agent", remotePath: 42 })]]));
		const cfg = loadConfig({ agentDir: AGENT_DIR, cwd: CWD, env: {}, ...fsMemory });
		expect(cfg.defaultBox).toBe("agent");
		expect(cfg.remotePath).toBe(DEFAULT_CONFIG.remotePath);
	});

	it("默认 agentDir 走 getAgentDir()（`PI_CODING_AGENT_DIR` 决定全局层位置）", () => {
		const file = path.join("/tmp/envagent", "extensions", "pi-instabox", "config.json");
		const fsMemory = memoryFs(new Map([[file, JSON.stringify({ defaultBox: "env-box" })]]));
		withEnv({ PI_CODING_AGENT_DIR: "/tmp/envagent" }, () => {
			expect(loadConfig({ cwd: CWD, env: {}, ...fsMemory }).defaultBox).toBe("env-box");
		});
	});
});

describe("环境变量层（最后覆盖）", () => {
	it("四个 INSTABOX_MCP_* 覆盖文件层", () => {
		const fsMemory = memoryFs(
			new Map([[GLOBAL_FILE, JSON.stringify({ defaultBox: "file-box", devToolsBox: "file-devtools" })]]),
		);
		const cfg = loadConfig({
			agentDir: AGENT_DIR,
			cwd: CWD,
			...fsMemory,
			env: {
				INSTABOX_MCP_DEFAULT_BOX: "env-box",
				INSTABOX_MCP_DEVTOOLS_BOX: "env-devtools",
				INSTABOX_MCP_AUTO_INSTALL: "0",
				INSTABOX_MCP_PATH: "/custom/bin:/usr/bin",
			},
		});
		expect(cfg.defaultBox).toBe("env-box");
		expect(cfg.devToolsBox).toBe("env-devtools");
		expect(cfg.autoInstallDevTools).toBe(false);
		expect(cfg.remotePath).toBe("/custom/bin:/usr/bin");
	});

	it("空串与非法值忽略（`AUTO_INSTALL` 只认 0/1，其余不动默认 true）", () => {
		expect(
			normalizeEnvOverlay({
				INSTABOX_MCP_DEFAULT_BOX: "",
				INSTABOX_MCP_DEVTOOLS_BOX: "",
				INSTABOX_MCP_AUTO_INSTALL: "false",
				INSTABOX_MCP_PATH: "",
			}),
		).toEqual({});
		expect(normalizeEnvOverlay({ INSTABOX_MCP_AUTO_INSTALL: "1" })).toEqual({ autoInstallDevTools: true });
	});
});

describe("VITEST 短路", () => {
	it("未注入 env 时忽略所有文件层，只返回默认值＋环境变量层", () => {
		expect(process.env.VITEST).toBeTruthy();
		const fsMemory = memoryFs(new Map([[GLOBAL_FILE, JSON.stringify({ defaultBox: "file-box" })]]));
		withEnv(
			{
				INSTABOX_MCP_DEFAULT_BOX: undefined,
				INSTABOX_MCP_DEVTOOLS_BOX: undefined,
				INSTABOX_MCP_AUTO_INSTALL: undefined,
				INSTABOX_MCP_PATH: undefined,
			},
			() => {
				expect(loadConfig({ agentDir: AGENT_DIR, cwd: CWD, isTrusted: true, ...fsMemory })).toEqual(DEFAULT_CONFIG);
				withEnv({ INSTABOX_MCP_DEFAULT_BOX: "env-box" }, () => {
					const cfg = loadConfig({ agentDir: AGENT_DIR, cwd: CWD, isTrusted: true, ...fsMemory });
					expect(cfg.defaultBox).toBe("env-box");
					expect(cfg.devToolsBox).toBe("");
				});
			},
		);
	});
});
