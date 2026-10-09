import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfigDirName, getProjectSettingsPath, resolveProjectRoot } from "../src/context.ts";
import { createDraft, synthesize, type FieldOrigin, type Override } from "../src/merge.ts";
import type { RowClassification } from "../src/rowstate.ts";
import {
	buildProfileDocument,
	planRebuild,
	SettingsWriteError,
	writeJsonAtomic,
	writeProfile,
	writeProjectAgentOverrides,
	type RebuildRowInput,
} from "../src/writer.ts";

function classification(overrides: Partial<RowClassification> = {}): RowClassification {
	return {
		state: "inherit",
		isAlias: false,
		disabledByOverride: false,
		disabledUpstream: false,
		providerHits: [],
		bulkFlags: [],
		projectProviderHits: [],
		...overrides,
	};
}

/**
 * 逐字段来源（`state` 判定的输入）。
 * 测试里基底 ① 就是项目条，其余算全局层——够覆盖本文件的判定，不需要真跑 profile。
 */
function originFor(merged: Override, projectEntry: Override | undefined, globalEntry: Override | undefined): FieldOrigin {
	const base: string[] = [];
	const global: string[] = [];
	for (const key of Object.keys(merged)) {
		if (projectEntry !== undefined && key in projectEntry) base.push(key);
		else if (globalEntry !== undefined && key in globalEntry) global.push(key);
		else base.push(key);
	}
	return { base, global };
}

function row(
	name: string,
	opts: {
		projectEntry?: Override | undefined;
		merged: Override;
		/** ② 全局层同名条目（决定 `r` 后冻结的基底）。 */
		globalEntry?: Override | undefined;
		/** 逐字段来源覆盖（默认由 `originFor` 推导）。 */
		origin?: FieldOrigin;
		touch?: { key: "model" | "thinking"; value: string | false | undefined };
		/** 第二个矩阵键的改动（用于「两个键都显式清空」的场景）。 */
		touch2?: { key: "model" | "thinking"; value: string | false | undefined };
		extra?: Override;
		/** 按过 `r`（reset）。 */
		reset?: boolean;
		state?: RowClassification["state"];
		isAlias?: boolean;
		aliasOf?: string;
		disabledUpstream?: boolean;
		fromEntry?: Override;
	} = { merged: {} },
): RebuildRowInput {
	const draft = createDraft(name, opts.merged);
	if (opts.touch) {
		draft.touched.add(opts.touch.key);
		if (opts.touch.key === "model") draft.model = opts.touch.value;
		else draft.thinking = opts.touch.value;
	}
	if (opts.touch2) {
		draft.touched.add(opts.touch2.key);
		if (opts.touch2.key === "model") draft.model = opts.touch2.value;
		else draft.thinking = opts.touch2.value;
	}
	if (opts.extra) draft.extra = { ...draft.extra, ...opts.extra };
	if (opts.reset) draft.reset = true;
	return {
		name,
		projectEntry: opts.projectEntry,
		merged: opts.merged,
		origin: opts.origin ?? originFor(opts.merged, opts.projectEntry, opts.globalEntry),
		...(opts.globalEntry ? { globalEntry: opts.globalEntry } : {}),
		draft,
		classification: classification({
			...(opts.state ? { state: opts.state } : {}),
			...(opts.isAlias !== undefined ? { isAlias: opts.isAlias } : {}),
			...(opts.aliasOf ? { aliasOf: opts.aliasOf } : {}),
			...(opts.disabledUpstream ? { disabledUpstream: true } : {}),
			...(opts.state === "unmerged" ? { providerHits: ["other"] } : {}),
		}),
		...(opts.fromEntry ? { fromEntry: opts.fromEntry } : {}),
	};
}

