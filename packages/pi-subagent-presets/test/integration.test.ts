import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildCompletions } from "../src/completions.ts";
import { getConfigDirName, getProfilePath, getProjectSettingsPath, getUserSettingsPath } from "../src/context.ts";
import { DEFAULT_AGENTS, configPaths, loadConfig, normalizeAgents, normalizeConfig } from "../src/config.ts";
import { listProfileNames, profileExists, readDefaultProfile, readProfile, readProjectLayer, readSettingsLayer, readUserLayer } from "../src/settings-io.ts";
import { buildRowViews, buildSession, resetAfterSave, type UpstreamDiscovery } from "../src/session.ts";
import type { UpstreamAgent, UpstreamModule } from "../src/upstream.ts";
import { callDiscoverAll, clearDiscoveryCache, detectUpstream, findUpstreamInstall, UPSTREAM_ENTRIES } from "../src/upstream.ts";
import { buildPlan, buildRebuildInputs, collectWarnings, commitSave, parseArgs, parseEditedContent, editorContent, entryForEditor, reviewEditedJson, jsonEditorHeader, readMaxThinking, summaryLines, collectDiscovery, refreshViews } from "../src/index.ts";
import register, { COMMAND_NAME } from "../src/index.ts";
import type { MatrixRowView } from "../src/tui/matrix.ts";
import { applyEditedEntry, synthesize, type Override, initialExtra, isDirty, rowMergeState } from "../src/merge.ts";
import { FIELD_GUIDE, KNOWN_FIELDS } from "../src/validate.ts";
import { isEditable } from "../src/rowstate.ts";
import { createDefaultLoader } from "../src/upstream.ts";

/**
 * 集成测试骨架：临时 `PI_CODING_AGENT_DIR` + 临时项目目录，**绝不碰用户的 `~/.pi`**。
 * 上游一律注入 fake（loader + module），默认不连真实 pi-subagents。
 */

let tmp: string;
let agentDir: string;
let projectRoot: string;
let prevAgentDir: string | undefined;

const BUILTIN_AGENTS: UpstreamAgent[] = [
	{ name: "worker", model: "def/w1", thinking: "low" },
	{ name: "scout", model: "def/s1" },
	{ name: "reviewer", model: "def/r1" },
	{ name: "oracle", model: "def/o1", aliases: ["advisor"] },
	{ name: "researcher", model: "def/rs1", disabled: true },
	{ name: "delegate", model: "def/d1" },
	{ name: "evidence-auditor", model: "def/ea1" },
];

/** 上游 `resolveAgentName` 的最小复刻（真实实现见 agents.js:417-447）。 */
function fakeResolveAgentName(name: string, agents: UpstreamAgent[]): { agent?: UpstreamAgent; error?: string } {
	const raw = name.trim();
	const canonical = agents.filter((agent) => agent.name === raw);
	if (canonical.length === 1) return { agent: canonical[0] };
	if (canonical.length > 1) return { error: `Ambiguous agent name '${name}'` };
	const local = agents.filter((agent) => agent.localName === raw);
	if (local.length === 1) return { agent: local[0] };
	if (local.length > 1) return { error: `Ambiguous local agent name '${name}'` };
	const aliases = agents.filter((agent) => agent.aliases?.includes(raw));
	if (aliases.length === 1) return { agent: aliases[0] };
	if (aliases.length > 1) return { error: `Ambiguous agent alias '${name}'` };
	return {};
}

function fakeModule(overrides: Partial<UpstreamModule> = {}): UpstreamModule {
	return {
		discoverAgentsAll: () => ({ builtin: BUILTIN_AGENTS, package: [], user: [], project: [] }),
		discoverAgents: () => ({ agents: BUILTIN_AGENTS.filter((a) => a.disabled !== true) }),
		resolveAgentName: fakeResolveAgentName,
		findConfiguredProjectRoot: () => projectRoot,
		clearAgentDiscoveryCache: () => {
			cleared++;
		},
		...overrides,
	};
}

let cleared = 0;

