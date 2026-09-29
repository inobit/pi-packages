import { describe, expect, it } from "vitest";
import {
	isKnownField,
	isSafeProfileName,
	KNOWN_FIELDS,
	normalizeProfileName,
	THINKING_LEVELS,
	validateAgentOverrides,
	validateOverrideEntry,
	validateProfileAgentOverrides,
} from "../src/validate.ts";

describe("白名单", () => {
	it("恰好 26 个官方字段", () => {
		expect(KNOWN_FIELDS).toHaveLength(26);
	});

	it("包含全部 §6.6 列出的字段", () => {
		for (const field of [
			"description",
			"output",
			"outputMode",
			"model",
			"fast",
			"thinking",
			"systemPromptMode",
			"inheritProjectContext",
			"inheritGlobalContext",
			"inheritSkills",
			"defaultContext",
			"acceptanceRole",
			"disabled",
			"toolBudget",
			"systemPrompt",
			"machine",
			"defaultReads",
			"defaultProvider",
			"skills",
			"tools",
			"excludeTools",
			"allowNestedSubagents",
			"allowedAgents",
			"extensions",
			"subagentOnlyExtensions",
			"mutationTools",
		]) {
			expect(isKnownField(field)).toBe(true);
		}
		expect(isKnownField("fallbackModels")).toBe(false);
		expect(isKnownField("thinkingg")).toBe(false);
	});
});

describe("未知 key → 警告（可写回）", () => {
	it("thinkingg 产生警告而非错误", () => {
		const result = validateOverrideEntry("reviewer", { thinkingg: "high" });
		expect(result.errors).toEqual([]);
		expect(result.warnings.join("\n")).toContain("thinkingg");
		expect(result.warnings.join("\n")).toContain("silently dropped");
	});

	it("未知键是条目唯一键时，警告额外写明整条会消失", () => {
		const result = validateOverrideEntry("reviewer", { thinkingg: "high" });
		expect(result.warnings.join("\n")).toContain("only key");
	});

	it("未知键与已知键共存时不再提『整条消失』", () => {
		const result = validateOverrideEntry("reviewer", { thinkingg: "high", model: "p/m" });
		expect(result.warnings.join("\n")).not.toContain("only key");
	});
});

describe("已知字段非法值 → 拒绝（会让整个项目 discovery 抛错）", () => {
	const rejected: [string, unknown][] = [
		["outputMode", "x"],
		["model", null],
		["model", 123],
		["thinking", 123],
		["thinking", true],
		["fallbackModels", ["a"]],
		["fast", "yes"],
		["systemPromptMode", "nope"],
		["inheritProjectContext", 1],
		["inheritSkills", "true"],
		["defaultContext", "merge"],
		["acceptanceRole", "reviewer"],
		["disabled", "true"],
		["toolBudget", 5],
		["systemPrompt", ["x"]],
		["machine", ""],
		["machine", 12],
		["defaultProvider", ""],
		["skills", "one"],
		["skills", [1]],
		["tools", "everything"],
		["tools", [2]],
		["excludeTools", {}],
		["allowNestedSubagents", "no"],
		["allowedAgents", "scout"],
		["extensions", 1],
		["subagentOnlyExtensions", "x"],
		["mutationTools", {}],
		["description", 5],
		["output", 5],
	];
	for (const [field, value] of rejected) {
		it(`${field}: ${JSON.stringify(value)}`, () => {
			const result = validateOverrideEntry("reviewer", { [field]: value });
			expect(result.errors.length).toBeGreaterThan(0);
		});
	}

	it("null 一律拒绝（上游走 typeof 判定落到 else 分支）", () => {
		for (const field of KNOWN_FIELDS) {
			const result = validateOverrideEntry("reviewer", { [field]: null });
			expect(result.errors.length, `field ${field}`).toBeGreaterThan(0);
		}
	});

	it("未知 key 的 null ⇒ 警告而非拒绝（上游不读未知键，不会抛错）", () => {
		const result = validateOverrideEntry("reviewer", { unknown: null });
		expect(result.errors).toEqual([]);
		expect(result.warnings.join("\n")).toContain("Unknown field 'unknown'");
		// 已知字段与未知 key 混在一起时，null 仍然拒绝
		const mixed = validateOverrideEntry("reviewer", { tools: null, unknown: null });
		expect(mixed.errors.length).toBe(1);
		expect(mixed.warnings.length).toBe(1);
	});

	it("条目本身非对象 → 拒绝", () => {
		expect(validateOverrideEntry("reviewer", "x").errors.length).toBeGreaterThan(0);
		expect(validateOverrideEntry("reviewer", []).errors.length).toBeGreaterThan(0);
		expect(validateOverrideEntry("reviewer", null).errors.length).toBeGreaterThan(0);
	});
});

describe("thinking 非档位字符串 → 拒绝（上游放行但会拼进模型串）", () => {
	it("turbo 被拒", () => {
		const result = validateOverrideEntry("reviewer", { thinking: "turbo" });
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors.join("\n")).toContain("turbo");
	});

	it("全部 7 个已知档位放行，false 也放行", () => {
		for (const level of THINKING_LEVELS) {
			expect(validateOverrideEntry("reviewer", { thinking: level }).errors).toEqual([]);
		}
		expect(validateOverrideEntry("reviewer", { thinking: false }).errors).toEqual([]);
	});
});

