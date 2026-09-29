import { describe, expect, it } from "vitest";
import {
	applyDraft,
	applyEditedEntry,
	createDraft,
	deepEqualOverride,
	deepCloneOverride,
	effectiveBase,
	effectiveOrigin,
	initialExtra,
	isDirty,
	keepExisting,
	materializeRow,
	resetEffective,
	resetParticipates,
	rowBaseOf,
	rowDirty,
	rowMergeState,
	synthesize,
	synthesizeDetailed,
	type Draft,
	type Override,
	type RowBaseInput,
} from "../src/merge.ts";

/** 26 字段全部塞满的全局条目（等价性回归的输入）。 */
const ALL_26_FIELDS: Override = {
	description: "desc",
	output: "out",
	outputMode: "inline",
	model: "u/m2",
	fast: true,
	thinking: "medium",
	systemPromptMode: "append",
	inheritProjectContext: true,
	inheritGlobalContext: false,
	inheritSkills: true,
	defaultContext: "fork",
	acceptanceRole: "writer",
	disabled: false,
	toolBudget: { maxCalls: 3 },
	systemPrompt: "be brief",
	machine: "runner-a",
	defaultReads: ["src/**"],
	defaultProvider: "u",
	skills: ["s1"],
	tools: ["read", "bash"],
	excludeTools: ["write"],
	allowNestedSubagents: true,
	allowedAgents: ["scout"],
	extensions: ["x1"],
	subagentOnlyExtensions: ["x2"],
	mutationTools: ["write"],
};

describe("synthesize (§3.1)", () => {
	it("base0 > user，user 只补 base0 没有的键", () => {
		const merged = synthesize({ projectEntry: { model: "p/m1", thinking: "high" }, userEntry: { model: "u/m2", tools: ["read"] } });
		expect(merged).toEqual({ model: "p/m1", thinking: "high", tools: ["read"] });
	});

	it("无 --from 时 base0 = 项目条目；项目无条目时回落 default profile", () => {
		expect(synthesize({ projectEntry: { model: "p/m1" }, defaultProfile: { model: "d/m0" }, userEntry: {} })).toEqual({ model: "p/m1" });
		expect(synthesize({ defaultProfile: { model: "d/m0", thinking: "low" }, userEntry: {} })).toEqual({ model: "d/m0", thinking: "low" });
	});

	it("--from 换的是整个基底：加载指定配置，项目现有条目不参与（base0 = fromProfile ?? …）", () => {
		const merged = synthesize({
			fromProfile: { model: "b/m9", thinking: "low" },
			projectEntry: { model: "p/m1", skills: ["s"] },
			defaultProfile: { model: "d/m0" },
			userEntry: { machine: "runner-b" },
		});
		// 指定 profile 整条胜出；项目条目与 default profile 都不参与基底
		expect(merged).toEqual({ model: "b/m9", thinking: "low", machine: "runner-b" });
	});

	it("纯命令（无 --from）⇒ 基底取项目现有条目，项目没有才回落 default profile", () => {
		expect(
			synthesize({ fromProfile: undefined, projectEntry: { model: "p/m1", skills: ["s"] }, defaultProfile: { model: "d/m0" }, userEntry: {} }),
		).toEqual({ model: "p/m1", skills: ["s"] });
		expect(synthesize({ fromProfile: undefined, projectEntry: undefined, defaultProfile: { model: "d/m0" }, userEntry: {} })).toEqual({
			model: "d/m0",
		});
	});

	it("--from default ⇒ 显式使用 default profile（而非项目条目）", () => {
		expect(synthesize({ fromProfile: { model: "d/m0" }, projectEntry: { model: "p/m1" }, userEntry: {} })).toEqual({ model: "d/m0" });
	});

	it("--from 且项目无该 agent 条目 ⇒ 基底取指定 profile", () => {
		expect(synthesize({ fromProfile: { model: "b/m9" }, projectEntry: undefined, userEntry: {} })).toEqual({ model: "b/m9" });
	});

	it("machine 等字段无特例：全局有就物化", () => {
		const merged = synthesize({ projectEntry: {}, userEntry: { machine: "runner-b", tools: false } });
		expect(merged).toEqual({ machine: "runner-b", tools: false });
	});

	it("false 是合法值，不被 ?? 吞掉", () => {
		const merged = synthesize({ projectEntry: {}, userEntry: { fast: false, tools: false, machine: false } });
		expect(merged).toEqual({ fast: false, tools: false, machine: false });
		expect(Object.keys(merged)).toHaveLength(3);
	});

	it("键存在但值为 undefined 时仍算命中（`in` 语义）", () => {
		const merged = synthesize({ projectEntry: { model: undefined }, userEntry: { model: "u/m2" } });
		expect(merged).toHaveProperty("model");
		expect(merged.model).toBeUndefined();
	});

	it("两层都没有 ⇒ 空对象", () => {
		expect(synthesize({})).toEqual({});
	});

	it("合成结果为空 ⇒ 不产生条目（上层据此跳过写盘）", () => {
		const merged = synthesize({ projectEntry: {}, userEntry: {} });
		expect(Object.keys(merged).length).toBe(0);
	});
});

