/**
 * @inobit/pi-subagent-presets — 五种行状态判定（§4.1）+ 两条"不物化"保护（§3.1）。
 *
 * 纯函数：不依赖 pi / pi-ai / 上游模块对象，只吃 `discoverAgentsAll` 四桶的
 * 归一化结果与 settings 的裸 JSON，所以测试可以完全注入 fake。
 */

import { providerScopedHits, type UpstreamAgent } from "./upstream.ts";
import type { ProviderOverrideMap } from "./settings-io.ts";

/**
 * 行分类状态（**不是** `state` 列）。
 * - `unmerged` = 有 provider 条件层，**不物化**但保持现状
 * - `unresolved` = 上游已无（`MISSING`）**或**上游已禁用（`disabledUpstream`）：
 *   行为完全一致——不可编辑、不写盘、整行变暗；仅标记不同
 * - `project` / `inherit` = 正常行，按项目条目是否存在
 *
 * ⚠ `已禁用` **不是**一个状态：它来自 override 层的 `disabled: true`，记在
 * `RowClassification.disabledByOverride` 上（名字后缀，**可编辑**）。
 * ⚠ 矩阵 `state` 列的三个值是另一回事（`merge.ts` 的 `MergeState`）：
 * `GLOBAL` / `MERGE` / `OVERRIDE`，由**将写入对象的逐字段来源**实时计算。
 */
export type RowState = "project" | "inherit" | "unmerged" | "unresolved";

export interface RowContext {
	/** 白名单内的 canonical name（已 trim）。 */
	name: string;
	/** 项目现有条目（可能 undefined）。 */
	projectEntry?: Record<string, unknown> | undefined;
	/** 全局同名条目（`disabled` 标记的唯一来源之一；可能 undefined）。 */
	userEntry?: Record<string, unknown> | undefined;
	/** 全局 `agentOverridesByProvider`（裸 JSON，L0 也要判）。 */
	userProviderMap: ProviderOverrideMap;
	/** `discoverAgentsAll` 四桶的**并集**（L0 时 undefined ⇒ 不判灰 / 别名 / 禁用）。 */
	fourBucketAgents?: UpstreamAgent[] | undefined;
	/** 上游 `resolveAgentName`（L0 时 undefined）。 */
	resolveAgentName?: ((name: string, agents: UpstreamAgent[]) => { agent?: UpstreamAgent; error?: string }) | undefined;
	/** 项目侧 `agentOverridesByProvider`（提示用，不阻止）。 */
	projectProviderMap?: ProviderOverrideMap | undefined;
}

export interface RowClassification {
	state: RowState;
	/** `resolveAgentName` 解析到别的 canonical name ⇒ 别名键永远无效，绝不落盘。 */
	isAlias: boolean;
	/** 别名指向的 canonical name（`isAlias` 为 true 时有值）。 */
	aliasOf?: string;
	/**
	 * `disabled: true` 来自 override 层（项目 / 全局条目）——我们自己配的禁用。
	 * 名字后缀 `已禁用`，**可编辑**（改成 `false` 即启用）；定义层的 disabled 不读。
	 */
	disabledByOverride: boolean;
	/**
	 * **上游**禁用：四桶里存在但 `disabled === true`，且我们的合并结果里没有 `disabled`。
	 * 行为与 `MISSING` 完全一致（不可编辑 / 不写盘 / 整行变暗），仅标记不同
	 * （`⚠ 上游已禁用` vs `⚠上游已无` 且 `MISSING` 另加删除线）。
	 */
	disabledUpstream: boolean;
	/** 保护一命中的 provider 名（`state === "unmerged"` 时非空）。 */
	providerHits: string[];
	/** 保护二：顶层 bulk 开关（不阻止写入，但黄条 + 二次确认）。 */
	bulkFlags: BulkFlag[];
	/** 项目侧 provider 条件层命中的 provider（提示用）。 */
	projectProviderHits: string[];
	/** 解析错误（歧义名等）——灰行的一种成因。 */
	resolveError?: string;
}

