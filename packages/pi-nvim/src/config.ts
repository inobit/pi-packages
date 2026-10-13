/**
 * @inobit/pi-nvim — daemon 与截断配置。
 *
 * 加载顺序：包内 `config/default.json`（默认值）→ 全局
 * `~/.pi/agent/extensions/pi-nvim/config.json` → 项目级
 * `<cwd>/.pi/extensions/pi-nvim/config.json`（仅 trusted 时读取）。
 * 照 pi-todo `src/config.ts` 模式；VITEST 下恒返回默认值（测试确定性），
 * 校验逻辑走纯函数 `normalizeConfig` 单测。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 超时配置（毫秒；pollMs 为结果文件轮询间隔） */
export interface NvimTimeouts {
	/** spawn 后等 ready＋connect 就绪的上界 */
	spawnMs: number;
	/** 批内等各 root client attach 的上界 */
	attachMs: number;
	/** 诊断到达等待的上界 */
	diagMs: number;
	/** 单文件 format（含写盘＋收诊断）的上界 */
	/** 单次 daemon 请求（含 spawn sender＋轮询结果）的上界 */
	requestMs: number;
	/** 结果文件轮询间隔 */
	pollMs: number;
}

/** 截断预算：per-file 单文件诊断上限、整批上限、单条 message 字符上限 */
export interface NvimTruncation {
	perFile: number;
	batch: number;
	message: number;
}

export interface NvimConfig {
	/** nvim 二进制（PATH 优先，配置可覆盖为绝对路径） */
	nvimPath: string;
	/** socket 父目录覆盖（空＝XDG_RUNTIME_DIR 回退 os.tmpdir()） */
	sockDir: string;
	timeouts: NvimTimeouts;
	truncation: NvimTruncation;
	/** daemon 空闲停 clients 的 TTL（毫秒），默认 300000（5min） */
	idleMs: number;
	/** daemon 父进程存活探测间隔（毫秒），默认 15000（15s） */
	parentPollMs: number;
}

export const DEFAULT_CONFIG: NvimConfig = {
	nvimPath: "nvim",
	sockDir: "",
	timeouts: {
		spawnMs: 30000,
		attachMs: 20000,
		diagMs: 10000,
		requestMs: 60000,
		pollMs: 50,
	},
	truncation: {
		perFile: 50,
		batch: 200,
		message: 500,
	},
	idleMs: 300000,
	parentPollMs: 15000,
};