describe("等价性回归（v4 存在的理由）", () => {
	it("合并写入后的结果与『跟随全局』在全部 26 个字段上逐字段相等", () => {
		// 「跟随全局」= 项目没有该条目 ⇒ 上游用全局条目
		const followGlobal = ALL_26_FIELDS;
		// 合并写入 = 同样的字段被物化进项目条目
		const written = materializeRow(synthesize({ projectEntry: undefined, userEntry: ALL_26_FIELDS }), createDraft("reviewer", ALL_26_FIELDS));
		const followResolved = { ...followGlobal };
		expect(written).toEqual(followResolved);
		for (const key of Object.keys(ALL_26_FIELDS)) {
			expect(written[key]).toEqual(followResolved[key]);
		}
		// 差异数必须为 0
		const differing = Object.keys(ALL_26_FIELDS).filter((key) => JSON.stringify(written[key]) !== JSON.stringify(followResolved[key]));
		expect(differing).toEqual([]);
	});
});

describe("extra 初值与 deepEqual", () => {
	it("初值 = merged 去 model/thinking 的深拷贝", () => {
		const merged = { model: "m", thinking: "high", tools: ["read"], machine: "r" };
		const extra = initialExtra(merged);
		expect(extra).toEqual({ tools: ["read"], machine: "r" });
		(extra.tools as string[]).push("bash");
		expect(merged.tools).toEqual(["read"]);
	});

	it("键序无关的深比较（裸 JSON.stringify 会误判）", () => {
		expect(deepEqualOverride({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(deepEqualOverride({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
		expect(deepEqualOverride([1, { a: 1, b: 2 }], [1, { b: 2, a: 1 }])).toBe(true);
		expect(deepEqualOverride({ a: 1 }, { a: 2 })).toBe(false);
		expect(deepEqualOverride({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(deepEqualOverride([1, 2], [2, 1])).toBe(false);
		expect(deepEqualOverride(null, undefined)).toBe(false);
		expect(deepEqualOverride(1, "1")).toBe(false);
	});
});

describe("dirty 三条判定（§3.3）", () => {
	it("第 1 条：touched 任一键即 dirty", () => {
		const draft = createDraft("a", { model: "m" });
		expect(isDirty(draft, {})).toBe(false);
		draft.touched.add("model");
		expect(isDirty(draft, {})).toBe(true);
	});

	it("第 2 条（回归）：只改 extra、不碰 model/thinking 也要落盘", () => {
		const merged = { model: "m", thinking: "high" };
		const draft = createDraft("a", merged);
		expect(isDirty(draft, initialExtra(merged))).toBe(false);
		draft.extra.tools = ["read", "bash"];
		expect(isDirty(draft, initialExtra(merged))).toBe(true);
	});

	it("第 3 条：reset 即 dirty", () => {
		const merged = { model: "m" };
		const draft = createDraft("a", merged);
		expect(isDirty(draft, initialExtra(merged))).toBe(false);
		draft.reset = true;
		expect(isDirty(draft, initialExtra(merged))).toBe(true);
	});

	it("extra 初值口径：基底 extra 为空时不会一开屏就恒 dirty", () => {
		const merged = { tools: ["read"] };
		const draft = createDraft("a", merged);
		// 这里的 baseExtra 取自同一行 synthesize 的结果（initialExtra 复刻其口径）
		expect(isDirty(draft, initialExtra(merged))).toBe(false);
	});
});

describe("applyDraft 三态 + 删键语义（§3.3）", () => {
	it("未触碰时保留合并基底的值", () => {
		const merged = { model: "u/m2", thinking: "high", tools: ["read"] };
		const draft = createDraft("a", merged);
		draft.touched.add("model");
		draft.model = "p/m1";
		const out = materializeRow(merged, draft);
		expect(out).toEqual({ model: "p/m1", thinking: "high", tools: ["read"] });
	});

	it("显式清空（touched + undefined）删除该键", () => {
		const merged = { model: "u/m2", thinking: "high" };
		const draft = createDraft("a", merged);
		draft.touched.add("thinking");
		draft.thinking = undefined;
		expect(materializeRow(merged, draft)).toEqual({ model: "u/m2" });
	});

	it("显式选 false 写入 false（不是删键）", () => {
		const merged = { model: "u/m2" };
		const draft = createDraft("a", merged);
		draft.touched.add("model");
		draft.model = false;
		expect(materializeRow(merged, draft)).toEqual({ model: false });
	});

	it("extra 字段存活（含未知键）", () => {
		const merged = { model: "m" };
		const draft = createDraft("a", merged);
		draft.extra.zzzUnknown = { deep: [1, 2] };
		expect(materializeRow(merged, draft)).toEqual({ model: "m", zzzUnknown: { deep: [1, 2] } });
	});

	it("extra.model/thinking 不进 extra（由矩阵草稿的 model/thinking 决定；`e` 回填也走这两条）", () => {
		const merged = { model: "u/m2", thinking: "high" };
		const draft = createDraft("a", merged);
		draft.extra.model = "should-be-ignored";
		draft.extra.thinking = "should-be-ignored";
		draft.touched.add("model");
		draft.model = "p/m1";
		expect(materializeRow(merged, draft)).toEqual({ model: "p/m1", thinking: "high" });
	});

	it("回归：e 里删掉一个已物化字段后保存，不得复活", () => {
		const merged = { model: "u/m2", tools: ["read"], machine: "runner-a" };
		const draft = createDraft("a", merged);
		expect(draft.extra).toEqual({ tools: ["read"], machine: "runner-a" });
		delete draft.extra.tools;
		draft.touched.add("thinking");
		draft.thinking = "max";
		const out = materializeRow(merged, draft);
		expect(out).toEqual({ model: "u/m2", machine: "runner-a", thinking: "max" });
		expect("tools" in out).toBe(false);
	});

	it("extra 里值为 undefined ⇒ 删键", () => {
		const merged = { model: "m", tools: ["read"] };
		const draft = createDraft("a", merged);
		draft.extra.tools = undefined;
		expect(materializeRow(merged, draft)).toEqual({ model: "m" });
	});

	it("applyDraft 就地修改传入对象（§7.1 伪代码语义）；materializeRow 负责深拷贝", () => {
		const merged: Override = { model: "m", tools: ["read"] };
		const draft = createDraft("a", merged);
		draft.touched.add("model");
		draft.model = "other";
		expect(applyDraft(merged, draft)).toBe(merged);
		expect(merged).toEqual({ model: "other", tools: ["read"] });
		// materializeRow 先深拷贝再改，基底不受影响
		const base: Override = { model: "m", tools: ["read"] };
		expect(materializeRow(base, draft)).toEqual({ model: "other", tools: ["read"] });
		expect(base).toEqual({ model: "m", tools: ["read"] });
	});
});

describe("keepExisting（§7.1 的 keep existing 分支）", () => {
	it("undefined / 空对象 ⇒ 不写回（上游把 `{}` 视为无条目）", () => {
		expect(keepExisting(undefined)).toBeUndefined();
		expect(keepExisting({})).toBeUndefined();
	});

	it("非空条目深拷贝回填", () => {
		const entry: Override = { model: "p/m3", tools: ["read"] };
		const kept = keepExisting(entry);
		expect(kept).toEqual(entry);
		expect(kept).not.toBe(entry);
		kept!.model = "mutated";
		expect(entry.model).toBe("p/m3");
	});
});

describe("合并基底不含定义层的值（§3.1）", () => {
	it("两层都没有 ⇒ 合并结果里没有该键（不回落定义层）", () => {
		const merged = synthesize({ projectEntry: undefined, defaultProfile: undefined, userEntry: undefined });
		expect(merged).toEqual({});
		expect("model" in merged).toBe(false);
		expect("thinking" in merged).toBe(false);
	});

	it("只有全局有时只有全局的那几个键", () => {
		const merged = synthesizeDetailed({ userEntry: { tools: ["read"] } });
		expect(merged.merged).toEqual({ tools: ["read"] });
		expect(merged.origin).toEqual({ base: [], global: ["tools"] });
	});
});

/** 构造一行用于 `state` 判定（`merged` 由 `synthesize` 产出，`origin` 与它同源）。 */
function rowOf(opts: { projectEntry?: Override; userEntry?: Override; globalEntry?: Override; draft?: (draft: Draft) => void }): RowBaseInput {
	const { merged, origin } = synthesizeDetailed({ projectEntry: opts.projectEntry, userEntry: opts.userEntry });
	const draft = createDraft("reviewer", merged);
	opts.draft?.(draft);
	return {
		merged,
		origin,
		globalEntry: opts.globalEntry ?? opts.userEntry,
		draft,
	};
}

describe("state 三值（GLOBAL / MERGE / OVERRIDE，实时计算）", () => {
	it("全部字段来自全局 ⇒ GLOBAL", () => {
		const row = rowOf({ userEntry: { model: "u/m", thinking: "high" } });
		expect(rowMergeState(row)).toBe("GLOBAL");
	});

	it("全部字段来自基底（项目条目 / 模板）⇒ OVERRIDE", () => {
		const row = rowOf({ projectEntry: { model: "p/m", thinking: "low" } });
		expect(rowMergeState(row)).toBe("OVERRIDE");
	});

	it("一部分来自基底、一部分跟随全局 ⇒ MERGE", () => {
		const row = rowOf({ projectEntry: { model: "p/m" }, userEntry: { thinking: "high" } });
		expect(rowMergeState(row)).toBe("MERGE");
	});

	it("两层皆空 ⇒ GLOBAL（含合并结果为空对象）", () => {
		const row = rowOf({});
		expect(Object.keys(row.merged)).toEqual([]);
		expect(rowMergeState(row)).toBe("GLOBAL");
	});

	it("`touched` 且显式选值 ⇒ 计入 base 侧", () => {
		const row = rowOf({
			userEntry: { thinking: "high" },
			draft: (draft) => {
				draft.touched.add("model");
				draft.model = "p/m";
			},
		});
		// 全局只贡献 thinking，而 model 是你改的 ⇒ 两侧都有
		expect(rowMergeState(row)).toBe("MERGE");
	});

	it("`touched` 且显式清空 ⇒ 计入 global 侧（键不写入 ⇒ 运行时由全局兜底）", () => {
		const row = rowOf({
			projectEntry: { model: "p/m", thinking: "high" },
			draft: (draft) => {
				draft.touched.add("model");
				draft.model = undefined;
			},
		});
		// model 不写入（⇒ 算 global 侧）、thinking 仍来自项目条 ⇒ 两侧都有
		expect(rowMergeState(row)).toBe("MERGE");

		const onlyModel = rowOf({
			projectEntry: { model: "p/m" },
			draft: (draft) => {
				draft.touched.add("model");
				draft.model = undefined;
			},
		});
		expect(onlyModel.draft.touched.size).toBe(1);
		// 项目条的**唯一**字段被清空 ⇒ 项目条零贡献 ⇒ GLOBAL
		expect(rowMergeState(onlyModel)).toBe("GLOBAL");
	});

	it("`e` 里改过/新增的 extra 字段 ⇒ 计入 base 侧", () => {
		const row = rowOf({
			userEntry: { model: "u/m" },
			draft: (draft) => {
				draft.extra.tools = ["read"];
			},
		});
		expect(rowMergeState(row)).toBe("MERGE");
	});

	it("演进链：初始 OVERRIDE ─ r(reset) ─▶ GLOBAL ─ 改一个字段 ─▶ MERGE ─ 改完其余 ─▶ OVERRIDE", () => {
		const projectEntry: Override = { model: "p/m", thinking: "low" };
		const userEntry: Override = { model: "u/m", thinking: "high" };
		const row = rowOf({ projectEntry, userEntry, globalEntry: userEntry });
		expect(rowMergeState(row)).toBe("OVERRIDE");

		row.draft.reset = true;
		expect(resetParticipates(row)).toBe(false);
		expect(rowBaseOf(row)).toEqual(userEntry);
		expect(effectiveOrigin(row.origin, userEntry, true)).toEqual({ base: [], global: ["model", "thinking"] });
		expect(rowMergeState(row)).toBe("GLOBAL");

		row.draft.touched.add("model");
		row.draft.model = "p/m2";
		// 改任一字段 ⇒ 行重新参与重建，但基底仍然冻结在全局层
		expect(resetParticipates(row)).toBe(true);
		expect(rowBaseOf(row)).toEqual(userEntry);
		expect(rowMergeState(row)).toBe("MERGE");

		row.draft.touched.add("thinking");
		row.draft.thinking = "max";
		expect(rowMergeState(row)).toBe("OVERRIDE");
	});

	it("resetEffective / resetParticipates：未改 ⇒ 不参与；改过（touched / extra）⇒ 重新参与", () => {
		const merged: Override = { model: "p/m", tools: ["read"] };
		const draft = createDraft("a", merged);
		const row = { merged, draft };
		expect(resetEffective(row)).toBe(false); // 没按过 r
		draft.reset = true;
		expect(resetEffective(row)).toBe(true);
		expect(resetParticipates(row)).toBe(false);
		draft.extra.tools = ["read", "bash"];
		expect(resetEffective(row)).toBe(true);
		expect(resetParticipates(row)).toBe(true);
		draft.extra.tools = ["read"];
		/** `e` 里新增一个键也算改过 */
		draft.extra.skills = ["s"];
		expect(resetParticipates(row)).toBe(true);
		delete draft.extra.skills;
		draft.touched.add("thinking");
		expect(resetParticipates(row)).toBe(true);
	});

	it("reset 行的 base 与 origin 冻结为只取全局层", () => {
		const row = rowOf({ projectEntry: { model: "p/m" }, userEntry: { thinking: "high" }, globalEntry: { thinking: "high" } });
		expect(rowBaseOf(row)).toEqual({ model: "p/m", thinking: "high" });
		row.draft.reset = true;
		expect(rowBaseOf(row)).toEqual({ thinking: "high" });
		expect(effectiveBase({ model: "p/m" }, undefined, true)).toEqual({});
	});

	it("rowDirty：reset 与修改都算 dirty；未动过的行不 dirty", () => {
		const row = rowOf({ projectEntry: { model: "p/m" }, userEntry: { thinking: "high" } });
		expect(rowDirty(row)).toBe(false);
		row.draft.reset = true;
		expect(rowDirty(row)).toBe(true);
	});
});

describe("applyEditedEntry（`e` 编辑整条条目后回填草稿）", () => {
	it("model / thinking 同步进草稿并标 touched（矩阵与 e 是同一份数据）", () => {
		const merged: Override = { model: "u/m", thinking: "high", tools: ["read"] };
		const draft = createDraft("a", merged);
		applyEditedEntry(draft, { model: "p/m2", thinking: "max", tools: ["read", "bash"] });
		expect(draft.model).toBe("p/m2");
		expect(draft.thinking).toBe("max");
		expect(draft.touched).toEqual(new Set(["model", "thinking"]));
		expect(draft.extra).toEqual({ tools: ["read", "bash"] });
		expect(materializeRow(merged, draft)).toEqual({ model: "p/m2", thinking: "max", tools: ["read", "bash"] });
	});

	it("删掉的键不写入（touched + undefined = 显式清空）", () => {
		const merged: Override = { model: "u/m", thinking: "high", tools: ["read"] };
		const draft = createDraft("a", merged);
		applyEditedEntry(draft, { tools: ["read"] });
		expect(draft.model).toBeUndefined();
		expect(draft.thinking).toBeUndefined();
		expect(materializeRow(merged, draft)).toEqual({ tools: ["read"] });
	});

	it("非法值也照原样存储（校验只警告，绝不改写用户的值）", () => {
		const merged: Override = { model: "u/m" };
		const draft = createDraft("a", merged);
		applyEditedEntry(draft, { model: "u/m", outputMode: "x", futureField: { deep: [1] } });
		expect(materializeRow(merged, draft)).toEqual({ model: "u/m", outputMode: "x", futureField: { deep: [1] } });
	});
});

describe("deepCloneOverride", () => {
	it("克隆数组与嵌套对象", () => {
		const src: Override = { a: [1, { b: 2 }], c: { d: [3] } };
		const out = deepCloneOverride(src);
		expect(out).toEqual(src);
		expect(out.a).not.toBe(src.a);
		(out.a as unknown[])[1] = "mutated";
		expect((src.a as unknown[])[1]).toEqual({ b: 2 });
	});
});
