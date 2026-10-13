/**
 * @inobit/pi-nvim — daemon 配置。
 *
 * 加载顺序：包内 `config/default.json`（默认值）→ 全局
 * `~/.pi/agent/extensions/pi-nvim/config.json` → 项目级
 * `<cwd>/.pi/extensions/pi-nvim/config.json`（仅 trusted 时读取）。
 * 照 pi-todo `src/config.ts` 模式；VITEST 下恒返回默认值（测试确定性），
 * 校验逻辑走纯函数 `normalizeConfig` 单测。
 *
 * 诊断不截断（结构化、可再生；坏构建的量由调用方拆文件承担），故无 truncation 配置节；
 * 唯一截断是错误文本（见 result.ts truncateError，非结构化、前重后轻）。
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

/** 调用守卫白名单单表：后缀（不带点，小写）＋精确文件名（大小写敏感） */
export interface NvimWhitelistTable {
	extensions: string[];
	filenames: string[];
}

/** 调用守卫白名单：enabled:false 仅关白名单闸（存在/是文件/可读文本三闸仍生效） */
export interface NvimWhitelist {
	enabled: boolean;
	diagnostics: NvimWhitelistTable;
	format: NvimWhitelistTable;
}

export interface NvimConfig {
	/** nvim 二进制（PATH 优先，配置可覆盖为绝对路径） */
	nvimPath: string;
	/** socket 父目录覆盖（空＝XDG_RUNTIME_DIR 回退 os.tmpdir()） */
	sockDir: string;
	timeouts: NvimTimeouts;
	/** daemon 空闲停 clients 的 TTL（毫秒），默认 300000（5min） */
	idleMs: number;
	/** daemon 父进程存活探测间隔（毫秒），默认 15000（15s） */
	parentPollMs: number;
	/** 调用守卫白名单（仅调用时短路，无自动触发） */
	whitelist: NvimWhitelist;
}

export const DEFAULT_WHITELIST: NvimWhitelist = {
	enabled: true,
	diagnostics: {
		extensions: ["ts", "tsx", "js", "mjs", "cjs", "lua", "py", "rs", "go", "sh", "json", "jsonc", "yaml", "html", "css", "scss", "c", "h", "cpp", "hpp", "md"],
		filenames: ["Dockerfile"],
	},
	format: {
		extensions: ["ts", "tsx", "js", "mjs", "cjs", "lua", "py", "rs", "go", "sh", "json", "yaml", "html", "css", "scss", "c", "h", "cpp", "hpp"],
		filenames: [],
	},
};

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
	idleMs: 300000,
	parentPollMs: 15000,
	whitelist: {
		enabled: DEFAULT_WHITELIST.enabled,
		diagnostics: { ...DEFAULT_WHITELIST.diagnostics, extensions: [...DEFAULT_WHITELIST.diagnostics.extensions], filenames: [...DEFAULT_WHITELIST.diagnostics.filenames] },
		format: { ...DEFAULT_WHITELIST.format, extensions: [...DEFAULT_WHITELIST.format.extensions], filenames: [...DEFAULT_WHITELIST.format.filenames] },
	},
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

/** 后缀归一：去前导点＋小写；空串视为非法 */
function asExtension(raw: unknown): string | undefined {
	if (typeof raw !== "string" || raw === "") return undefined;
	const noDot = raw.startsWith(".") ? raw.slice(1) : raw;
	const lower = noDot.toLowerCase();
	if (lower === "") return undefined;
	return lower;
}

function asStringList(raw: unknown, map: (v: unknown) => string | undefined): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: string[] = [];
	for (const v of raw) {
		const s = map(v);
		if (s !== undefined && !out.includes(s)) out.push(s);
	}
	// 全非法输入回 undefined（保留底包值）；用户显式 [] 才表示清空
	if (out.length === 0 && raw.length > 0) return undefined;
	return out;
}

function asWhitelistTable(raw: unknown, fallback: NvimWhitelistTable): NvimWhitelistTable {
	if (!raw || typeof raw !== "object") {
		return { extensions: [...fallback.extensions], filenames: [...fallback.filenames] };
	}
	const t = raw as Record<string, unknown>;
	const extensions = asStringList(t["extensions"], asExtension);
	const filenames = asStringList(t["filenames"], asNonEmptyString);
	return {
		extensions: extensions ?? [...fallback.extensions],
		filenames: filenames ?? [...fallback.filenames],
	};
}