export function getAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR;
	if (env) {
		if (env === "~" || env.startsWith("~/") || env.startsWith("~\\")) return path.join(os.homedir(), env.slice(2));
		return env;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

export interface LoadConfigOptions {
	globalPath?: string;
	projectPath?: string;
	trusted?: boolean;
	/** 包根目录（解析包内 config/default.json；默认按 __dirname 推导） */
	packageRoot?: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function asInt(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isInteger(raw)) return undefined;
	return raw;
}

function asPositiveInt(raw: unknown): number | undefined {
	const n = asInt(raw);
	if (n === undefined || n <= 0) return undefined;
	return n;
}

function asNonEmptyString(raw: unknown): string | undefined {
	if (typeof raw !== "string" || raw === "") return undefined;
	return raw;
}

/**
 * 纯校验：非法字段回退默认值；数值须为正整数（sockDir 允许空字符串表未覆盖）。
 * 约束：pollMs/idleMs/parentPollMs 与各项超时一律正整数，否则回退。
 */
export function normalizeConfig(raw: Record<string, unknown> | undefined): NvimConfig {
	const out: NvimConfig = {
		nvimPath: DEFAULT_CONFIG.nvimPath,
		sockDir: DEFAULT_CONFIG.sockDir,
		timeouts: { ...DEFAULT_CONFIG.timeouts },
		truncation: { ...DEFAULT_CONFIG.truncation },
		idleMs: DEFAULT_CONFIG.idleMs,
		parentPollMs: DEFAULT_CONFIG.parentPollMs,
	};
	if (!raw) return out;
	const nvimPath = asNonEmptyString(raw["nvimPath"]);
	if (nvimPath !== undefined) out.nvimPath = nvimPath;
	if (typeof raw["sockDir"] === "string") out.sockDir = raw["sockDir"];
	const timeouts = raw["timeouts"];
	if (timeouts && typeof timeouts === "object") {
		const t = timeouts as Record<string, unknown>;
		for (const key of ["spawnMs", "attachMs", "diagMs", "requestMs", "pollMs"] as const) {
			const n = asPositiveInt(t[key]);
			if (n !== undefined) out.timeouts[key] = n;
		}
	}
	const truncation = raw["truncation"];
	if (truncation && typeof truncation === "object") {
		const t = truncation as Record<string, unknown>;
		for (const key of ["perFile", "batch", "message"] as const) {
			const n = asPositiveInt(t[key]);
			if (n !== undefined) out.truncation[key] = n;
		}
	}
	const idleMs = asPositiveInt(raw["idleMs"]);
	if (idleMs !== undefined) out.idleMs = idleMs;
	const parentPollMs = asPositiveInt(raw["parentPollMs"]);
	if (parentPollMs !== undefined) out.parentPollMs = parentPollMs;
	return out;
}

/** 包根目录：jiti 直载下 import.meta.url 不可用，用 CJS __dirname 手法（照 pi-reader 实测） */
export function packageRootOf(callerDirname: string): string {
	// 从 src/ 加载时取父级即包目录
	return path.join(callerDirname, "..");
}

function resolvePackageRoot(explicit?: string): string {
	if (explicit) return explicit;
	let baseDir = "";
	try {
		baseDir = typeof __dirname !== "undefined" && __dirname ? __dirname : "";
	} catch {
		baseDir = "";
	}
	if (baseDir) return packageRootOf(baseDir);
	return "";
}

/**
 * 加载配置：包内 default.json 作底， global/project 覆盖（project 仅 trusted）。
 * VITEST 下恒返回默认值。
 */
export function loadConfig(cwd: string, opts: LoadConfigOptions = {}): NvimConfig {
	if (process.env.VITEST) return { ...DEFAULT_CONFIG, timeouts: { ...DEFAULT_CONFIG.timeouts }, truncation: { ...DEFAULT_CONFIG.truncation } };
	const pkgRoot = resolvePackageRoot(opts.packageRoot);
	const base = pkgRoot ? readJson(path.join(pkgRoot, "config", "default.json")) : undefined;
	let merged: NvimConfig = normalizeConfig(base);
	const globalPath =
		opts.globalPath ?? path.join(getAgentDir(), "extensions", "pi-nvim", "config.json");
	const globalRaw = readJson(globalPath);
	if (globalRaw) {
		const overlay = normalizeConfigOverlay(globalRaw);
		merged = {
			...merged,
			...overlay,
			timeouts: { ...merged.timeouts, ...(overlay.timeouts ?? {}) },
			truncation: { ...merged.truncation, ...(overlay.truncation ?? {}) },
		};
	}
	const trusted = opts.trusted ?? false;
	const projectPath = opts.projectPath ?? path.join(cwd, ".pi", "extensions", "pi-nvim", "config.json");
	if (trusted) {
		const projectRaw = readJson(projectPath);
		if (projectRaw) {
			const overlay = normalizeConfigOverlay(projectRaw);
			merged = {
				...merged,
				...overlay,
				timeouts: { ...merged.timeouts, ...(overlay.timeouts ?? {}) },
				truncation: { ...merged.truncation, ...(overlay.truncation ?? {}) },
			};
		}
	}
	return merged;
}

/** 用户层覆盖：只叠加逐字段合法的值；非法字段忽略（保留底包值） */
function normalizeConfigOverlay(raw: Record<string, unknown>): Partial<NvimConfig> {
	const out: Partial<NvimConfig> = {};
	const nvimPath = asNonEmptyString(raw["nvimPath"]);
	if (nvimPath !== undefined) out.nvimPath = nvimPath;
	if (typeof raw["sockDir"] === "string") out.sockDir = raw["sockDir"];
	if (raw["timeouts"] && typeof raw["timeouts"] === "object") {
		const t = raw["timeouts"] as Record<string, unknown>;
		const timeouts: Partial<NvimTimeouts> = {};
		for (const key of ["spawnMs", "attachMs", "diagMs", "requestMs", "pollMs"] as const) {
			const n = asPositiveInt(t[key]);
			if (n !== undefined) timeouts[key] = n;
		}
		if (Object.keys(timeouts).length > 0) out.timeouts = timeouts as NvimTimeouts;
	}
	if (raw["truncation"] && typeof raw["truncation"] === "object") {
		const t = raw["truncation"] as Record<string, unknown>;
		const truncation: Partial<NvimTruncation> = {};
		for (const key of ["perFile", "batch", "message"] as const) {
			const n = asPositiveInt(t[key]);
			if (n !== undefined) truncation[key] = n;
		}
		if (Object.keys(truncation).length > 0) out.truncation = truncation as NvimTruncation;
	}
	const idleMs = asPositiveInt(raw["idleMs"]);
	if (idleMs !== undefined) out.idleMs = idleMs;
	const parentPollMs = asPositiveInt(raw["parentPollMs"]);
	if (parentPollMs !== undefined) out.parentPollMs = parentPollMs;
	return out;
}

/** 包资源定位：找不到报明确错误（package.json files 必须含 lua/config） */
export function resolveResource(packageRoot: string, rel: string): string {
	const full = path.join(packageRoot, rel);
	if (!fs.existsSync(full)) {
		throw new Error(
			`@inobit/pi-nvim: 找不到资源 ${rel}（包目录 ${packageRoot}）；` +
				"若为手动安装请确认 lua/ 与 config/ 已随包发布（package.json files 须含 src,lua,config）。",
		);
	}
	return full;
}