let tmp: string;
let projectRoot: string;
let projectPath: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-presets-writer-"));
	projectRoot = path.join(tmp, "proj");
	fs.mkdirSync(projectRoot, { recursive: true });
	projectPath = getProjectSettingsPath(projectRoot);
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function writeProjectSettings(value: unknown): void {
	fs.mkdirSync(path.dirname(projectPath), { recursive: true });
	fs.writeFileSync(projectPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readProjectSettings(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(projectPath, "utf8")) as Record<string, unknown>;
}

describe("写盘口径：写就写**完整合并**（v7 定稿）", () => {
	// 上游对 **builtin** agent 是 **agent 级替换**（`applyBuiltinOverrides`：
	// 项目条目一旦存在就直接 return，全局条目根本不参与）。所以只要我们写了项目条目，
	// 就必须把**全局来源的字段也物化进去**，否则那些字段不是“合并”，而是被**丢弃**。
	const GLOBAL = { model: "g/GLOBAL-MODEL", thinking: "low", tools: ["read", "bash"] };

	it("项目条目只覆盖部分字段 ⇒ 写入时把全局来源的字段一并物化", () => {
		const plan = planRebuild({
			rows: [row("researcher", { projectEntry: { thinking: "low" }, merged: { ...GLOBAL, thinking: "low" }, globalEntry: GLOBAL, touch: { key: "thinking", value: "high" } })],
			projectOverrides: {},
			whitelist: ["researcher"],
		});
		// ⚠️ 关键：model / tools 来自全局，但**必须写进项目**，否则 builtin 解析时它们直接消失
		expect(plan.overrides.researcher).toEqual({ thinking: "high", model: "g/GLOBAL-MODEL", tools: ["read", "bash"] });
	});

	it("项目原本无条目，只改一个字段 ⇒ 同样物化全局层全部字段", () => {
		const plan = planRebuild({
			rows: [row("researcher", { merged: GLOBAL, globalEntry: GLOBAL, touch: { key: "thinking", value: "high" } })],
			projectOverrides: {},
			whitelist: ["researcher"],
		});
		expect(plan.overrides.researcher).toEqual({ thinking: "high", model: "g/GLOBAL-MODEL", tools: ["read", "bash"] });
	});

	it("`r` reset 后又改了字段 ⇒ 参与写盘，基底取冻结的全局层并整体物化", () => {
		const plan = planRebuild({
			rows: [row("researcher", { projectEntry: { model: "p/old" }, merged: { ...GLOBAL, model: "p/old" }, globalEntry: GLOBAL, touch: { key: "thinking", value: "high" }, reset: true })],
			projectOverrides: { researcher: { model: "p/old" } },
			whitelist: ["researcher"],
		});
		expect(plan.overrides.researcher).toEqual({ thinking: "high", model: "g/GLOBAL-MODEL", tools: ["read", "bash"] });
	});

	it("`r` reset 后**不改**任何字段 ⇒ 不写入，且删除已有条目", () => {
		const plan = planRebuild({
			rows: [row("researcher", { projectEntry: { model: "p/old" }, merged: { ...GLOBAL, model: "p/old" }, globalEntry: GLOBAL, reset: true })],
			projectOverrides: { researcher: { model: "p/old" } },
			whitelist: ["researcher"],
		});
		expect(plan.overrides.researcher).toBeUndefined();
		expect(plan.removals.map((r) => `${r.name}:${r.reason}`)).toEqual(["researcher:reset"]);
	});
});

describe("§7.1 重建循环：不可合并行保持现状（回归）", () => {
	it("项目已有 {model:'p/m3'} + user 侧任意 provider 层 ⇒ 保存后条目仍在，p/m3 不丢", () => {
		const plan = planRebuild({
			rows: [row("worker", { projectEntry: { model: "p/m3" }, merged: { model: "p/m3", thinking: "u/m2-thinking" }, state: "unmerged", touch: { key: "thinking", value: "max" } })],
			projectOverrides: { worker: { model: "p/m3" } },
			whitelist: ["worker"],
		});
		expect(plan.overrides.worker).toEqual({ model: "p/m3" });
		expect(plan.keptLocked).toEqual(["worker"]);
		// 朴素 `continue` 会让 rebuilt 里没有 worker ⇒ 条目被删、回落 u/m2
		expect(plan.changed).toEqual([]);
	});

	it("不可合并且项目原本无条目 ⇒ 不产生条目", () => {
		const plan = planRebuild({
			rows: [row("worker", { merged: { model: "u/m2" }, state: "unmerged", touch: { key: "model", value: "p/m1" } })],
			projectOverrides: {},
			whitelist: ["worker"],
		});
		expect(plan.overrides).toEqual({});
		expect(plan.keptLocked).toEqual([]);
	});

	it("不可合并行的空 {} 项目条目不写回（上游把 {} 视为无条目）", () => {
		const plan = planRebuild({
			rows: [row("worker", { projectEntry: {}, merged: { model: "u/m2" }, state: "unmerged", touch: { key: "model", value: "p/m1" } })],
			projectOverrides: { worker: {} },
			whitelist: ["worker"],
		});
		expect(plan.overrides).toEqual({});
	});
});

describe("§7.1 重建循环：四类移除", () => {
	it("上游已无此 agent（灰行）⇒ 连同旧条目消失", () => {
		const plan = planRebuild({
			rows: [row("stale-agent", { projectEntry: { model: "p/m" }, merged: { model: "u/m2" }, state: "unresolved" })],
			projectOverrides: { "stale-agent": { model: "p/m" } },
			whitelist: ["stale-agent"],
		});
		expect(plan.overrides).toEqual({});
		expect(plan.removals).toEqual([{ name: "stale-agent", reason: "unresolved", detail: "no such agent upstream" }]);
	});

	it("不在白名单 ⇒ 项目条目被移除", () => {
		const plan = planRebuild({
			rows: [],
			projectOverrides: { "legacy-check": { model: "p/m" } },
			whitelist: ["reviewer"],
		});
		expect(plan.removals).toEqual([{ name: "legacy-check", reason: "not-whitelisted", detail: "not whitelisted (add it back to keep it)" }]);
	});

	it("别名键 ⇒ 移除并说明已改用 canonical name", () => {
		const plan = planRebuild({
			rows: [row("advisor", { projectEntry: { model: "p/m" }, merged: {}, isAlias: true, aliasOf: "oracle", state: "inherit" })],
			projectOverrides: { advisor: { model: "p/m" } },
			whitelist: ["advisor", "oracle"],
		});
		expect(plan.overrides).toEqual({});
		expect(plan.removals[0]?.reason).toBe("alias");
		expect(plan.removals[0]?.detail).toContain("oracle");
	});

	it("④ 合成结果为空（显式清空两个矩阵键）⇒ 不产生条目，列入 emptyBase", () => {
		// 只清空 model，thinking 还在基底里 ⇒ 条目仍存在
		const oneCleared = planRebuild({
			rows: [
				row("reviewer", {
					projectEntry: { model: "p/m", thinking: "high" },
					merged: { model: "p/m", thinking: "high" },
					touch: { key: "model", value: undefined },
				}),
			],
			projectOverrides: { reviewer: { model: "p/m", thinking: "high" } },
			whitelist: ["reviewer"],
		});
		expect(oneCleared.overrides.reviewer).toEqual({ thinking: "high" });
		expect(oneCleared.emptyBase).toEqual([]);

		// 两个矩阵键都显式清空，且基底里没有其它字段 ⇒ 结果为空
		const cleared = planRebuild({
			rows: [
				row("reviewer", {
					projectEntry: { model: "p/m", thinking: "high" },
					merged: { model: "p/m", thinking: "high" },
					touch: { key: "model", value: undefined },
					touch2: { key: "thinking", value: undefined },
				}),
			],
			projectOverrides: { reviewer: { model: "p/m", thinking: "high" } },
			whitelist: ["reviewer"],
		});
		expect(cleared.overrides).toEqual({});
		expect(cleared.emptyBase).toEqual(["reviewer"]);
		expect(cleared.removals).toEqual([{ name: "reviewer", reason: "empty-base", detail: "merged base is empty, the entry will be removed" }]);
	});

	it("回归：合并基底为空但**项目里本来就没有条目** ⇒ 不列入 emptyBase / removals", () => {
		// 三层都没有该 agent（它一直在白名单里、但从没被配置过）：
		// 没有任何东西可删，列进「将移除」是纯噪音（冒烟时看到 evidence-auditor 被误列）。
		const never = planRebuild({
			rows: [row("evidence-auditor", { merged: {} })],
			projectOverrides: {},
			whitelist: ["evidence-auditor"],
		});
		expect(never.overrides).toEqual({});
		expect(never.emptyBase).toEqual([]);
		expect(never.removals).toEqual([]);
	});

	it("reset 掉的行 ⇒ 项目条目被移除（reason: reset）", () => {
		const plan = planRebuild({
			rows: [row("scout", { projectEntry: { model: "p/m" }, merged: { model: "p/m" }, reset: true })],
			projectOverrides: { scout: { model: "p/m" } },
			whitelist: ["scout"],
		});
		expect(plan.overrides).toEqual({});
		expect(plan.removals).toEqual([{ name: "scout", reason: "reset", detail: "reset: project entry removed, falls back to the global layer" }]);
		expect(plan.zeroContribution).toEqual(["scout"]);
	});

	it("🔑 项目条目存在 + state === GLOBAL ⇒ 该条目被删除（核心判定）", () => {
		// 项目条里的字段全部被显式清空 ⇒ 合并结果只剩全局层的字段 ⇒ 项目条零贡献
		const projectEntry: Override = { model: "p/m" };
		const globalEntry: Override = { model: "u/m", thinking: "high" };
		const plan = planRebuild({
			rows: [
				row("reviewer", {
					projectEntry,
					globalEntry,
					merged: { model: "p/m", thinking: "high" },
					touch: { key: "model", value: undefined },
				}),
			],
			projectOverrides: { reviewer: projectEntry },
			whitelist: ["reviewer"],
		});
		expect(plan.overrides).toEqual({});
		expect(plan.deleteAgentOverrides).toBe(true);
		expect(plan.removals.map((r) => r.name)).toEqual(["reviewer"]);
	});

	it("Finding 8：--from 下模板缺该条目 ⇒ 移除原因说明 blueprint 无条目（行为正确：删项目条，留全局层）", () => {
		// 模板没有该 agent 的条目，全局层有，项目层也有 ⇒ 基底落到全局层 ⇒ state GLOBAL。
		// 项目条目被删是**对的**（模板 + 全局的结果就是全局那份），但原因不是 "merged base is empty"。
		const plan = planRebuild({
			rows: [
				row("scout", {
					projectEntry: { model: "p/m" },
					globalEntry: { model: "u/m" },
					merged: { model: "u/m" },
					origin: { base: [], global: ["model"] },
					// 无 fromEntry：模板里没有该 agent
				}),
			],
			projectOverrides: { scout: { model: "p/m" } },
			whitelist: ["scout"],
			fromProfileActive: true,
		});
		expect(plan.overrides).toEqual({});
		expect(plan.removals).toEqual([
			{ name: "scout", reason: "empty-base", detail: "the blueprint has no entry for this agent; the project entry is removed so the global layer applies" },
		]);
	});

	it("Finding 8：其余场景维持原文案（无 --from / 模板有该条目）", () => {
		const opts = {
			projectEntry: { model: "p/m" },
			globalEntry: { model: "u/m" },
			merged: { model: "u/m" },
			origin: { base: [], global: ["model"] },
		};
		// 无 --from：原文案
		const plain = planRebuild({
			rows: [row("scout", opts)],
			projectOverrides: { scout: { model: "p/m" } },
			whitelist: ["scout"],
		});
		expect(plain.removals).toEqual([{ name: "scout", reason: "empty-base", detail: "merged base is empty, the entry will be removed" }]);
		// --from 且模板有该条目（空条目也是“有”）：原文案
		const withEntry = planRebuild({
			rows: [row("scout", { ...opts, fromEntry: {} })],
			projectOverrides: { scout: { model: "p/m" } },
			whitelist: ["scout"],
			fromProfileActive: true,
		});
		expect(withEntry.removals).toEqual([{ name: "scout", reason: "empty-base", detail: "merged base is empty, the entry will be removed" }]);
	});

	it("state === GLOBAL 且项目无条目 ⇒ 什么都不做（不产生移除记录）", () => {
		const plan = planRebuild({
			rows: [row("reviewer", { globalEntry: { model: "u/m" }, merged: { model: "u/m" } })],
			projectOverrides: {},
			whitelist: ["reviewer"],
		});
		expect(plan.overrides).toEqual({});
		expect(plan.removals).toEqual([]);
		expect(plan.zeroContribution).toEqual([]);
	});

	it("回归：reset 后再改值 ⇒ 行重新参与重建，改的值被写入（旧代码静默丢弃）", () => {
		const projectEntry: Override = { model: "p/m", thinking: "low" };
		const globalEntry: Override = { model: "u/m", thinking: "high" };
		const plan = planRebuild({
			rows: [
				row("reviewer", {
					projectEntry,
					globalEntry,
					merged: { model: "p/m", thinking: "low" },
					reset: true,
					touch: { key: "model", value: "p/m2" },
				}),
			],
			projectOverrides: { reviewer: projectEntry },
			whitelist: ["reviewer"],
		});
		// 基底仍是冻结的全局层（thinking 跟着全局），你改的 model 被写入
		expect(plan.overrides.reviewer).toEqual({ model: "p/m2", thinking: "high" });
		expect(plan.removals).toEqual([]);
	});
});

describe("两种禁用的写盘行为（§4.1）", () => {
	it("我们配的禁用（disabled:true）⇒ 行照常可写", () => {
		const projectEntry: Override = { disabled: true };
		const plan = planRebuild({
			rows: [
				row("researcher", {
					projectEntry,
					merged: { disabled: true },
					touch: { key: "model", value: "p/m" },
				}),
			],
			projectOverrides: { researcher: projectEntry },
			whitelist: ["researcher"],
		});
		expect(plan.overrides.researcher).toEqual({ disabled: true, model: "p/m" });
		expect(plan.removals).toEqual([]);
	});

	it("上游已禁用 ⇒ 不可写、旧条目去除，detail 区分于『上游已无』", () => {
		const plan = planRebuild({
			rows: [row("researcher", { projectEntry: { model: "p/m" }, merged: { model: "p/m" }, state: "unresolved", disabledUpstream: true })],
			projectOverrides: { researcher: { model: "p/m" } },
			whitelist: ["researcher"],
		});
		expect(plan.overrides).toEqual({});
		expect(plan.removals).toEqual([{ name: "researcher", reason: "unresolved", detail: "disabled upstream" }]);
	});

	it("MISSING（上游已无）⇒ 同样去除，detail 为『上游已无此 agent』", () => {
		const plan = planRebuild({
			rows: [row("stale-agent", { projectEntry: { model: "p/m" }, merged: { model: "p/m" }, state: "unresolved" })],
			projectOverrides: { "stale-agent": { model: "p/m" } },
			whitelist: ["stale-agent"],
		});
		expect(plan.removals).toEqual([{ name: "stale-agent", reason: "unresolved", detail: "no such agent upstream" }]);
	});
});

describe("未 dirty 行保留现有值（§11 用例 9：按解析后的对象断言，不按字节）", () => {
	it("未改动 ⇒ 语义相等，不翻转成遮蔽", () => {
		const projectEntry: Override = { model: "p/m3", tools: ["read"] };
		const merged = synthesize({ projectEntry, userEntry: { model: "u/m2", thinking: "high" } });
		const plan = planRebuild({
			rows: [row("reviewer", { projectEntry, merged })],
			projectOverrides: { reviewer: projectEntry },
			whitelist: ["reviewer"],
		});
		expect(plan.overrides.reviewer).toEqual(projectEntry);
		expect(plan.unchanged).toEqual(["reviewer"]);
		expect(plan.changed).toEqual([]);
	});

	it("只改 extra（不碰 model/thinking）也算 dirty 并落盘", () => {
		const projectEntry: Override = { model: "p/m3" };
		const merged = synthesize({ projectEntry, userEntry: { model: "p/m3", tools: ["read"] } });
		const plan = planRebuild({
			rows: [row("reviewer", { projectEntry, merged, extra: { tools: ["read", "bash"] } })],
			projectOverrides: { reviewer: projectEntry },
			whitelist: ["reviewer"],
		});
		expect(plan.overrides.reviewer).toEqual({ model: "p/m3", tools: ["read", "bash"] });
		expect(plan.changed[0]?.fields.map((f) => f.key)).toEqual(["tools"]);
	});

	it("只改 model 也会把合并基底的其它字段一起物化（合并的意义）", () => {
		const projectEntry: Override = {};
		const userEntry: Override = { tools: ["read", "bash"], acceptanceRole: "writer", thinking: "medium" };
		const merged = synthesize({ projectEntry, userEntry });
		const plan = planRebuild({
			rows: [row("reviewer", { projectEntry, merged, touch: { key: "model", value: "p/m1" } })],
			projectOverrides: {},
			whitelist: ["reviewer"],
		});
		expect(plan.overrides.reviewer).toEqual({ tools: ["read", "bash"], acceptanceRole: "writer", thinking: "medium", model: "p/m1" });
	});
});

describe("applyDraft 删键在重建路径上的回归", () => {
	it("e 里删掉一个已物化字段后保存，不得复活", () => {
		const projectEntry: Override = { model: "p/m3", tools: ["read"] };
		const merged = synthesize({ projectEntry, userEntry: { model: "p/m3", tools: ["read"], machine: "r" } });
		const r = row("reviewer", { projectEntry, merged, touch: { key: "thinking", value: "max" } });
		delete r.draft.extra.tools;
		const plan = planRebuild({ rows: [r], projectOverrides: { reviewer: projectEntry }, whitelist: ["reviewer"] });
		expect(plan.overrides.reviewer).toEqual({ model: "p/m3", machine: "r", thinking: "max" });
		expect("tools" in plan.overrides.reviewer!).toBe(false);
	});
});

describe("--from 的「模板未生效字段」预览", () => {
	it("--from 换掉整个基底 ⇒ 列出项目现有条目里有、而指定 profile 与全局都没有的字段", () => {
		const plan = planRebuild({
			rows: [
				row("reviewer", {
					projectEntry: { model: "p/m", skills: ["s"] },
					merged: { model: "b/m", thinking: "max" },
					fromEntry: { model: "b/m", thinking: "max" },
					touch: { key: "thinking", value: "low" },
				}),
			],
			projectOverrides: { reviewer: { model: "p/m", skills: ["s"] } },
			whitelist: ["reviewer"],
			fromProfileActive: true,
		});
		// 实际写入：指定 profile 的基底 + 草稿；项目条目里的 skills 不参与基底、也不会写回
		expect(plan.overrides.reviewer).toEqual({ model: "b/m", thinking: "low" });
		// skills 在项目条目里有、但不在合并结果里 ⇒ 会被真实丢弃
		expect(plan.dropped).toEqual([{ name: "reviewer", keys: ["skills"] }]);
	});

	it("项目无该 agent 条目 ⇒ 模板全量生效，不产出任何未生效字段", () => {
		const plan = planRebuild({
			rows: [
				row("scout", {
					projectEntry: undefined,
					merged: { model: "b/m", thinking: "max" },
					fromEntry: { model: "b/m", thinking: "max" },
					touch: { key: "model", value: "b/m" },
				}),
			],
			projectOverrides: {},
			whitelist: ["scout"],
			fromProfileActive: true,
		});
		expect(plan.overrides.scout).toEqual({ model: "b/m", thinking: "max" });
		expect(plan.dropped).toEqual([]);
	});

	it("无 --from 时不产出该预览", () => {
		const plan = planRebuild({
			rows: [row("reviewer", { projectEntry: { model: "p/m", skills: ["s"] }, merged: { model: "p/m", skills: ["s"] }, touch: { key: "model", value: "p/m" } })],
			projectOverrides: {},
			whitelist: ["reviewer"],
		});
		expect(plan.dropped).toEqual([]);
	});
});

describe("--from 落盘修复（§16.1）", () => {
	it("1. --from + 未编辑 + 项目条目与模板不同 ⇒ changed 含该行，overrides 取模板值", () => {
		const projectEntry: Override = { model: "p/m", thinking: "low" };
		const plan = planRebuild({
			rows: [row("reviewer", { projectEntry, merged: { model: "b/m", thinking: "high" }, fromEntry: { model: "b/m", thinking: "high" } })],
			projectOverrides: { reviewer: projectEntry },
			whitelist: ["reviewer"],
			fromProfileActive: true,
		});
		expect(plan.overrides.reviewer).toEqual({ model: "b/m", thinking: "high" });
		expect(plan.changed).toHaveLength(1);
		expect(plan.changed[0]?.name).toBe("reviewer");
		expect(plan.changed[0]?.isNew).toBe(false);
		expect(plan.changed[0]?.before).toEqual(projectEntry);
		expect(plan.unchanged).toEqual([]);
	});

	it("2. --from + 未编辑 + 项目无条目 + 模板有 ⇒ 写入，isNew: true", () => {
		const plan = planRebuild({
			rows: [row("scout", { merged: { model: "b/m", thinking: "max" }, fromEntry: { model: "b/m", thinking: "max" } })],
			projectOverrides: {},
			whitelist: ["scout"],
			fromProfileActive: true,
		});
		expect(plan.overrides.scout).toEqual({ model: "b/m", thinking: "max" });
		expect(plan.changed).toHaveLength(1);
		expect(plan.changed[0]?.name).toBe("scout");
		expect(plan.changed[0]?.isNew).toBe(true);
	});

	it("3. --from + 未编辑 + 项目条目与模板完全相同 ⇒ 不写，unchanged 含该行（幂等）", () => {
		const projectEntry: Override = { model: "b/m", thinking: "high" };
		const plan = planRebuild({
			rows: [row("reviewer", { projectEntry, merged: { model: "b/m", thinking: "high" }, fromEntry: { model: "b/m", thinking: "high" } })],
			projectOverrides: { reviewer: projectEntry },
			whitelist: ["reviewer"],
			fromProfileActive: true,
		});
		expect(plan.changed).toEqual([]);
		expect(plan.unchanged).toEqual(["reviewer"]);
		expect(plan.overrides.reviewer).toEqual(projectEntry);
	});

	it("4. 不带 --from + 未编辑 + 项目无条目 ⇒ 不写（决策 5 的回归）", () => {
		// 基底来自 default profile 的行：与用例 2 同形，只是没开 --from ⇒ 必须不写
		const plan = planRebuild({
			rows: [row("scout", { merged: { model: "d/m", thinking: "max" } })],
			projectOverrides: {},
			whitelist: ["scout"],
		});
		expect(plan.changed).toEqual([]);
		expect(plan.overrides).toEqual({});
		expect(plan.unchanged).toEqual([]);
	});

	it("5. --from + 模板条目为空（基底回落到项目条目）⇒ 不写、不产生 removal", () => {
		const projectEntry: Override = { model: "p/m" };
		const plan = planRebuild({
			rows: [row("reviewer", { projectEntry, merged: { model: "p/m" } })],
			projectOverrides: { reviewer: projectEntry },
			whitelist: ["reviewer"],
			fromProfileActive: true,
		});
		expect(plan.changed).toEqual([]);
		expect(plan.removals).toEqual([]);
		expect(plan.unchanged).toEqual(["reviewer"]);
		expect(plan.overrides.reviewer).toEqual(projectEntry);
	});

	it("6. dropped：项目条目里模板没有的键进 plan.dropped", () => {
		const projectEntry: Override = { model: "p/m", skills: ["s"] };
		const plan = planRebuild({
			rows: [row("reviewer", { projectEntry, merged: { model: "b/m" }, fromEntry: { model: "b/m" } })],
			projectOverrides: { reviewer: projectEntry },
			whitelist: ["reviewer"],
			fromProfileActive: true,
		});
		expect(plan.overrides.reviewer).toEqual({ model: "b/m" });
		expect(plan.changed).toHaveLength(1);
		expect(plan.dropped).toEqual([{ name: "reviewer", keys: ["skills"] }]);
	});
});

describe("writeProjectAgentOverrides（只替换一个键 + 原子写）", () => {
	it("文件不存在 ⇒ 创建目录并只写 subagents.agentOverrides", () => {
		const result = writeProjectAgentOverrides(projectRoot, { reviewer: { model: "p/m" } });
		expect(result.file).toBe(projectPath);
		expect(readProjectSettings()).toEqual({ subagents: { agentOverrides: { reviewer: { model: "p/m" } } } });
	});

	it("其余键语义保留（键集合与值相等）", () => {
		writeProjectSettings({
			theme: "dark",
			enabledModels: ["a"],
			subagents: { defaultModel: "u/m", maxThinking: "high", modelScope: { a: 1 }, agentOverrides: { old: { model: "x" } } },
		});
		writeProjectAgentOverrides(projectRoot, { reviewer: { model: "p/m" } });
		const settings = readProjectSettings();
		expect(settings.theme).toBe("dark");
		expect(settings.enabledModels).toEqual(["a"]);
		expect(settings.subagents).toEqual({
			defaultModel: "u/m",
			maxThinking: "high",
			modelScope: { a: 1 },
			agentOverrides: { reviewer: { model: "p/m" } },
		});
	});

	it("② agentOverrides 全空 ⇒ 删该键；subagents 也空 ⇒ 一并删 subagents", () => {
		writeProjectSettings({ theme: "dark", subagents: { agentOverrides: { old: { model: "x" } } } });
		writeProjectAgentOverrides(projectRoot, {});
		expect(readProjectSettings()).toEqual({ theme: "dark" });
	});

	it("② agentOverrides 全空但 subagents 还有别的键 ⇒ 只删 agentOverrides", () => {
		writeProjectSettings({ subagents: { agentOverrides: { old: {} }, defaultModel: "u/m" } });
		writeProjectAgentOverrides(projectRoot, {});
		expect(readProjectSettings()).toEqual({ subagents: { defaultModel: "u/m" } });
	});

	it("settings.json 语法错误 ⇒ 抛 SettingsWriteError，不写盘（避免覆盖用户数据）", () => {
		fs.mkdirSync(path.dirname(projectPath), { recursive: true });
		fs.writeFileSync(projectPath, "{ not json", "utf-8");
		expect(() => writeProjectAgentOverrides(projectRoot, { reviewer: {} })).toThrow(SettingsWriteError);
		expect(fs.readFileSync(projectPath, "utf8")).toBe("{ not json");
	});

	it("顶层非对象 ⇒ 拒绝", () => {
		fs.mkdirSync(path.dirname(projectPath), { recursive: true });
		fs.writeFileSync(projectPath, "[]", "utf-8");
		expect(() => writeProjectAgentOverrides(projectRoot, {})).toThrow(SettingsWriteError);
	});

	it("未知键被写回（不复用上游的 allowlist 拷贝）", () => {
		writeProjectAgentOverrides(projectRoot, { reviewer: { model: "p/m", someFutureField: { deep: [1] } } });
		const settings = readProjectSettings() as { subagents: { agentOverrides: Record<string, Override> } };
		expect(settings.subagents.agentOverrides.reviewer?.someFutureField).toEqual({ deep: [1] });
	});

	it("内容无变化时不重写文件（mtime 不变）", () => {
		writeProjectAgentOverrides(projectRoot, { reviewer: { model: "p/m" } });
		const before = fs.statSync(projectPath).mtimeMs;
		const result = writeProjectAgentOverrides(projectRoot, { reviewer: { model: "p/m" } });
		expect(result.changedKeys).toEqual([]);
		expect(fs.statSync(projectPath).mtimeMs).toBe(before);
	});
});

describe("writeJsonAtomic", () => {
	it("写临时文件 + rename，不留残骸", () => {
		const file = path.join(tmp, "deep", "nested", "x.json");
		writeJsonAtomic(file, { a: 1 });
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1 });
		expect(fs.readdirSync(path.dirname(file))).toEqual(["x.json"]);
	});

	it("末尾带换行", () => {
		const file = path.join(tmp, "y.json");
		writeJsonAtomic(file, { a: 1 });
		expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
	});
});

