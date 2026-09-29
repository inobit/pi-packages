import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { checkCeiling, clampToModel, cycleLevelsOf, cycleThinkingLevel, splitKnownThinkingSuffix, supportedThinkingLevels, type ModelLike } from "../src/thinking.ts";

/** 无 `thinkingLevelMap` 的 reasoning 模型。 */
const PLAIN: ModelLike = { id: "m", provider: "p", reasoning: true };
/** 显式定义 xhigh / max 的模型。 */
const MAPPED: ModelLike = {
	id: "m2",
	provider: "p",
	reasoning: true,
	thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
};
/** 显式把 medium 与 off 标为不支持。 */
const NO_MEDIUM: ModelLike = { id: "m3", provider: "p", reasoning: true, thinkingLevelMap: { medium: null, off: null } };
/** `reasoning: false` 的非推理模型。 */
const NON_REASONING: ModelLike = { id: "m4", provider: "p", reasoning: false };

describe("splitKnownThinkingSuffix（只剥已知档位）", () => {
	it("剥掉 7 个已知档位后缀", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(splitKnownThinkingSuffix(`p/m:${level}`)).toEqual({ baseModel: "p/m", thinkingSuffix: `:${level}` });
		}
	});

	it("未知后缀 :turbo 整体视为模型名的一部分（剥了会损坏 registry.find）", () => {
		expect(splitKnownThinkingSuffix("p/m:turbo")).toEqual({ baseModel: "p/m:turbo", thinkingSuffix: "" });
	});

	it("无冒号时原样返回", () => {
		expect(splitKnownThinkingSuffix("p/m")).toEqual({ baseModel: "p/m", thinkingSuffix: "" });
	});

	it("用最后一个冒号切分（model id 本身可以含冒号）", () => {
		expect(splitKnownThinkingSuffix("p/a:b:high")).toEqual({ baseModel: "p/a:b", thinkingSuffix: ":high" });
	});

	it("模型串为 falsy 时不抛", () => {
		expect(splitKnownThinkingSuffix("")).toEqual({ baseModel: "", thinkingSuffix: "" });
	});
});

