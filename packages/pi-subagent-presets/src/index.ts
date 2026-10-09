/**
 * @inobit/pi-subagent-presets — 扩展入口：注册 `/subagent-presets` 并编排整条流程。
 *
 * 编排链：
 * 1. 解析 `--from <name>`
 * 2. 探测 pi-subagents（软依赖，三档降级，绝不阻断）
 * 3. 装配会话（读三层 settings + 判行状态 + 算显示值）
 * 4. 无 UI ⇒ 打印解析摘要后正常返回（与上游 `/subagents` 一致）
 * 5. 有 UI ⇒ `ctx.ui.custom` 打开矩阵；保存后清缓存 + 提示用 `/subagents-models` 复核
 *
 * 架构原则：我们只生成配置，pi-subagents 负责解释配置。不建模上游解析行为，
 * 唯一例外是 §3.1 的两条"不物化"保护。
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, DefaultPackageManager, getAgentDir, KeybindingsManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { buildCompletions } from "./completions.ts";
import { loadConfig } from "./config.ts";
import { applyConfigDirNameOverride, getProfilePath, getProjectSettingsPath } from "./context.ts";
import { runExternalEditorRound } from "./external-editor.ts";
import { listModels, locateModel, refreshModels, type ModelRegistryLike, type ScopedModelLike } from "./models.ts";
import { MAIN_ROW_NAME, mainAuthWarning, mainEntryForEditor } from "./main-row.ts";
import { deepCloneOverride, rowBaseOf, rowMaterialize, type Override } from "./merge.ts";
import {
	buildRowViews,
	buildSession,
	refreshRowView,
	resetAfterSave,
	type RowEntry,
	type SessionState,
	type UpstreamDiscovery,
	type ViewSources,
} from "./session.ts";
import { listProfileNames, readProfile, type SettingsLayer } from "./settings-io.ts";
import {
	callDiscoverAgents,
	callDiscoverAll,
	clearDiscoveryCache,
	detectUpstream,
	setPackageManagerProbe,
	UPSTREAM_PACKAGE,
	type UpstreamAgent,
	type UpstreamModule,
} from "./upstream.ts";
import { PresetsMatrix, type MatrixRowView } from "./tui/matrix.ts";
import type { SaveResult, SaveWarning } from "./tui/save-dialog.ts";
import { FIELD_GUIDE, isSafeProfileName, KNOWN_FIELDS, normalizeProfileName, overrideIssues, THINKING_LEVELS, type OverrideIssue, validateOverrideEntry, validateProfileMain } from "./validate.ts";
import { emptyMainPlan, planMain, planRebuild, profileSnapshot, writeProfile, writeProjectSettings, type CommitResult, type RebuildRowInput, type RebuildPlan } from "./writer.ts";

applyConfigDirNameOverride(CONFIG_DIR_NAME);

export const COMMAND_NAME = "subagent-presets";
export const DEFAULT_PROFILE_NAME = "default";

export interface ParsedArgs {
	from?: string;
	errors: string[];
}

/** `/subagent-presets [--from <profile>]`。 */
export function parseArgs(raw: string): ParsedArgs {
	const errors: string[] = [];
	const tokens = raw.trim().length > 0 ? raw.trim().split(/\s+/) : [];
	let from: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === undefined) continue;
		if (token === "--from") {
			const value = tokens[i + 1];
			if (value === undefined || value.startsWith("--")) {
				errors.push("--from requires a profile name");
				break;
			}
			from = normalizeProfileName(value);
			i++;
			continue;
		}
		if (token.startsWith("--from=")) {
			from = normalizeProfileName(token.slice("--from=".length));
			continue;
		}
		// 裸位置参数几乎总是“补全把 `--from` 吃掉了”的产物（pi 会用补全项的
		// `value` 整体替换参数前缀）。直接点名，比 “Unknown argument” 可操作得多。
		errors.push(`Unexpected argument '${token}': did you mean --from ${token}?`);
	}
	if (from !== undefined && !isSafeProfileName(from)) {
		errors.push(`Invalid profile name '${from}': must match ^[A-Za-z0-9][A-Za-z0-9._-]*$`);
	}
	return { ...(from !== undefined ? { from } : {}), errors };
}

function projectLabel(ctx: ExtensionCommandContext): string {
	return path.basename(ctx.cwd) || ctx.cwd;
}

function parentModelText(ctx: ExtensionCommandContext): string {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	if (!model?.provider || !model?.id) return "—";
	return `${model.provider}/${model.id}`;
}

function safeIsProjectTrusted(ctx: ExtensionCommandContext): boolean {
	try {
		return ctx.isProjectTrusted() === true;
	} catch {
		return false;
	}
}

/** 自定义消息类型：与上游 `/subagents` 的 admin 消息同一机制。 */
export const MESSAGE_TYPE = "pi-subagent-presets";

/**
 * 输出：**只发一次**。
 *
 * 之前 `pi.sendMessage` + `ctx.ui.notify` 两条都发，交互模式下同一条提示会渲染两遍
 * （一遍带 `[pi-subagent-presets]` 来源标签，一遍是 toast）。按“提示类归 pi”的
 * 原则，有 UI 时只走 `ctx.ui.notify`（pi 的通用提示区）。
 *
 * headless（print / RPC，`ui.notify` 是空实现）走 `pi.sendMessage`，
 * 这样 `-p` 下仍有输出；两条都不可用时最后退回 stdout。
 */