function writeUserSettings(value: unknown): void {
	fs.mkdirSync(path.dirname(getUserSettingsPath(agentDir)), { recursive: true });
	fs.writeFileSync(getUserSettingsPath(agentDir), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeProjectSettings(value: unknown): void {
	fs.mkdirSync(path.dirname(getProjectSettingsPath(projectRoot)), { recursive: true });
	fs.writeFileSync(getProjectSettingsPath(projectRoot), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readProjectSettings(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(getProjectSettingsPath(projectRoot), "utf8")) as Record<string, unknown>;
}

/** L1（四桶 + discoverAgents 齐全）发现结果。 */
function l1(): UpstreamDiscovery {
	return { module: fakeModule(), fourBucketAgents: BUILTIN_AGENTS, baselineAgents: BUILTIN_AGENTS };
}

/** 装配一次会话（托管清单 = 默认 7 个 + 别名行 + 灰行）。 */
function sessionOf(discovery: UpstreamDiscovery, fromProfile?: string) {
	return buildSession(
		{ cwd: projectRoot, agentDir, trusted: true, ...(fromProfile !== undefined ? { fromProfile } : {}) },
		discovery,
		{ agents: [...DEFAULT_AGENTS, "advisor", "stale-agent"] },
	);
}

/** 最小 view 集合：直接由 session.rows 造，够驱动 buildPlan 与 `e`。 */
function sessionViews(s: ReturnType<typeof sessionOf>): MatrixRowView[] {
	return s.rows.map((row) => ({
		name: row.name,
		classification: row.classification,
		draft: row.draft,
		merged: row.merged,
		origin: row.origin,
		...(row.globalEntry ? { globalEntry: row.globalEntry } : {}),
		locatedModel: undefined,
		maxThinking: undefined,
		fullModelText: "",
		modelText: "",
		modelUnresolved: false,
		thinkingText: "",
		thinkingValue: "",
		overCeiling: false,
		carriedKeys: Object.keys(row.merged).filter((k) => k !== "model" && k !== "thinking"),
		editWarnings: [],
	}));
}

beforeEach(() => {
	cleared = 0;
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-presets-int-"));
	agentDir = path.join(tmp, "agent");
	projectRoot = path.join(tmp, "repo", "packages", "foo");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectRoot, { recursive: true });
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("配置读写（双层 config.json）", () => {
	it("默认托管清单是 7 个纯 Pi runner 的 builtin", () => {
		expect(DEFAULT_AGENTS).toEqual(["worker", "scout", "reviewer", "oracle", "researcher", "delegate", "evidence-auditor"]);
	});

	it("路径模式：<agentDir>/extensions/… 与 <cwd>/<CONFIG_DIR_NAME>/extensions/…", () => {
		const paths = configPaths(projectRoot, agentDir);
		expect(paths.globalPath).toBe(path.join(agentDir, "extensions", "pi-subagent-presets", "config.json"));
		expect(paths.projectPath).toBe(path.join(projectRoot, getConfigDirName(), "extensions", "pi-subagent-presets", "config.json"));
	});

	it("项目层整体替换全局层（不是并集）", () => {
		const merged = normalizeConfig({ agents: ["a", "b"] }, { agents: ["c"] });
		expect(merged.agents).toEqual(["c"]);
	});

	it("未 trust 时只读全局层", () => {
		const globalPath = path.join(agentDir, "extensions", "pi-subagent-presets", "config.json");
		const projectPath = path.join(projectRoot, getConfigDirName(), "extensions", "pi-subagent-presets", "config.json");
		fs.mkdirSync(path.dirname(globalPath), { recursive: true });
		fs.mkdirSync(path.dirname(projectPath), { recursive: true });
		fs.writeFileSync(globalPath, JSON.stringify({ agents: ["a"] }));
		fs.writeFileSync(projectPath, JSON.stringify({ agents: ["c"] }));
		expect(loadConfig(projectRoot, { trusted: false }).agents).toEqual(["a"]);
		expect(loadConfig(projectRoot, { trusted: true }).agents).toEqual(["c"]);
	});

	it("首次运行在全局层生成默认配置文件（VITEST 下不落盘）", () => {
		fs.mkdirSync(path.join(agentDir, "extensions", "pi-subagent-presets"), { recursive: true });
		const cfg = loadConfig(projectRoot, { skipWrite: false });
		expect(cfg.agents).toEqual([...DEFAULT_AGENTS]);
		expect(JSON.parse(fs.readFileSync(path.join(agentDir, "extensions", "pi-subagent-presets", "config.json"), "utf8"))).toEqual({
			agents: [...DEFAULT_AGENTS],
		});
	});

	it("normalizeAgents 去空白 / 去非串 / 去重", () => {
		expect(normalizeAgents([" a ", "b", "a", 1, "", "c"])).toEqual(["a", "b", "c"]);
		expect(normalizeAgents("x")).toBeUndefined();
	});
});

describe("三层 settings 读取（纯 IO，无上游依赖）", () => {
	it("文件不存在是正常情况（exists:false，无 error）", () => {
		const layer = readSettingsLayer(path.join(tmp, "nope.json"));
		expect(layer.exists).toBe(false);
		expect(layer.error).toBeUndefined();
		expect(layer.subagents.agentOverrides).toEqual({});
	});

	it("语法错误 ⇒ 带 error，不抛", () => {
		const file = path.join(tmp, "bad.json");
		fs.writeFileSync(file, "{ nope");
		const layer = readSettingsLayer(file);
		expect(layer.error).toContain("Failed to parse");
	});

	it("顶层非对象 ⇒ 带 error", () => {
		const file = path.join(tmp, "arr.json");
		fs.writeFileSync(file, "[]");
		expect(readSettingsLayer(file).error).toContain("must contain a JSON object");
	});

	it("裸 JSON 整体读：agentOverridesByProvider 与顶层 disable* 都能拿到（L0 保护所需）", () => {
		writeUserSettings({
			subagents: {
				disableThinking: true,
				disableBuiltins: true,
				defaultProvider: "u",
				agentOverrides: { reviewer: { model: "u/m2" } },
				agentOverridesByProvider: { ino2api: { worker: { thinking: "max" } } },
			},
		});
		const layer = readUserLayer(agentDir);
		expect(layer.subagents.disableThinking).toBe(true);
		expect(layer.subagents.disableBuiltins).toBe(true);
		expect(layer.subagents.defaultProvider).toBe("u");
		expect(layer.subagents.hasProviderOverrides).toBe(true);
		expect(layer.subagents.agentOverridesByProvider.ino2api?.worker).toEqual({ thinking: "max" });
	});

	it("maxThinking 自读：项目优先于全局（与 resolveSubagentMaxThinking 一致）", () => {
		writeUserSettings({ subagents: { maxThinking: "low" } });
		expect(readMaxThinking(readProjectLayer(projectRoot), readUserLayer(agentDir))).toBe("low");
		writeProjectSettings({ subagents: { maxThinking: "high" } });
		expect(readMaxThinking(readProjectLayer(projectRoot), readUserLayer(agentDir))).toBe("high");
	});
});

describe("profile 读写与校验（§11 用例 12）", () => {
	function writeProfile(name: string, value: unknown): void {
		const file = getProfilePath(name, agentDir);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	}

	it("列出可用名字（只列 *.json，已剥后缀，升序）", () => {
		writeProfile("work", { subagents: { agentOverrides: {} } });
		writeProfile("default", { subagents: { agentOverrides: {} } });
		fs.mkdirSync(path.join(getProfilePath("", agentDir).replace(/\.json$/, "")), { recursive: true });
		fs.writeFileSync(path.join(path.dirname(getProfilePath("x", agentDir)), "notes.txt"), "ignored");
		expect(listProfileNames(agentDir)).toEqual(["default", "work"]);
	});

	it("合法 profile 读入并通过校验器", () => {
		writeProfile("work", { subagents: { agentOverrides: { reviewer: { model: "p/m", thinking: "high" } } } });
		const entry = readProfile("work", agentDir);
		expect(entry?.errors).toEqual([]);
		expect(entry?.agentOverrides).toEqual({ reviewer: { model: "p/m", thinking: "high" } });
	});

	it("非法 profile ⇒ errors 非空（红条并拒绝合并）", () => {
		writeProfile("bad", { subagents: { agentOverrides: { reviewer: { outputMode: "x" } } } });
		expect(readProfile("bad", agentDir)?.errors.length).toBeGreaterThan(0);
		writeProfile("bad2", { subagents: { agentOverrides: { reviewer: { model: false } } } });
		expect(readProfile("bad2", agentDir)?.errors.length).toBeGreaterThan(0);
		writeProfile("bad3", { noSubagents: true });
		expect(readProfile("bad3", agentDir)?.errors.length).toBeGreaterThan(0);
	});

	it("未知键只警告不报错（profile 读取仍成功）", () => {
		writeProfile("warn", { subagents: { agentOverrides: { reviewer: { model: "p/m", futureField: 1 } } } });
		const entry = readProfile("warn", agentDir);
		expect(entry?.errors).toEqual([]);
		expect(entry?.warnings.length).toBeGreaterThan(0);
	});

	it("不存在的名字 / 非法名字 ⇒ undefined", () => {
		expect(readProfile("nope", agentDir)).toBeUndefined();
		expect(readProfile("../escape", agentDir)).toBeUndefined();
		expect(profileExists("nope", agentDir)).toBe(false);
	});

	it("default profile 是基底 ① 的回落", () => {
		writeProfile("default", { subagents: { agentOverrides: { scout: { model: "d/m" } } } });
		expect(readDefaultProfile(agentDir)).toEqual({ scout: { model: "d/m" } });
	});
});

describe("上游探测（软依赖，loader 注入）", () => {
	it("找不到安装根 ⇒ L2 黄条，绝不抛", async () => {
		const status = await detectUpstream({ cwd: projectRoot, agentDir, trusted: true, install: undefined });
		expect(status.level).toBe("L2");
		expect(status.notice).toContain("not detected");
	});

	it("loader 返回 null ⇒ L2（无可加载 JS 入口，如 git 检出只有 .ts）", async () => {
		const status = await detectUpstream({
			cwd: projectRoot,
			agentDir,
			trusted: true,
			install: { root: "/somewhere", version: "0.73.1", via: "fallback" },
			loader: async () => null,
		});
		expect(status.level).toBe("L2");
		expect(status.notice).toContain("no loadable JS entry");
	});

	it("loader 抛错 ⇒ L2 降级，不抛", async () => {
		const status = await detectUpstream({
			cwd: projectRoot,
			agentDir,
			trusted: true,
			install: { root: "/somewhere", via: "fallback" },
			loader: async () => {
				throw new Error("boom");
			},
		});
		expect(status.level).toBe("L2");
		expect(status.cause).toBeInstanceOf(Error);
	});

	it("缺 discoverAgentsAll ⇒ L2「版本过旧」（形状检查优先于版本号）", async () => {
		const status = await detectUpstream({
			cwd: projectRoot,
			agentDir,
			trusted: true,
			install: { root: "/somewhere", version: "0.60.0", via: "fallback" },
			loader: async () => ({ discoverAgents: () => ({ agents: [] }) }),
		});
		expect(status.level).toBe("L2");
		expect(status.notice).toContain("too old");
		expect(status.notice).toContain("0.60.0");
	});

	it("形状齐全 ⇒ L1 并带版本号", async () => {
		const status = await detectUpstream({
			cwd: projectRoot,
			agentDir,
			trusted: true,
			install: { root: "/somewhere", version: "0.73.1", via: "fallback" },
			loader: async () => fakeModule(),
		});
		expect(status.level).toBe("L1");
		expect(status.version).toBe("0.73.1");
	});

	it("入口顺序：先 .js 再 .ts（npm tarball 只有 .js，git 检出只有 .ts）", () => {
		expect(UPSTREAM_ENTRIES).toEqual(["src/agents/agents.js", "src/agents/agents.ts"]);
	});

	it("无任何根 ⇒ findUpstreamInstall 返回 undefined（绝不据此说『没装』）", () => {
		const emptyDir = path.join(tmp, "empty-agent");
		fs.mkdirSync(emptyDir, { recursive: true });
		expect(findUpstreamInstall(projectRoot, emptyDir, true)).toBeUndefined();
	});

	it("manifest 探测：agentDir/npm/package.json 声明依赖且目录存在", () => {
		const root = path.join(agentDir, "npm", "node_modules", "pi-subagents");
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-subagents", version: "0.73.1" }));
		fs.mkdirSync(path.join(agentDir, "npm"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "npm", "package.json"), JSON.stringify({ dependencies: { "pi-subagents": "0.73.1" } }));
		const install = findUpstreamInstall(projectRoot, agentDir, true);
		expect(install?.via).toBe("manifest");
		expect(install?.version).toBe("0.73.1");
	});
});

describe("上游 discovery 调用（callDiscoverAll）", () => {
	it("四桶并集不过滤 disabled；effective 过滤", () => {
		const result = callDiscoverAll(fakeModule(), projectRoot, "ino2api");
		expect(result.all.map((a) => a.name)).toContain("researcher");
		expect(result.effective.map((a) => a.name)).not.toContain("researcher");
		expect(result.error).toBeUndefined();
	});

	it("上游抛错 ⇒ 返回 error，不崩（情形 ⑤）", () => {
		const result = callDiscoverAll(
			fakeModule({
				discoverAgentsAll: () => {
					throw new Error("invalid 'outputMode'");
				},
				discoverAgents: () => {
					throw new Error("invalid 'outputMode'");
				},
			}),
			projectRoot,
			"ino2api",
		);
		expect(result.error).toContain("outputMode");
		expect(result.all).toEqual([]);
	});

	it("discoverAgentsAll 缺失 ⇒ 返回 error（不抛）", () => {
		const result = callDiscoverAll({ discoverAgents: () => ({ agents: [] }) }, projectRoot, undefined);
		expect(result.error).toContain("discoverAgentsAll");
	});

	it("collectDiscovery 把上游错误透传为 red-bar 素材", () => {
		const discovery = collectDiscovery(
			fakeModule({
				discoverAgentsAll: () => {
					throw new Error("bad");
				},
			}),
			projectRoot,
			undefined,
		);
		expect(discovery.error).toBe("bad");
	});

	it("clearAgentDiscoveryCache 缺失 / 抛错都无害（best-effort）", () => {
		expect(() => clearDiscoveryCache(undefined)).not.toThrow();
		expect(() => clearDiscoveryCache({ clearAgentDiscoveryCache: () => { throw new Error("x"); } })).not.toThrow();
		clearDiscoveryCache(fakeModule());
		expect(cleared).toBe(1);
	});
});

describe("会话装配 + 端到端保存", () => {
	it("行分类：7 个默认行 + 别名行 + 灰行（上游禁用与上游已无同一行为）", () => {
		const s = sessionOf(l1());
		const byName = new Map(s.rows.map((row) => [row.name, row]));
		// 假上游里 researcher 是 disabled ⇒ 上游禁用 ⇒ 行为与 MISSING 一致
		expect(byName.get("researcher")?.classification.state).toBe("unresolved");
		expect(byName.get("researcher")?.classification.disabledUpstream).toBe(true);
		expect(byName.get("advisor")?.classification.isAlias).toBe(true);
		expect(byName.get("advisor")?.classification.aliasOf).toBe("oracle");
		expect(byName.get("stale-agent")?.classification.state).toBe("unresolved");
		expect(byName.get("stale-agent")?.classification.disabledUpstream).toBe(false);
		expect(byName.get("reviewer")?.classification.state).toBe("inherit");
	});

	it("我们配的禁用（合并结果里有 disabled:true）⇒ 行仍可编辑、照常写盘", () => {
		writeUserSettings({ subagents: { agentOverrides: { reviewer: { disabled: true } } } });
		const s = sessionOf(l1());
		const byName = new Map(s.rows.map((row) => [row.name, row]));
		expect(byName.get("reviewer")?.classification.disabledByOverride).toBe(true);
		expect(byName.get("reviewer")?.classification.disabledUpstream).toBe(false);
		expect(isEditable("inherit", false)).toBe(true);
	});

	it("显示口径：没有值就真是空白；`model: \"inherit\"` 就是 inherit（不是 not in registry）", () => {
		writeUserSettings({ subagents: { agentOverrides: { reviewer: { model: "inherit", thinking: "high" } } } });
		const s = sessionOf(l1(), undefined);
		const sources = { models: [], registry: { getAvailable: () => [] }, scopedModels: [] };
		const views = buildRowViews(s.rows, { module: fakeModule(), baselineAgents: BUILTIN_AGENTS }, sources);

		const reviewer = views.find((v) => v.name === "reviewer")!;
		expect(reviewer.modelText).toBe("inherit");
		expect(reviewer.fullModelText).toBe("");

		// 两层都没有该 agent 的字段 ⇒ 两列真正的空白（不回落到定义层）
		const scout = views.find((v) => v.name === "scout")!;
		expect(scout.merged).toEqual({});
		expect(scout.modelText).toBe("");
		expect(scout.thinkingText).toBe("");
	});

	it("端到端：把全局条目合并写入项目，其余键语义保留", () => {
		writeProjectSettings({ theme: "dark", subagents: { defaultModel: "u/m", maxThinking: "high", agentOverrides: { legacy: { model: "x" } } } });
		writeUserSettings({ subagents: { agentOverrides: { reviewer: { model: "u/m2", tools: ["read", "bash"], acceptanceRole: "writer", thinking: "medium" } } } });

		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "reviewer")!;
		expect(row.merged).toEqual({ model: "u/m2", tools: ["read", "bash"], acceptanceRole: "writer", thinking: "medium" });

		row.draft.touched.add("model");
		row.draft.model = "p/m1";
		const vs = sessionViews(s);
		const { plan } = buildPlan(s, vs);
		// 写进去的字段就是最终值；非白名单的 legacy 条目被移除
		expect(plan.overrides).toEqual({
			reviewer: { model: "p/m1", tools: ["read", "bash"], acceptanceRole: "writer", thinking: "medium" },
		});
		expect(plan.removals.map((r) => r.name)).toContain("legacy");

		commitSave(s, { writeProject: true, writeProfile: false, profileName: "default" }, plan, [], agentDir, fakeModule());
		const settings = readProjectSettings();
		expect(settings.theme).toBe("dark");
		expect(settings.subagents).toEqual({
			defaultModel: "u/m",
			maxThinking: "high",
			agentOverrides: {
				reviewer: { model: "p/m1", tools: ["read", "bash"], acceptanceRole: "writer", thinking: "medium" },
			},
		});
		expect(cleared).toBe(1);
	});

	it("不可合并行保持现状（回归）：项目 {model:'p/m3'} + user 侧任意 provider 层", () => {
		writeProjectSettings({ subagents: { agentOverrides: { worker: { model: "p/m3" } } } });
		writeUserSettings({ subagents: { agentOverrides: { worker: { model: "u/m2" } }, agentOverridesByProvider: { ino2api: { worker: { thinking: "max" } } } } });

		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "worker")!;
		expect(row.classification.state).toBe("unmerged");
		expect(row.classification.providerHits).toEqual(["ino2api"]);
		// 即便用户改了 thinking，也不物化
		row.draft.touched.add("thinking");
		row.draft.thinking = "max";

		const { plan } = buildPlan(s, sessionViews(s));
		expect(plan.overrides.worker).toEqual({ model: "p/m3" });
		expect(plan.keptLocked).toEqual(["worker"]);

		commitSave(s, { writeProject: true, writeProfile: false, profileName: "default" }, plan, [], agentDir, fakeModule());
		const settings = readProjectSettings() as { subagents: { agentOverrides: Record<string, Override> } };
		expect(settings.subagents.agentOverrides.worker).toEqual({ model: "p/m3" });
	});

	it("别名行与灰行不落盘；保存时列入移除", () => {
		writeProjectSettings({ subagents: { agentOverrides: { advisor: { model: "p/m" }, "stale-agent": { model: "p/m" } } } });
		const s = sessionOf(l1());
		const { plan } = buildPlan(s, sessionViews(s));
		expect(plan.overrides.advisor).toBeUndefined();
		expect(plan.overrides["stale-agent"]).toBeUndefined();
		const reasons = new Map(plan.removals.map((r) => [r.name, r.reason]));
		expect(reasons.get("advisor")).toBe("alias");
		expect(reasons.get("stale-agent")).toBe("unresolved");
	});

	it("--from：项目已有该 agent 条目 ⇒ 基底仍取**指定 profile**（--from 换掉整个基底）", () => {
		const profileFile = getProfilePath("work", agentDir);
		fs.mkdirSync(path.dirname(profileFile), { recursive: true });
		fs.writeFileSync(profileFile, JSON.stringify({ subagents: { agentOverrides: { reviewer: { model: "b/m", thinking: "max" } } } }));
		writeProjectSettings({ subagents: { agentOverrides: { reviewer: { model: "p/m", skills: ["s"] } } } });

		const s = sessionOf(l1(), "work");
		const row = s.rows.find((r) => r.name === "reviewer")!;
		// 基底 = 指定 profile（项目条目不参与），因此 skills 不进入基底
		expect(row.merged).toEqual({ model: "b/m", thinking: "max" });

		// 项目条目里的 skills 不在合并结果里 ⇒ 写入时被丢弃，保存屏单列出来
		row.draft.touched.add("thinking");
		row.draft.thinking = "low";
		const plan = buildPlan(s, sessionViews(s)).plan;
		expect(plan.overrides.reviewer).toEqual({ model: "b/m", thinking: "low" });
		expect(plan.dropped).toEqual([{ name: "reviewer", keys: ["skills"] }]);
	});

	it("纯命令（无 --from）：项目已有该 agent 条目 ⇒ 基底取项目条目", () => {
		const profileFile = getProfilePath("work", agentDir);
		fs.mkdirSync(path.dirname(profileFile), { recursive: true });
		fs.writeFileSync(profileFile, JSON.stringify({ subagents: { agentOverrides: { reviewer: { model: "b/m", thinking: "max" } } } }));
		writeProjectSettings({ subagents: { agentOverrides: { reviewer: { model: "p/m", skills: ["s"] } } } });

		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "reviewer")!;
		expect(row.merged).toEqual({ model: "p/m", skills: ["s"] });
		// 未触碰时不写盘，项目条目原样保留
		const plan = buildPlan(s, sessionViews(s)).plan;
		expect(plan.overrides.reviewer).toEqual({ model: "p/m", skills: ["s"] });
		expect(plan.dropped).toEqual([]);
	});

	it("--from：项目无该 agent 条目 ⇒ 基底取模板条目", () => {
		const profileFile = getProfilePath("work", agentDir);
		fs.mkdirSync(path.dirname(profileFile), { recursive: true });
		fs.writeFileSync(profileFile, JSON.stringify({ subagents: { agentOverrides: { scout: { model: "b/m", thinking: "max" } } } }));
		writeProjectSettings({ subagents: { agentOverrides: { reviewer: { model: "p/m" } } } });

		const s = sessionOf(l1(), "work");
		const row = s.rows.find((r) => r.name === "scout")!;
		expect(row.merged).toEqual({ model: "b/m", thinking: "max" });
		// 新行：模板全量生效（需 dirty：§7.1 不创建未触碰且项目里不存在的行）
		row.draft.touched.add("model");
		row.draft.model = "b/m";
		const plan = buildPlan(s, sessionViews(s)).plan;
		expect(plan.overrides.scout).toEqual({ model: "b/m", thinking: "max" });
		expect(plan.dropped).toEqual([]);
	});

	it("--from 不存在 ⇒ error（入口会列出可用名字）", () => {
		const s = sessionOf(l1(), "nope");
		expect(s.errors.some((e) => e.includes("Profile not found"))).toBe(true);
		expect(s.fromProfileRejected).toBe(true);
		expect(s.fromProfileActive).toBe(false);
	});

	it("--from 非法 ⇒ 红条 + 拒绝合并（不带着项目基底进矩阵，§11 用例 12）", () => {
		const profileFile = getProfilePath("bad", agentDir);
		fs.mkdirSync(path.dirname(profileFile), { recursive: true });
		fs.writeFileSync(profileFile, JSON.stringify({ subagents: { agentOverrides: { reviewer: { thinking: "turbo" } } } }));
		writeProjectSettings({ subagents: { agentOverrides: { reviewer: { model: "p/m", skills: ["s"] } } } });

		const s = sessionOf(l1(), "bad");
		expect(s.errors.length).toBeGreaterThan(0);
		// 拒绝合并：会话被标为 rejected，模板**不进入**槽位；
		// index 侧见到 `fromProfileRejected` 就终止，不会把这些行带进矩阵。
		expect(s.fromProfileRejected).toBe(true);
		expect(s.fromProfileActive).toBe(false);
		expect(s.baseSources.fromProfile).toBeUndefined();
		expect(s.rows.find((r) => r.name === "reviewer")?.fromEntry).toBeUndefined();
	});

	it("--from 非法 ⇒ 入口直接终止（红条 + Aborted），不进入矩阵也不写盘", async () => {
		const profileFile = getProfilePath("bad", agentDir);
		fs.mkdirSync(path.dirname(profileFile), { recursive: true });
		fs.writeFileSync(profileFile, JSON.stringify({ subagents: { agentOverrides: { reviewer: { thinking: "turbo" } } } }));
		writeProjectSettings({ subagents: { agentOverrides: { reviewer: { model: "p/m", skills: ["s"] } } } });

		const messages: string[] = [];
		let customOpened = false;
		const commands: { handler: (args: string, ctx: unknown) => Promise<void> }[] = [];
		register({
			registerCommand: (_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands.push(options as { handler: (args: string, ctx: unknown) => Promise<void> });
			},
			sendMessage: (m: { content: string }) => {
				messages.push(m.content);
				return Promise.resolve();
			},
		} as never);
		await commands[0]!.handler("--from bad", {
			cwd: projectRoot,
			hasUI: true,
			ui: {
				notify: (message: string) => messages.push(message),
				custom: () => {
					customOpened = true;
				},
			},
			modelRegistry: { getAvailable: () => [] },
			scopedModels: [],
		});
		expect(messages.join("\n")).toContain("Aborted");
		expect(messages.join("\n")).toContain("must be one of");
		expect(customOpened).toBe(false);
		// 项目文件未被改写
		expect(readProjectSettings().subagents).toEqual({ agentOverrides: { reviewer: { model: "p/m", skills: ["s"] } } });
		expect(COMMAND_NAME).toBe("subagent-presets");
	});

	it("--from 存在但 profile 缺该 agent ⇒ 回落项目条目（base0 = projectEntry ?? template）", () => {
		const profileFile = getProfilePath("other", agentDir);
		fs.mkdirSync(path.dirname(profileFile), { recursive: true });
		fs.writeFileSync(profileFile, JSON.stringify({ subagents: { agentOverrides: { oracle: { model: "b/m9" } } } }));
		writeProjectSettings({ subagents: { agentOverrides: { reviewer: { model: "p/m", skills: ["s"] } } } });

		const s = sessionOf(l1(), "other");
		const row = s.rows.find((r) => r.name === "reviewer")!;
		expect(row.merged).toEqual({ model: "p/m", skills: ["s"] });
		expect(row.projectEntry).toEqual({ model: "p/m", skills: ["s"] });
	});

	it("保存后摘要的 ceiling 提示只报真超限的行（回归：曾按“thinking 有变更”误报）", () => {
		writeUserSettings({ subagents: { agentOverrides: { reviewer: { model: "u/m", thinking: "low" } } } });
		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "reviewer")!;
		row.draft.touched.add("thinking");
		row.draft.thinking = "high";
		const { plan } = buildPlan(s, sessionViews(s));
		// 改了 thinking，但没超 ceiling ⇒ 不应出现该提示
		const withoutCeiling = commitSave(
			s,
			{ writeProject: true, writeProfile: false, profileName: "default" },
			plan,
			[],
			agentDir,
			fakeModule(),
			[],
		);
		expect(withoutCeiling.ok).toBe(true);
		expect(withoutCeiling.message).not.toContain("above maxThinking");

		const withCeiling = commitSave(
			s,
			{ writeProject: false, writeProfile: true, profileName: "default" },
			plan,
			[],
			agentDir,
			fakeModule(),
			["reviewer"],
		);
		expect(withCeiling.message).toContain("⚠ thinking above maxThinking for: reviewer");
	});

	it("L0 降级：不判灰/别名/禁用，但两条保护仍生效且有黄条", () => {
		writeUserSettings({ subagents: { disableThinking: true, agentOverridesByProvider: { x: { worker: {} } } } });
		const s = sessionOf({});
		expect(s.notices.some((n) => n.includes("not detected"))).toBe(true);
		expect(s.bulkFlags).toEqual([{ key: "disableThinking", scope: "user" }]);
		const worker = s.rows.find((r) => r.name === "worker")!;
		expect(worker.classification.state).toBe("unmerged");
		const advisor = s.rows.find((r) => r.name === "advisor")!;
		expect(advisor.classification.isAlias).toBe(false);
		expect(advisor.classification.state).toBe("inherit");
	});

	it("上游抛错 ⇒ 红条 + L0（不崩）", () => {
		const s = sessionOf({ error: "invalid 'outputMode'", module: undefined });
		expect(s.errors.some((e) => e.includes("outputMode"))).toBe(true);
	});

	it("项目根解析不再委托上游：`.pi` 优先、`.agents` 不算项目标记", () => {
		// 上游抛错也**不影响**我们 anymore —— 解析完全自实现（`.pi` → git → cwd），
		// 所以即便上游的 `findConfiguredProjectRoot` 不可用/会抛，写盘目标也稳定。
		const s = buildSession(
			{ cwd: projectRoot, agentDir, trusted: true },
			{
				module: fakeModule({
					findConfiguredProjectRoot: () => {
						throw new Error("invalid 'projectRootResolution'");
					},
				}),
				fourBucketAgents: BUILTIN_AGENTS,
			},
			{ agents: ["worker"] },
		);
		expect(s.projectRoot.root).toBe(projectRoot);
		expect(["pi", "git", "cwd"]).toContain(s.projectRoot.tier);
	});

	it("settings.json 语法错误 ⇒ 报错并给出路径，不写入", () => {
		fs.mkdirSync(path.dirname(getProjectSettingsPath(projectRoot)), { recursive: true });
		fs.writeFileSync(getProjectSettingsPath(projectRoot), "{ broken", "utf-8");
		const s = sessionOf(l1());
		expect(s.errors.some((e) => e.includes("Failed to parse"))).toBe(true);
		const { plan } = buildPlan(s, sessionViews(s));
		const outcome = commitSave(s, { writeProject: true, writeProfile: false, profileName: "default" }, plan, [], agentDir, fakeModule());
		expect(outcome.ok).toBe(false);
		expect(outcome.message).toContain("Failed to parse");
		expect(fs.readFileSync(getProjectSettingsPath(projectRoot), "utf8")).toBe("{ broken");
	});

	it("项目未 trust ⇒ 顶部黄条 + 写入二次确认（配置依然会生效）", () => {
		const s = buildSession({ cwd: projectRoot, agentDir, trusted: false }, l1(), { agents: ["worker"] });
		const row = s.rows[0]!;
		row.draft.touched.add("model");
		row.draft.model = "p/m1";
		const warnings = collectWarnings(s, sessionViews(s));
		expect(warnings).toEqual([]);
		// 提示由 resolution 自带的 warning 独家提供（index.ts 不再重复一条）
		// （`git` / `cwd` 档的文案在 context.ts 的 resolveProjectRoot 里断言）
	});

	it("bulk 开关与项目侧 provider 层都产生提示（不阻止）", () => {
		writeProjectSettings({
			subagents: {
				disableBuiltins: true,
				agentOverridesByProvider: { cur: { scout: { thinking: "low" } } },
			},
		});
		const s = sessionOf(l1());
		expect(s.bulkFlags).toEqual([{ key: "disableBuiltins", scope: "project" }]);
		const warnings = collectWarnings(s, sessionViews(s));
		expect(warnings.some((w) => w.message.includes("provider-scoped values"))).toBe(true);
		expect(warnings.some((w) => w.message.includes("disableBuiltins"))).toBe(true);
	});

	it("连续两次保存幂等", () => {
		writeUserSettings({ subagents: { agentOverrides: { reviewer: { thinking: "medium" } } } });
		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "reviewer")!;
		row.draft.touched.add("thinking");
		row.draft.thinking = "max";

		const first = buildPlan(s, sessionViews(s)).plan;
		commitSave(s, { writeProject: true, writeProfile: false, profileName: "default" }, first, [], agentDir, fakeModule());
		resetAfterSave(s);
		// 草稿转为未 dirty（保存后矩阵行为）
		row.draft.touched.clear();
		const second = buildPlan(s, sessionViews(s)).plan;
		expect(second.changed).toEqual([]);
		commitSave(s, { writeProject: true, writeProfile: false, profileName: "default" }, second, [], agentDir, fakeModule());
		expect((readProjectSettings() as { subagents: { agentOverrides: Record<string, Override> } }).subagents.agentOverrides).toEqual({
			reviewer: { thinking: "max" },
		});
	});

	it("保存后重读项目层，projectEntry 与磁盘一致", () => {
		writeProjectSettings({ subagents: { agentOverrides: { scout: { model: "p/m" } } } });
		const s = sessionOf(l1());
		expect(s.rows.find((r) => r.name === "scout")?.projectEntry).toEqual({ model: "p/m" });
		const row = s.rows.find((r) => r.name === "scout")!;
		row.projectEntry = undefined;
		resetAfterSave(s);
		expect(row.projectEntry).toEqual({ model: "p/m" });
	});

	it("profile 导出：model:false 剔除并提示", () => {
		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "worker")!;
		row.draft.touched.add("model");
		row.draft.model = false;
		row.draft.touched.add("thinking");
		row.draft.thinking = "high";
		const { plan } = buildPlan(s, sessionViews(s));
		const outcome = commitSave(s, { writeProject: true, writeProfile: true, profileName: "work" }, plan, [], agentDir, fakeModule());
		expect(outcome.ok).toBe(true);
		expect(outcome.message).toContain("profile side stripped model:false");
		const profile = JSON.parse(fs.readFileSync(getProfilePath("work", agentDir), "utf8")) as {
			subagents: { agentOverrides: Record<string, Override> };
		};
		expect(profile.subagents.agentOverrides.worker).toEqual({ thinking: "high" });
		// 项目侧保留 model:false
		const settings = readProjectSettings() as { subagents: { agentOverrides: Record<string, Override> } };
		expect(settings.subagents.agentOverrides.worker).toEqual({ model: false, thinking: "high" });
	});

	it("reset 行 ⇒ 项目条目被移除（核心逻辑：项目条零贡献必须删）", () => {
		writeProjectSettings({ theme: "dark", subagents: { agentOverrides: { scout: { model: "p/m" } } } });
		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "scout")!;
		row.draft.reset = true;
		const { plan } = buildPlan(s, sessionViews(s));
		expect(plan.overrides).toEqual({});
		expect(plan.deleteAgentOverrides).toBe(true);
		expect(plan.removals.map((r) => r.reason)).toEqual(["reset"]);
		commitSave(s, { writeProject: true, writeProfile: false, profileName: "default" }, plan, [], agentDir, fakeModule());
		// scout 的项目条连同 subagents 一起消失（theme 语义保留）
		expect(readProjectSettings()).toEqual({ theme: "dark" });
	});

	it("回归：reset 后再改值 ⇒ 行重新参与写盘（旧代码静默丢弃）", () => {
		writeProjectSettings({ subagents: { agentOverrides: { scout: { model: "p/m", thinking: "low" } } } });
		writeUserSettings({ subagents: { agentOverrides: { scout: { model: "u/m", thinking: "high" } } } });
		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "scout")!;
		row.draft.reset = true;
		row.draft.touched.add("model");
		row.draft.model = "p/m2";
		const { plan } = buildPlan(s, sessionViews(s));
		// 基底仍是冻结的全局层（thinking 跟全局走），你改的 model 被写出去
		expect(plan.overrides.scout).toEqual({ model: "p/m2", thinking: "high" });
		commitSave(s, { writeProject: true, writeProfile: false, profileName: "default" }, plan, [], agentDir, fakeModule());
		const settings = readProjectSettings() as { subagents: { agentOverrides: Record<string, Override> } };
		expect(settings.subagents.agentOverrides.scout).toEqual({ model: "p/m2", thinking: "high" });
	});

	it("buildRebuildInputs 逐行对应 session.rows，并把 origin / globalEntry 带过去", () => {
		writeUserSettings({ subagents: { agentOverrides: { scout: { model: "u/m" } } } });
		const s = sessionOf(l1());
		const inputs = buildRebuildInputs(s, sessionViews(s));
		expect(inputs).toHaveLength(s.rows.length);
		expect(inputs.map((i) => i.name)).toEqual(s.rows.map((r) => r.name));
		const scout = inputs.find((i) => i.name === "scout")!;
		expect(scout.origin).toEqual(s.rows.find((r) => r.name === "scout")!.origin);
		expect(scout.globalEntry).toEqual({ model: "u/m" });
	});

	it("refreshViews 按草稿重算脏行", () => {
		writeUserSettings({ subagents: { agentOverrides: { reviewer: { model: "u/m2", thinking: "medium" } } } });
		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "reviewer")!;
		const model = { id: "m2", provider: "u", reasoning: true };
		const sources = { models: [model], registry: { getAvailable: () => [], find: (p: string, i: string) => (p === "u" && i === "m2" ? model : undefined) }, scopedModels: [] };
		const before = refreshViews(sessionViews(s), s, { module: fakeModule(), baselineAgents: BUILTIN_AGENTS }, sources);
		const reviewerBefore = before.find((v) => v.name === "reviewer")!;
		expect(reviewerBefore.thinkingText).toBe("medium");
		expect(reviewerBefore.modelText).toBe("u/m2");

		row.draft.touched.add("thinking");
		row.draft.thinking = "max";
		const after = refreshViews(before, s, { module: fakeModule(), baselineAgents: BUILTIN_AGENTS }, sources);
		const reviewerAfter = after.find((v) => v.name === "reviewer")!;
		// 5 档模型（无 thinkingLevelMap）⇒ max 被 clamp 到 high
		expect(reviewerAfter.thinkingText).toBe("high");
	});

	it("无 UI 摘要：打印各 agent 的解析摘要后正常返回", () => {
		writeUserSettings({ subagents: { agentOverrides: { reviewer: { model: "u/m2", thinking: "high" } } } });
		const s = sessionOf(l1());
		const ctx = { cwd: projectRoot, model: { provider: "p", id: "m" } } as never;
		const lines = summaryLines(ctx, s, sessionViews(s));
		expect(lines.join("\n")).toContain("Subagent presets");
		expect(lines.join("\n")).toContain("reviewer");
		expect(lines.join("\n")).toContain("No changes were written");
	});
});

