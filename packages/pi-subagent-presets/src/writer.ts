/**
 * @inobit/pi-subagent-presets — 重建 `subagents.agentOverrides` + 自实现原子写（§7.1）。
 *
 * ⚠️ **不复用上游 `saveBuiltinAgentOverride`**（`agents.js:1419-1435`）：
 * - 它只能整条替换**单个** key，不能删条目
 * - `cloneOverrideValue`（`agents.js:516-545`）是 allowlist 拷贝，会剥掉未知键
 *   （与 §6.6「未知 key 可写回」冲突）
 * - `writeSettingsFile` 是 `writeFileSync`，无原子性
 *
 * 这里走主路径：读 JSON → 只替换 `subagents.agentOverrides` 一个键 → 临时文件 + rename。
 * 语义保证是**值相等**，不是字节相同（JSON 重写会规范化缩进 / 键序 / 行尾）。
 */

import fs from "node:fs";
import path from "node:path";
import { getProjectSettingsPath } from "./context.ts";
import type { Draft, Override } from "./merge.ts";
import { deepCloneOverride, keepExisting, materializeRow, resetParticipates, rowBaseOf, rowDirty, rowMergeState, type FieldOrigin } from "./merge.ts";
import type { BulkFlag, RowClassification, RowContext } from "./rowstate.ts";

/** 一行的全部决策所需输入（纯数据，测试可直接构造）。 */
export interface RebuildRowInput {
	name: string;
	projectEntry?: Override | undefined;
	merged: Override;
	/** 逐字段来源（`state` 判定用）。 */
	origin: FieldOrigin;
	/** 全局层同名条目（`r` reset 后基底冻结为只取它）。 */
	globalEntry?: Override | undefined;
	draft: Draft;
	classification: RowClassification;
	/** `--from` 模板里该 agent 的原始条目（无 `--from` 时 undefined）。 */
	fromEntry?: Override | undefined;
}

/**
 * 移除原因（保存屏的「移除」区按它分类显示）。
 * - `reset`：按过 `r` 且没再改过（`state === GLOBAL`）⇒ 项目条对最终结果零贡献
 * - `empty-base`：非 reset 的零贡献行（字段被清空或两边都没配过），同样不产生条
 * - `unresolved`：上游已无（`MISSING`）**或**上游已禁用（靠 detail 区分）
 */
export type RemovalReason = "unresolved" | "not-whitelisted" | "alias" | "empty-base" | "reset";

export interface RemovalEntry {
	name: string;
	reason: RemovalReason;
	/** 人读原因（保存屏「移除」段用）。 */
	detail: string;
}

export interface ChangedEntry {
	name: string;
	before?: Override;
	after: Override;
	/** 逐字段差异（保存屏用）。 */
	fields: { key: string; before: unknown; after: unknown }[];
	isNew: boolean;
}

export interface DroppedField {
	name: string;
	keys: string[];
}

export interface RebuildPlan {
	/** 最终要写进 `subagents.agentOverrides` 的内容。 */
	overrides: Record<string, Override>;
	changed: ChangedEntry[];
	removals: RemovalEntry[];
	/** 未 dirty、保持现有值的行。 */
	unchanged: string[];
	/** `unmerged` 行：保持现状（不写也不删），列出便于保存屏说明。 */
	keptLocked: string[];
	/** `dropped`：`--from` 场景下模板里有、但因项目条目优先而**不会写入**的字段。 */
	dropped: DroppedField[];
	/** 合并基底为空的 dirty 行（不产生条目 ⇒ 会被移除）。 */
	emptyBase: string[];
	/** 项目条目存在、但该行 `state === GLOBAL` ⇒ 对最终结果零贡献 ⇒ 被删除。 */
	zeroContribution: string[];
	/** 是否需要删掉 `subagents.agentOverrides` 键。 */
	deleteAgentOverrides: boolean;
}

function diffFields(before: Override | undefined, after: Override): { key: string; before: unknown; after: unknown }[] {
	const keys = new Set<string>([...Object.keys(before ?? {}), ...Object.keys(after)]);
	const fields: { key: string; before: unknown; after: unknown }[] = [];
	for (const key of keys) {
		const b = before?.[key];
		const a = after[key];
		if (JSON.stringify(b) === JSON.stringify(a)) continue;
		fields.push({ key, before: b, after: a });
	}
	return fields;
}

export interface RebuildOptions {
	rows: RebuildRowInput[];
	/** 项目现有 `agentOverrides`（整体，用于识别非白名单 / 灰行条目的移除）。 */
	projectOverrides: Record<string, Override>;
	/** 白名单（canonical name 集合）——不在其中的项目条目会被移除。 */
	whitelist: readonly string[];
	/** `--from` 场景：是否用指定 profile 占模板槽位（决定是否产出「模板未生效字段」预览）。 */
	fromProfileActive?: boolean;
}