function emit(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		try {
			ctx.ui.notify(message, level);
			return;
		} catch {
			// 退回 sendMessage
		}
	}
	try {
		void pi.sendMessage({ customType: MESSAGE_TYPE, content: message, display: true });
		return;
	} catch {
		// 极老的宿主没有 sendMessage：退回 stdout
	}
	process.stdout.write(`${message}\n`);
}

/** 收集上游 discovery 结果；上游自身抛错时不崩，转 `error`（红条 + L0）。 */
export function collectDiscovery(module: UpstreamModule | undefined, cwd: string, provider: string | undefined): UpstreamDiscovery {
	if (!module) return {};
	const all = callDiscoverAll(module, cwd, provider);
	if (all.error) {
		// 情形 ⑤：装上、能加载，但 `discoverAgents` 自己抛错（根因通常是用户手改出非法值）
		return { module, error: all.error };
	}
	const baseline = callDiscoverAgents(module, cwd, provider) ?? all.effective;
	return { module, fourBucketAgents: all.all, baselineAgents: baseline };
}

/** L0 自读顶层 `subagents.maxThinking`（口径与 `resolveSubagentMaxThinking` 一致：项目 ?? 全局）。 */
export function readMaxThinking(projectLayer: SettingsLayer, userLayer: SettingsLayer): string | undefined {
	const read = (layer: SettingsLayer): string | undefined => {
		const value = (layer.settings.subagents as { maxThinking?: unknown } | undefined)?.maxThinking;
		return typeof value === "string" ? value : undefined;
	};
	return read(projectLayer) ?? read(userLayer);
}

function buildViewSources(ctx: ExtensionCommandContext, session: SessionState): ViewSources {
	const registry = ctx.modelRegistry as unknown as ModelRegistryLike;
	const scopedModels = (ctx.scopedModels ?? []) as unknown as readonly ScopedModelLike[];
	const models = listModels({ scopedModels, registry }) as (Record<string, unknown> & { id: string; provider: string })[];
	const maxThinking = readMaxThinking(session.projectLayer, session.userLayer);
	return {
		models,
		registry,
		scopedModels,
		parentProvider: (ctx.model as { provider?: string } | undefined)?.provider,
		...(maxThinking ? { maxThinking } : {}),
	};
}

/** L0 无 UI 摘要（与上游 `/subagents` 的 headless 行为一致）。main 行排在最前（`views` 首行即它）。 */
export function summaryLines(ctx: ExtensionCommandContext, session: SessionState, views: MatrixRowView[], fromProfileName?: string): string[] {
	const out: string[] = [];
	// §16.7：default profile 已移除。`--from` 激活写 `--from <profile>`，否则写 `project settings only`。
	out.push(
		`Subagent presets · ${projectLabel(ctx)} · base: ${session.fromProfileActive ? `--from ${fromProfileName ?? "profile"}` : "project settings only"}`,
	);
	out.push(`parent session model: ${parentModelText(ctx)}`);
	out.push("");
	for (const error of session.errors) out.push(`ERROR ${error}`);
	for (const notice of session.notices) out.push(`WARN  ${notice}`);
	if (session.errors.length > 0 || session.notices.length > 0) out.push("");
	out.push(`  ${"agent".padEnd(16)} ${"model".padEnd(38)} thinking`);
	for (const view of views) {
		// 没有值就是空白（与矩阵同一口径，不印 `—` 占位符）
		out.push(`  ${view.name.padEnd(16)} ${view.modelText.slice(0, 38).padEnd(38)} ${view.thinkingText}`);
	}
	if (session.bulkFlags.length > 0) {
		out.push("");
		for (const flag of session.bulkFlags) out.push(`WARN  subagents.${flag.key}=true (${flag.scope} scope)`);
	}
	out.push("");
	out.push("No changes were written (no interactive UI available).");
	return out;
}

/**
 * `e` 的注释头：带注释的**字段骨架模板**（每字段一行注释 + 值域提示）。
 *
 * 不再写“model / thinking 请在矩阵改”那套散文：`e` 现在编辑的就是**整条将写入的
 * 条目**，矩阵与 `e` 是同一份数据的两个视图，两边都能改。
 */
/**
 * 外部编辑器打开时的注释头。
 *
 * 刻意保持**短**：v1 曾经一行一个字段（26 行）+ 15 行说明 = 41 行注释对 3 行 JSON，
 * 信噪比太差。这里只保留“看不懂就会写错”的部分，完整字段值域表见包 README。
 */
