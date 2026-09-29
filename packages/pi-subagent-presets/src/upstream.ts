/**
 * @inobit/pi-subagent-presets — pi-subagents 软依赖探测（§8.2）。
 *
 * 三档降级，**不内置任何上游数据**（frontmatter 默认值、别名表全部运行时探测）：
 * - L0（必需）：只依赖 pi core + pi-ai。合并、写盘、profile 导出、模型列表、
 *   thinking 夹取、26 字段校验、§3.1 两条"不物化"保护全部可用。
 * - L1（增强）：`discoverAgentsAll` 四桶 + `resolveAgentName` + `findConfiguredProjectRoot`
 *   + `clearAgentDiscoveryCache`。
 * - L2（提示）：黄条，不阻断写盘。
 *
 * 探测点按优先级全部只读：交给 pi 的包管理器 → manifest/lock → 五类安装根兜底。
 * **探测失败一律降级，绝不报"未安装"**；加载器可注入（测试用 fake，不连真实上游）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Override } from "./merge.ts";

/** `discoverAgentsAll` 的四个 bucket。 */
export interface UpstreamBuckets {
	builtin: UpstreamAgent[];
	package: UpstreamAgent[];
	user: UpstreamAgent[];
	project: UpstreamAgent[];
	[key: string]: unknown;
}

export interface UpstreamAgent {
	name: string;
	localName?: string;
	aliases?: string[];
	disabled?: boolean;
	model?: string;
	modelProvider?: string;
	thinking?: string | false;
	maxThinking?: string;
	override?: { fields?: string[]; fieldScopes?: Record<string, string[]>; scope?: string };
	[key: string]: unknown;
}

export interface UpstreamAgentInfo {
	agents: UpstreamAgent[];
	agentDiagnostics?: unknown[];
	[key: string]: unknown;
}

export interface ResolveAgentNameResult {
	agent?: UpstreamAgent;
	error?: string;
}

/** 上游 JS 入口里我们实际用到的形状（**形状检查优先于版本号**）。 */
export interface UpstreamModule {
	discoverAgentsAll?: (cwd: string, provider?: string, options?: unknown) => UpstreamBuckets;
	discoverAgents?: (cwd: string, scope: "both" | "user" | "project", provider?: string, options?: unknown) => UpstreamAgentInfo;
	resolveAgentName?: (name: string, agents: UpstreamAgent[]) => ResolveAgentNameResult;
	findConfiguredProjectRoot?: (cwd: string) => string | null;
	clearAgentDiscoveryCache?: () => void;
	removeBuiltinAgentOverride?: (cwd: string, name: string, scope: "user" | "project", options?: { preserveMachine?: boolean }) => void;
}

export interface UpstreamInstall {
	root: string;
	version?: string;
	/** 该根是怎么被找到的（提示性文案用）。 */
	via: "package-manager" | "manifest" | "fallback";
}

export type UpstreamLoader = (root: string) => Promise<unknown>;

export type UpstreamLevel = "L0" | "L1" | "L2";

export interface UpstreamStatus {
	level: UpstreamLevel;
	module?: UpstreamModule;
	version?: string;
	root?: string;
	/** 黄条（不阻断）。 */
	notice?: string;
	/** 红条（上游存在但 `discoverAgents` 自己抛错，§12）。 */
	error?: string;
	/** 触发降级的原始错误。 */
	cause?: unknown;
}

/** 上游包名（npm source 与包目录同名）。 */
export const UPSTREAM_PACKAGE = "pi-subagents";
/** 五类安装根里唯一需要 try 的入口：npm tarball 只有 `.js`，git 检出只有 `.ts`。 */
export const UPSTREAM_ENTRIES = ["src/agents/agents.js", "src/agents/agents.ts"] as const;

/**
 * 动态加载。
 *
 * ⚠️ `import()` 的实参必须是**计算出来的字符串**：写成字面量 TS 会去解析它并报
 * TS2307，且结果退化为 `any`。git 检出只有 `.ts`，从扩展里 import `.ts` 不保证可用，
 * 所以两种入口都试、失败就试下一个、绝不抛。
 */
