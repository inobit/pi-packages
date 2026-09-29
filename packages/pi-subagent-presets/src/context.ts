/**
 * @inobit/pi-subagent-presets — 路径与项目根解析。
 *
 * 三条硬约束（来自上游口径，不是我们的选择）：
 * 1. `agentDir` = `$PI_CODING_AGENT_DIR`（支持 `~` 展开）或 `<CONFIG_DIR_NAME>/agent`。
 * 2. 项目配置目录名**不硬编码**：pi 与 pi-subagents 都从各自 `package.json` 的
 *    `piConfig.configDir` 解析。这里用 `createRequire` 读 pi 包的 manifest（同步、
 *    不引入 pi 的整张模块图），与上游 `resolveConfigDirNameFromPackageJson` 同口径；
 *    `applyConfigDirNameOverride()` 供入口用 pi 主入口导出的 `CONFIG_DIR_NAME` 兜底校正。
 * 3. 项目根分档：L1 走上游 `findConfiguredProjectRoot`（**必须 try/catch**，它会对
 *    `projectRootResolution` 等我们不校验的键抛错），L0 退回 `ctx.cwd`。
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG_DIR_NAME = ".pi";
const require_ = createRequire(import.meta.url);

let configDirNameOverride: string | undefined;
let configDirNameCached: string | undefined;

/** 用 pi 主入口导出的 `CONFIG_DIR_NAME` 校正（值一致时是幂等的 no-op）。 */
export function applyConfigDirNameOverride(name: string | undefined): void {
	if (typeof name === "string" && name.trim()) {
		configDirNameOverride = name.trim();
		configDirNameCached = undefined;
	}
}

function configDirNameFromManifest(): string | undefined {
	try {
		const manifestPath = require_.resolve("@earendil-works/pi-coding-agent/package.json");
		const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
			piConfig?: { configDir?: unknown };
		};
		const dir = parsed.piConfig?.configDir;
		if (typeof dir === "string" && /^[A-Za-z0-9._-]+$/.test(dir)) return dir;
	} catch {
		// manifest 不可达（未安装 pi / 打包环境）：退回默认名
	}
	return undefined;
}

export function getConfigDirName(): string {
	if (configDirNameOverride) return configDirNameOverride;
	if (configDirNameCached) return configDirNameCached;
	const resolved = configDirNameFromManifest() ?? DEFAULT_CONFIG_DIR_NAME;
	configDirNameCached = resolved;
	return resolved;
}

/** `$PI_CODING_AGENT_DIR` 支持 `~` / `~/` 展开，与 pi 及同仓其它包一致。 */
export function getAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR;
	if (env) {
		if (env === "~") return os.homedir();
		if (env.startsWith("~/") || env.startsWith("~\\")) return path.join(os.homedir(), env.slice(2));
		return env;
	}
	return path.join(os.homedir(), getConfigDirName(), "agent");
}

export function getUserSettingsPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "settings.json");
}

/** 项目 settings 路径：pi 自身**没有向上搜索**，就是 `cwd/<CONFIG_DIR_NAME>`。 */
export function getProjectSettingsPath(projectRoot: string): string {
	return path.join(projectRoot, getConfigDirName(), "settings.json");
}

/** profile 目录与上游官方目录一致，天然互通 `/subagents-profiles`。 */
export function getProfilesDir(agentDir = getAgentDir()): string {
	return path.join(agentDir, "profiles", "pi-subagents");
}

export function getProfilePath(name: string, agentDir = getAgentDir()): string {
	return path.join(getProfilesDir(agentDir), `${name}.json`);
}

export type ProjectRootTier = "pi" | "git" | "cwd";

export interface ProjectRootResolution {
	root: string;
	tier: ProjectRootTier;
	/** 上游探测自身抛错时的说明（已回落 ctx.cwd，绝不硬失败）。 */
	warning?: string;
}

/**
 * 项目根解析：**`.pi` → git 根 → cwd**。
 *
 * 为什么不直接用上游 `findConfiguredProjectRoot`：它的候选判据是「祖先目录含 `.pi`
 * **或** `.agents`」（`agents.js:546-548`），**git 根完全不参与**（除非某个候选在
 * `.pi/settings.json` 里显式写 `projectRootResolution: "git-root"`）。于是容器目录里
 * 只要残留一个 `.agents/`（例：`myprojects/.agents` 只是 `skills -> .claude/skills`
 * 的软链），就会成为最近候选，**它下面所有仓库的配置全被写进同一个目录**。
 *
 * 收敛性：写盘会在选中的根创建 `<CONFIG_DIR_NAME>/`，该目录随即成为上游的最近候选，
 * 所以**第一次保存之后两边一致**（差异只存在于“还没有配置文件”的那一刻）。
 */
export function resolveProjectRoot(
	cwd: string,
	_upstreamProjectRoot: ((cwd: string) => string | null) | undefined,
): ProjectRootResolution {
	const configDir = getConfigDirName();
	const gitRoot = findNearestGitRoot(cwd);
	const nearestPi = findNearestDirWithConfigDir(cwd, configDir);

	// 上游的显式 opt-in：某个 `.pi` 里写了 `projectRootResolution: "git-root"` ⇒ 用 git 根。
	// 不尊重它会导致我们写在 `.pi` 目录、而上游去读 git 根 ⇒ 配置静默失效。
	if (nearestPi && gitRoot && isDeeperThan(gitRoot, nearestPi) && wantsGitRoot(nearestPi, configDir)) {
		return { root: gitRoot, tier: "git", warning: `${nearestPi}/.pi requests projectRootResolution: "git-root"` };
	}
	if (nearestPi) return { root: nearestPi, tier: "pi" };
	if (gitRoot) {
		return {
			root: gitRoot,
			tier: "git",
			warning: `No ${configDir} found above cwd; using the git root ${gitRoot}. A ${configDir}/settings.json will be created there.`,
		};
	}
	return { root: cwd, tier: "cwd" };
}

function isDeeperThan(candidate: string, ancestor: string): boolean {
	return path.resolve(candidate).length > path.resolve(ancestor).length;
}

/** 从 `cwd` 向上找最近的含 `<configDir>/` 的祖先；**到 home 为止**。 */
function findNearestDirWithConfigDir(cwd: string, configDir: string): string | undefined {
	const homes = new Set(
		[os.homedir(), process.env.HOME, process.env.USERPROFILE].filter((v): v is string => Boolean(v?.trim())).map((v) => safeRealpath(v)),
	);
	let current = path.resolve(cwd);
	for (;;) {
		// `~/.pi` 是全局配置，**永不**当作隐式项目（与上游一致）。
		if (homes.has(safeRealpath(current))) return undefined;
		if (fs.existsSync(path.join(current, configDir))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** 向上找最近的 `.git`（文件或目录都算，worktree/submodule 是 `.git` 文件）。 */
function findNearestGitRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** 读 `<root>/<configDir>/settings.json` 的 `subagents.projectRootResolution`（读失败当作没写）。 */
function wantsGitRoot(root: string, configDir: string): boolean {
	try {
		const raw = fs.readFileSync(path.join(root, configDir, "settings.json"), "utf-8");
		const parsed = JSON.parse(raw) as { subagents?: { projectRootResolution?: unknown } };
		return parsed?.subagents?.projectRootResolution === "git-root";
	} catch {
		return false;
	}
}

function safeRealpath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}
