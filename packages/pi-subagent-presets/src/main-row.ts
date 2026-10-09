/**
 * @inobit/pi-subagent-presets — main 虚拟行的纯逻辑（§16.2.1）。
 *
 * main 行只在矩阵里表示"主 agent"，核心是改顶层那 3 个键（§16.0 决策 1）：
 * **不进 `agentOverrides`、不进白名单、不是 agent**。
 * 本模块是**纯函数**，不 import pi，只吃裸 JSON。
 */

import { deepCloneOverride, materializeRow, storageKeysOf, type Draft, type FieldOrigin, type Override } from "./merge.ts";
import type { RowClassification } from "./rowstate.ts";

/** main 行的显示名（虚拟行，不是 agent，不进白名单）。 */
export const MAIN_ROW_NAME = "main";

/** 落盘对象的三个真实键。 */
export const MAIN_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;
export type MainKey = (typeof MAIN_KEYS)[number];

/** 一层 settings 里的 main 三键（裸 JSON，已剔除非法类型）。 */
export interface MainLayer {
	provider?: string | undefined;
	model?: string | undefined;
	thinkingLevel?: string | undefined;
}

export interface MainBaseInput {
	/** `--from` 模板（优先级最高）。 */
	fromProfile?: MainLayer | undefined;
	/** 项目 `.pi/settings.json`。 */
	project?: MainLayer | undefined;
	/** 全局 `~/.pi/agent/settings.json`。 */
	user?: MainLayer | undefined;
}

/** `MainLayer` 短键到落盘真实键名的映射。 */
const LAYER_TO_STORAGE: Record<keyof Required<MainLayer>, MainKey> = {
	provider: "defaultProvider",
	model: "defaultModel",
	thinkingLevel: "defaultThinkingLevel",
};

/**
 * 逐键合并：`fromProfile` ▸ `project` ▸ `user`（§16.0 决策 3 的"逐键"落地）。
 *
 * `merged` 的键就是三条真实键名；`origin.base` = 值来自 `fromProfile` 或 `project`
 * 的键，`origin.global` = 只在 `user` 里出现的键。这让 `state` 三值判定
 * （`merge.ts` 的 `mergeStateOf`）对 main 天然可用。
 */
export function synthesizeMain(input: MainBaseInput): { merged: Override; origin: FieldOrigin } {
	const layers: (MainLayer | undefined)[] = [input.fromProfile, input.project, input.user];
	const merged: Override = {};
	const origin: FieldOrigin = { base: [], global: [] };
	for (const shortKey of Object.keys(LAYER_TO_STORAGE) as (keyof Required<MainLayer>)[]) {
		const storageKey = LAYER_TO_STORAGE[shortKey];
		for (let i = 0; i < layers.length; i++) {
			const value = layers[i]?.[shortKey];
			// 缺省（undefined）不算命中，继续往下一层回落
			if (value === undefined) continue;
			merged[storageKey] = value;
			// 第 0/1 层命中 ⇒ base 侧，第 2 层（user）⇒ global 侧
			(i <= 1 ? origin.base : origin.global).push(storageKey);
			break;
		}
	}
	return { merged, origin };
}

/**
 * 从一层 settings 对象读三键（`defaultProvider` / `defaultModel` / `defaultThinkingLevel`）。
 * 非字符串一律剔除（裸 JSON 的非法类型不进合并）。
 */
export function readMainLayer(settings: Record<string, unknown>): MainLayer {
	const out: MainLayer = {};
	const provider = settings.defaultProvider;
	const model = settings.defaultModel;
	const thinkingLevel = settings.defaultThinkingLevel;
	if (typeof provider === "string") out.provider = provider;
	if (typeof model === "string") out.model = model;
	if (typeof thinkingLevel === "string") out.thinkingLevel = thinkingLevel;
	return out;
}

/** 把 `MainLayer` 归一化成落盘形状的 `Override`（三条真实键，缺省不出现）。 */
export function mainLayerToOverride(layer: MainLayer | undefined): Override {
	if (!layer) return {};
	const out: Override = {};
	if (layer.provider !== undefined) out.defaultProvider = layer.provider;
	if (layer.model !== undefined) out.defaultModel = layer.model;
	if (layer.thinkingLevel !== undefined) out.defaultThinkingLevel = layer.thinkingLevel;
	return out;
}

/**
 * 显示用的 model 串：`provider` 有值 ⇒ `${provider}/${model}`，否则裸 id。
 * 输入是"将写入的基底 + 草稿"，取值口径与落盘一致（`materializeRow`）。
 */
