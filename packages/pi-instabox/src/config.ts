/**
 * @inobit/pi-instabox — 扩展配置与路径。
 *
 * 叠加顺序（后者覆盖前者）：`DEFAULT_CONFIG` → `<agentDir>/extensions/pi-instabox/config.json`
 * → `<cwd>/.pi/extensions/pi-instabox/config.json`（仅项目可信时）→ 环境变量 `INSTABOX_MCP_*`。
 * 照 pi-todo / pi-nvim `src/config.ts` 范式：单测走纯函数 `normalizeConfig`，`loadConfig`
 * 在 `VITEST` 下恒返回默认值＋环境变量层（测试确定性），所有外部访问都走注入面便于离线测试。
 *
 * 路径布局（裁决 V3）：配置进 `<agentDir>/extensions/pi-instabox/`，运行期状态进
 * `<agentDir>/pi-instabox/`，事件日志进 `<agentDir>/logs/pi-instabox/`（与
 * `logs/pi-permission/` 的生态惯例一致：扩展目录只放配置，日志与 `pi-debug.log` 同级）。
 * 所有路径单点在 `resolvePaths()`，其余模块只消费它的返回值。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 超时（毫秒）：准备阶段总预算 ＋ 各步单步上限（D4 唤醒链、D7 ⑤ 远端 MCP 客户端）。
 *
 * 两层语义不同，别按「各步相加」理解：`prepareMs` 是**一次工具调用准备阶段的截止时间**，
 * 下面每个字段只是**单步上限**——某一步卡住时实际超时取 `min(该步上限, 剩余预算)`，
 * 所以准备阶段的上界是 `prepareMs`，不是各字段之和。
 */
export interface InstaboxTimeouts {
	/**
	 * 准备阶段总预算：查状态 → 唤醒链（`wake`/`start`/`resume`）→ 确认 `running` → 建连 共享
	 * 这一个截止时间。用户要求「准备阶段总共约 1 分钟」，投一次桌面调用不该等 8 分钟。
	 */
	prepareMs: number;
	/** `instabox wake` 单步上限（只处理「自动暂停」；吃满即截止到 `prepareMs`） */
	wakeMs: number;
	/** `instabox start` / `instabox resume` 单步上限（整箱冷启） */
	startMs: number;
	/**
	 * spawn 后等远端 MCP 传输建链的单步上限。
	 *
	 * 唤醒由准备阶段的唤醒链完成（`wake`/`start`/`resume`），这里不必再覆盖官方文档里
	 * 「自动唤醒最多等 45s」那一段，只留「spawn → 首个字节」的余量。`remote.ts` 的
	 * `DEFAULT_TIMEOUTS.connect`（15s）只是该模块的兜底值，装配层（`pool.ts`）会用本字段
	 * 覆盖它，改这里才生效。
	 */
	connectMs: number;
	/** `initialize` 请求上界 */
	initializeMs: number;
	/** `tools/list` 请求上界 */
	listToolsMs: number;
	/**
	 * `tools/call` 请求上界（桌面操作可能含截图，给得最宽）。
	 * 它属于工具调用本身，**不**在准备阶段的 `prepareMs` 里。
	 */
	callMs: number;
}

export interface InstaboxConfig {
	/** 解析链靠后的兜底目标；空串＝未配置（退到「`instabox ls` 第一台」） */
	defaultBox: string;
	/**
	 * 远端 DevTools MCP 的开关（默认 `true`）：`on` 注册、`off` 完全不碰该能力。
	 *
	 * 优先级（高到低）：`--instabox-devtools` / `--no-instabox-devtools` → `INSTABOX_MCP_DEVTOOLS`
	 * → 本字段。它只决定开关，不提供箱名（箱名见 {@link devToolsBox}）。
	 */
	devTools: boolean;
	/** DevTools 唯一对应的 box；空串＝没有默认箱（开关开着时会提示一次并拒绝注册） */
	devToolsBox: string;
	/** 指定了 devToolsBox 但远端没装 `chrome-devtools-mcp` 时，连接前尝试自动安装 */
	autoInstallDevTools: boolean;
	/** 钉死的远端 PATH（不同模板的 npm prefix 不同，`/opt/npm/bin` 与 `/usr/local/bin` 都出现过） */
	remotePath: string;
	/** 原样透传给 `chrome-devtools-mcp` 的参数 */
	devToolsArgs: string[];
	timeouts: InstaboxTimeouts;
}

export const DEFAULT_CONFIG: InstaboxConfig = {
	defaultBox: "",
	devTools: true,
	devToolsBox: "",
	autoInstallDevTools: true,
	remotePath: "/opt/npm/bin:/usr/local/bin:/usr/bin:/bin",
	devToolsArgs: [
		"--headless",
		"--userDataDir=/data/home/.agent-chrome",
		"--executablePath=/usr/bin/chromium",
		"--viewport=1280x800",
		"--no-usage-statistics",
	],
	timeouts: {
		prepareMs: 60_000,
		wakeMs: 20_000,
		startMs: 30_000,
		connectMs: 15_000,
		initializeMs: 15_000,
		listToolsMs: 15_000,
		callMs: 120_000,
	},
};