describe("参数解析", () => {
	it("回归：`--from` 补全项的 value 必须**带 `--from` 前缀**", () => {
		// pi 用补全项的 `value` **整体替换参数前缀**。只回 profile 名会把命令行
		// 变成 `/subagent-presets default` ⇒ `--from` 丢失 ⇒ 静默退化成纯命令。
		const items = buildCompletions("--from ", ["default", "test"]) ?? [];
		expect(items.map((i) => i.value)).toEqual(["--from default", "--from test"]);
		// `--from=` 形式要保持等号风格
		expect((buildCompletions("--from=t", ["test", "tmp"]) ?? []).map((i) => i.value)).toEqual(["--from=test", "--from=tmp"]);
		// 前缀不匹配 ⇒ null（不接管补全）
		expect(buildCompletions("--other", ["default"])).toBeNull();
	});

	it("无参数", () => {
		expect(parseArgs("")).toEqual({ errors: [] });
		expect(parseArgs("   ")).toEqual({ errors: [] });
	});

	it("--from <name> 与 --from=<name> 两种写法", () => {
		expect(parseArgs("--from work").from).toBe("work");
		expect(parseArgs("--from=work").from).toBe("work");
	});

	it("剥掉尾部 .json", () => {
		expect(parseArgs("--from work.json").from).toBe("work");
	});

	it("--from 缺值 / 未知参数 / 非法名字都报错", () => {
		expect(parseArgs("--from").errors.length).toBe(1);
		expect(parseArgs("--from --other").errors.length).toBeGreaterThan(0);
		expect(parseArgs("--bogus").errors.join()).toContain("Unexpected argument");
		expect(parseArgs("--from ../escape").errors.join()).toContain("Invalid profile name");
	});
});

