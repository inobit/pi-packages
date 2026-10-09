import { describe, expect, it } from "vitest";
import {
	applyMainEditedEntry,
	classifyMainRow,
	MAIN_KEYS,
	MAIN_ROW_NAME,
	mainAuthWarning,
	mainEntryForEditor,
	mainLayerToOverride,
	mainModelText,
	readMainLayer,
	synthesizeMain,
} from "../src/main-row.ts";
import { createDraft, materializeRow, rowBaseOf, rowMergeState } from "../src/merge.ts";

describe("synthesizeMain 逐键优先级（§16.2.1）", () => {
	it("三层齐全 ⇒ fromProfile ▸ project ▸ user，逐键独立", () => {
		const { merged, origin } = synthesizeMain({
			fromProfile: { model: "b/m" },
			project: { provider: "p", model: "p/m" },
			user: { provider: "u", model: "u/m", thinkingLevel: "low" },
		});
		expect(merged).toEqual({ defaultProvider: "p", defaultModel: "b/m", defaultThinkingLevel: "low" });
		expect(origin.base).toEqual(["defaultProvider", "defaultModel"]);
		expect(origin.global).toEqual(["defaultThinkingLevel"]);
	});

	it("两层：project 有的键不回落 user", () => {
		const { merged, origin } = synthesizeMain({ project: { model: "p/m" }, user: { model: "u/m", thinkingLevel: "high" } });
		expect(merged).toEqual({ defaultModel: "p/m", defaultThinkingLevel: "high" });
		expect(origin).toEqual({ base: ["defaultModel"], global: ["defaultThinkingLevel"] });
	});

	it("空层 ⇒ 空对象（不回落任何默认值）", () => {
		expect(synthesizeMain({})).toEqual({ merged: {}, origin: { base: [], global: [] } });
		expect(synthesizeMain({ project: {} }).merged).toEqual({});
	});

	it("merged 的键就是三条真实键名（`state` 判定可直接用）", () => {
		const { merged } = synthesizeMain({ user: { provider: "u", model: "u/m", thinkingLevel: "low" } });
		expect(Object.keys(merged).sort()).toEqual([...MAIN_KEYS].sort());
	});
});

describe("readMainLayer 剔非法类型（§16.2.1）", () => {
	it("字符串保留，非字符串剔除", () => {
		expect(readMainLayer({ defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "high" })).toEqual({
			provider: "p",
			model: "m",
			thinkingLevel: "high",
		});
		expect(readMainLayer({ defaultProvider: 123, defaultModel: null, defaultThinkingLevel: ["x"] })).toEqual({});
		expect(readMainLayer({ other: "x" })).toEqual({});
	});

	it("mainLayerToOverride 归一化成落盘形状（缺省不出现）", () => {
		expect(mainLayerToOverride({ provider: "p" })).toEqual({ defaultProvider: "p" });
		expect(mainLayerToOverride(undefined)).toEqual({});
		expect(mainLayerToOverride({})).toEqual({});
	});
});

describe("mainModelText（§16.2.1）", () => {
	it("provider 有值 ⇒ `provider/model`", () => {
		const { merged } = synthesizeMain({ project: { provider: "p", model: "m" } });
		expect(mainModelText(merged, createDraft("main", merged, "main"), merged)).toBe("p/m");
	});

	it("无 provider ⇒ 裸 id", () => {
		const { merged } = synthesizeMain({ project: { model: "m" } });
		expect(mainModelText(merged, createDraft("main", merged, "main"), merged)).toBe("m");
	});

	it("无 model ⇒ 空白", () => {
		const { merged } = synthesizeMain({ project: { provider: "p" } });
		expect(mainModelText(merged, createDraft("main", merged, "main"), merged)).toBe("");
		expect(mainModelText({}, createDraft("main", {}, "main"), {})).toBe("");
	});

	it("草稿值优先（touched 的 model / extra 的 provider）", () => {
		const { merged } = synthesizeMain({ project: { provider: "p", model: "m" } });
		const draft = createDraft("main", merged, "main");
		draft.touched.add("model");
		draft.model = "m2";
		expect(mainModelText(merged, draft, merged)).toBe("p/m2");
		// `e` / 选择器改了 provider ⇒ 相对**原基底**算“用户改过”⇒ 用草稿值
		draft.extra.defaultProvider = "q";
		expect(mainModelText(merged, draft, merged)).toBe("q/m2");
	});

	it("reset 后不复活 reset 前的 provider（显示与落盘同一个口径）", () => {
		// 冒烟实测：项目层 provider=mimo，全局层 provider=ino2api。
		// 按 `r` 之后曾显示（并写入）`mimo/opencode/exo-free` —— provider 取自 reset 前的
		// `draft.extra`、model 取自冻结后的全局基底，拼出一个任何层都不存在的混合值。
		const project = { provider: "mimo", model: "mimo-v2.6-flash" };
		// globalEntry 必须是**落盘形状**（真实键名），与 session.ts 构造的一致
		const user = mainLayerToOverride({ provider: "ino2api", model: "opencode/exo-free" });
		const { merged } = synthesizeMain({ project, user });
		const draft = createDraft("main", merged, "main");
		const row = { merged, origin: { base: [], global: [] }, globalEntry: user, draft };

		// 未 reset：项目层的 provider 生效
		expect(mainModelText(merged, draft, merged)).toBe("mimo/mimo-v2.6-flash");

		draft.reset = true;
		const frozen = rowBaseOf(row);
		expect(mainModelText(frozen, draft, merged)).toBe("ino2api/opencode/exo-free");

		// reset 之后**再改**档位：基底仍冻结为全局层，provider 不得复活成项目层的
		draft.touched.add("thinking");
		draft.thinking = "high";
		expect(mainModelText(rowBaseOf(row), draft, merged)).toBe("ino2api/opencode/exo-free");
		// 对照：把 `draft.extra.defaultProvider` 换成另一个 provider（= 用户真的改了）⇒ 用草稿值
		draft.extra.defaultProvider = "zhipu";
		expect(mainModelText(rowBaseOf(row), draft, merged)).toBe("zhipu/opencode/exo-free");
	});
});