describe("supportedThinkingLevels（pi-ai 版，先判空）", () => {
	it("undefined 不抛（pi-ai 对它会抛 TypeError），返回空数组表示『不可操作』", () => {
		expect(supportedThinkingLevels(undefined)).toEqual([]);
		expect(supportedThinkingLevels(null)).toEqual([]);
	});

	it("无 thinkingLevelMap → 5 档（上游自己那份是 6 档，多 xhigh）", () => {
		expect(supportedThinkingLevels(PLAIN)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it("reasoning falsy（含缺失）→ 仅 off", () => {
		expect(supportedThinkingLevels(NON_REASONING)).toEqual(["off"]);
		expect(supportedThinkingLevels({ id: "x", provider: "p" })).toEqual(["off"]);
	});

	it("显式定义时 xhigh / max 才出现", () => {
		expect(supportedThinkingLevels(MAPPED)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("值为 null 的档被剔除；xhigh / max 需显式定义才出现", () => {
		// NO_MEDIUM 的 map 里没有 xhigh / max 条目 ⇒ 它们不出现（pi-ai 口径）
		expect(supportedThinkingLevels(NO_MEDIUM)).toEqual(["minimal", "low", "high"]);
	});

	it("一致性记录：pi-ai 5 档 vs 上游 6 档（同输入不同口径，有意为之）", () => {
		// pi-ai：直接从 pi-ai 导出的那一份
		expect(getSupportedThinkingLevels(PLAIN as never)).toEqual(["off", "minimal", "low", "medium", "high"]);
		// 上游 shared/model-info.js 口径：无 map 时含 xhigh（6 档）
		const upstreamNoMap = ["off", "minimal", "low", "medium", "high", "xhigh"];
		expect(upstreamNoMap).toHaveLength(6);
		expect(supportedThinkingLevels(PLAIN)).not.toEqual(upstreamNoMap);
		// 两份在 reasoning === false 时一致
		expect(supportedThinkingLevels(NON_REASONING)).toEqual(["off"]);
	});
});

describe("clampToModel", () => {
	it("低于所有支持档 → 夹到最低可用（不是最高）", () => {
		// NO_MEDIUM 的最低可用档是 minimal（off 被标为 null）；请求 off ⇒ 夹到 minimal
		expect(clampToModel(NO_MEDIUM, "off")).toBe("minimal");
	});

	it("中间缺档时先向上找，再向下找（pi-ai 口径：先上后下）", () => {
		// NO_MEDIUM 不支持 medium：先向上找 high，命中
		expect(clampToModel(NO_MEDIUM, "medium")).toBe("high");
	});

	it("高于所有支持档 → 夹到最高可用", () => {
		expect(clampToModel(PLAIN, "max")).toBe("high");
		expect(clampToModel(NON_REASONING, "high")).toBe("off");
	});

	it("不在档位表里的值 → 夹到最低可用", () => {
		expect(clampToModel(PLAIN, "turbo")).toBe("off");
	});

	it("模型不可解析时原样返回（由显示层标注 ⚠ 无法夹取）", () => {
		expect(clampToModel(undefined, "high")).toBe("high");
		expect(clampToModel(null, "max")).toBe("max");
	});
});

describe("checkCeiling（用请求值，不是显示值）", () => {
	it("无 ceiling ⇒ 从不超限", () => {
		expect(checkCeiling("max", PLAIN, undefined).over).toBe(false);
		expect(checkCeiling("max", PLAIN, undefined).clamped).toBe("high");
	});

	it("请求值 <= ceiling ⇒ 不超限", () => {
		expect(checkCeiling("high", MAPPED, "high").over).toBe(false);
		expect(checkCeiling("low", MAPPED, "high").over).toBe(false);
	});

	it("请求值 > ceiling ⇒ 超限，并给出 clamp 后的实际值", () => {
		const result = checkCeiling("xhigh", MAPPED, "medium");
		expect(result.over).toBe(true);
		expect(result.clamped).toBe("xhigh");
		const clampedLow = checkCeiling("max", PLAIN, "medium");
		expect(clampedLow.over).toBe(true);
		expect(clampedLow.clamped).toBe("high");
	});

	it("非档位值不参与比较（不算超限）", () => {
		expect(checkCeiling("turbo", MAPPED, "off").over).toBe(false);
		expect(checkCeiling("high", MAPPED, "turbo").over).toBe(false);
	});

	it("未知 ceiling 值同样不判定", () => {
		expect(checkCeiling("max", MAPPED, "ludicrous").over).toBe(false);
	});
});

describe("cycleThinkingLevel（§3.6 环形）", () => {
	it("没有 model（未配置 / 不在 registry）⇒ 覆盖 pi 默认全 7 档", () => {
		expect(cycleLevelsOf(undefined)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(cycleLevelsOf(null)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

		// 全 7 档走一圈（起点用空串，indexOf = -1 ⇒ 从 levels[0] 开始）
		let current = "";
		const seen: string[] = [];
		for (let i = 0; i < 8; i++) {
			const next = cycleThinkingLevel(current, undefined);
			expect(next.level).toBeDefined();
			current = next.level as string;
			seen.push(current);
		}
		expect(seen).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max", "off"]);
	});

	it("有 model 时用 getSupportedThinkingLevels(model)，不用 pi 默认 7 档", () => {
		expect(cycleLevelsOf(PLAIN)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(cycleLevelsOf(MAPPED)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("reasoning falsy ⇒ 无操作（不把定制档覆盖成 off）", () => {
		const result = cycleThinkingLevel("off", NON_REASONING);
		expect(result.level).toBeUndefined();
		expect(result.reason).toContain("does not support thinking");
	});

	it("reasoning 缺失（falsy 但非 false）同样无操作", () => {
		expect(cycleThinkingLevel("off", { id: "x", provider: "p" }).level).toBeUndefined();
	});

	it("环形：off → minimal → … → high → off（5 档模型）", () => {
		let current = "off";
		const seen = [current];
		for (let i = 0; i < 4; i++) {
			const next = cycleThinkingLevel(current, PLAIN);
			expect(next.level).toBeDefined();
			current = next.level as string;
			seen.push(current);
		}
		expect(seen).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(cycleThinkingLevel("high", PLAIN).level).toBe("off");
	});

	it("indexOf 为 -1 时从 levels[0] 开始", () => {
		expect(cycleThinkingLevel("nonsense", PLAIN).level).toBe("off");
	});

	it("current 取显示值（clamp 后）：被夹到 high 后从 high 的下一档开始", () => {
		// NO_MEDIUM 支持 [minimal, low, high]，high 的下一档是 minimal（环绕）
		expect(supportedThinkingLevels(NO_MEDIUM)).toEqual(["minimal", "low", "high"]);
		expect(cycleThinkingLevel("high", NO_MEDIUM).level).toBe("minimal");
		// 用 7 档模型验证非环绕情形：high 的下一档是 xhigh
		expect(cycleThinkingLevel("high", MAPPED).level).toBe("xhigh");
	});

	it("7 档模型也正确环绕", () => {
		expect(cycleThinkingLevel("max", MAPPED).level).toBe("off");
	});
});