describe("JSON 编辑器（`e` = 整条将写入的条目）", () => {
	it("注释头里**不含实现过程的说明**（列宽/排版这类是我们的内部实现，对读文件的人没用）", () => {
		const header = jsonEditorHeader("reviewer");
		// 曾经的 “字段一览（4 列左对齐）”、“枚举（每个值域独立一行）”
		expect(header).not.toContain("左对齐");
		expect(header).not.toContain("独立一行");
		expect(header).toContain("// 字段一览：");
		expect(header).toContain("// 枚举：");
	});

	it("枚举值域**每个独立一行**（`枚举：` 标题行 + 每行一个 tag=value|value）", () => {
		const lines = jsonEditorHeader("reviewer").split("\n");
		const header = lines.findIndex((l) => l.trim() === "// 枚举：");
		expect(header).toBeGreaterThan(0);
		const enums: string[] = [];
		for (const line of lines.slice(header + 1)) {
			if (!line.startsWith("//")) break; // 越过注释块
			enums.push(line);
		}
		// 每个非空枚举行只含**一个** tag（没有 ` · ` 分隔的第二个枚举）
		const nonEmpty = enums.filter((l) => l.replace(/^\/\/\s*/, "").trim().length > 0);
		for (const line of nonEmpty) expect(line).not.toContain(" · ");
		for (const tag of ["thinking=", "outputMode=", "systemPromptMode=", "defaultContext=", "acceptanceRole=", "model="]) {
			expect(nonEmpty.some((l) => l.includes(tag)), tag).toBe(true);
		}
	});

	it("回归：字段一览 4 列按**显示宽度**对齐（CJK 占 2 列，`padEnd` 会歪）", () => {
		// 标签是中文：`String.padEnd` 按 UTF-16 码元补齐，而 CJK 在终端占 2 列
		// ⇒ 每行 CJK 数量不同 ⇒ 后面几列的起点逐行漂移（实测只有第一列看着对齐）。
		const rows = jsonEditorHeader("reviewer")
			.split("\n")
			.filter((line) => /^\/\/\s{3}\S/.test(line) && !line.includes("枚举") && !line.includes("上游回落") && !line.includes("删键"));
		expect(rows.length).toBeGreaterThanOrEqual(6);
		// 逐行算第 2/3/4 列的**显示列起点**，必须完全一致。
		// ⚠️ 必须用带捕获组的 split 保留「补齐用的空白」——`filter(Boolean)` 会把它剥掉，
		//   量到的就成了未补齐的原始宽度（那样每行必然不同，测不出对齐）。
		const offsets = rows
			.map((row) => {
				// 交替：文本 / 空白 / 文本 / 空白 …
				const parts = row.slice(5).split(/(\s{2,})/);
				const cellCount = parts.filter((_, i) => i % 2 === 0).length;
				if (cellCount < 4) return null; // 末行可能不满 4 格
				const starts: number[] = [];
				let pos = 5;
				for (let i = 0; i < parts.length && starts.length < 4; i += 2) {
					starts.push(pos);
					pos += visibleWidth(parts[i] as string);
					if (i + 1 < parts.length) pos += visibleWidth(parts[i + 1] as string);
				}
				return starts;
			})
			.filter((o): o is number[] => o !== null);
		expect(offsets.length).toBeGreaterThanOrEqual(5);
		for (const col of [1, 2, 3]) {
			const set = new Set(offsets.map((o) => o[col] as number));
			expect(set.size, `第 ${col + 1} 列起点不一致: ${[...set].join(",")}`).toBe(1);
		}
	});

	it("注释头精简（≤ 22 行）、含 agent 名与全部 26 个字段名，且全是注释", () => {
		const header = jsonEditorHeader("reviewer");
		// 精简：v1 是一行一个字段 + 15 行说明 = 41 行注释对 3 行 JSON；v7 枚举拆行后 21 行
		const commentLines = header.split("\n").filter((line) => line.startsWith("//"));
		expect(commentLines.length).toBeLessThanOrEqual(22);
		expect(header).toContain('agent "reviewer"');
		for (const field of KNOWN_FIELDS) expect(header, field).toContain(field);
		// 关键枚举仍在（猜错就会写坏的那种）
		expect(header).toContain("off|minimal|low|medium|high|xhigh|max|false");
		expect(header).toContain("outputMode=inline|file-only");
		expect(header).toContain("acceptanceRole=read-only|writer|false");
		expect(header).toContain('systemPrompt 可为 ""');
		// 语义提示保留
		expect(header).toContain("删键 = 这一行不写该字段");
		expect(header).toContain("未知键会被静默丢弃");
		expect(header.split("\n").every((line) => line === "" || line.startsWith("//"))).toBe(true);
	});

	it("值域表以包 README 为准，字段清单与校验器同源", () => {
		expect(FIELD_GUIDE.map((e) => e.field)).toEqual([...KNOWN_FIELDS]);
		// 字段名不靠自由发挥：与 validate.ts 的清单一致
		expect(jsonEditorHeader()).toContain(KNOWN_FIELDS[0]);
		expect(jsonEditorHeader()).toContain(KNOWN_FIELDS[KNOWN_FIELDS.length - 1]);
	});

	it("输入文本 = 注释头 + 整条条目的 JSON（含 model / thinking 与全部字段）", () => {
		const entry: Override = { model: "p/m", thinking: "high", tools: ["read"], futureField: 1 };
		const content = editorContent(entry, "reviewer");
		expect(content.startsWith("//")).toBe(true);
		expect(content).toContain('agent "reviewer"');
		expect(parseEditedContent(content)).toEqual({ ok: true, value: entry });
	});

	it("空文件 / 纯注释 ⇒ 取消（不当成空条目）", () => {
		expect(parseEditedContent("")).toMatchObject({ ok: false });
		expect(parseEditedContent("// only comments\n")).toMatchObject({ ok: false });
	});

	it("非法 JSON ⇒ 报错字符串，可重编", () => {
		expect(parseEditedContent("{ nope").ok).toBe(false);
	});

	it("未知 key ⇒ 只警告（可写回），文案写明上游会静默丢弃", () => {
		const review = reviewEditedJson("reviewer", { thinkingg: "high", model: "p/m" });
		expect(review.accepted).toBe(true);
		expect(review.errors).toEqual([]);
		expect(review.warnings).toContain("未知键会被静默丢弃：reviewer.thinkingg");
	});

	it("非法值 ⇒ **只警告不阻止**，文案照规格写，且值原样保存", () => {
		const cases: [string, Override][] = [
			["outputMode", { outputMode: "x" }],
			["model", { model: null }],
			["thinking", { thinking: 123 }],
			["fallbackModels", { fallbackModels: ["a"] }],
			["thinking", { thinking: "turbo" }],
			["description", { description: "" }],
			["output", { output: "" }],
			["defaultProvider", { defaultProvider: "" }],
			["thinking", { thinking: "" }],
		];
		for (const [field, value] of cases) {
			const review = reviewEditedJson("reviewer", value);
			expect(review.accepted, field).toBe(true);
			expect(review.value, field).toEqual(value);
			expect(review.warnings.join("\n"), field).toContain("上游会对以下内容报错（已照原样保存）：reviewer.");
		}
		expect(reviewEditedJson("reviewer", { outputMode: "x" }).warnings).toContain(
			'上游会对以下内容报错（已照原样保存）：reviewer.outputMode="x"',
		);
	});

	it('systemPrompt:"" 放行（无任何警告）', () => {
		const review = reviewEditedJson("reviewer", { systemPrompt: "" });
		expect(review.accepted).toBe(true);
		expect(review.warnings).toEqual([]);
	});

	it("顶层不是对象 ⇒ 唯一会被拒的形状（存不进 agentOverrides）", () => {
		expect(reviewEditedJson("reviewer", []).accepted).toBe(false);
		expect(reviewEditedJson("reviewer", "x").accepted).toBe(false);
		expect(reviewEditedJson("reviewer", null).accepted).toBe(false);
	});

	it("entryForEditor = 合并基底 + 草稿（含 model/thinking）", () => {
		writeUserSettings({ subagents: { agentOverrides: { reviewer: { model: "u/m", tools: ["read"] } } } });
		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "reviewer")!;
		row.draft.touched.add("thinking");
		row.draft.thinking = "max";
		const view = sessionViews(s).find((v) => v.name === "reviewer")!;
		expect(entryForEditor(view)).toEqual({ model: "u/m", tools: ["read"], thinking: "max" });
	});

	it("`e` 往返：改 model/thinking 同步进草稿并写盘；删掉的键不写入；非法值只警告仍写入", () => {
		writeProjectSettings({ subagents: { agentOverrides: { reviewer: { model: "p/m", thinking: "low", tools: ["read"] } } } });
		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "reviewer")!;
		const view = sessionViews(s).find((v) => v.name === "reviewer")!;

		// 打开 `e`：内容就是整条将写入的条目
		const opened = parseEditedContent(editorContent(entryForEditor(view)));
		expect(opened).toEqual({ ok: true, value: { model: "p/m", thinking: "low", tools: ["read"] } });

		// 用户改了 model / thinking、删了 tools、加了一个非法值
		const review = reviewEditedJson("reviewer", { model: "p/m2", thinking: "max", outputMode: "x" });
		expect(review.accepted).toBe(true);
		expect(review.warnings.length).toBeGreaterThan(0);
		applyEditedEntry(row.draft, review.value);

		expect(row.draft.model).toBe("p/m2");
		expect(row.draft.thinking).toBe("max");
		expect(row.draft.touched).toEqual(new Set(["model", "thinking"]));
		expect("tools" in row.draft.extra).toBe(false);

		const { plan } = buildPlan(s, sessionViews(s));
		expect(plan.overrides.reviewer).toEqual({ model: "p/m2", thinking: "max", outputMode: "x" });
		expect("tools" in plan.overrides.reviewer!).toBe(false);
	});

	it("`e` 的校验警告会汇总到保存屏的提示里", () => {
		writeUserSettings({ subagents: { agentOverrides: { reviewer: { model: "u/m" } } } });
		const s = sessionOf(l1());
		const row = s.rows.find((r) => r.name === "reviewer")!;
		const views = sessionViews(s);
		const view = views.find((v) => v.name === "reviewer")!;
		const review = reviewEditedJson("reviewer", { ...entryForEditor(view), outputMode: "x" });
		applyEditedEntry(row.draft, review.value);
		view.editWarnings = review.warnings;

		const warnings = collectWarnings(s, views);
		expect(warnings.some((w) => w.agent === "reviewer" && w.message.includes("已照原样保存"))).toBe(true);
	});
});