describe("classifyMainRow 恒可编辑（§16.2.1）", () => {
	it("有项目条目 ⇒ project，无 ⇒ inherit；无 provider 作用域 / 上游概念", () => {
		expect(classifyMainRow({ defaultModel: "m" }).state).toBe("project");
		expect(classifyMainRow(undefined).state).toBe("inherit");
		expect(classifyMainRow({}).state).toBe("inherit");
		for (const c of [classifyMainRow({ defaultModel: "m" }), classifyMainRow(undefined)]) {
			expect(c.isAlias).toBe(false);
			expect(c.disabledUpstream).toBe(false);
			expect(c.providerHits).toEqual([]);
			expect(c.projectProviderHits).toEqual([]);
		}
	});

	it("MAIN_ROW_NAME 是虚拟行名（不进白名单）", () => {
		expect(MAIN_ROW_NAME).toBe("main");
	});
});

describe("e 编辑器往返（§16.2.1）", () => {
	it("mainEntryForEditor 给三条真实键（所见即所得 = 将落盘的键）", () => {
		const { merged } = synthesizeMain({ project: { provider: "p", model: "m", thinkingLevel: "low" } });
		const draft = createDraft("main", merged, "main");
		expect(mainEntryForEditor(merged, draft, merged)).toEqual({ defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "low" });
	});

	it("reset 后 `e` 不再显示混合值（与显示/落盘同一口径）", () => {
		// 冒烟实测：reset 之后按 `e`，外部编辑器里是
		//   {"defaultProvider":"mimo","defaultModel":"opencode/exo-free","defaultThinkingLevel":"max"}
		// —— provider 是 reset 前的项目值、model/thinking 是冻结后的全局值。
		const { merged } = synthesizeMain({
			project: { provider: "mimo", model: "mimo-v2.6-flash", thinkingLevel: "minimal" },
			user: { provider: "ino2api", model: "opencode/exo-free", thinkingLevel: "max" },
		});
		const draft = createDraft("main", merged, "main");
		const user = mainLayerToOverride({ provider: "ino2api", model: "opencode/exo-free", thinkingLevel: "max" });
		draft.reset = true;
		const base = rowBaseOf({ merged, origin: { base: [], global: [] }, globalEntry: user, draft });
		expect(mainEntryForEditor(base, draft, merged)).toEqual({
			defaultProvider: "ino2api",
			defaultModel: "opencode/exo-free",
			defaultThinkingLevel: "max",
		});
	});

	it("applyMainEditedEntry 回填后 materializeRow 的结果等于编辑对象", () => {
		const { merged } = synthesizeMain({ project: { provider: "p", model: "m", thinkingLevel: "low" } });
		const draft = createDraft("main", merged, "main");
		applyMainEditedEntry(draft, { defaultProvider: "q", defaultModel: "m2", defaultThinkingLevel: "high" });
		expect(draft.touched).toEqual(new Set(["model", "thinking"]));
		expect(materializeRow(merged, draft)).toEqual({ defaultProvider: "q", defaultModel: "m2", defaultThinkingLevel: "high" });
	});

	it("删掉的键 = 显式清空（touched + undefined ⇒ 不写入）", () => {
		const { merged } = synthesizeMain({ project: { provider: "p", model: "m", thinkingLevel: "low" } });
		const draft = createDraft("main", merged, "main");
		applyMainEditedEntry(draft, { defaultProvider: "p" });
		expect(materializeRow(merged, draft)).toEqual({ defaultProvider: "p" });
	});
});

describe("mainAuthWarning（§16.2.1）", () => {
	it("无 provider / 无查询句柄 ⇒ 无警告", () => {
		expect(mainAuthWarning(undefined, () => ({ configured: false }))).toBeUndefined();
		expect(mainAuthWarning("", () => ({ configured: false }))).toBeUndefined();
		expect(mainAuthWarning("p", undefined)).toBeUndefined();
	});

	it("有凭证 ⇒ 无警告；无凭证 ⇒ 英文警告串", () => {
		expect(mainAuthWarning("p", () => ({ configured: true }))).toBeUndefined();
		const warning = mainAuthWarning("p", () => ({ configured: false }));
		expect(warning).toContain("p");
		expect(warning).toContain("no configured credentials");
	});

	it("查询抛错 ⇒ 不误报", () => {
		expect(
			mainAuthWarning("p", () => {
				throw new Error("boom");
			}),
		).toBeUndefined();
	});
});

describe("main 行的 state 三值（mergeStateOf 天然可用）", () => {
	function mainRowOf(input: Parameters<typeof synthesizeMain>[0]) {
		const { merged, origin } = synthesizeMain(input);
		return { merged, origin, draft: createDraft("main", merged, "main") };
	}

	it("全部来自全局 ⇒ GLOBAL；全部来自项目 ⇒ OVERRIDE；混合 ⇒ MERGE", () => {
		expect(rowMergeState(mainRowOf({ user: { model: "u/m" } }))).toBe("GLOBAL");
		expect(rowMergeState(mainRowOf({ project: { model: "p/m" } }))).toBe("OVERRIDE");
		expect(rowMergeState(mainRowOf({ project: { model: "p/m" }, user: { thinkingLevel: "high" } }))).toBe("MERGE");
	});
});