export function jsonEditorHeader(agentName?: string): string {
	const who = agentName ? ` · agent "${agentName}"` : "";
	const lines: string[] = [
		`// subagent-presets${who} 的 override 条目 —— 将原样写入项目 settings`,
		"// 改任何字段都行（含 model / thinking，与矩阵是同一份草稿）。",
		"// 删键 = 这一行不写该字段：builtin 是按 agent 整体替换的，全局那个值不会补进来，",
		'//   运行期会落到 定义层 → subagents.defaultModel → 父会话模型（写 "inherit" ≠ 删键）。',
		"// 未知键会被静默丢弃；已知字段的非法值会让整个项目的 agent discovery 失败。",
		"// 字段一览：",
	];
	lines.push(...fieldTable());
	lines.push("// 枚举：");
	lines.push(
		`//   thinking=${THINKING_LEVELS.join("|")}|false`,
		"//   outputMode=inline|file-only",
		"//   systemPromptMode=append|replace",
		"//   defaultContext=fresh|fork|false",
		"//   acceptanceRole=read-only|writer|false",
		"//   model=false≡跟随父会话模型",
		"",
		"// 其他约束：systemPrompt 可为 \"\"；description / output / defaultProvider / machine 必须非空。",
		"// 完整值域见包 README",
		"",
	);
	return lines.join("\n");
}

/**
 * main 行的外部编辑器注释头（英文，§16.3.4）。
 *
 * 只讲三件事：这 3 个键原样写到 settings 顶层、下次启动生效、未 trust 不生效。
 */
export function jsonEditorHeaderMain(): string {
	return [
		"// main agent defaults — these 3 keys are written as-is to the top-level of the project settings",
		"// They apply on the next pi start in this project (resuming an old session keeps that session's model)",
		"// An untrusted project ignores the project settings entirely",
		"// Keys other than these three are ignored — only these three are written; invalid values only warn, never block saving",
		"",
	].join("\n");
}

/**
 * 字段一览：**4 列左对齐**，每格 `key: 中文说明`（裸键，不加 `{}`）。
 *
 * v1 是一行一个字段（26 行）+ 15 行散文 = 41 行注释对 3 行 JSON；
 * v2 折成 4 行纯字段名（丢了说明）；现在是 7 行 4 列，信息密度合适。
 */
/** 每个字段的**短标签**（≤ 6 字），用于 `e` 里的 4 列表格。 */
const FIELD_LABELS: Record<string, string> = {
	description: "描述",
	output: "输出契约",
	outputMode: "回传方式",
	model: "provider/id",
	fast: "更快启动",
	thinking: "档位",
	systemPromptMode: "提示词模式",
	inheritProjectContext: "继承项目上下文",
	inheritGlobalContext: "继承全局上下文",
	inheritSkills: "继承 skills",
	defaultContext: "上下文起点",
	acceptanceRole: "验收角色",
	disabled: "禁用开关",
	toolBudget: "工具预算",
	systemPrompt: "系统提示",
	machine: "限定机器",
	defaultReads: "必读文件",
	defaultProvider: "裸 id 的 provider",
	skills: "skill 白名单",
	tools: "工具白名单",
	excludeTools: "工具黑名单",
	allowNestedSubagents: "允许嵌套",
	allowedAgents: "可调度白名单",
	extensions: "加载扩展",
	subagentOnlyExtensions: "仅子会话扩展",
	mutationTools: "可写工具",
};

function fieldTable(): string[] {
	// 用自定的**短标签**（而不是 FIELD_GUIDE.note 的散文），列宽才可控。
	// 不加 `{}` 包裹（JSON 键本来就裸写），每列**左对齐**。
	const cells = FIELD_GUIDE.map((entry) => `${entry.field}: ${FIELD_LABELS[entry.field] ?? entry.field}`);
	const cols = 4;
	// ⚠️ 必须按**显示宽度**补齐，不能用 `String.padEnd`：标签是中文，
	//   CJK 在终端占 **2 列**，而 `padEnd` 按 UTF-16 码元算 ⇒ 每行里 CJK 数量不同，
	//   第二列起点就逐行漂移（实测：只有第一列“对齐”，其余全歪）。
	const widths = Array.from({ length: cols }, (_, col) => Math.max(...cells.filter((_, i) => i % cols === col).map((c) => visibleWidth(c))));
	const rows: string[] = [];
	for (let i = 0; i < cells.length; i += cols) {
		const chunk = cells.slice(i, i + cols);
		rows.push(`//   ${chunk.map((c, col) => padVisible(c, widths[col] ?? visibleWidth(c))).join("  ")}`.trimEnd());
	}
	return rows;
}

/** 按**显示宽度**右侧补空格（CJK 占 2 列，`padEnd` 不行）。 */
function padVisible(text: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(text));
	return text + " ".repeat(pad);
}

/** 把一段文本按宽度折成注释行（按空格断行，不截断单词）。 */
function wrapComment(text: string, width: number, prefix: string): string[] {
	const out: string[] = [];
	let line = prefix;
	for (const word of text.split(/\s+/)) {
		const candidate = line.trimEnd().length + 1 + word.length;
		if (line.trimEnd() !== prefix && candidate > width) {
			out.push(line.trimEnd());
			line = prefix + word;
		} else {
			line = line.trimEnd() === prefix ? prefix + word : `${line} ${word}`;
		}
	}
	if (line.trimEnd() !== prefix) out.push(line.trimEnd());
	return out;
}

