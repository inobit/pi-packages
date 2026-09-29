import { describe, expect, it } from "vitest";
import { fullModelId, listModels, locateModel, refreshModels, splitProviderId, type ModelRegistryLike, type ScopedModelLike } from "../src/models.ts";

const A = { id: "a", provider: "ino2api", reasoning: true };
const B = { id: "b", provider: "cline", reasoning: false };
const SAME_ID = { id: "shared", provider: "ino2api", reasoning: true };
const OTHER_SAME_ID = { id: "shared", provider: "cline", reasoning: true };

function registry(available: unknown[] = [A, B, SAME_ID, OTHER_SAME_ID]): ModelRegistryLike {
	return {
		getAvailable: () => available as never,
		find: (provider, modelId) => available.find((m) => (m as { provider: string }).provider === provider && (m as { id: string }).id === modelId) as never,
	};
}

describe("listModels（§3.4：/model 口径优先）", () => {
	it("scopedModels 非空时优先", () => {
		const scoped: ScopedModelLike[] = [{ model: A as never }];
		expect(listModels({ scopedModels: scoped, registry: registry() })).toEqual([A]);
	});

	it("scopedModels 为空时回落 getAvailable()", () => {
		const all = registry();
		expect(listModels({ scopedModels: [], registry: all })).toEqual(all.getAvailable());
	});

	it("scopedModels 里带 thinkingLevel 的条目也只取 model", () => {
		const scoped: ScopedModelLike[] = [{ model: A as never, thinkingLevel: "high" }];
		expect(listModels({ scopedModels: scoped, registry: registry() })).toEqual([A]);
	});
});

describe("fullModelId", () => {
	it("provider/id", () => {
		expect(fullModelId({ provider: "p", id: "m" })).toBe("p/m");
		// model id 本身可以含斜杠，拼接不歧义（按第一个斜杠切分）
		expect(fullModelId({ provider: "ino2api", id: "opencode/muse" })).toBe("ino2api/opencode/muse");
	});
});

describe("locateModel（剥后缀 → provider 定位）", () => {
	it("先剥已知 :level 后缀再查 registry", () => {
		const located = locateModel({ registry: registry(), models: [A, B], modelRef: "ino2api/a:high", provider: "ino2api" });
		expect(located?.baseModel).toBe("ino2api/a");
		expect(located?.thinkingSuffix).toBe(":high");
		expect(located?.model).toEqual(A);
	});

	it("未知后缀 :turbo 不剥（剥了会损坏 registry.find），整串当模型名", () => {
		const turbo = { id: "a:turbo", provider: "ino2api", reasoning: true };
		const r = registry([turbo]);
		const located = locateModel({ registry: r, models: [turbo], modelRef: "ino2api/a:turbo", provider: "ino2api" });
		expect(located?.baseModel).toBe("ino2api/a:turbo");
		expect(located?.thinkingSuffix).toBe("");
		expect(located?.model).toEqual(turbo);
	});

	it("provider 已知时优先该 provider 的同名模型（裸 id 消歧）", () => {
		const located = locateModel({ registry: registry(), models: [SAME_ID, OTHER_SAME_ID], modelRef: "shared", provider: "cline" });
		expect(located?.model).toEqual(OTHER_SAME_ID);
	});

	it("provider 未知且全表唯一命中 ⇒ 定位成功", () => {
		const located = locateModel({ registry: { getAvailable: () => [] }, models: [B], modelRef: "cline/b", provider: undefined });
		expect(located?.model).toEqual(B);
	});

	it("provider 未知且多个同名 ⇒ 定位失败（由显示层标注 ⚠ 无法夹取）", () => {
		const located = locateModel({ registry: { getAvailable: () => [] }, models: [SAME_ID, OTHER_SAME_ID], modelRef: "shared", provider: undefined });
		expect(located?.model).toBeUndefined();
	});

	it("模型已下线 ⇒ 保留原值并标注，不静默替换", () => {
		const located = locateModel({ registry: registry(), models: [A], modelRef: "gone/model", provider: "gone" });
		expect(located?.baseModel).toBe("gone/model");
		expect(located?.model).toBeUndefined();
	});

	it("modelRef 为 undefined ⇒ undefined", () => {
		expect(locateModel({ registry: registry(), models: [A], modelRef: undefined, provider: "ino2api" })).toBeUndefined();
	});

	it("modelRef 为空串 ⇒ undefined（不当作 '' 去找）", () => {
		expect(locateModel({ registry: registry(), models: [A], modelRef: "", provider: "ino2api" })).toBeUndefined();
	});

	it("也接受已经是完整 id（provider/id）的 model 串", () => {
		const located = locateModel({ registry: { getAvailable: () => [] }, models: [A], modelRef: "ino2api/a", provider: undefined });
		expect(located?.model).toEqual(A);
	});

	it("model 串自带的 provider 优先于环境里的父会话 provider", () => {
		// 父会话是 openrouter，override 写的是 ino2api/a ⇒ 必须按 ino2api 定位
		const located = locateModel({
			registry: { getAvailable: () => [], find: (p, i) => (p === "ino2api" && i === "a" ? A : undefined) },
			models: [A],
			modelRef: "ino2api/a",
			provider: "openrouter",
		});
		expect(located?.model).toEqual(A);
	});

	it("id 本身含斜杠时只拆第一个斜杠", () => {
		const deep = { id: "cline/stealth/space-bunny-alpha", provider: "ino2api", reasoning: true };
		const r: ModelRegistryLike = {
			getAvailable: () => [],
			find: (p, i) => (p === "ino2api" && i === "cline/stealth/space-bunny-alpha" ? deep : undefined),
		};
		const located = locateModel({ registry: r, models: [deep], modelRef: "ino2api/cline/stealth/space-bunny-alpha", provider: "openrouter" });
		expect(located?.model).toEqual(deep);
		expect(splitProviderId("ino2api/cline/stealth/space-bunny-alpha")).toEqual({
			provider: "ino2api",
			id: "cline/stealth/space-bunny-alpha",
		});
	});

	it("无斜杠 / 空段 ⇒ undefined（不硬拆）", () => {
		expect(splitProviderId("a")).toBeUndefined();
		expect(splitProviderId("/a")).toBeUndefined();
		expect(splitProviderId("a/")).toBeUndefined();
	});
});

describe("refreshModels（失败只 warning，绝不阻断）", () => {
	it("无 refresh 方法 ⇒ 返回 undefined", async () => {
		expect(await refreshModels({ getAvailable: () => [] })).toBeUndefined();
	});

	it("成功 ⇒ undefined", async () => {
		const r: ModelRegistryLike = { getAvailable: () => [], refresh: async () => ({}) };
		expect(await refreshModels(r)).toBeUndefined();
	});

	it("抛错 ⇒ 返回消息，不抛", async () => {
		const r: ModelRegistryLike = {
			getAvailable: () => [],
			refresh: async () => {
				throw new Error("network down");
			},
		};
		expect(await refreshModels(r)).toBe("network down");
	});

	it("allowNetwork:false + 超时 signal 是本扩展的固定口径", async () => {
		let seen: unknown;
		const r: ModelRegistryLike = {
			getAvailable: () => [],
			refresh: async (options) => {
				seen = options;
				return {};
			},
		};
		await refreshModels(r);
		expect(seen).toMatchObject({ allowNetwork: false });
		expect((seen as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
	});
});
