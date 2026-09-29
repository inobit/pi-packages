/**
 * @inobit/pi-subagent-presets — 会话装配：读三层 settings → 判行状态 → 算显示值。
 *
 * 纯逻辑 + 注入的上游句柄，不 import pi（pi 类型只在 `index.ts` 里出现），
 * 所以本模块可被单测直接驱动。
 */

import { loadConfig, type PresetsConfig } from "./config.ts";
import { resolveProjectRoot, type ProjectRootResolution } from "./context.ts";
import { createDraft, rowBaseOf, synthesizeDetailed, type FieldOrigin, type Override } from "./merge.ts";
import { classifyRow, detectBulkFlags, type BulkFlag, type RowClassification } from "./rowstate.ts";
import { readDefaultProfile, readProfile, readProjectLayer, readUserLayer, type ProviderOverrideMap, type SettingsLayer } from "./settings-io.ts";
import { checkCeiling } from "./thinking.ts";
import { locateModel, type ModelLike, type ModelRegistryLike, type ScopedModelLike } from "./models.ts";
import type { UpstreamAgent, UpstreamModule } from "./upstream.ts";
import type { MatrixRowView } from "./tui/matrix.ts";

export interface UpstreamDiscovery {
	module?: UpstreamModule;
	fourBucketAgents?: UpstreamAgent[];
	/**
	 * `discoverAgents` 的 effective 基准值。
	 *
	 * ⚠️ 用途已收窄为 `maxThinking` 上限与 provider 消歧（`agent.modelProvider`），
	 * **不再**用来取 model / thinking 的显示基准值——基底两层都没有该字段时就该显示
	 * 空白，而不是显示定义层的值（那会让人误以为那是"配好的"）。
	 */
	baselineAgents?: UpstreamAgent[];
	/** 上游存在但 discovery 抛错（情形 ⑤ ⇒ 红条）。 */
	error?: string;
	version?: string;
	root?: string;
}

export interface SessionInputs {
	cwd: string;
	agentDir: string;
	trusted: boolean;
	/** `--from <name>`（已 normalize）。 */
	fromProfile?: string | undefined;
}

export interface SessionState {
	projectRoot: ProjectRootResolution;
	projectPath: string;
	projectLayer: SettingsLayer;
	userLayer: SettingsLayer;
	whitelist: string[];
	rows: RowEntry[];
	bulkFlags: BulkFlag[];
	/** L0 降级提示（黄条）。 */
	notices: string[];
	/** 红条（上游抛错 / settings 语法错误）。 */
	errors: string[];
	fromProfileActive: boolean;
	/**
	 * `--from` 指定了但 profile 非法（§11 用例 12）⇒ 调用方必须**红条并终止**，
	 * 不得带着替代基底（项目现有配置）进矩阵。
	 */
	fromProfileRejected: boolean;
	/** 基底 ①/② 的来源，保存后用它重算每行的合并基底。 */
	baseSources: {
		fromProfile?: Record<string, unknown> | undefined;
		defaultProfile?: Record<string, unknown> | undefined;
	};
}

export interface RowEntry {
	name: string;
	classification: RowClassification;
	merged: Override;
	/** 逐字段来源（`state` 列判定用）。 */
	origin: FieldOrigin;
	/** 全局层同名条目（`r` reset 后基底冻结为只取它）。 */
	globalEntry?: Override;
	projectEntry?: Override;
	fromEntry?: Override;
	draft: ReturnType<typeof createDraft>;
}

/**
 * 一行的基底 ①（§3.1 第一步），**同时产出逐字段来源**。
 *
 * ⚠️ 入参是**整张 profile 映射**（`{ [agentName]: Override }`），因为
 * `fromProfile` / `defaultProfile` 都是 profile 文件里的 `agentOverrides`；
 * 落到本行时取 `name` 对应的那一条。
 *
 * `--from <name>` 只是指定**用哪个 profile 当模板**（占用 default profile 那个槽位），
 * **不改变优先级**：项目现有条目始终优先。优先级由 `synthesizeDetailed` 统一实现
 * （`base0 = fromProfile ?? projectEntry ?? defaultProfile`），本函数不做任何特判。
 */
export function baseEntryFor(
	name: string,
	state: {
		fromProfile?: Record<string, unknown> | undefined;
		projectEntry?: Override | undefined;
		defaultProfile?: Record<string, unknown> | undefined;
		/** ② 全局 `~/.pi/agent/settings.json` 的同名条目（恒参与合并）。 */
		userEntry?: Override | undefined;
	},
): { merged: Override; origin: FieldOrigin } {
	const fromEntry = state.fromProfile ? asOverride(state.fromProfile[name]) : undefined;
	const defaultEntry = state.defaultProfile ? asOverride(state.defaultProfile[name]) : undefined;
	return synthesizeDetailed({
		...(fromEntry ? { fromProfile: fromEntry } : {}),
		...(state.projectEntry ? { projectEntry: state.projectEntry } : {}),
		...(defaultEntry ? { defaultProfile: defaultEntry } : {}),
		...(state.userEntry ? { userEntry: state.userEntry } : {}),
	});
}