describe("profile 导出（§4.2）", () => {
	it("格式为 { subagents: { agentOverrides } }，不含顶层 subagents 键", () => {
		const { document } = buildProfileDocument({ reviewer: { model: "p/m" } });
		expect(document).toEqual({ subagents: { agentOverrides: { reviewer: { model: "p/m" } } } });
		expect(Object.keys(document.subagents)).toEqual(["agentOverrides"]);
	});

	it("model:false 剔除并提示", () => {
		const { document, strippedModelFalse, droppedEntries } = buildProfileDocument({
			a: { model: false, thinking: "high" },
			b: { model: "p/m" },
		});
		expect(strippedModelFalse).toEqual(["a"]);
		expect(droppedEntries).toEqual([]);
		expect(document.subagents.agentOverrides.a).toEqual({ thinking: "high" });
		expect(document.subagents.agentOverrides.b).toEqual({ model: "p/m" });
	});

	it("剔除后条目变空 ⇒ 整条不导出", () => {
		const { document, droppedEntries } = buildProfileDocument({ a: { model: false } });
		expect(droppedEntries).toEqual(["a"]);
		expect(document.subagents.agentOverrides).toEqual({});
	});

	it("writeProfile 落到 profiles 目录", () => {
		const agentDir = path.join(tmp, "agentdir");
		const file = path.join(agentDir, "profiles", "pi-subagents", "work.json");
		const result = writeProfile(file, { reviewer: { model: "p/m" } });
		expect(result.file).toBe(file);
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ subagents: { agentOverrides: { reviewer: { model: "p/m" } } } });
	});
});