function asWhitelist(raw: unknown): NvimWhitelist {
	const fallback = DEFAULT_WHITELIST;
	if (!raw || typeof raw !== "object") {
		return {
			enabled: fallback.enabled,
			diagnostics: { extensions: [...fallback.diagnostics.extensions], filenames: [...fallback.diagnostics.filenames] },
			format: { extensions: [...fallback.format.extensions], filenames: [...fallback.format.filenames] },
		};
	}
	const t = raw as Record<string, unknown>;
	return {
		enabled: typeof t["enabled"] === "boolean" ? (t["enabled"] as boolean) : fallback.enabled,
		diagnostics: asWhitelistTable(t["diagnostics"], fallback.diagnostics),
		format: asWhitelistTable(t["format"], fallback.format),
	};
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
		idleMs: DEFAULT_CONFIG.idleMs,
		parentPollMs: DEFAULT_CONFIG.parentPollMs,
		whitelist: asWhitelist(undefined),
	};
	if (!raw) return out;
	out.whitelist = asWhitelist(raw["whitelist"]);
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
	if (out.timeouts.diagMs > out.timeouts.requestMs) out.timeouts.diagMs = out.timeouts.requestMs;
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
	if (process.env.VITEST) return { ...DEFAULT_CONFIG, timeouts: { ...DEFAULT_CONFIG.timeouts }, whitelist: asWhitelist(undefined) };
	const pkgRoot = resolvePackageRoot(opts.packageRoot);
	const base = pkgRoot ? readJson(path.join(pkgRoot, "config", "default.json")) : undefined;
	let merged: NvimConfig = normalizeConfig(base);
	const globalPath =
		opts.globalPath ?? path.join(getAgentDir(), "extensions", "pi-nvim", "config.json");
	const globalRaw = readJson(globalPath);
	if (globalRaw) {
		const overlay = normalizeConfigOverlay(globalRaw);
		merged = applyOverlay(merged, overlay);
	}
	const trusted = opts.trusted ?? false;
	const projectPath = opts.projectPath ?? path.join(cwd, ".pi", "extensions", "pi-nvim", "config.json");
	if (trusted) {
		const projectRaw = readJson(projectPath);
		if (projectRaw) {
			const overlay = normalizeConfigOverlay(projectRaw);
			merged = applyOverlay(merged, overlay);
		}
	}
	return merged;
}

/** 顶层浅合并＋timeouts 逐字段深合并＋whitelist 逐表深合并（附 diagMs≤requestMs 钳制） */
export function applyOverlay(base: NvimConfig, overlay: Partial<NvimConfig>): NvimConfig {
	const wPatch = overlay.whitelist as unknown as
		| { enabled?: boolean; diagnostics?: { extensions?: string[]; filenames?: string[] }; format?: { extensions?: string[]; filenames?: string[] } }
		| undefined;
	const merged: NvimConfig = {
		...base,
		...overlay,
		timeouts: { ...base.timeouts, ...(overlay.timeouts ?? {}) },
		whitelist: wPatch
			? {
					enabled: wPatch.enabled ?? base.whitelist.enabled,
					diagnostics: {
						extensions: wPatch.diagnostics?.extensions ?? base.whitelist.diagnostics.extensions,
						filenames: wPatch.diagnostics?.filenames ?? base.whitelist.diagnostics.filenames,
					},
					format: {
						extensions: wPatch.format?.extensions ?? base.whitelist.format.extensions,
						filenames: wPatch.format?.filenames ?? base.whitelist.format.filenames,
					},
				}
			: base.whitelist,
	};
	// P2-2：diagMs 若被 overlay 抬过 requestMs，健康 daemon 会被误判卡死丢温；钳住
	if (merged.timeouts.diagMs > merged.timeouts.requestMs) {
		merged.timeouts = { ...merged.timeouts, diagMs: merged.timeouts.requestMs };
	}
	return merged;
}

/** 用户层覆盖：只叠加逐字段合法的值；非法字段忽略（保留底包值） */
export function normalizeConfigOverlay(raw: Record<string, unknown>): Partial<NvimConfig> {
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
	const idleMs = asPositiveInt(raw["idleMs"]);
	if (idleMs !== undefined) out.idleMs = idleMs;
	const parentPollMs = asPositiveInt(raw["parentPollMs"]);
	if (parentPollMs !== undefined) out.parentPollMs = parentPollMs;
	if (raw["whitelist"] && typeof raw["whitelist"] === "object") {
		const w = raw["whitelist"] as Record<string, unknown>;
		const patch: { enabled?: boolean; diagnostics?: { extensions?: string[]; filenames?: string[] }; format?: { extensions?: string[]; filenames?: string[] } } = {};
		if (typeof w["enabled"] === "boolean") patch.enabled = w["enabled"] as boolean;
		for (const key of ["diagnostics", "format"] as const) {
			const t = w[key];
			if (t && typeof t === "object") {
				const tt = t as Record<string, unknown>;
				const extensions = asStringList(tt["extensions"], asExtension);
				const filenames = asStringList(tt["filenames"], asNonEmptyString);
				if (extensions !== undefined || filenames !== undefined) {
					patch[key] = {};
					if (extensions !== undefined) patch[key].extensions = extensions;
					if (filenames !== undefined) patch[key].filenames = filenames;
				}
			}
		}
		if (patch.enabled !== undefined || patch.diagnostics !== undefined || patch.format !== undefined) {
			out.whitelist = patch as unknown as NvimWhitelist;
		}
	}
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