/**
 * §7.1 的重建循环。
 *
 * 四个必须分清的边界：
 * ① `rebuilt` 从空构建 ⇒ "移除"是**隐式**的，任何 `continue` 都等于**删除**。
 *    因此 `unmerged`（不可合并）与 `!dirty` 两行都必须走 `keepExisting` 分支。
 * ② `agentOverrides` 全空时删该键；`subagents` 也变空时一并删（对齐上游
 *    `removeBuiltinAgentOverride`，`agents.js:1436-1470`）。
 * ③ 项目里原本的 `{}` 空条目**不写回**（`Object.keys(e).length > 0` 守卫）。
 * ④ 合并基底为空的 dirty 行不产生条目，保存屏列入「将移除」。
 *
 * 🔑 **核心判定**：
 * ```
 * 项目条目存在 + 该行 state === GLOBAL ⇒ 该条目对最终结果没有任何贡献 ⇒ 必须删除它
 * ```
 * 没有这一条，`r`(reset) 就只是"不写"而不是"删除已有条目"，reset 也就没意义：
 * 旧条目会继续在磁盘上遮蔽全局层。`state` 由 `merge.ts` 的 `rowMergeState` 给出
 * （将写入对象里每个字段的来源）——所以这里只消费，不重算。
 *
 * reset 的两种后续：`state === GLOBAL` ⇒ 删条目（reason `reset`）；被改过字段 ⇒
 * `state` 变成 `MERGE`/`OVERRIDE`，行走下面正常的写分支（基底仍是冻结的全局层）。
 */
export function planRebuild(opts: RebuildOptions): RebuildPlan {
	const rebuilt: Record<string, Override> = {};
	const changed: ChangedEntry[] = [];
	const removals: RemovalEntry[] = [];
	const unchanged: string[] = [];
	const keptLocked: string[] = [];
	const dropped: DroppedField[] = [];
	const emptyBase: string[] = [];
	const zeroContribution: string[] = [];
	const rowNames = new Set(opts.rows.map((row) => row.name));
	const whitelist = new Set(opts.whitelist);
	const fromProfileActive = opts.fromProfileActive === true;

	for (const row of opts.rows) {
		const { classification, draft, name } = row;
		const existing = keepExisting(row.projectEntry);

		// 灰行（上游已无 / 上游已禁用）与别名行：连同其旧条目一并消失（隐式移除）
		if (classification.state === "unresolved") {
			if (existing) {
				removals.push({
					name,
					reason: "unresolved",
					detail: classification.disabledUpstream ? "disabled upstream" : "no such agent upstream",
				});
			}
			continue;
		}
		if (classification.isAlias) {
			if (existing) {
				removals.push({
					name,
					reason: "alias",
					detail: `alias key (always inert on ${name}; using ${classification.aliasOf ?? "the canonical name"} instead)`,
				});
			}
			continue;
		}

		// 保护一：不可合并 ⇒ 不写、也不删（保持现状）
		if (classification.state === "unmerged") {
			if (existing) {
				rebuilt[name] = existing;
				keptLocked.push(name);
			}
			continue;
		}

		const base = rowBaseOf(row);
		// 🔑 项目条目存在 + `state === GLOBAL` ⇒ 零贡献 ⇒ 删除（`r` 的效果就靠它）
		if (rowMergeState(row) === "GLOBAL") {
			// ⚠️ 必须有 `existing` 守卫：合并基底为空但**项目里本来就没有条目**时
			// 没有任何东西可删，列进「将移除」是纯噪音。
			if (existing && Object.keys(materializeRow(base, draft)).length === 0) emptyBase.push(name);
			if (existing) {
				zeroContribution.push(name);
				removals.push(
					draft.reset && !resetParticipates(row)
						? { name, reason: "reset", detail: "reset: project entry removed, falls back to the global layer" }
						: { name, reason: "empty-base", detail: "merged base is empty, the entry will be removed" },
				);
			}
			continue;
		}

		if (!rowDirty(row)) {
			// 未 dirty 且非新建的行 ⇒ 保留其现有值（物化会把"跟随全局"翻转成遮蔽）
			if (existing) {
				rebuilt[name] = existing;
				unchanged.push(name);
			}
			continue;
		}

		const after = materializeRow(base, draft);
		if (Object.keys(after).length === 0) {
			// ④ 合并基底为空的 dirty 行不产生条目
			emptyBase.push(name);
			if (existing) removals.push({ name, reason: "empty-base", detail: "merged base is empty, the entry will be removed" });
			continue;
		}
		rebuilt[name] = after;
		const fields = diffFields(existing, after);
		if (fields.length > 0 || !existing) {
			changed.push({ name, ...(existing ? { before: existing } : {}), after, fields, isNew: !existing });
		}
	}

	// 非白名单的项目条目一并消失（白名单即托管清单）
	for (const name of Object.keys(opts.projectOverrides)) {
		if (rowNames.has(name)) continue;
		removals.push({
			name,
			reason: whitelist.has(name) ? "unresolved" : "not-whitelisted",
			detail: whitelist.has(name) ? "no such agent upstream" : "not whitelisted (add it back to keep it)",
		});
	}

	// `--from <name>` 场景：base0 就是指定 profile，项目现有条目**不参与基底**。
	// 所以项目条目里那些“指定 profile 没有、合并结果也没有”的键会被真实丢弃。
	// 这里把它们单列出来（不阻止，只提示）。
	if (fromProfileActive) {
		for (const row of opts.rows) {
			if (row.classification.isAlias || row.classification.state === "unresolved") continue;
			const existing = row.projectEntry;
			if (!existing) continue; // 项目无条目 ⇒ 无可丢
			const written = rebuilt[row.name];
			const droppedKeys = Object.keys(existing).filter((key) => written === undefined || !(key in written));
			if (droppedKeys.length > 0) dropped.push({ name: row.name, keys: droppedKeys });
		}
	}

	const deleteAgentOverrides = Object.keys(rebuilt).length === 0;
	return {
		overrides: rebuilt,
		changed,
		removals,
		unchanged,
		keptLocked,
		dropped,
		emptyBase,
		zeroContribution,
		deleteAgentOverrides,
	};
}