/** 上游问题的用户可读文案（两类：上游会报错 / 上游静默丢弃）。 */
export function formatOverrideIssue(name: string, issue: OverrideIssue, value: Override): string {
	if (issue.kind === "warns") return `未知键会被静默丢弃：${name}.${issue.field}`;
	const rendered = issue.field ? `${name}.${issue.field}=${JSON.stringify(value[issue.field])}` : name;
	return `上游会对以下内容报错（已照原样保存）：${rendered}`;
}

/**
 * 校验用户在 `e` 里编辑的 JSON（§6.6 重定位后）。
 *
 * **只警告，绝不阻止保存、绝不改写用户的值**：已知字段的非法值也照原样写回，
 * 因为上游抛错的事只应该“告诉用户”，不该变成我们的写入规则。唯一拒绝的是
 * 顶层不是对象（那种形状根本不能存进 `agentOverrides`）。
 */
export function reviewEditedJson(
	name: string,
	parsed: unknown,
): { accepted: boolean; value: Override; errors: string[]; warnings: string[] } {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { accepted: false, value: {}, errors: ["The edited JSON must be a JSON object"], warnings: [] };
	}
	const value = parsed as Override;
	const warnings = overrideIssues(name, value).map((issue) => formatOverrideIssue(name, issue, value));
	return { accepted: true, value, errors: [], warnings };
}

/** `e` 的输入文本 = 注释头 + **整条将写入的条目**。 */
export function editorContent(entry: Override, agentName?: string): string {
	return `${jsonEditorHeader(agentName)}\n${JSON.stringify(entry, null, 2)}\n`;
}

/**
 * `e` 的 main 行输入文本 = main 专属注释头 + 三条真实键（§16.3.4）。
 * 所见即所得 = 将落盘的键（`defaultProvider` / `defaultModel` / `defaultThinkingLevel`）。
 */
export function editorContentForMain(entry: Override): string {
	return `${jsonEditorHeaderMain()}\n${JSON.stringify(entry, null, 2)}\n`;
}

/**
 * main 行 `e` 编辑器的内容（**生产路径的单一出口**，测试直接驱动本函数）。
 *
 * 基底取 `rowBaseOf(row)` 而非 `row.merged`：`r` reset 之后基底冻结为只取全局层，
 * 否则 `e` 会把 reset 前的项目值重新端出来，接受即等于撤销 reset（与 agent 行的
 * `entryForEditor` = `rowMaterialize` 同口径）。
 */
export function mainEditorContent(row: MatrixRowView): string {
	return editorContentForMain(mainEntryForEditor(rowBaseOf(row), row.draft, row.merged));
}

/**
 * 校验 main 行在 `e` 里编辑的 JSON（§16.3.4）。
 *
 * **只警告，绝不阻止保存**：`validateProfileMain` 的 errors 在此一并降为 warnings
 * （配对与否是用户的行为，插件不干涉，§16.0 决策 2）。唯一拒绝的是顶层非对象。
 */
export function reviewMainEditedJson(
	parsed: unknown,
): { accepted: boolean; value: Override; errors: string[]; warnings: string[] } {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { accepted: false, value: {}, errors: ["The edited JSON must be a JSON object"], warnings: [] };
	}
	const value = parsed as Override;
	const result = validateProfileMain(value);
	return { accepted: true, value, errors: [], warnings: [...result.errors, ...result.warnings] };
}

/** 外部编辑器打开的内容：合并基底（有效 reset 时只取全局层）+ 草稿。 */
export function entryForEditor(row: MatrixRowView): Override {
	return rowMaterialize(row);
}