/** `noUncheckedIndexedAccess` 下索引结果是 `unknown`；profile 条目必须是非数组对象。 */
function asOverride(value: unknown): Override | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Override) : undefined;
}

/**
 * 装配一次会话（不含 TUI）。
 *
 * 合并优先级（§5）：① = 项目现有条目 ?? 模板（`--from` 指定的 profile，否则 default profile）
 * ——**项目现有配置始终优先**，`--from` 只决定模板槽位用哪个 profile。
 * ② 恒为全局 `~/.pi/agent/settings.json`。
 */
export function buildSession(inputs: SessionInputs, discovery: UpstreamDiscovery, config?: PresetsConfig): SessionState {
	const notices: string[] = [];
	const errors: string[] = [];

	const userLayer = readUserLayer(inputs.agentDir);
	if (userLayer.error) errors.push(userLayer.error);

	const projectRoot = resolveProjectRoot(
		inputs.cwd,
		discovery.module?.findConfiguredProjectRoot
			? (cwd: string) => (discovery.module as UpstreamModule).findConfiguredProjectRoot!(cwd)
			: undefined,
	);
	if (projectRoot.warning) notices.push(projectRoot.warning);

	const projectLayer = readProjectLayer(projectRoot.root);
	if (projectLayer.error) errors.push(projectLayer.error);

	const settings = config ?? loadConfig(inputs.cwd, { trusted: inputs.trusted });
	const whitelist = settings.agents;

	const defaultProfile = readDefaultProfile(inputs.agentDir);
	let fromProfile: Record<string, unknown> | undefined;
	let fromProfileRejected = false;
	if (inputs.fromProfile) {
		const profile = readProfile(inputs.fromProfile, inputs.agentDir);
		if (!profile) {
			errors.push(`Profile not found: ${inputs.fromProfile}`);
			fromProfileRejected = true;
		} else if (profile.errors.length > 0) {
			// §11 用例 12：非法 ⇒ 红条并拒绝合并（调用方必须终止，不得回落项目配置）
			errors.push(...profile.errors);
			fromProfileRejected = true;
		} else {
			fromProfile = profile.agentOverrides;
		}
	}

	// 两条提示互相独立：装上但抛错（情形 ⑤）要红条，没装才是黄条
	if (discovery.error) {
		errors.push(`pi-subagents discovery failed: ${discovery.error}`);
	} else if (!discovery.module) {
		notices.push("pi-subagents not detected — degraded mode: row state is not classified and the maxThinking ceiling comes from settings");
	}
	if (projectRoot.tier === "cwd" && !discovery.module) {
		notices.push(
			"pi-subagents not detected, writing to cwd/<config dir>; if the upstream project root differs, re-run afterwards",
		);
	}

	const bulkFlags = detectBulkFlags(projectLayer.subagents, userLayer.subagents);
	const userProviderMap: ProviderOverrideMap = userLayer.subagents.agentOverridesByProvider;
	const projectProviderMap: ProviderOverrideMap = projectLayer.subagents.agentOverridesByProvider;

	const rows: RowEntry[] = whitelist.map((name) => {
		const projectEntry = projectLayer.subagents.agentOverrides[name];
		const globalEntry = userLayer.subagents.agentOverrides[name];
		const classification = classifyRow({
			name,
			projectEntry,
			// 全局条目也参与“我们自己配的禁用 / 上游禁用”的判定
			...(globalEntry ? { userEntry: globalEntry } : {}),
			userProviderMap,
			projectProviderMap,
			fourBucketAgents: discovery.fourBucketAgents,
			resolveAgentName: discovery.module?.resolveAgentName
				? (n, agents) => (discovery.module as UpstreamModule).resolveAgentName!(n, agents)
				: undefined,
		});
		const { merged, origin } = baseEntryFor(name, {
			fromProfile,
			projectEntry,
			defaultProfile,
			userEntry: globalEntry,
		});
		// `noUncheckedIndexedAccess` 下 `fromProfile[name]` 是 `unknown`；条目必为对象才能算模板
		const rawFromEntry: unknown = fromProfile ? fromProfile[name] : undefined;
		const fromEntryOverride: Override | undefined = asOverride(rawFromEntry);
		return {
			name,
			classification,
			merged,
			origin,
			...(globalEntry ? { globalEntry } : {}),
			...(projectEntry ? { projectEntry } : {}),
			...(fromEntryOverride ? { fromEntry: fromEntryOverride } : {}),
			draft: createDraft(name, merged),
		};
	});

	return {
		projectRoot,
		projectPath: projectLayer.settingsPath,
		projectLayer,
		userLayer,
		whitelist,
		rows,
		bulkFlags,
		notices,
		errors,
		fromProfileActive: inputs.fromProfile !== undefined && !fromProfileRejected,
		fromProfileRejected,
		baseSources: { fromProfile, defaultProfile },
	};
}