export interface BulkFlag {
	/** `disableThinking` 或 `disableBuiltins`。 */
	key: "disableThinking" | "disableBuiltins";
	scope: "project" | "user";
}

/**
 * §3.1 保护二：项目或全局任一为 true 即算（`projectFlag || userFlag`）。
 *
 * 判据是严格的 `=== true`，与上游 `readSubagentSettings` 的口径一致——`"yes"` / `1`
 * 这类真值不算（settings-io 已经把它们归一化成布尔，但本函数作为公开判定也要守住）。
 */
export function detectBulkFlags(
	project: { disableThinking?: unknown; disableBuiltins?: unknown },
	user: { disableThinking?: unknown; disableBuiltins?: unknown },
): BulkFlag[] {
	const flags: BulkFlag[] = [];
	for (const key of ["disableThinking", "disableBuiltins"] as const) {
		if (project[key] === true) flags.push({ key, scope: "project" });
		if (user[key] === true) flags.push({ key, scope: "user" });
	}
	return flags;
}

function nonEmptyEntry(entry: Record<string, unknown> | undefined): boolean {
	return entry !== undefined && Object.keys(entry).length > 0;
}

/**
 * 判定一行。
 *
 * 优先级（从硬到软）：
 * 1. provider 条件层（保护一）⇒ `unmerged`：**不物化但保持现状**（§7.1 的 keep existing）
 * 2. 别名键 ⇒ `isAlias`：**绝不落盘**
 * 3. 上游四桶里都没有 ⇒ 灰行（`unresolved`）：照算照显示，但下次保存会被清理
 * 4. **override 层**（项目条目 / 全局条目）的 `disabled === true` ⇒ `disabled`：
 *    可改（改成 `false` 即启用）
 * 5. 否则按项目条目是否存在标 `project` / `inherit`（仅供诊断，`state` 列不读它）
 *
 * ⚠️ 灰行判定查**四桶**而非 effective 列表：后者过滤了 `disabled`，
 * 会把用户故意禁用的 agent 当死键删掉。
 *
 * ⚠️ `disabled` **只看 override 层**（项目 / 全局条目里的 `disabled: true`），
 * 不读定义层 `agents/*.md` 的 `disabled`（那与"基底两层"是同一原则：不把定义层
 * 当成"配好的"）。`subagents.disableBuiltins` 属顶层批量开关，只参与保护二的警告。
 */
export function classifyRow(ctx: RowContext): RowClassification {
	const userHits = providerScopedHits(ctx.name, ctx.userProviderMap ?? {});
	const projectHits = providerScopedHits(ctx.name, ctx.projectProviderMap ?? {});
	const base: RowClassification = {
		state: "inherit",
		isAlias: false,
		disabledByOverride: false,
		disabledUpstream: false,
		providerHits: userHits,
		bulkFlags: [],
		projectProviderHits: projectHits,
	};

	// 保护一优先于一切：命中即整行不物化（含别名行——别名的项目条目本就是垃圾）
	if (userHits.length > 0) return { ...base, state: "unmerged" };

	// 四桶里按 canonical name 找到的那一条（上游更老的版本没有 resolveAgentName 时也用它）
	const upstreamAgent = ctx.fourBucketAgents?.find((agent) => agent.name === ctx.name);

	if (ctx.fourBucketAgents) {
		if (ctx.resolveAgentName) {
			const result = ctx.resolveAgentName(ctx.name, ctx.fourBucketAgents);
			if (!result.agent) {
				return { ...base, state: "unresolved", ...(result.error ? { resolveError: result.error } : {}) };
			}
			if (result.agent.name !== ctx.name) {
				return { ...base, state: nonEmptyEntry(ctx.projectEntry) ? "project" : "inherit", isAlias: true, aliasOf: result.agent.name };
			}
		} else if (!upstreamAgent) {
			// 没有 resolveAgentName（上游更老）时退化为直接按 canonical name 找
			return { ...base, state: "unresolved" };
		}
	}

	// override 层的 disabled：我们自己配的禁用（可改成 false 重新启用）。
	// 口径与“合并结果”一致：项目条存在时它就是基底 ①，全局只补它没写的键。
	const projectHasDisabled = ctx.projectEntry !== undefined && "disabled" in ctx.projectEntry;
	const userHasDisabled = ctx.userEntry !== undefined && "disabled" in ctx.userEntry;
	const effectiveDisabled = projectHasDisabled ? ctx.projectEntry?.disabled : ctx.userEntry?.disabled;
	if (effectiveDisabled === true) {
		return { ...base, state: nonEmptyEntry(ctx.projectEntry) ? "project" : "inherit", disabledByOverride: true };
	}
	// 上游禁用 + 我们的合并结果里**没有** `disabled` ⇒ 行为与 MISSING 完全一致
	// （写了 `disabled: false` 就不算“没有”，用户就是这样重新启用它的）
	if (!projectHasDisabled && !userHasDisabled && upstreamAgent?.disabled === true) {
		return { ...base, state: "unresolved", disabledUpstream: true };
	}
	if (nonEmptyEntry(ctx.projectEntry)) return { ...base, state: "project" };
	return { ...base, state: "inherit" };
}