export function createDefaultLoader(): UpstreamLoader {
	return async (root: string): Promise<unknown> => {
		for (const entry of UPSTREAM_ENTRIES) {
			const file = join(root, entry);
			if (!existsSync(file)) continue;
			try {
				const specifier = pathToFileURL(file).href;
				return await import(specifier);
			} catch {
				// 试下一个入口
			}
		}
		return null;
	};
}

function readVersion(root: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 由入口注入 pi 的包管理器能力。
 *
 * 单独做成注入点有两个理由：包管理器构造需要 `SettingsManager`（会拉起 pi 的存储层），
 * 而纯逻辑测试必须完全不碰真实上游与 `~/.pi`。
 */
let packageManagerProbe: ((cwd: string, agentDir: string, trusted: boolean) => string | undefined) | undefined;

export function setPackageManagerProbe(probe: ((cwd: string, agentDir: string, trusted: boolean) => string | undefined) | undefined): void {
	packageManagerProbe = probe;
}

function viaManifest(agentDir: string): string | undefined {
	const manifestPath = join(agentDir, "npm", "package.json");
	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
		if (!parsed.dependencies?.[UPSTREAM_PACKAGE]) return undefined;
	} catch {
		return undefined;
	}
	const root = join(agentDir, "npm", "node_modules", UPSTREAM_PACKAGE);
	return existsSync(root) ? root : undefined;
}