describe("项目根解析：`.pi` → git 根 → cwd", () => {
	/** 造一个临时目录树，返回 cleanup。 */
	function tree(spec: Record<string, string[]>) {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "presets-root-"));
		for (const [dir, files] of Object.entries(spec)) {
			fs.mkdirSync(path.join(base, dir), { recursive: true });
			for (const f of files) {
				const abs = path.join(base, dir, f);
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				fs.writeFileSync(abs, f.endsWith(".json") ? "{}" : "");
			}
		}
		return { base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
	}

	it("最近的含 `.pi` 的祖先优先（哪怕 cwd 只是它的子目录）", () => {
		const t = tree({ "proj/.pi": ["settings.json"], "proj/sub/.git": ["HEAD"] });
		try {
			const r = resolveProjectRoot(path.join(t.base, "proj/sub"), undefined);
			expect(r.root).toBe(path.join(t.base, "proj"));
			expect(r.tier).toBe("pi");
		} finally {
			t.cleanup();
		}
	});

	it("回归：祖先只有 `.agents`（容器目录里的残留软链）时**不**被当作项目根", () => {
		// 真实事故：`myprojects/.agents` 里只有一个 `skills -> .claude/skills` 软链，
		// 上游的候选判据（`.pi` 或 `.agents`）会让它成为最近候选，
		// 于是它下面**所有仓库**的配置被写进同一个容器目录。
		const t = tree({ "container/.agents/skills": ["x"], "container/repo/.git": ["HEAD"] });
		try {
			const r = resolveProjectRoot(path.join(t.base, "container/repo"), undefined);
			expect(r.root).toBe(path.join(t.base, "container/repo"));
			expect(r.tier).toBe("git");
			expect(r.warning).toContain("git root");
		} finally {
			t.cleanup();
		}
	});

	it("既无 `.pi` 也无 git 根 ⇒ cwd", () => {
		const t = tree({ "plain/dir": [".keep"] });
		try {
			const r = resolveProjectRoot(path.join(t.base, "plain/dir"), undefined);
			expect(r.root).toBe(path.join(t.base, "plain/dir"));
			expect(r.tier).toBe("cwd");
		} finally {
			t.cleanup();
		}
	});

	it("`projectRootResolution: \"git-root\"` 显式 opt-in ⇒ 用 git 根（否则我们写的地方上游不读）", () => {
		// 真正需要它的场景：`.pi` 在**外层**，而 cwd 所在的是一个嵌套的 git 仓库。
		// 不 opt-in 时按“最近 `.pi`”会选外层（与上游一致）；opt-in 后内外层两个规则
		// 都指向内层的 git 根，收敛。
		const t = tree({ "outer/.pi": ["settings.json"], "outer/nested/.git": ["HEAD"] });
		try {
			const nested = path.join(t.base, "outer/nested");
			const piSettings = path.join(t.base, "outer/.pi/settings.json");

			// 未 opt-in ⇒ 最近 `.pi`（外层）
			expect(resolveProjectRoot(nested, undefined).tier).toBe("pi");

			// opt-in ⇒ git 根（内层）
			fs.writeFileSync(piSettings, JSON.stringify({ subagents: { projectRootResolution: "git-root" } }));
			const r = resolveProjectRoot(nested, undefined);
			expect(r.root).toBe(nested);
			expect(r.tier).toBe("git");
			expect(r.warning).toContain("git-root");
		} finally {
			t.cleanup();
		}
	});

	it("`.pi/settings.json` 坏 JSON ⇒ 忽略 opt-in，不抛（绝不硬失败）", () => {
		const t = tree({ "proj/.git": ["HEAD"], "proj/.pi": ["settings.json"] });
		try {
			fs.writeFileSync(path.join(t.base, "proj/.pi/settings.json"), "{ broken");
			expect(() => resolveProjectRoot(path.join(t.base, "proj"), undefined)).not.toThrow();
		} finally {
			t.cleanup();
		}
	});

	it("写入路径 = <projectRoot>/<CONFIG_DIR_NAME>/settings.json（目录名不硬编码）", () => {
		const dirName = getConfigDirName();
		expect(dirName).toBe(".pi");
		expect(getProjectSettingsPath("/repo")).toBe(path.join("/repo", dirName, "settings.json"));
	});
});