describe("基线口径（纯函数，便于复核）", () => {
	it("resetAfterSave 重算合并基底：保存后基底跟磁盘走（连续保存幂等的前提）", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-presets-reset-"));
		const dir = path.join(tmpDir, "agent");
		const root = path.join(tmpDir, "proj");
		fs.mkdirSync(dir, { recursive: true });
		fs.mkdirSync(path.dirname(getProjectSettingsPath(root)), { recursive: true });
		fs.writeFileSync(
			getProjectSettingsPath(root),
			JSON.stringify({ subagents: { agentOverrides: { reviewer: { thinking: "max" } } } }),
		);
		fs.writeFileSync(
			getUserSettingsPath(dir),
			JSON.stringify({ subagents: { agentOverrides: { reviewer: { thinking: "low" } } } }),
		);
		const s = buildSession(
			{ cwd: root, agentDir: dir, trusted: true },
			{ fourBucketAgents: [{ name: "reviewer" }], baselineAgents: [{ name: "reviewer" }] },
			{ agents: ["reviewer"] },
		);
		const row = s.rows[0]!;
		expect(row.merged).toEqual({ thinking: "max" });

		resetAfterSave(s);
		expect(row.projectEntry).toEqual({ thinking: "max" });
		// 草稿回到未触碰态，extra 与新基底一致
		expect(row.draft.touched.size).toBe(0);
		expect(row.draft.extra).toEqual({});
		expect(isDirty(row.draft, initialExtra(row.merged))).toBe(false);

		// 基底被手工改回旧值时，reset 会把它纠正过来
		row.merged = { thinking: "low" };
		resetAfterSave(s);
		expect(row.merged).toEqual({ thinking: "max" });
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("createDefaultLoader 依次试 .js / .ts，两种都不可用时返回 null（不抛）", async () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-presets-loader-"));
		await expect(createDefaultLoader()(empty)).resolves.toBeNull();
		fs.rmSync(empty, { recursive: true, force: true });
	});

	it("createDefaultLoader 载入可用的 .js 入口", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-presets-loader2-"));
		fs.mkdirSync(path.join(root, "src", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "src", "agents", "agents.js"),
			"export const discoverAgentsAll = () => ({ builtin: [], package: [], user: [], project: [] });\n",
		);
		const mod = (await createDefaultLoader()(root)) as { discoverAgentsAll?: unknown };
		expect(typeof mod.discoverAgentsAll).toBe("function");
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("createDefaultLoader 在 .js 加载失败时继续试 .ts", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-presets-loader3-"));
		fs.mkdirSync(path.join(root, "src", "agents"), { recursive: true });
		// 语法错误的 .js ⇒ import 抛错 ⇒ 必须降级而不是把错误抛给调用方
		fs.writeFileSync(path.join(root, "src", "agents", "agents.js"), "this is not valid javascript ((( \n");
		await expect(createDefaultLoader()(root)).resolves.toBeNull();
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("合并基底参与基底选择的回归（§3.1 步骤）", () => {
	it("base0 = 项目条目 ?? default profile（无 --from）", () => {
		const userEntry: Override = { thinking: "low" };
		const fromProject = synthesize({ projectEntry: { model: "p/m" }, defaultProfile: { model: "d/m" }, userEntry });
		expect(fromProject).toEqual({ model: "p/m", thinking: "low" });
		const fromDefault = synthesize({ defaultProfile: { model: "d/m" }, userEntry });
		expect(fromDefault).toEqual({ model: "d/m", thinking: "low" });
	});
});