const TIMEOUT_KEYS = [
	"prepareMs",
	"wakeMs",
	"startMs",
	"connectMs",
	"initializeMs",
	"listToolsMs",
	"callMs",
] as const;

/** agent 目录：`PI_CODING_AGENT_DIR` 优先，否则 `~/.pi/agent`（不可用 import.meta.url 推导：jiti 直载下不可靠） */
export function getAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) {
		// `~` / `~/x` 两种写法都按家目录展开（与 pi-todo / pi-nvim 一致）
		if (env === "~" || env.startsWith("~/") || env.startsWith("~\\")) return path.join(os.homedir(), env.slice(2));
		return env;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

/** 配置文件相对路径：全局层相对 `agentDir`，项目层相对 `<cwd>/.pi` */
const CONFIG_RELATIVE_PATH = path.join("extensions", "pi-instabox", "config.json");

/** 运行期目录名：状态进 `<agentDir>/pi-instabox`，日志进 `<agentDir>/logs/pi-instabox` */
const STATE_DIR_NAME = "pi-instabox";

export interface InstaboxPaths {
	/** 配置文件（全局层；项目层在 `<cwd>/.pi/` 下同名） */
	configFile: string;
	/** 运行期状态目录（模板缓存的父目录，按需创建） */
	stateDir: string;
	/** per-box 模板缓存 */
	templateCacheFile: string;
	/** 事件日志目录（JSONL 由 `log.ts` 写入，按需创建） */
	logDir: string;
}

export function resolvePaths(agentDir: string): InstaboxPaths {
	const stateDir = path.join(agentDir, STATE_DIR_NAME);
	return {
		configFile: path.join(agentDir, CONFIG_RELATIVE_PATH),
		stateDir,
		templateCacheFile: path.join(stateDir, "templates.json"),
		logDir: path.join(agentDir, "logs", STATE_DIR_NAME),
	};
}

/** 单层覆盖：只含逐字段合法的值；非法字段直接缺席（＝保留底层值） */
export interface InstaboxConfigOverlay {
	defaultBox?: string;
	devTools?: boolean;
	devToolsBox?: string;
	autoInstallDevTools?: boolean;
	remotePath?: string;
	devToolsArgs?: string[];
	timeouts?: Partial<InstaboxTimeouts>;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	return raw as Record<string, unknown>;
}

function asNonEmptyString(raw: unknown): string | undefined {
	return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function asPositiveInt(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return undefined;
	return raw;
}

/** 字符串数组：丢非字符串与空串；显式 `[]` 表示清空（保留），全非法输入回 undefined（保留底层值） */
function asStringList(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: string[] = [];
	for (const v of raw) {
		if (typeof v === "string" && v !== "") out.push(v);
	}
	if (out.length === 0 && raw.length > 0) return undefined;
	return out;
}

function asTimeouts(raw: unknown): Partial<InstaboxTimeouts> | undefined {
	const rec = asRecord(raw);
	if (!rec) return undefined;
	const out: Partial<InstaboxTimeouts> = {};
	for (const key of TIMEOUT_KEYS) {
		const n = asPositiveInt(rec[key]);
		if (n !== undefined) out[key] = n;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** 纯校验（单层）：任意 `unknown` 输入都不 throw，非法/未知字段缺席 */
export function normalizeConfigOverlay(raw: unknown): InstaboxConfigOverlay {
	const rec = asRecord(raw);
	if (!rec) return {};
	const out: InstaboxConfigOverlay = {};
	const defaultBox = rec["defaultBox"];
	if (typeof defaultBox === "string") out.defaultBox = defaultBox;
	const devTools = rec["devTools"];
	if (typeof devTools === "boolean") out.devTools = devTools;
	const devToolsBox = rec["devToolsBox"];
	if (typeof devToolsBox === "string") out.devToolsBox = devToolsBox;
	const autoInstallDevTools = rec["autoInstallDevTools"];
	if (typeof autoInstallDevTools === "boolean") out.autoInstallDevTools = autoInstallDevTools;
	const remotePath = asNonEmptyString(rec["remotePath"]);
	if (remotePath !== undefined) out.remotePath = remotePath;
	const devToolsArgs = asStringList(rec["devToolsArgs"]);
	if (devToolsArgs !== undefined) out.devToolsArgs = devToolsArgs;
	const timeouts = asTimeouts(rec["timeouts"]);
	if (timeouts !== undefined) out.timeouts = timeouts;
	return out;
}

/** 叠加一层：`timeouts` 逐字段深合并，数组/对象一律拷贝（不共享 `DEFAULT_CONFIG` 的引用） */
export function applyOverlay(base: InstaboxConfig, overlay: InstaboxConfigOverlay): InstaboxConfig {
	return {
		defaultBox: overlay.defaultBox ?? base.defaultBox,
		devTools: overlay.devTools ?? base.devTools,
		devToolsBox: overlay.devToolsBox ?? base.devToolsBox,
		autoInstallDevTools: overlay.autoInstallDevTools ?? base.autoInstallDevTools,
		remotePath: overlay.remotePath ?? base.remotePath,
		devToolsArgs: [...(overlay.devToolsArgs ?? base.devToolsArgs)],
		timeouts: { ...base.timeouts, ...(overlay.timeouts ?? {}) },
	};
}

/** 纯校验（单文件语义）：`normalizeConfig(undefined)` 即 `DEFAULT_CONFIG` 的深拷贝 */
export function normalizeConfig(raw: unknown): InstaboxConfig {
	return applyOverlay(DEFAULT_CONFIG, normalizeConfigOverlay(raw));
}

/**
 * 环境变量名（`INSTABOX_MCP_AUTO_INSTALL` / `INSTABOX_MCP_DEVTOOLS` 取值 `0|1`，
 * `INSTABOX_MCP_PATH` 喂远端命令的 PATH）。装配层复用 {@link ENV_KEYS} 判定开关来源，
 * 因此在配置里统一命名一次。
 */
export const ENV_KEYS = {
	defaultBox: "INSTABOX_MCP_DEFAULT_BOX",
	devTools: "INSTABOX_MCP_DEVTOOLS",
	devToolsBox: "INSTABOX_MCP_DEVTOOLS_BOX",
	autoInstall: "INSTABOX_MCP_AUTO_INSTALL",
	remotePath: "INSTABOX_MCP_PATH",
} as const;

export type EnvLike = Record<string, string | undefined>;

/** 环境变量层：空串＝未设置（忽略）；`INSTABOX_MCP_DEVTOOLS` / `INSTABOX_MCP_AUTO_INSTALL` 只认 `0`/`1` */
export function normalizeEnvOverlay(env: EnvLike): InstaboxConfigOverlay {
	const overlay: InstaboxConfigOverlay = {};
	const defaultBox = env[ENV_KEYS.defaultBox];
	if (defaultBox) overlay.defaultBox = defaultBox;
	const devTools = env[ENV_KEYS.devTools];
	if (devTools === "0") overlay.devTools = false;
	else if (devTools === "1") overlay.devTools = true;
	const devToolsBox = env[ENV_KEYS.devToolsBox];
	if (devToolsBox) overlay.devToolsBox = devToolsBox;
	const autoInstall = env[ENV_KEYS.autoInstall];
	if (autoInstall === "0") overlay.autoInstallDevTools = false;
	else if (autoInstall === "1") overlay.autoInstallDevTools = true;
	const remotePath = env[ENV_KEYS.remotePath];
	if (remotePath) overlay.remotePath = remotePath;
	return overlay;
}

export interface LoadConfigOptions {
	/** agent 目录（默认 `getAgentDir()`） */
	agentDir?: string;
	/** 项目根（默认 `process.cwd()`） */
	cwd?: string;
	/** 项目可信才读 `<cwd>/.pi/extensions/pi-instabox/config.json`（默认 false） */
	isTrusted?: boolean;
	/** 读文件（默认 `fs.readFileSync(file, "utf8")`；抛错视为该层不存在） */
	readFile?: (file: string) => string;
	/** 存在性检查（默认 `fs.existsSync`；false 即跳过该层） */
	exists?: (file: string) => boolean;
	/** 环境变量源（默认 `process.env`；**显式注入即跳过 VITEST 短路**，供离线测试逐层断言） */
	env?: EnvLike;
}

function readLayer(
	file: string,
	readFile: (file: string) => string,
	exists: (file: string) => boolean,
): InstaboxConfigOverlay | undefined {
	if (!exists(file)) return undefined;
	let text: string;
	try {
		text = readFile(file);
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// 非法 JSON 当该层不存在：配置文件写坏不能拖垮会话
		return undefined;
	}
	return normalizeConfigOverlay(parsed);
}

/**
 * 加载配置：`DEFAULT_CONFIG` → 全局层 → 项目层（仅 trusted）→ 环境变量层。
 * `VITEST` 下（且未注入 `env`）只返回默认值＋环境变量层，不碰文件系统。
 */
export function loadConfig(options: LoadConfigOptions = {}): InstaboxConfig {
	const env = options.env ?? process.env;
	if (options.env === undefined && process.env.VITEST) {
		return applyOverlay(DEFAULT_CONFIG, normalizeEnvOverlay(env));
	}
	const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
	const exists = options.exists ?? ((file: string) => fs.existsSync(file));
	const agentDir = options.agentDir ?? getAgentDir();
	const cwd = options.cwd ?? process.cwd();
	const projectFile = path.join(cwd, ".pi", CONFIG_RELATIVE_PATH);
	let merged = normalizeConfig(undefined);
	for (const file of [resolvePaths(agentDir).configFile, options.isTrusted === true ? projectFile : undefined]) {
		if (!file) continue;
		const layer = readLayer(file, readFile, exists);
		if (layer) merged = applyOverlay(merged, layer);
	}
	return applyOverlay(merged, normalizeEnvOverlay(env));
}