/** 去掉注释头后解析用户内容。 */
export function parseEditedContent(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const stripped = content
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n")
		.trim();
	if (!stripped) return { ok: false, error: "Empty file — treated as cancel" };
	try {
		return { ok: true, value: JSON.parse(stripped) as unknown };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * 是否 main 虚拟行：**只**认 `kind === "main"`（`row.kind ?? row.draft.kind`）。
 * 名字不算——白名单里可能有同名的真 agent 行（保留名见 `normalizeAgents`），
 * 按名字判会把两行都标成 main 并滤出重建循环（Finding 1）。
 * main 不进白名单、不进 `agentOverrides`（§16.0 决策 1）。
 */
function isMainView(row: { kind?: string | undefined; draft: { kind?: string | undefined } }): boolean {
	return (row.kind ?? row.draft.kind ?? "agent") === "main";
}

/**
 * 矩阵行 → 重建输入（含 main 行的 kind 标记；过滤由 `buildPlan` 做）。
 *
 * 按**身份**取行：main 行靠 `draft.kind === "main"` 找，其余按 name。
 * 不能用 `name` 做 Map 键——白名单里若有同名的真 agent 行，它会覆盖 main 行
 * （或反之），同名两行被一起误标成 main 后滤掉，`agentOverrides["main"]`
 * 就进了无行认领的移除（Finding 1）。
 */
export function buildRebuildInputs(session: SessionState, rows: MatrixRowView[]): RebuildRowInput[] {
	const mainEntry = session.rows.find((row) => (row.draft.kind ?? "agent") === "main");
	const byName = new Map<string, RowEntry>();
	for (const row of session.rows) {
		if ((row.draft.kind ?? "agent") === "main") continue;
		byName.set(row.name, row);
	}
	const inputs: RebuildRowInput[] = [];
	for (const view of rows) {
		const entry = isMainView(view) ? mainEntry : byName.get(view.name);
		if (!entry) continue;
		inputs.push({
			name: view.name,
			kind: isMainView(view) || (entry.draft.kind ?? "agent") === "main" ? "main" : "agent",
			projectEntry: entry.projectEntry,
			merged: entry.merged,
			origin: entry.origin,
			...(entry.globalEntry ? { globalEntry: entry.globalEntry } : {}),
			draft: entry.draft,
			classification: entry.classification,
			...(entry.fromEntry ? { fromEntry: entry.fromEntry } : {}),
		});
	}
	return inputs;
}

/** 保存屏的提示（不阻止；`e` 的校验警告与 bulk 开关那两条也走这里）。 */
export function collectWarnings(session: SessionState, rows: MatrixRowView[]): SaveWarning[] {
	const warnings: SaveWarning[] = [];
	for (const view of rows) {
		// `e` 里校验出来的警告（只警告不阻止写入）-——与“上游会对这条报错”同一类
		for (const warning of view.editWarnings) {
			warnings.push({ agent: view.name, message: warning });
		}
		for (const provider of view.classification.projectProviderHits) {
			warnings.push({
				agent: view.name,
				message: `provider-scoped values under '${provider}' will keep overriding the fields you save in the base layer`,
			});
		}
		for (const flag of session.bulkFlags) {
			if (view.classification.state === "unmerged" || view.classification.state === "unresolved") continue;
			// bulk 开关只管子 agent 条目 resuscitation，不管顶层 main 三键。
			if (isMainView(view)) continue;
			warnings.push({
				agent: view.name,
				message:
					flag.key === "disableThinking"
						? `subagents.disableThinking=true (${flag.scope} scope): writing resurrects thinking`
						: `subagents.disableBuiltins=true (${flag.scope} scope): writing resurrects the whole entry in this project only`,
			});
		}
	}
	return warnings;
}

/** `buildPlan` 的 registry 输入：main 静默失效警告需要定位模型与查 provider 凭证。 */
export interface MainWarningSources {
	registry: ModelRegistryLike & { getProviderAuthStatus?: (provider: string) => { configured: boolean } };
	models: readonly (Record<string, unknown> & { id: string; provider: string })[];
}

export function buildPlan(
	session: SessionState,
	rows: MatrixRowView[],
	sources?: MainWarningSources | undefined,
): { plan: RebuildPlan; warnings: SaveWarning[] } {
	// main 虚拟行不走 `planRebuild` 的行循环（它不是 agent 条目），只走 `planMain`。
	const plan = planRebuild({
		rows: buildRebuildInputs(session, rows).filter((input) => (input.kind ?? "agent") !== "main"),
		projectOverrides: session.projectLayer.subagents.agentOverrides,
		whitelist: session.whitelist,
		fromProfileActive: session.fromProfileActive,
	});
	plan.main = planMainFor(session, rows);
	const warnings = collectWarnings(session, rows);
	if (sources && (plan.main.changed || plan.main.removal)) warnings.push(...mainSaveWarnings(plan.main.after, sources));
	return { plan, warnings };
}

/**
 * main 行的重建输入：会话里的基底 + 视图里的实时草稿（与 agent 行同一 live 口径）。
 *
 * 兜底是显式 no-op（`changed` / `removal` 全假）：当前正常流程下不可达
 * （`buildSession` 恒造 main 行），但绝不能是 `after: {}` 配无条件写盘——
 * 那会把顶层三键全删（潜伏的批量删除）。`commitSave` 只在
 * `changed || removal` 时才把 `after` 传下去，no-op 配 `undefined` = 顶层不动。
 */
function planMainFor(session: SessionState, rows: MatrixRowView[]): RebuildPlan["main"] {
	const entry = session.rows.find((row) => (row.draft.kind ?? "agent") === "main");
	const view = rows.find((row) => isMainView(row));
	const draft = view?.draft ?? entry?.draft;
	if (!entry || !draft) return emptyMainPlan();
	return planMain({
		...(entry.projectEntry ? { project: entry.projectEntry } : {}),
		merged: entry.merged,
		origin: entry.origin,
		...(entry.globalEntry ? { globalEntry: entry.globalEntry } : {}),
		draft,
		...(session.fromProfileActive ? { fromProfileActive: true } : {}),
	});
}

/**
 * main 落盘值的静默失效警告（§16.0 调研，保存屏 `notices` 段展示，不阻止写入）。
 * 只在 main 将写入时调用；`after` 为空（removal）⇒ 无警告。
 */
function mainSaveWarnings(
	after: Override,
	sources: MainWarningSources,
): SaveWarning[] {
	const warnings: SaveWarning[] = [];
	const provider = after.defaultProvider;
	const model = after.defaultModel;
	if (typeof model === "string" && model !== "") {
		const display = typeof provider === "string" && provider !== "" ? `${provider}/${model}` : model;
		const located = locateModel({
			registry: sources.registry,
			models: sources.models,
			modelRef: display,
			provider: typeof provider === "string" && provider !== "" ? provider : undefined,
		});
		if (!located?.model) {
			warnings.push({
				agent: "main",
				message: `main: defaultModel="${display}" is not in the model registry — pi will silently fall back to automatic model selection`,
			});
		}
	}
	if (typeof provider === "string" && provider !== "") {
		const getAuthStatus = sources.registry.getProviderAuthStatus;
		const warning = mainAuthWarning(provider, typeof getAuthStatus === "function" ? getAuthStatus.bind(sources.registry) : undefined);
		if (warning) warnings.push({ agent: "main", message: warning });
	}
	return warnings;
}

/**
 * 项目侧是否真的无事可做（= 与现有内容等值）。
 *
 * `S` 不再因零改动而拦截（导出/改名 profile 是独立目的，§16.8：profile = 整张矩阵快照），
 * 所以 commit 时用它在后台**静默跳过**项目写入 —— 既不改文件，也不在保存提示里报一个
 * 没写过的路径。
 */
function projectIsNoop(plan: RebuildPlan): boolean {
	return (
		plan.changed.length === 0 &&
		plan.removals.length === 0 &&
		plan.dropped.length === 0 &&
		!plan.main.changed &&
		!plan.main.removal
	);
}

/**
 * 该不该真的写项目 settings。
 *
 * 零改动（只为导出/改名 profile）⇒ **静默跳过**，连文件都不碰。但 `settings.json` 本身
 * 解析失败时照常尝试：写盘层会拒绝并把错误报出来（绝不覆盖用户数据），而跳过会把这条
 * 信息一并吞掉。
 */
function shouldWriteProject(session: SessionState, plan: RebuildPlan): boolean {
	return session.projectLayer.error !== undefined || !projectIsNoop(plan);
}

/**
 * 执行保存。
 *
 * 失败时**不**写后续目标（project 写失败就不写 profile），把错误交回调用方弹红条；
 * 成功时清缓存 + 重建会话状态（`resetAfterSave`），这是连续保存幂等的前提。
 */
export function commitSave(
	session: SessionState,
	result: SaveResult,
	plan: RebuildPlan,
	warnings: SaveWarning[],
	agentDir: string,
	module: UpstreamModule | undefined,
	/** 真正**超** `maxThinking` 的行名（来自 `MatrixRowView.overCeiling`，不是“改过 thinking”）。 */
	overCeilingAgents: readonly string[] = [],
	/** 当前矩阵视图（带实时草稿）——profile 快照要按它算，缺省则不导出任何 agent 条目。 */
	views: readonly MatrixRowView[] = [],
): CommitResult {
	const messages: string[] = [];
	const mainChanged = plan.main.changed || plan.main.removal;
	const agentChanged = plan.changed.length > 0 || plan.removals.length > 0;
	// main 无改动 ⇒ 传 `undefined`（顶层三键不动）；无条件传 `after` 会把三键全删
	// （`after` 为 `{}` 时 `writeProjectSettings` 按“缺键即删”处理）。
	const mainAfter = mainChanged ? plan.main.after : undefined;
	// profile = **整张矩阵快照**，不是 `plan.overrides`（§16.8）：profile 是“下个项目
	// `--from` 铺开用的模板”，只导出会写的部分就是残缺模板。必须在 `resetAfterSave`
	// （下方）之前算，那会重算草稿。
	const snapshot = result.writeProfile ? profileSnapshot(buildRebuildInputs(session, [...views])) : {};
	let wroteProject = false;
	if (result.writeProject && shouldWriteProject(session, plan)) {
		// 零改动（只为导出/改名 profile）时**静默跳过**项目写入：连文件都不碰。
		// 等值内容 `writeProjectSettings` 本身也会早退，这里先判一次是为了不必读文件、
		// 也不会让保存提示指向一个没写过的路径。
		try {
			writeProjectSettings(session.projectRoot.root, { overrides: plan.overrides, ...(mainAfter !== undefined ? { main: mainAfter } : {}) });
			wroteProject = true;
			messages.push(`project: ${getProjectSettingsPath(session.projectRoot.root)}`);
			if (mainChanged) messages.push("main: defaultProvider/defaultModel/defaultThinkingLevel (next pi start)");
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	}
	if (result.writeProfile) {
		try {
			const written = writeProfile(getProfilePath(result.profileName, agentDir), snapshot, mainAfter);
			messages.push(`profile: ${written.file}`);
			if (written.strippedModelFalse.length > 0) {
				messages.push(
					(result.writeProject ? "project side keeps model:false, " : "") +
						`profile side stripped model:false (upstream profile validation requires a string): ${written.strippedModelFalse.join(", ")}`,
				);
			}
			if (written.droppedEntries.length > 0) {
				messages.push(`profile entries dropped after stripping: ${written.droppedEntries.join(", ")}`);
			}
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	}
	// 写盘后清缓存（best-effort）：指纹含 size/mtimeMs，下次 launch 也会自动重建
	clearDiscoveryCache(module);
	resetAfterSave(session);
	// ⚠ 不能用“plan.changed 里 thinking 字段有差异”推导超限：那只是“改过 thinking”，
	//  与是否真超 `maxThinking` 无关（会误报）。来源与保存屏一致：`MatrixRowView.overCeiling`。
	if (overCeilingAgents.length > 0) messages.push(`⚠ thinking above maxThinking for: ${overCeilingAgents.join(", ")} (rejected at run time)`);
	if (warnings.length > 0) messages.push(`${warnings.length} notice(s) shown before saving`);
	if (agentChanged) messages.push("verify with /subagents-models <agent>");
	if (mainChanged) messages.push("verify by starting pi again in this project");
	return { ok: true, message: messages.join("; "), wroteProject, wroteProfile: result.writeProfile };
}

/** 脏行必须重算：用户改草稿后列要按草稿值刷新（否则连按 shift+tab 看不到变化）。 */
export function refreshViews(
	views: MatrixRowView[],
	session: SessionState,
	discovery: UpstreamDiscovery,
	sources: ViewSources,
): MatrixRowView[] {
	const byName = new Map<string, UpstreamAgent>();
	for (const agent of discovery.baselineAgents ?? []) byName.set(agent.name, agent);
	// ⚠️ 行归属**只能按 kind**：main 虚拟行与真agent 行可能同名（`buildSession` 是导出 API，
	// 调用方可直接构造 `{agents:["main"]}`），按 name 找会让两行都命中虚拟行，
	// 然后 `buildPlan` 把两行一起滤出 `planRebuild` ⇒ 同名 agent 的项目条目变成无主条目被删。
	const mainEntry = session.rows.find((row) => (row.draft.kind ?? "agent") === "main");
	const agentRows = new Map<string, RowEntry>();
	for (const row of session.rows) {
		if ((row.draft.kind ?? "agent") === "main") continue;
		agentRows.set(row.name, row);
	}
	return views.map((view) => {
		const entry = isMainView(view) ? mainEntry : agentRows.get(view.name);
		if (!entry) return view;
		return refreshRowView(view, entry, sources, byName.get(view.name));
	});
}

/** L0 写入提示的文案（§12）。 */
export default function (pi: ExtensionAPI): void {
	// 包管理器探测：交给 pi 的 `DefaultPackageManager`（首选，不猜路径）。
	setPackageManagerProbe((cwd, agentDir, trusted) => {
		try {
			const pm = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: trusted }),
			});
			return pm.getInstalledPath(`npm:${UPSTREAM_PACKAGE}`, "user") ?? pm.getInstalledPath(`npm:${UPSTREAM_PACKAGE}`, "project");
		} catch {
			return undefined;
		}
	});

	pi.registerCommand(COMMAND_NAME, {
		description:
			"Batch-configure pi-subagents agent model + thinking per project, and export the result as a reusable global profile",
		getArgumentCompletions: (prefix: string) => buildCompletions(prefix, listProfileNames(getAgentDir())),
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (parsed.errors.length > 0) {
				for (const error of parsed.errors) emit(pi, ctx, error, "error");
				if (parsed.from === undefined) reportAvailableProfiles(pi, ctx);
				return;
			}
			if (parsed.from !== undefined && readProfile(parsed.from) === undefined) {
				emit(pi, ctx, `Profile not found: ${parsed.from}`, "error");
				reportAvailableProfiles(pi, ctx);
				return;
			}
			await runCommand(pi, ctx, parsed.from);
		},
	});
}