/**
 * 保存后的状态转移：重读项目层，并按**新**的项目条目重算每行的合并基底与草稿。
 *
 * 不重算的话基底会停留在旧项目条目上，导致「保存后接着改 `e`」的 dirty 判定
 * 拿错了参照（连续两次保存可能因此不幂等）。
 */
export function resetAfterSave(session: SessionState): void {
	const fresh = readProjectLayer(session.projectRoot.root);
	session.projectLayer = fresh;
	for (const row of session.rows) {
		row.projectEntry = fresh.subagents.agentOverrides[row.name];
		row.globalEntry = session.userLayer.subagents.agentOverrides[row.name];
		const next = baseEntryFor(row.name, {
			fromProfile: session.baseSources.fromProfile,
			defaultProfile: session.baseSources.defaultProfile,
			projectEntry: row.projectEntry,
			userEntry: row.globalEntry,
		});
		row.merged = next.merged;
		row.origin = next.origin;
		// 草稿回到「未触碰」态：extra 重置为新基底的深拷贝
		row.draft = createDraft(row.name, row.merged);
	}
}

export interface ViewSources {
	models: readonly (Record<string, unknown> & { id: string; provider: string })[];
	registry: ModelRegistryLike;
	scopedModels: readonly ScopedModelLike[];
	/** `ctx.model?.provider`。 */
	parentProvider?: string | undefined;
	/** 顶层 `subagents.maxThinking`（L0 自读：项目 ?? 全局）。 */
	maxThinking?: string | undefined;
}

/**
 * 显示值（§3.5）。
 *
 * 输入 = 合并基底 ∪ 草稿（touched 的键用草稿值替换）。**基底两层都没有该字段时就显示
 * 真正的空白**，不再回落到 `discoverAgents` 的解析值——那是定义层的值，读它只是为了让
 * 屏幕不空，而显示它会让人误以为那是"配好的"（用户其实没配过）。
 *
 * `discoverAgents` 仍提供 `maxThinking` 上限与 `agent.modelProvider`（provider 消歧）；
 * clamp 需要的 Model 对象由 modelRef 定位得到，不手算上游回落链。
 */
export function buildRowViews(
	rows: RowEntry[],
	discovery: UpstreamDiscovery,
	sources: ViewSources,
): MatrixRowView[] {
	const byName = new Map<string, UpstreamAgent>();
	for (const agent of discovery.baselineAgents ?? []) byName.set(agent.name, agent);

	return rows.map((row) => buildView(row, sources, byName.get(row.name)));
}

/** 一行在当前草稿下的完整显示视图（按过 `r` 且未再改时基底只取全局层）。 */
function buildView(row: RowEntry, sources: ViewSources, baseline: UpstreamAgent | undefined): MatrixRowView {
	const base = rowBaseOf(row);
	const maxThinking = baseline?.maxThinking ?? sources.maxThinking;
	const provider = baseline?.modelProvider ?? sources.parentProvider;
	const modelRef = modelRefOf(base, row.draft);
	const located = modelRef ? locateModel({ registry: sources.registry, models: sources.models, modelRef, provider }) : undefined;
	const model = located?.model;
	const thinking = thinkingViewOf(base, row.draft, model, located?.thinkingSuffix, maxThinking);
	return {
		name: row.name,
		classification: row.classification,
		draft: row.draft,
		merged: row.merged,
		origin: row.origin,
		...(row.globalEntry ? { globalEntry: row.globalEntry } : {}),
		locatedModel: model,
		maxThinking,
		fullModelText: modelRef ?? "",
		modelText: modelTextOf(base, row.draft, row.globalEntry),
		modelUnresolved: modelUnresolved(modelRef, model, base, row.draft),
		thinkingText: thinking.text,
		thinkingValue: thinking.value,
		overCeiling: thinking.over,
		carriedKeys: Object.keys(base).filter((k) => k !== "model" && k !== "thinking"),
		editWarnings: [],
	};
}

/**
 * 待显示的 model 串：touched 优先，其次合并基底。
 *
 * `"inherit"`（选择器里的 Follow parent session model）与 `false` 语义相同，都是“跟随
 * 父会话模型”——**不是** registry 里的模型 id，所以不当成可定位的串（否则会印成
 * `inherit (not in registry)`）。
 */