describe("连续两次保存幂等（§11 用例 10）", () => {
	it("脏行 → 保存 → 未脏行：第二次不产生任何差异", () => {
		const projectEntry: Override = {};
		const userEntry: Override = { thinking: "medium" };
		const merged = synthesize({ projectEntry, userEntry });

		// 第一次：改 thinking
		const first = planRebuild({
			rows: [row("reviewer", { projectEntry, merged, touch: { key: "thinking", value: "max" } })],
			projectOverrides: {},
			whitelist: ["reviewer"],
		});
		writeProjectAgentOverrides(projectRoot, first.overrides);
		const written = first.overrides.reviewer;
		expect(written).toEqual({ thinking: "max" });

		// 第二次：重读项目条目，基底 = 项目条目（未 dirty ⇒ 保持现有值）
		const reloaded = readProjectSettings() as { subagents: { agentOverrides: Record<string, Override> } };
		const reloadedEntry = reloaded.subagents.agentOverrides.reviewer;
		const merged2 = synthesize({ projectEntry: reloadedEntry, userEntry });
		const second = planRebuild({
			rows: [row("reviewer", { projectEntry: reloadedEntry, merged: merged2 })],
			projectOverrides: reloaded.subagents.agentOverrides,
			whitelist: ["reviewer"],
		});
		expect(second.changed).toEqual([]);
		expect(second.overrides.reviewer).toEqual(written);
		const before = fs.statSync(projectPath).mtimeMs;
		writeProjectAgentOverrides(projectRoot, second.overrides);
		expect(fs.statSync(projectPath).mtimeMs).toBe(before);
	});
});