/** 原子写：同目录临时文件 + `rename`（跨文件系统安全，避免半截文件）。 */
export function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	try {
		fs.renameSync(tmp, file);
	} catch (e) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// 清理 best-effort
		}
		throw e;
	}
}

export class SettingsWriteError extends Error {}

function readSettingsObject(file: string): { value: Record<string, unknown>; error?: string } {
	if (!fs.existsSync(file)) return { value: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { value: {}, error: `Settings file '${file}' must contain a JSON object.` };
		}
		return { value: parsed as Record<string, unknown> };
	} catch (e) {
		// 语法错误 ⇒ **不写入**（避免覆盖用户数据）
		return { value: {}, error: `Failed to parse '${file}': ${e instanceof Error ? e.message : String(e)}` };
	}
}

export interface WriteProjectResult {
	file: string;
	changedKeys: string[];
	deletedKeys: string[];
}

/**
 * 只替换 `subagents.agentOverrides` 这一个键，其余内容**语义保留**
 * （键集合与值相等；JSON 重写会规范化格式，字节不保证）。
 */
export function writeProjectAgentOverrides(projectRoot: string, overrides: Record<string, Override>): WriteProjectResult {
	const file = getProjectSettingsPath(projectRoot);
	const { value: settings, error } = readSettingsObject(file);
	if (error) throw new SettingsWriteError(error);

	const before = JSON.stringify(settings);
	const subagentsBefore =
		settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
			? ({ ...(settings.subagents as Record<string, unknown>) })
			: {};

	if (Object.keys(overrides).length === 0) {
		delete subagentsBefore.agentOverrides;
		if (Object.keys(subagentsBefore).length === 0) delete settings.subagents;
		else settings.subagents = subagentsBefore;
	} else {
		settings.subagents = { ...subagentsBefore, agentOverrides: deepCloneOverride(overrides) };
	}
	if (JSON.stringify(settings) === before) {
		return { file, changedKeys: [], deletedKeys: [] };
	}
	writeJsonAtomic(file, settings);
	return { file, changedKeys: ["subagents.agentOverrides"], deletedKeys: Object.keys(overrides).length === 0 ? ["subagents.agentOverrides"] : [] };
}

export interface ProfileWriteResult {	file: string;
	/** 被剔除的 `model: false`（上游 profile 校验器要求 `model` 必须是 string）。 */
	strippedModelFalse: string[];
	/** 因剔除后条目变空而整条不导出的 agent。 */
	droppedEntries: string[];
}

/**
 * 导出 profile：`{ subagents: { agentOverrides: … } }`，**不含顶层 `subagents` 键**
 * （`defaultModel` / `defaultThinking` / `maxThinking` 天然生效、不被遮蔽，所以不导出）。
 */
export function buildProfileDocument(overrides: Record<string, Override>): { document: { subagents: { agentOverrides: Record<string, Override> } }; strippedModelFalse: string[]; droppedEntries: string[] } {
	const out: Record<string, Override> = {};
	const strippedModelFalse: string[] = [];
	const droppedEntries: string[] = [];
	for (const [name, entry] of Object.entries(overrides)) {
		const next = deepCloneOverride(entry);
		if (next.model === false) {
			strippedModelFalse.push(name);
			delete next.model;
		}
		if (Object.keys(next).length === 0) {
			droppedEntries.push(name);
			continue;
		}
		out[name] = next;
	}
	return { document: { subagents: { agentOverrides: out } }, strippedModelFalse, droppedEntries };
}

export function writeProfile(profileFile: string, overrides: Record<string, Override>): ProfileWriteResult {
	const { document, strippedModelFalse, droppedEntries } = buildProfileDocument(overrides);
	writeJsonAtomic(profileFile, document);
	return { file: profileFile, strippedModelFalse, droppedEntries };
}

export type { RowContext, BulkFlag };

/** 保存结果（成功 ⇒ 摘要行；失败 ⇒ 错误文案，由调用方弹红条）。 */
export interface CommitResult {
	ok: boolean;
	message: string;
}