function modelRefOf(base: Override, draft: RowEntry["draft"]): string | undefined {
	if (draft.touched.has("model")) {
		const draftModel = draft.model;
		if (typeof draftModel === "string") return draftModel === "inherit" ? undefined : draftModel;
		// 在 `e` 里删掉了 `model` 键（选择器不提供删键项）。
		// ⚠️ **不能**回落到全局值：对 builtin agent，项目条目一旦存在就是**整体替换**
		//   （`applyBuiltinOverrides` 直接 return，全局条目不参与），全局 model 不会生效。
		//   同 `modelTextOf`：显示空白最诚实。
		return undefined;
	}
	return normalizeModelRef(base.model);
}

/** `"inherit"` / `false` 不是 registry 里的模型 id ⇒ 不能拿去定位（否则会印成 `not in registry`）。 */
function normalizeModelRef(value: unknown): string | undefined {
	return typeof value === "string" && value !== "inherit" ? value : undefined;
}

/**
 * 显示用的 model 串（含 `"inherit"` 这种“跟随父会话”的配过值）。
 * 取**运行期真正生效**的那个；`e` 里删掉 `model` 键时显示空白（不是全局值）。
 */
function modelTextOf(base: Override, draft: RowEntry["draft"], globalEntry: Override | undefined): string {
	if (draft.touched.has("model")) {
		const draftModel = draft.model;
		if (draftModel === "inherit" || draftModel === false) return "inherit";
		if (draftModel === undefined) {
			// 在 `e` 里删掉了 `model` 键（选择器已不提供 `None`）。
			// ⚠️ **不能**显示全局值：对 builtin agent，项目条目一旦存在就是**整体替换**
			//   （`applyBuiltinOverrides` 直接 return，全局条目不参与），全局 model 不会生效。
			//   显示真正的空白最诚实（“这一行不写 model”）；运行期会落到
			//   定义 → subagents.defaultModel → 父会话模型。
			return "";
		}
	}
	if (base.model === "inherit" || base.model === false) return "inherit";
	const ref = normalizeModelRef(base.model);
	return ref ?? "";
}

/** `noUncheckedIndexedAccess` / 结构化类型下统一用这个别名便于传参。 */
type LocatedModelValue = ModelLike & Record<string, unknown>;

function thinkingViewOf(
	base: Override,
	draft: RowEntry["draft"],
	model: LocatedModelValue | undefined,
	thinkingSuffix: string | undefined,
	maxThinking: string | undefined,
): { text: string; value: string; over: boolean } {
	const draftThinking = draft.touched.has("thinking") ? draft.thinking : undefined;
	const requested =
		(typeof draftThinking === "string" ? draftThinking : undefined) ??
		(typeof base.thinking === "string" ? base.thinking : base.thinking === false ? "off" : undefined);
	// 没有值 ⇒ 真正的空白（不印 `inherit` / `—`）
	// `value` = 空串 ⇒ 循环时 `indexOf("")` 为 -1 ⇒ 从 `levels[0]` 开始（与 pi 一致）
	if (requested === undefined) return { text: "", value: "", over: false };
	// 生效档位（去掉标注）：后缀 > clamp 后 > 原始。`shift+tab` 循环必须用**它**，
	// 不能用 `text`（那是带标注的显示串，`indexOf` 永远 -1 ⇒ 循环卡死在第一档）。
	const value = buildThinkingText(requested, model, thinkingSuffix).replace(/ \(cannot clamp\)$/, "");
	return { text: buildThinkingText(requested, model, thinkingSuffix), value, over: checkCeiling(requested, model, maxThinking).over };
}


/** model 串在当前 registry 里定位不到（⇒ 无法夹取 thinking、无法校验 ceiling）。 */
function modelUnresolved(
	modelRef: string | undefined,
	model: LocatedModelValue | undefined,
	base: Override,
	draft: RowEntry["draft"],
): boolean {
	if (modelRef === undefined) return false;
	return model === undefined;
}

function buildThinkingText(requested: string, model: LocatedModelValue | undefined, suffix: string | undefined): string {
	// model 串上的 `:level` 后缀优先于 thinking 字段
	if (suffix) return suffix.slice(1);
	// 模型可解析 ⇒ 显示**实际会跑**的档位（clamp 后）。
	// ⚠️ 不可解析时**不再**追加 ` (cannot clamp)` 标注：它既占列宽又读不懂；
	//   “无法夹取/校验上限”由矩阵顶部提示用中文说，thinking 单元格只给档位本身。
	if (!model) return requested;
	return checkCeiling(requested, model, undefined).clamped;
}

/** 重新计算一行在草稿改动后的显示值（脏行必须重算，否则连按 shift+tab 看不到变化）。 */
export function refreshRowView(view: MatrixRowView, row: RowEntry, sources: ViewSources, baseline: UpstreamAgent | undefined): MatrixRowView {
	// `e` 回填产生的警告跟着草稿走（重算会新建视图对象）
	return { ...buildView(row, sources, baseline), editWarnings: view.editWarnings };
}