/**
 * 行级特殊态的**就地表达**：标记挂在 agent 名上，不进 `state` 列
 * （`state` 列只有 `GLOBAL` / `MERGE` / `OVERRIDE` 三个值）。
 *
 * - override 层 `disabled: true` ⇒ `已禁用`（可改、可 `r`）
 * - `unmerged` ⇒ `🔒 provider 作用域`（不可改、不可 `r`）
 * - `unresolved`（上游已无）⇒ `⚠上游已无`（另加删除线 + 整行变暗）
 * - `unresolved` + `disabledUpstream`（上游已禁用）⇒ `⚠ 上游已禁用`
 *   （行为同上，但**不加删除线**——agent 还在，只是被上游禁用了）
 *
 * ⚠ 按过 `r`（reset）**不渲染任何标记**：reset 之后 `state` 就是 `GLOBAL`，与
 * "本来就没有项目配置"的行在结果上完全一致，用户视角不需要区分。取消 reset 的
 * 用户路径是“改任意字段”，`r` 在 `GLOBAL` 行上一律警告"无意义"。
 */
export function rowSuffixOf(classification: {
	state: RowState;
	disabledByOverride: boolean;
	disabledUpstream?: boolean;
	isAlias?: boolean;
	aliasOf?: string;
}): string {
	// 行级**状态**用紧凑标记就地表达（不写散文提示——提示归 pi 的通知区）
	if (classification.isAlias) return classification.aliasOf ? ` =${classification.aliasOf}` : " =alias";
	if (classification.state === "unmerged") return " 🔒";
	if (classification.state === "unresolved") return classification.disabledUpstream ? " ⚠UPSTREAM DISABLED" : " ⚠MISSING";
	if (classification.disabledByOverride) return " DISABLED";
	return "";
}

/** agent 单元格的纯文本（含行级后缀），列宽按它的长度分配。 */
export function agentCellText(
	name: string,
	classification: { state: RowState; disabledByOverride: boolean; disabledUpstream?: boolean; isAlias?: boolean; aliasOf?: string },
): string {
	return `${name}${rowSuffixOf(classification)}`;
}

/** `MISSING`（上游已无）才加删除线；上游已禁用仍是一行正常的名字。 */
export function isStruckThrough(classification: { state: RowState; disabledUpstream?: boolean }): boolean {
	return classification.state === "unresolved" && classification.disabledUpstream !== true;
}

/** 该行是否可改（灰行 / 上游已禁用 / 不可合并 / 别名行一律只读）。 */
export function isEditable(state: RowState, isAlias: boolean): boolean {
	return state !== "unresolved" && state !== "unmerged" && !isAlias;
}

