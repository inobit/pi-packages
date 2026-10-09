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
import { MAIN_KEYS, resolveMainEntry } from "./main-row.ts";
import type { Draft, Override, RowKind } from "./merge.ts";
import { deepCloneOverride, keepExisting, materializeRow, resetParticipates, rowBaseOf, rowDirty, rowMaterialize, rowMergeState, type FieldOrigin } from "./merge.ts";
import type { BulkFlag, RowClassification, RowContext } from "./rowstate.ts";

/** 一行的全部决策所需输入（纯数据，测试可直接构造）。 */
export interface RebuildRowInput {
	name: string;
	/** 行种类（默认 `"agent"`；main 虚拟行不走 `planRebuild` 的行循环，见 `planMain`）。 */
	kind?: RowKind | undefined;
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
	/** main 虚拟行的顶层三键计划（§16.2.5，不走行循环，由 `planMain` 单独算）。 */
	main: MainPlan;
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

/**
 * main 虚拟行的重建计划（§16.2.5）。
 *
 * main 不是 agent 条目，不走 `planRebuild` 的行循环：`index.ts` 组装 `buildPlan`
 * 时把 `planMain(...)` 的结果挂到 `plan.main` 上。`after` 的键是三条真实键名，
 * 缺省的键 ⇒ 从项目文件里**删除**该顶层键（`r` reset 的落盘）。
 */
export interface MainPlan {
	/** 项目层现有三键（缺省/空 ⇒ undefined，无可删）。 */
	before?: Override;
	/** 将写入的三键（空对象 = 三键全部消失 ⇒ 需要删键）。 */
	after: Override;
	/** 逐字段差异（保存屏用）。 */
	fields: { key: string; before: unknown; after: unknown }[];
	/** 与 before 有差异（含 before 不存在）。移除走 `removal`，不走这里。 */
	changed: boolean;
	/** before 不存在且 after 非空。 */
	isNew: boolean;
	/** 项目层三键全部消失（`r` reset / 显式清空）⇒ 需要删键。 */
	removal: boolean;
}

/** `planMain` 的输入（纯数据，测试可直接构造）。 */
export interface MainPlanInput {
	/** 项目层现有三键（真实键名，缺省 ⇒ 无现有值）。 */
	project?: Override | undefined;
	/** 合并基底（`synthesizeMain` 的 `merged`，真实键名）。 */
	merged: Override;
	/** 逐字段来源（`state` 判定用）。 */
	origin: FieldOrigin;
	/** 全局层三键（`r` reset 后基底冻结为只取它）。 */
	globalEntry?: Override | undefined;
	/** main 行的草稿（`kind: "main"`）。 */
	draft: Draft;
	/** `--from` 模板激活时，未编辑的行也要按模板落盘（与 agent 行 §16.1 同口径）。 */
	fromProfileActive?: boolean;
}

/** 中性的 main 计划（`planRebuild` 行循环不产出 main，由调用方用 `planMain` 覆盖）。 */
export function emptyMainPlan(): MainPlan {
	return { after: {}, fields: [], changed: false, isNew: false, removal: false };
}

/**
 * main 行落盘/显示**共用**的条目解析（单一口径）。
 *
 * 只覆盖顶层三键（`MAIN_KEYS`）：`resolveMainEntry` 会把草稿 `extra` 里的未知键
 * 一并带出来，但 `writeProjectSettings` 只写三键 ⇒ 未知键永远不会落盘；这里提前滤掉，
 * 它们也就不进 `fields`、不出现在保存屏的 diff 里（否则会显示一条永远不会落盘的
 * `~ someKey → …`）。
 *
 * provider 的解析规则见 `main-row.ts` 的 `resolveMainEntry`（reset 后不复活项目层的
 * provider）——显示与落盘必须走同一个函数，否则会出现“屏幕一个值、写盘另一个值”。
 */
function mainAfter(row: { merged: Override; origin: FieldOrigin; globalEntry?: Override | undefined; draft: Draft }): Override {
	const after = resolveMainEntry(rowBaseOf(row), row.draft, row.merged);
	const out: Override = {};
	for (const key of MAIN_KEYS) {
		if (key in after) out[key] = after[key];
	}
	return out;
}

/**
 * main 行的重建判定（§16.2.5，`planRebuild` 行循环的 main 版等价实现）。
 *
 * - `r` reset 且未再改 ⇒ 直接删键（**不**写冻结的全局值，这正是 reset 的含义）。
 * - `state === GLOBAL` 且项目有键 ⇒ 删（零贡献）；项目无键 ⇒ 无事可做。
 * - 未 dirty：普通命令 ⇒ 保留现有值；`--from` ⇒ 按模板落盘（§16.1 同口径，幂等）。
 * - dirty ⇒ 写完整合并；结果为空且项目有键 ⇒ 删。
 *
 * ⚠️ main 的三个键**绝不**进 `subagents.agentOverrides`：`after` 只含顶层三键，
 * 由 `writeProjectSettings` 写顶层，`planRebuild` 的 `overrides` 碰不到它们。
 */
export function planMain(input: MainPlanInput): MainPlan {
	const fromProfileActive = input.fromProfileActive === true;
	const before = keepExisting(input.project);
	const row = { merged: input.merged, origin: input.origin, globalEntry: input.globalEntry, draft: input.draft };
	const withBefore = <T extends object>(extra: T): T & { before?: Override } => (before ? { ...extra, before } : extra);

	// `r` reset 且未再改：删键（agent 行走 removals，这里走 removal）
	if (input.draft.reset && !resetParticipates({ merged: input.merged, draft: input.draft })) {
		if (before) return { ...withBefore({}), after: {}, fields: diffFields(before, {}), changed: false, isNew: false, removal: true };
		return emptyMainPlan();
	}

	// 🔑 零贡献（与 agent 行的 GLOBAL 分支同理）
	if (rowMergeState(row) === "GLOBAL") {
		const after = mainAfter(row);
		if (before && Object.keys(after).length === 0) {
			return { ...withBefore({}), after: {}, fields: diffFields(before, {}), changed: false, isNew: false, removal: true };
		}
		return { ...withBefore({}), after: before ?? {}, fields: [], changed: false, isNew: false, removal: false };
	}

	if (!rowDirty(row)) {
		// `--from`：基底就是模板 ⇒ 未编辑的行也要按模板落盘
		if (fromProfileActive) {
			const after = mainAfter(row);
			if (Object.keys(after).length > 0) {
				const fields = diffFields(before, after);
				if (fields.length > 0 || !before) {
					return { ...withBefore({}), after, fields, changed: true, isNew: !before, removal: false };
				}
			}
		}
		// 未 dirty ⇒ 保留现有值（写回等值对象，写盘层据此跳过重写）
		return { ...withBefore({}), after: before ?? {}, fields: [], changed: false, isNew: false, removal: false };
	}

	const after = mainAfter(row);
	if (Object.keys(after).length === 0) {
		if (before) return { ...withBefore({}), after: {}, fields: diffFields(before, {}), changed: false, isNew: false, removal: true };
		return emptyMainPlan();
	}
	const fields = diffFields(before, after);
	if (fields.length > 0 || !before) {
		return { ...withBefore({}), after, fields, changed: true, isNew: !before, removal: false };
	}
	return { ...withBefore({}), after, fields: [], changed: false, isNew: false, removal: false };
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
				// `--from` 下模板缺该条目：基底落到全局层，项目条目被删是**对的**
				// （模板 + 全局的结果就是全局那份），但原因不是 "merged base is empty"。
				// 判据用 `fromEntry`：模板里有没有这一条（空对象也算"有"⇒ 走原文案）。
				removals.push(
					draft.reset && !resetParticipates(row)
						? { name, reason: "reset", detail: "reset: project entry removed, falls back to the global layer" }
						: fromProfileActive && !row.fromEntry
							? {
									name,
									reason: "empty-base",
									detail: "the blueprint has no entry for this agent; the project entry is removed so the global layer applies",
								}
							: { name, reason: "empty-base", detail: "merged base is empty, the entry will be removed" },
				);
			}
			continue;
		}

		if (!rowDirty(row)) {
			// `--from`：基底就是模板 ⇒ 未编辑的行也要按模板落盘。判定基准从
			// “草稿 vs 草稿初值”换成“将写入对象 vs 项目现有条目”。
			if (fromProfileActive) {
				const after = materializeRow(base, draft);
				if (Object.keys(after).length > 0) {
					const fields = diffFields(existing, after);
					if (fields.length > 0 || !existing) {
						rebuilt[name] = after;
						changed.push({ name, ...(existing ? { before: existing } : {}), after, fields, isNew: !existing });
						continue;
					}
				}
			}
			// 未 dirty 且非新建的行 ⇒ 保留其现有值（物化会把“跟随全局”翻转成遮蔽）
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
		main: emptyMainPlan(),
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

/** `writeProjectSettings` 的输入：agent 条目 + 可选的顶层 main 三键。 */
export interface WriteProjectSettingsInput {
	/** 最终要写进 `subagents.agentOverrides` 的内容（全空 ⇒ 删该键）。 */
	overrides: Record<string, Override>;
	/**
	 * 顶层 main 三键（真实键名）。缺省的键 ⇒ 从文件里**删除**该顶层键
	 * （`r` reset 的落盘）；整个 `main` 缺省 ⇒ 顶层三键不动。
	 */
	main?: Override | undefined;
}

/**
 * 只替换 `subagents.agentOverrides` + 顶层 main 三键，其余内容**语义保留**
 * （键集合与值相等；JSON 重写会规范化格式，字节不保证）。
 *
 * ⚠️ main 的三个键写**顶层**，绝不进 `subagents`（那里的 `defaultProvider`
 * 是上游的裸 id 消歧键，同名不同义，见 `settings-io.ts` 的 `SubagentsLayer`）。
 */
export function writeProjectSettings(projectRoot: string, input: WriteProjectSettingsInput): WriteProjectResult {
	const file = getProjectSettingsPath(projectRoot);
	const { value: settings, error } = readSettingsObject(file);
	if (error) throw new SettingsWriteError(error);

	const before = JSON.stringify(settings);
	const subagentsBefore =
		settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
			? ({ ...(settings.subagents as Record<string, unknown>) })
			: {};

	if (Object.keys(input.overrides).length === 0) {
		delete subagentsBefore.agentOverrides;
		if (Object.keys(subagentsBefore).length === 0) delete settings.subagents;
		else settings.subagents = subagentsBefore;
	} else {
		settings.subagents = { ...subagentsBefore, agentOverrides: deepCloneOverride(input.overrides) };
	}
	const changedKeys: string[] = [];
	const deletedKeys: string[] = [];
	if (input.main !== undefined) {
		for (const key of MAIN_KEYS) {
			if (key in input.main) {
				if (JSON.stringify(settings[key]) !== JSON.stringify(input.main[key])) {
					settings[key] = input.main[key];
					changedKeys.push(key);
				}
			} else if (key in settings) {
				delete settings[key];
				deletedKeys.push(key);
			}
		}
	}
	if (JSON.stringify(settings) === before) {
		return { file, changedKeys: [], deletedKeys: [] };
	}
	writeJsonAtomic(file, settings);
	return {
		file,
		changedKeys: ["subagents.agentOverrides", ...changedKeys],
		deletedKeys: [...(Object.keys(input.overrides).length === 0 ? ["subagents.agentOverrides"] : []), ...deletedKeys],
	};
}

/**
 * 只替换 `subagents.agentOverrides` 这一个键，其余内容**语义保留**
 * （键集合与值相等；JSON 重写会规范化格式，字节不保证）。
 * 薄封装：等价 `writeProjectSettings(root, { overrides })`，顶层三键不动。
 */
export function writeProjectAgentOverrides(projectRoot: string, overrides: Record<string, Override>): WriteProjectResult {
	return writeProjectSettings(projectRoot, { overrides });
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
 *
 * main 三键写文档**顶层**（真实键名），绝不进 `subagents`；三键全空时不出现。
 */
export interface ProfileDocument {
	subagents: { agentOverrides: Record<string, Override> };
	defaultProvider?: unknown;
	defaultModel?: unknown;
	defaultThinkingLevel?: unknown;
}

/**
 * profile 导出用：**整张矩阵的快照**（= 下一个项目 `--from` 铺开时要用的完整模板）。
 *
 * ⚠️ 与项目写入的口径**故意不同**（§16.8）：
 * - 项目：只写“需要写的”（`plan.overrides`），未改动的行不进项目文件
 * - profile：导出矩阵里看到的**全部托管 agent**，含一个改动都没有的行
 *
 * 为什么：profile 是“下个项目铺开用的模板”。只导出会写的部分，等于把“这次写了几行”
 * 当成“这个项目的配置”，下次 `--from` 铺出来是个残缺模板。
 *
 * 排除项与 `planRebuild` 对齐：
 * - `unresolved`（上游已无 / 已禁用）与别名行：profile 里写了也无效
 * - `unmerged`（provider 条件层）：profile 格式没有这一层，写进去等于伪造
 * - 物化后为空：同上游，写不出东西就不导
 *
 * ⚠️ 必须在 `resetAfterSave` **之前**算（那会重算草稿）；返回深拷贝，调用方随后
 * `resetAfterSave` 不影响已算好的快照。
 */
export function profileSnapshot(rows: RebuildRowInput[]): Record<string, Override> {
	const out: Record<string, Override> = {};
	for (const row of rows) {
		if ((row.draft.kind ?? "agent") === "main") continue;
		const { classification } = row;
		if (classification.state === "unresolved" || classification.isAlias) continue;
		if (classification.state === "unmerged") continue;
		const entry = rowMaterialize(row);
		if (Object.keys(entry).length === 0) continue;
		out[row.name] = entry;
	}
	return out;
}

export function buildProfileDocument(
	entries: Record<string, Override>,
	main?: Override | undefined,
): { document: ProfileDocument; strippedModelFalse: string[]; droppedEntries: string[] } {
	const out: Record<string, Override> = {};
	const strippedModelFalse: string[] = [];
	const droppedEntries: string[] = [];
	for (const [name, entry] of Object.entries(entries)) {
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
	const document: ProfileDocument = { subagents: { agentOverrides: out } };
	if (main) {
		for (const key of MAIN_KEYS) {
			if (key in main && main[key] !== undefined) document[key] = main[key];
		}
	}
	return { document, strippedModelFalse, droppedEntries };
}

/**
 * 导出 profile：`{ defaultProvider?, defaultModel?, defaultThinkingLevel?, subagents: { agentOverrides } }`。
 *
 * `entries` 传 `profileSnapshot(...)` 的结果（整张矩阵快照），**不是** `plan.overrides` ——
 * 见 `profileSnapshot` 的理由。顶层三键只写项目层实际要写的（`main` 为 `undefined` 时不写）。
 */
export function writeProfile(profileFile: string, entries: Record<string, Override>, main?: Override | undefined): ProfileWriteResult {
	const { document, strippedModelFalse, droppedEntries } = buildProfileDocument(entries, main);
	writeJsonAtomic(profileFile, document);
	return { file: profileFile, strippedModelFalse, droppedEntries };
}

export type { RowContext, BulkFlag };

/** 保存结果（成功 ⇒ 摘要行；失败 ⇒ 错误文案，由调用方弹红条）。 */
export interface CommitResult {
	ok: boolean;
	message: string;
	/** 项目 settings **真的被重写**（等值内容早退 ⇒ 零改动时为 false）。 */
	wroteProject?: boolean;
	/** profile 文件已导出（导出总是落盘，profile = 整张矩阵快照）。 */
	wroteProfile?: boolean;
}