/**
 * main 行落盘/显示**共用**的条目解析（单一口径）。
 *
 * = `materializeRow(base, draft)`，外加一条 provider 规则：
 * **用户没改过 provider（相对草稿原基底）⇒ 用基底值**，否则用草稿值。
 *
 * 起因（冒烟实测）：`r` reset 把基底冻结为只取全局层，但 `draft.extra.defaultProvider`
 * 里还留着 reset **前**的项目值，`applyDraft` 会把它盖回冻结基底 ⇒ 拼出
 * “项目 provider + 全局 model id”这种**任何层都不存在的混合值**，显示错、写盘也错。
 * agent 行没这个问题——它的 `model`/`thinking` 是矩阵键，`applyDraft` 只在 `touched` 时改写；
 * main 的 provider 藏在 `extra` 里，必须显式判“用户到底改没改”。
 *
 * @param base 该行**当前**基底（reset 后是冻结的全局层，否则是合并基底）
 * @param draft 草稿
 * @param originalBase 草稿的**原合并基底**（`row.merged`），判“改没改”的参照
 */
export function resolveMainEntry(base: Override, draft: Draft, originalBase: Override): Override {
	const after = materializeRow(deepCloneOverride(base), draft);
	const originalProvider = originalBase.defaultProvider;
	const draftProvider = draft.extra.defaultProvider;
	const userChanged =
		(draftProvider === undefined) !== (originalProvider === undefined) ||
		(draftProvider !== undefined && draftProvider !== originalProvider);
	if (userChanged) {
		if (draftProvider === undefined) delete after.defaultProvider;
		else after.defaultProvider = draftProvider;
	} else if ("defaultProvider" in base) {
		after.defaultProvider = base.defaultProvider;
	} else {
		delete after.defaultProvider;
	}
	return after;
}

/**
 * 显示用的 model 串：`provider` 有值 ⇒ `${provider}/${model}`，否则裸 id。
 * 解析口径与落盘一致（`resolveMainEntry`）——两者必须是同一个函数的结果。
 */
export function mainModelText(base: Override, draft: Draft, originalBase: Override): string {
	const after = resolveMainEntry(base, draft, originalBase);
	const model = after.defaultModel;
	if (typeof model !== "string" || model === "") return "";
	const provider = after.defaultProvider;
	if (typeof provider === "string" && provider !== "") return `${provider}/${model}`;
	return model;
}

/** main 行的行分类：恒可编辑（无 provider 作用域 / 上游概念）。 */
export function classifyMainRow(projectEntry: Override | undefined): RowClassification {
	const hasEntry = projectEntry !== undefined && Object.keys(projectEntry).length > 0;
	return {
		state: hasEntry ? "project" : "inherit",
		isAlias: false,
		disabledByOverride: false,
		disabledUpstream: false,
		providerHits: [],
		bulkFlags: [],
		projectProviderHits: [],
	};
}

/**
 * `e` 编辑器内容：三条真实键（所见即所得 = 将落盘的键）。
 * 只取三键投影——main 行不写其它键（`validateProfileMain` 对其它顶层键只警告）。
 */
export function mainEntryForEditor(base: Override, draft: Draft, originalBase: Override): Override {
	const after = resolveMainEntry(base, draft, originalBase);
	const out: Override = {};
	for (const key of MAIN_KEYS) {
		if (key in after) out[key] = after[key];
	}
	return out;
}

/**
 * `e` 回填：整条三键同步进草稿（`defaultModel` / `defaultThinkingLevel` 标 touched）。
 * 缺省的键 = 显式清空（touched + undefined ⇒ 删键）；`defaultProvider` 进 extra。
 */
export function applyMainEditedEntry(draft: Draft, entry: Override): void {
	const storage = storageKeysOf("main");
	draft.model = storage.model in entry ? entry[storage.model] : undefined;
	draft.thinking = storage.thinking in entry ? entry[storage.thinking] : undefined;
	draft.touched.add("model");
	draft.touched.add("thinking");
	const extra: Override = {};
	for (const [k, v] of Object.entries(entry)) {
		if (k === storage.model || k === storage.thinking) continue;
		extra[k] = v;
	}
	draft.extra = extra;
}

/**
 * provider 是否有凭证（无凭证 ⇒ pi 启动时静默忽略这条默认值，§16.0 调研结论）。
 * 无 provider / 无查询句柄 ⇒ 无警告；有 provider 且明确无凭证 ⇒ 英文警告串。
 */
export function mainAuthWarning(
	provider: string | undefined,
	getAuthStatus: ((p: string) => { configured: boolean }) | undefined,
): string | undefined {
	if (provider === undefined || provider === "" || getAuthStatus === undefined) return undefined;
	let status: { configured: boolean };
	try {
		status = getAuthStatus(provider);
	} catch {
		// 查询失败 ⇒ 不误报
		return undefined;
	}
	if (status.configured === false) return `main: provider "${provider}" has no configured credentials — pi will ignore this default`;
	return undefined;
}