describe("空串逐字段判定（§6.6）", () => {
	it('systemPrompt:"" 放行（上游只判 typeof === string）', () => {
		expect(validateOverrideEntry("reviewer", { systemPrompt: "" }).errors).toEqual([]);
	});

	it('description:"" / output:"" / defaultProvider:"" / thinking:"" 拒绝', () => {
		expect(validateOverrideEntry("reviewer", { description: "" }).errors.length).toBeGreaterThan(0);
		expect(validateOverrideEntry("reviewer", { output: "" }).errors.length).toBeGreaterThan(0);
		expect(validateOverrideEntry("reviewer", { defaultProvider: "" }).errors.length).toBeGreaterThan(0);
		expect(validateOverrideEntry("reviewer", { thinking: "" }).errors.length).toBeGreaterThan(0);
	});

	it('thinking:"" 的错误文案点明它既不是 inherit 也不是档位', () => {
		const result = validateOverrideEntry("reviewer", { thinking: "" });
		expect(result.errors.join("\n")).toContain("neither inherit nor a level");
	});

	it("空白串同样按非空串规则拒绝", () => {
		expect(validateOverrideEntry("reviewer", { description: "   " }).errors.length).toBeGreaterThan(0);
		expect(validateOverrideEntry("reviewer", { output: "  " }).errors.length).toBeGreaterThan(0);
	});
});

describe("合法边界值通过", () => {
	it('tools:false / tools:"inherit" / tools:数组', () => {
		expect(validateOverrideEntry("a", { tools: false }).errors).toEqual([]);
		expect(validateOverrideEntry("a", { tools: "inherit" }).errors).toEqual([]);
		expect(validateOverrideEntry("a", { tools: ["read", "bash"] }).errors).toEqual([]);
	});

	it("defaultContext:false / acceptanceRole:false / machine:false / toolBudget:false", () => {
		expect(validateOverrideEntry("a", { defaultContext: false }).errors).toEqual([]);
		expect(validateOverrideEntry("a", { acceptanceRole: false }).errors).toEqual([]);
		expect(validateOverrideEntry("a", { machine: false }).errors).toEqual([]);
		expect(validateOverrideEntry("a", { toolBudget: false }).errors).toEqual([]);
	});

	it("model:false 在项目 settings 侧合法（agents.js:1171-1177）", () => {
		expect(validateOverrideEntry("a", { model: false }).errors).toEqual([]);
	});

	it("machine 的长度与控制字符约束", () => {
		expect(validateOverrideEntry("a", { machine: "x".repeat(128) }).errors).toEqual([]);
		expect(validateOverrideEntry("a", { machine: "x".repeat(129) }).errors.length).toBeGreaterThan(0);
		expect(validateOverrideEntry("a", { machine: "a\u0001b" }).errors.length).toBeGreaterThan(0);
	});

	it("全部合法取值组合一次性通过", () => {
		const result = validateOverrideEntry("reviewer", {
			description: "d",
			output: "o",
			outputMode: "file-only",
			model: "p/m",
			fast: false,
			thinking: "max",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritGlobalContext: true,
			inheritSkills: false,
			defaultContext: "fresh",
			acceptanceRole: "read-only",
			disabled: true,
			toolBudget: { maxCalls: 1 },
			systemPrompt: "",
			machine: "runner",
			defaultReads: ["a"],
			defaultProvider: "u",
			skills: ["s"],
			tools: "inherit",
			excludeTools: ["w"],
			allowNestedSubagents: false,
			allowedAgents: ["scout"],
			extensions: false,
			subagentOnlyExtensions: false,
			mutationTools: false,
		});
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});
});

describe("validateAgentOverrides / profile 附加规则", () => {
	it("顶层非对象 → 拒绝", () => {
		expect(validateAgentOverrides([]).errors.length).toBeGreaterThan(0);
		expect(validateAgentOverrides("x").errors.length).toBeGreaterThan(0);
		expect(validateAgentOverrides(undefined).errors.length).toBeGreaterThan(0);
	});

	it("逐条聚合 errors 与 warnings", () => {
		const result = validateAgentOverrides({ a: { model: 1 }, b: { zzz: 1 } });
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("profile 侧 model 必须是 string（model:false 在 profile 侧非法）", () => {
		expect(validateProfileAgentOverrides({ a: { model: false } }).errors.length).toBeGreaterThan(0);
		expect(validateProfileAgentOverrides({ a: { model: "p/m" } }).errors).toEqual([]);
		// 项目 settings 侧仍接受 model:false
		expect(validateOverrideEntry("a", { model: false }).errors).toEqual([]);
	});
});

describe("profile 名归一化与校验（SAFE_PATH_TOKEN）", () => {
	it("剥掉尾部 .json", () => {
		expect(normalizeProfileName("work.json")).toBe("work");
		expect(normalizeProfileName("  work.json  ")).toBe("work");
		expect(normalizeProfileName("work")).toBe("work");
		expect(normalizeProfileName("a.b.json")).toBe("a.b");
	});

	it("只允许 ^[A-Za-z0-9][A-Za-z0-9._-]*$", () => {
		for (const ok of ["work", "W1", "a.b-c_d", "0", "x.json"]) {
			expect(isSafeProfileName(normalizeProfileName(ok)), ok).toBe(true);
		}
		for (const bad of ["", ".", "..", "a/b", "a\\b", "-lead", "has space", "a:b"]) {
			expect(isSafeProfileName(normalizeProfileName(bad)), bad).toBe(false);
		}
	});
});