function reportAvailableProfiles(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	const available = listProfileNames(getAgentDir());
	emit(pi, ctx, available.length > 0 ? `Available profiles: ${available.join(", ")}` : "No profiles found", "info");
}

async function runCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, from: string | undefined): Promise<void> {
	const agentDir = getAgentDir();
	const trusted = safeIsProjectTrusted(ctx);
	const refreshWarning = await refreshModels(ctx.modelRegistry as unknown as ModelRegistryLike);

	const detection = await detectUpstream({ cwd: ctx.cwd, agentDir, trusted });
	const provider = (ctx.model as { provider?: string } | undefined)?.provider;
	const discovery: UpstreamDiscovery = {
		...collectDetection(detection.module, ctx.cwd, provider),
		...(detection.version ? { version: detection.version } : {}),
		...(detection.root ? { root: detection.root } : {}),
	};

	const presetConfig = loadConfig(ctx.cwd, { trusted });
	const session = buildSession(
		{ cwd: ctx.cwd, agentDir, trusted, fromProfile: from },
		{ ...discovery, version: detection.version, root: detection.root },
		presetConfig,
	);
	// §11 用例 12：`--from` 的 profile 非法 ⇒ 红条并**拒绝合并**，
	// 不得带着替代基底（项目现有配置）进矩阵。
	if (session.fromProfileRejected) {
		for (const error of session.errors) emit(pi, ctx, error, "error");
		emit(pi, ctx, `Aborted: profile '${from}' was rejected, nothing was merged and nothing was written.`, "error");
		return;
	}

	const sources = buildViewSources(ctx, session);
	const views = buildRowViews(session.rows, discovery, sources);

	if (!ctx.hasUI) {
		emit(pi, ctx, summaryLines(ctx, session, views, from).join("\n"), "info");
		return;
	}

	const notices = [...session.notices];
	if (detection.notice) notices.unshift(detection.notice);
	if (refreshWarning) notices.push(`Model refresh failed: ${refreshWarning}`);

	// ⚠️ 原则：**提示类归 pi，状态类归项目/行本身**。
	//   所以这些 notice 走 `ctx.ui.notify`（pi 自己的通知区），**不**渲染进矩阵；
	//   矩阵里只留 error（硬失败）+ 行内紧凑标记 + state 列。
	if (ctx.hasUI) {
		for (const notice of notices) ctx.ui.notify(notice, "warning");
		for (const error of session.errors) ctx.ui.notify(error, "error");
	}

	await ctx.ui.custom<void>((tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void) => {
		const matrix = new PresetsMatrix({
			// 提示类一律走 pi 的通知区（原则：提示归 pi，状态归行本身）
			notify: (level, message) => ctx.ui.notify(message, level),
			// pi 的 custom UI 不会因 handleInput 自动重绘，必须显式请求
			requestRender: () => tui.requestRender(true),
			header: {
				notices,
				errors: session.errors,
			},
			rows: views,
			models: sources.models,
			keybindings,
			theme,
			projectPath: getProjectSettingsPath(session.projectRoot.root),
			profilePath: getProfilePath(DEFAULT_PROFILE_NAME, agentDir),
			bulkFlags: session.bulkFlags,
			untrusted: !trusted,
			defaultProfileName: DEFAULT_PROFILE_NAME,
			callbacks: {
				onDone: () => done(),
				onNeedRefresh: () => {
					const next = refreshViews(matrix.currentViews(), session, discovery, sources);
					matrix.replaceRows(next);
				},
				onEditJson: async (row) => editRowInExternalEditor(pi, tui, ctx, row),
				planSave: (rows) => {
					const { plan, warnings } = buildPlan(session, rows, { registry: sources.registry, models: sources.models });
					return { plan, warnings, overCeilingAgents: rows.filter((row) => row.overCeiling).map((row) => row.name) };
				},
				onSave: async (result, plan, warnings) => {
					const outcome = commitSave(
						session,
						result,
						plan,
						warnings,
						agentDir,
						detection.module,
						matrix.currentViews().filter((row) => row.overCeiling).map((row) => row.name),
						matrix.currentViews(),
					);
					if (!outcome.ok) emit(pi, ctx, outcome.message, "error");
					return outcome;
				},
			},
		});
		matrix.replaceRows(views);
		tui.setFocus(matrix);
		return matrix;
	});
}

