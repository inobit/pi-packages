/**
 * @inobit/pi-subagent-presets — thinking 后缀 / 档位 / clamp / ceiling（§3.4、§3.5、§3.6）。
 *
 * 统一用 **pi-ai 版** `getSupportedThinkingLevels`（与子会话内 pi 的 `/thinking` 同源）。
 * 它与上游自己那份（`shared/model-info.js:65-81`）的差异是有意的：
 * - 无 `thinkingLevelMap`：pi-ai 5 档 / 上游 6 档（多 `xhigh`）
 * - `reasoning` 缺失（falsy 但非 `false`）：pi-ai `["off"]` / 上游 6 档
 * - `reasoning === false`：两者都 `["off"]`
 *
 * 另：pi-ai 版对 `model === undefined` 抛 `TypeError`（`model.reasoning` 解引用），
 * 所以本模块**一律先判空再调函数**。
 *
 * ⚠️ 唯一的例外是 `cycleThinkingLevel`：**没有 model 时**不看成"不可操作"，而是用
 * pi 默认全 7 档（见该函数的理由），只有 model 可解析但 `reasoning` falsy 才无操作。
 */

import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { THINKING_LEVELS } from "./validate.ts";

/** 与 `shared/model-info.js:38-49` 同口径的"只剥已知档位"后缀拆分。 */
export function splitKnownThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
	if (!suffix) return { baseModel: model, thinkingSuffix: "" };
	return { baseModel: model.substring(0, colonIdx), thinkingSuffix: `:${suffix}` };
}

/** registry Model 的最小结构（本模块只读这三个字段，测试可传鸭子类型）。 */
export interface ModelLike {
	id: string;
	provider: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null | undefined> | undefined;
}

/**
 * pi-ai 版档位表，**先判空**。
 * @returns `[]` 表示"模型不可解析"——调用方必须把它当作不可操作（§3.6），
 * 绝不能回退成 `["off"]` 再写回，那会把为已下线模型配的定制档覆盖成 off。
 */
export function supportedThinkingLevels(model: ModelLike | undefined | null): string[] {
	if (!model) return [];
	return [...getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0])];
}

/** clamp 到该模型支持的档位；模型不可解析时返回原始值（由显示层标注 ⚠ 无法夹取）。 */
export function clampToModel(model: ModelLike | undefined | null, level: string): string {
	if (!model) return level;
	return clampThinkingLevel(model as Parameters<typeof clampThinkingLevel>[0], level as never);
}

export interface CeilingCheck {
	/** 请求值（clamp 前的值）是否超出 `maxThinking`。 */
	over: boolean;
	/** 夹取后的实际生效值，供"实际会以 <值> 运行"的提示使用。 */
	clamped: string;
}

/**
 * `maxThinking` 是硬上限，且 `discoverAgents` **一律静默**（实测 `maxThinking=medium`
 * + `thinking=xhigh` ⇒ 返回 `thinking="xhigh"`, `maxThinking="medium"`），
 * 所以必须由本扩展在 UI 侧标注。
 *
 * 判定用**请求值**（clamp 前），与 `assertThinkingWithinCeiling` 的比较口径一致。
 */
export function checkCeiling(requested: string, model: ModelLike | undefined | null, maxThinking: string | undefined): CeilingCheck {
	const clamped = clampToModel(model, requested);
	if (!maxThinking) return { over: false, clamped };
	const reqIdx = THINKING_LEVELS.indexOf(requested);
	const maxIdx = THINKING_LEVELS.indexOf(maxThinking);
	if (reqIdx === -1 || maxIdx === -1) return { over: false, clamped };
	return { over: reqIdx > maxIdx, clamped };
}

export interface CycleResult {
	/** `undefined` 表示无操作（模型支持thinking 但无可用档位 / `reasoning` falsy）。 */
	level: string | undefined;
	reason?: string;
}

/**
 * `shift+tab` 的档位范围（§3.6 重定）。
 *
 * - 该行 model 可解析 ⇒ `getSupportedThinkingLevels(model)`
 * - **没有 model**（未配置 / 不在 registry）⇒ pi 默认全 7 档
 *
 * 后者对齐 pi 自己 `agent-session.js` 的 `THINKING_LEVEL_OPTIONS` 回落：没配 model
 * 不代表不能配 thinking（`delegate` / `evidence-auditor` 这类行就是这种情况）。
 */
export function cycleLevelsOf(model: ModelLike | undefined | null): string[] {
	return model ? supportedThinkingLevels(model) : [...THINKING_LEVELS];
}

/**
 * §3.6 `shift+tab` 环形切换。
 * - `current` 取显示值（clamp 后）；`indexOf` 为 -1 时从 `levels[0]` 开始
 * - 模型可解析但 `reasoning` falsy ⇒ 无操作（`model does not support thinking`）
 */
export function cycleThinkingLevel(current: string, model: ModelLike | undefined | null): CycleResult {
	if (model && !model.reasoning) return { level: undefined, reason: "Model does not support thinking" };
	const levels = cycleLevelsOf(model);
	if (levels.length === 0) return { level: undefined, reason: "No thinking levels available for this model" };
	const idx = levels.indexOf(current);
	const found = levels[(idx + 1) % levels.length];
	const next = found ?? levels[0] ?? "off";
	return { level: next };
}

/** 显示层：`agent.thinking === false`（只可能来自定义层）印 `off`。 */
export function displayThinkingOf(agentThinking: unknown): string | undefined {
	if (agentThinking === undefined) return undefined;
	if (agentThinking === false) return "off";
	if (typeof agentThinking === "string") return agentThinking;
	return undefined;
}
