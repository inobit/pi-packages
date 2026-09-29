/**
 * @inobit/pi-subagent-presets — 模型列表与 provider 定位（§3.4、§3.5）。
 *
 * 模型列表取 `/model` 的口径（`ctx.scopedModels`，受 `enabledModels` / `--models`
 * 约束），为空才回落 `getAvailable()`——比上游 `/subagents` 面板更严格，
 * 避免配出用不了的模型。
 *
 * provider 定位用 `agent.modelProvider ?? ctx.model?.provider`：顶层
 * `subagents.defaultProvider` 会被上游注入到 `agent.modelProvider`，裸 id 靠它消歧。
 */

import type { ModelLike } from "./thinking.ts";

export type { ModelLike };
import { splitKnownThinkingSuffix } from "./thinking.ts";

/** `ctx.scopedModels` 的最小结构。 */
export interface ScopedModelLike {
	model: ModelLike & Record<string, unknown>;
	thinkingLevel?: string;
}

/** `ctx.modelRegistry` 的最小结构（测试可传鸭子类型）。 */
export interface ModelRegistryLike {
	getAvailable: () => (ModelLike & Record<string, unknown>)[];
	find?: (provider: string, modelId: string) => (ModelLike & Record<string, unknown>) | undefined;
	refresh?: (options?: unknown) => Promise<unknown>;
}

export interface ModelListSources {
	scopedModels: readonly ScopedModelLike[];
	registry: ModelRegistryLike;
}

/** `scopedModels` 非空时优先，空时回落 `getAvailable()`。 */
export function listModels(sources: ModelListSources): (ModelLike & Record<string, unknown>)[] {
	if (sources.scopedModels.length > 0) return sources.scopedModels.map((entry) => entry.model);
	return sources.registry.getAvailable();
}

/** 打开选择器前刷新一次可用模型；失败 / 超时只 warning，不阻断。 */
export const REFRESH_TIMEOUT_MS = 5_000;

export async function refreshModels(registry: ModelRegistryLike): Promise<string | undefined> {
	if (typeof registry.refresh !== "function") return undefined;
	try {
		await registry.refresh({ allowNetwork: false, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
		return undefined;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

/** 模型的完整 id（`provider/modelId`），与 UI 展示与写盘一致。 */
export function fullModelId(model: Pick<ModelLike, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export interface LocateModelOptions {
	registry: ModelRegistryLike;
	models: readonly (ModelLike & Record<string, unknown>)[];
	/** 待定位的 model 串（可能带 `:level` 后缀）。 */
	modelRef: string | undefined;
	/** `agent.modelProvider ?? ctx.model?.provider`。 */
	provider: string | undefined;
}

export interface LocatedModel {
	/** 剥掉已知 `:level` 后缀后的 base id。 */
	baseModel: string;
	/** 剥下来的后缀（含冒号），无则空串。 */
	thinkingSuffix: string;
	model?: ModelLike & Record<string, unknown>;
}

/**
 * 剥 `:level` 后缀 → 用 provider 定位 registry Model。
 *
 * ⚠️ 只剥**已知**档位：`:turbo` 这类未知后缀整体视为模型名的一部分，剥了会损坏
 * `registry.find`。定位失败返回 `model: undefined`，由显示层标注 `⚠ 无法夹取`。
 */
export function locateModel(opts: LocateModelOptions): LocatedModel | undefined {
	if (!opts.modelRef) return undefined;
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(opts.modelRef);
	const located: LocatedModel = { baseModel, thinkingSuffix };

	// model 串本身就带 provider 时优先用它：环境里的父会话 provider 可能是另一个
	// provider（例：父会话是 openrouter，而 override 写的是 ino2api/...）
	const own = splitProviderId(baseModel);
	const providerCandidates = [own?.provider, opts.provider].filter((p): p is string => Boolean(p));
	const idCandidates = own ? [own.id, baseModel] : [baseModel];

	for (const provider of providerCandidates) {
		if (typeof opts.registry.find !== "function") break;
		for (const id of idCandidates) {
			const hit = opts.registry.find(provider, id);
			if (hit) return { ...located, model: hit };
		}
	}
	// 裸 id 消歧：provider 已知时优先该 provider 的同名模型，否则全表里唯一命中才算
	const matches = opts.models.filter((model) => model.id === baseModel || fullModelId(model) === baseModel);
	for (const provider of providerCandidates) {
		const preferred = matches.find((model) => model.provider === provider);
		if (preferred) return { ...located, model: preferred };
	}
	if (matches.length === 1) return { ...located, model: matches[0] };
	return located;
}

/**
 * 把 `provider/id` 拆成两段。
 *
 * 只拆**第一个**斜杠：model id 本身可以含斜杠（`ino2api/cline/stealth/space-bunny-alpha`
 * 的 id 是 `cline/stealth/space-bunny-alpha`），所以 `provider` 是首段、其余全是 id。
 */
export function splitProviderId(modelRef: string): { provider: string; id: string } | undefined {
	const slash = modelRef.indexOf("/");
	if (slash <= 0 || slash === modelRef.length - 1) return undefined;
	return { provider: modelRef.slice(0, slash), id: modelRef.slice(slash + 1) };
}