function collectDetection(module: UpstreamModule | undefined, cwd: string, provider: string | undefined): UpstreamDiscovery {
	return collectDiscovery(module, cwd, provider);
}

/**
 * `e` = 外部编辑器（§3.7 的 A/B 两段由 `runExternalEditorRound` 承担）。
 *
 * 编辑的是**整条将写入的条目**（`entryForEditor`）；回填时 `model` / `thinking` 同步
 * 进草稿并标 `touched`（矩阵与 `e` 是同一份数据的两个视图）。main 行编辑的是
 * 3 条真实键（`mainEntryForEditor` + 专属注释头），回填走 `applyMainEditedEntry`
 * （矩阵侧分支，§16.3.4）。
 * 校验结果**只当警告**带回去（保存屏汇总），非法值 / 解析失败都不会被静默改写。
 */
async function editRowInExternalEditor(
	pi: ExtensionAPI,
	tui: TUI,
	ctx: ExtensionCommandContext,
	row: MatrixRowView,
): Promise<{ value: Override; warnings: string[] } | undefined> {
	let command: string;
	try {
		command = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: safeIsProjectTrusted(ctx) }).getExternalEditorCommand();
	} catch (e) {
		emit(pi, ctx, `Cannot resolve the external editor: ${e instanceof Error ? e.message : String(e)}`, "error");
		return undefined;
	}
	// ⚠️ 只按 kind 判，不拿 `row.name === MAIN_ROW_NAME` 兜底（与 `isMainView` / `isMainRow`
	//   同口径）：虚拟行与真agent 行可能同名，按名字判会用 main 头打开一个 agent 行的编辑器，
	//   而回填侧按 kind 走 `applyEditedEntry` ⇒ 该行字段被错清空。
	const main = (row.kind ?? row.draft.kind ?? "agent") === "main";
	for (;;) {
		// main 行同样走 reset 冻结后的基底（与 agent 行的 `entryForEditor` = `rowMaterialize` 同口径）：
		// 按过 `r` 后 `e` 看到的是全局层的值，而不是 reset 前的合并基底。
		const content = main ? mainEditorContent(row) : editorContent(entryForEditor(row), row.name);
		const result = await runExternalEditorRound(tui, { command, content, fileName: "entry.jsonc" });
		if (result.status === "failed" || result.content === undefined) return undefined;
		const parsed = parseEditedContent(result.content);
		if (!parsed.ok) {
			emit(pi, ctx, `Invalid JSON: ${parsed.error}`, "error");
			continue;
		}
		const review = main ? reviewMainEditedJson(parsed.value) : reviewEditedJson(row.name, parsed.value);
		if (!review.accepted) {
			// 只可能是“顶层不是对象”——那种形状存不进 agentOverrides，必须重编
			for (const error of review.errors) emit(pi, ctx, error, "error");
			continue;
		}
		// deepCloneOverride 返回的对象与源不共享引用，所以可以直接把草稿快照写进下一行
		return { value: deepCloneOverride(review.value), warnings: review.warnings };
	}
}