/** 五类根兜底（1、2 都拿不到时）：user / project / legacy 全局 / git / temporary。 */
function viaFallback(agentDir: string, cwd: string, trusted: boolean): string | undefined {
	const candidates: string[] = [
		join(agentDir, "npm", "node_modules", UPSTREAM_PACKAGE),
		join(cwd, ".pi", "npm", "node_modules", UPSTREAM_PACKAGE),
		join(agentDir, "tmp", "npm", "node_modules", UPSTREAM_PACKAGE),
	];
	// 向上找 node_modules（本地开发 / `pi -e ./local`）
	let current = cwd;
	for (let depth = 0; depth < 12; depth++) {
		candidates.push(join(current, "node_modules", UPSTREAM_PACKAGE));
		const parent = join(current, "..");
		if (parent === current) break;
		current = parent;
	}
	for (const candidate of candidates) {
		if (!trusted && candidate.startsWith(join(cwd, ".pi"))) continue;
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
	return undefined;
}

/** 找安装根（只读探测，全部失败返回 undefined——**绝不据此说"没装"**）。 */
export function findUpstreamInstall(cwd: string, agentDir: string, trusted: boolean): UpstreamInstall | undefined {
	const probed = packageManagerProbe?.(cwd, agentDir, trusted);
	if (probed && existsSync(probed)) return { root: probed, via: "package-manager", version: readVersion(probed) };
	const manifestRoot = viaManifest(agentDir);
	if (manifestRoot) return { root: manifestRoot, via: "manifest", version: readVersion(manifestRoot) };
	const fallbackRoot = viaFallback(agentDir, cwd, trusted);
	if (fallbackRoot) return { root: fallbackRoot, via: "fallback", version: readVersion(fallbackRoot) };
	return undefined;
}

export interface DetectUpstreamOptions {
	cwd: string;
	agentDir: string;
	trusted: boolean;
	/** loader 可注入（测试用 fake）。 */
	loader?: UpstreamLoader;
	/** 安装根可注入（测试跳过文件系统探测）。 */
	install?: UpstreamInstall | undefined;
}

/**
 * 探测并加载上游。
 *
 * 降级矩阵（对应 §8.2 的五种"上游不可用"情形）：
 * ① 没装 / ② 五类根全落空 / ③ 无可加载 JS 入口 → L2 黄条「未检测到 pi-subagents」
 * ④ 装了但缺 `discoverAgentsAll` → L2 黄条「版本过旧：仅降级模式」
 * ⑤ 装上、能加载，但 `discoverAgents` 抛错 → 调用方红条 + L0（这里只负责不在探测期抛）
 */
export async function detectUpstream(opts: DetectUpstreamOptions): Promise<UpstreamStatus> {
	const loader = opts.loader ?? createDefaultLoader();
	const install = opts.install !== undefined ? opts.install : findUpstreamInstall(opts.cwd, opts.agentDir, opts.trusted);
	if (!install) {
		return { level: "L2", notice: "pi-subagents not detected — degraded mode: row state is not classified and the maxThinking ceiling comes from settings" };
	}
	const version = install.version ?? readVersion(install.root);
	let mod: unknown;
	try {
		mod = await loader(install.root);
	} catch (e) {
		return {
			level: "L2",
			root: install.root,
			version,
			notice: "pi-subagents is installed but its JS entry could not be loaded — degraded mode",
			cause: e,
		};
	}
	if (!mod || typeof mod !== "object") {
		return { level: "L2", root: install.root, version, notice: "pi-subagents is installed but has no loadable JS entry — degraded mode" };
	}
	const candidate = mod as UpstreamModule;
	if (typeof candidate.discoverAgentsAll !== "function") {
		return {
			level: "L2",
			root: install.root,
			version,
			notice: `pi-subagents ${version ?? "(unknown version)"} is too old (no discoverAgentsAll) — degraded mode only`,
		};
	}
	return { level: "L1", module: candidate, root: install.root, version };
}

export interface DiscoveryResult {
	buckets: UpstreamBuckets;
	/** 四桶并集（`resolveAgentName` 的第二参必须是它，否则自定义 agent 解析不到）。 */
	all: UpstreamAgent[];
	effective: UpstreamAgent[];
	error?: string;
}

function collectBuckets(buckets: UpstreamBuckets): UpstreamAgent[] {
	const out: UpstreamAgent[] = [];
	for (const key of ["builtin", "package", "user", "project"]) {
		const bucket = buckets[key];
		if (Array.isArray(bucket)) out.push(...bucket);
	}
	return out;
}

/**
 * 调 `discoverAgentsAll` 并归一化。
 *
 * ⚠️ 灰行判定**必须查四桶**，不能用 effective 列表（后者过滤了 `disabled`，
 * 会把用户故意禁用的 agent 当死键删掉）。上游自身抛错（情形 ⑤，根因通常是用户
 * 手改出非法值）时不崩，返回 `error` 让调用方红条 + L0。
 */
export function callDiscoverAll(
	module: UpstreamModule,
	cwd: string,
	provider: string | undefined,
	scope: "both" | "user" | "project" = "both",
): DiscoveryResult {
	if (typeof module.discoverAgentsAll !== "function") {
		return { buckets: { builtin: [], package: [], user: [], project: [] }, all: [], effective: [], error: "discoverAgentsAll is unavailable" };
	}
	try {
		const buckets = module.discoverAgentsAll(cwd, provider);
		const all = collectBuckets(buckets);
		return { buckets, all, effective: all.filter((agent) => agent.disabled !== true) };
	} catch (e) {
		const detail = e instanceof Error ? `${e.message}` : String(e);
		// 再试一次 effective 列表（可能 scope 参数下不抛）；抛了就是真抛。
		let effective: UpstreamAgent[] = [];
		if (typeof module.discoverAgents === "function") {
			try {
				effective = module.discoverAgents(cwd, scope, provider).agents.filter((agent) => agent.disabled !== true);
			} catch {
				effective = [];
			}
		}
		return {
			buckets: { builtin: [], package: [], user: [], project: [] },
			all: effective,
			effective,
			error: detail,
		};
	}
}

/** 提供 `discoverAgents` 基准值（§3.5 的规范：基准值必须直读上游解析结果）。 */
export function callDiscoverAgents(
	module: UpstreamModule | undefined,
	cwd: string,
	provider: string | undefined,
): UpstreamAgent[] | undefined {
	if (!module || typeof module.discoverAgents !== "function") return undefined;
	try {
		return module.discoverAgents(cwd, "both", provider).agents;
	} catch {
		return undefined;
	}
}

export function clearDiscoveryCache(module: UpstreamModule | undefined): void {
	if (!module || typeof module.clearAgentDiscoveryCache !== "function") return;
	try {
		module.clearAgentDiscoveryCache();
	} catch {
		// best-effort：清缓存失败不影响"下次 launch 自动重建"
	}
}

/** §3.1 保护一：任意 provider 键下 `userSettings.agentOverridesByProvider.<p>[name]` 存在。 */
export function providerScopedHits(name: string, userProviderMap: Record<string, Record<string, Override>>): string[] {
	return Object.entries(userProviderMap)
		.filter(([, map]) => map && name in map)
		.map(([provider]) => provider);
}
