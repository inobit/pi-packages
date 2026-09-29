/**
 * @inobit/pi-subagent-presets — 逐字段合并基底（§3.1）+ 草稿三态与 dirty 判定（§3.3）。
 *
 * 本模块是**纯函数**，不依赖 pi / pi-ai / 上游，只吃 settings 的裸 JSON。
 * 设计立场：我们只生成配置，pi-subagents 负责解释配置。因此这里**不建模上游解析
 * 行为**，唯一例外是"不物化"保护（判定在 rowstate.ts / writer.ts，理由见那里）。
 *
 * 基底只有**两层**：`base0`（项目条目 / `--from` 模板条目 / default profile）与全局层。
 * ⚠ **定义层不参与**：不写这个字段时上游本来就会用定义层的值兜底，把它物化等于把
 * 上游默认值钉死，而且显示定义层的值会让人误以为那是"配好的"。
 */

export type Override = Record<string, unknown>;

/** `model` / `thinking` 是矩阵的两列，走草稿三态；其余字段统称 extra。 */
export type MatrixKey = "model" | "thinking";
export const MATRIX_KEYS: readonly MatrixKey[] = ["model", "thinking"];

/**
 * 草稿。
 * - `touched` 区分三态：未触碰 / 显式清空（值为 undefined）/ 显式选值。
 * - `extra` 初值 = `merged` 中除 model/thinking 之外全部键的深拷贝。
 * - `reset` = 按过 `r`：基底冻结为只取全局层，**这一行不写项目条目**；改任一字段后
 *   行重新参与重建（`resetParticipates`），但基底仍是冻结的全局层。
 *   会话级标记，**不进写入对象、不持久化**。
 */
export interface Draft {
	name: string;
	/**
	 * 矩阵列的草稿值。类型是 `unknown` 而不是 `string | false | undefined`：
	 * `e` 里这两个键是**同一份数据**（§6.6 定位重做），而"只警告不阻止保存"要求
	 * 非法值照原样落盘，`null` / `123` 这类值不能被静默改写。`undefined` = 删键。
	 */
	model: unknown;
	thinking: unknown;
	touched: Set<MatrixKey>;
	extra: Override;
	reset: boolean;
}

/** 逐字段来源层：`base` 来自 base0（项目条目 / 模板条目），`global` 来自全局层。 */
export interface FieldOrigin {
	base: string[];
	global: string[];
}

export interface SynthesizeResult {
	merged: Override;
	/** 逐字段来源（供 `state` 列实时判定，不持久化、不缓存）。 */
	origin: FieldOrigin;
}

export interface SynthesizeOptions {
	/** `--from <name>` 命中时用它，否则用项目现有条目 / default profile。 */
	fromProfile?: Override | undefined;
	/** 项目现有条目（无 `--from` 时才参与基底）。 */
	projectEntry?: Override | undefined;
	/** default profile（无 `--from` 且项目无条目时）。 */
	defaultProfile?: Override | undefined;
	/** 全局 `~/.pi/agent/settings.json` 的同名条目。 */
	userEntry?: Override | undefined;
}

/**
 * §3.1 两层合并的合成部分，**同时输出逐字段来源**（`state` 列的判定依据）。
 *
 * 数据驱动（不枚举字段清单）：`base0 > user`，逐字段取第一个命中的层。
 * `base0 = fromProfile ?? (projectEntry ?? defaultProfile)`——`--from <name>` 加载指定配置、
 * 直接成为基底（项目现有条目不参与）；不带参数的纯命令才是「项目现有条目 ?? default profile」。
 * 不排除任何字段——`machine` / `tools` / `skills` / `acceptanceRole` 一视同仁。
 *
 * ⚠ 定义层（第 ③ 步）**不参与**：不写它，上游本来就会用定义层兜底。
 */
export function synthesizeDetailed(opts: SynthesizeOptions): SynthesizeResult {
	// `--from <name>` = 加载指定的配置：它**直接成为基底**，项目现有条目不参与。
	// 不带 `--from` 的纯命令才是：项目现有条目 ?? default profile。
	const base0: Override | undefined = opts.fromProfile ?? opts.projectEntry ?? opts.defaultProfile;
	const layers: (Override | undefined)[] = [base0, opts.userEntry];
	const keys = new Set<string>();
	for (const layer of layers) {
		if (!layer) continue;
		for (const key of Object.keys(layer)) keys.add(key);
	}
	const next: Override = {};
	const origin: FieldOrigin = { base: [], global: [] };
	for (const key of keys) {
		// 注意用 `in` 而不是 `!== undefined`：显式写 `false` / `null` 也是有效的"命中"。
		const hit = layers.find((layer) => layer != null && key in layer);
		if (!hit) continue;
		next[key] = hit[key];
		(hit === base0 ? origin.base : origin.global).push(key);
	}
	return { merged: next, origin };
}

/** 只要合并结果时用这个薄封装。 */
export function synthesize(opts: SynthesizeOptions): Override {
	return synthesizeDetailed(opts).merged;
}

/**
 * `state` 列的三值判定，**每帧实时重算**（不持久化、不缓存）。
 *
 * 语义 = **合并结果（= 将要写入项目条目的那个对象）里每个字段的来源集合**，
 * 用来预测“哪些字段会落到项目文件里、哪些会继续跟随全局”：
 *
 * | 值 | 含义 |
 * | --- | --- |
 * | `GLOBAL` | 全部字段跟随全局（或对象为空）——本扩展不产生任何覆盖 |
 * | `MERGE` | 一部分字段来自基底、一部分跟随全局 |
 * | `OVERRIDE` | 全部字段来自基底 |
 *
 * 逐字段的归类：
 * - 合并基底里、来自 base0（项目条目 / `--from` 模板 / default profile）的字段 ⇒ `base`
 * - 合并基底里、来自全局的字段 ⇒ `global`
 * - 草稿里 `touched` 且是显式选值（`model` / `thinking` 改过）⇒ `base`（你改的算项目侧）
 * - 草稿里 `touched` 且是显式清空（键不写入）⇒ `global`（键不落地，运行时由全局兜底）
 * - `e` 里改过或新增的其它字段 ⇒ `base`
 * - 未触碰的字段 ⇒ 按合并基底原本的来源
 *
 * 于是：`base` 侧无贡献（含基底与全局皆空、合并结果为空）⇒ `GLOBAL`；`global` 侧无贡献
 * ⇒ `OVERRIDE`；两侧都有 ⇒ `MERGE`。
 *
 * 演进链可读：`OVERRIDE` ──`r`(reset)──▶ `GLOBAL` ──改一个字段──▶ `MERGE`
 * ──改完其余──▶ `OVERRIDE`。
 *
 * ⚠️ **写盘判定跟着变**：项目条目存在 + 该行 `state === GLOBAL` ⇒ 该条目对最终结果
 * 没有任何贡献 ⇒ **必须删掉**（这正是 `r` 的效果）。见 writer.ts。
 */
export type MergeState = "GLOBAL" | "MERGE" | "OVERRIDE";

export interface MergeStateInput {
	/** 合并基底（不含草稿）。`r` reset 后由调用方传只取全局层的那一份。 */
	base: Override;
	/** 逐字段来源（`base` = base0 层，`global` = 全局层）。`r` reset 后传 base 侧为空的。 */
	origin: FieldOrigin;
	/** 草稿（判定哪些字段是"你改的"）。 */
	draft: Draft;
	/**
	 * `extra` 的"未改动"参照 = **草稿创建时的合并基底**（`row.merged`），不是 `base`。
	 *
	 * `r`(reset) 之后 `base` 冻结为只取全局层，而 `draft.extra` 仍来自原基底；
	 * 拿 `base` 当参照会把"其实没改过"误判成"改过"，reset 也就变不回 `GLOBAL`。
	 * 省略时按 `base` 处理（非 reset 场景两者等价）。
	 */
	extraRef?: Override | undefined;
}

export function mergeStateOf(input: MergeStateInput): MergeState {
	const { base, origin, draft } = input;
	const extraRef = input.extraRef ?? base;
	const result = materializeRow(base, draft);
	const fromBase = new Set<string>();
	const fromGlobal = new Set<string>();
	for (const key of Object.keys(result)) {
		if (isUserProvided(draft, extraRef, key)) fromBase.add(key);
		else if (origin.base.includes(key)) fromBase.add(key);
		else fromGlobal.add(key);
	}
	// 基底里有、结果里没有的键（显式清空 / 在 `e` 里删了）⇒ 不写入 ⇒ 运行时由全局兜底
	for (const key of Object.keys(base)) {
		if (!(key in result)) fromGlobal.add(key);
	}
	if (fromBase.size === 0) return "GLOBAL";
	if (fromGlobal.size === 0) return "OVERRIDE";
	return "MERGE";
}

/**
 * 该键是否是"你改的"（⇒ 计入 base 侧）。
 * 矩阵两列看 `touched`（显式选值算、显式清空不算——清空的键压根不在结果里）；
 * `e` 编辑的其它字段没有 touched 集合，按**与草稿原基底是否不同**判定。
 */
function isUserProvided(draft: Draft, extraRef: Override, key: string): boolean {
	if (key === "model" || key === "thinking") return draft.touched.has(key) && draft[key] !== undefined;
	if (!(key in draft.extra)) return false;
	return !deepEqualOverride(draft.extra[key], extraRef[key]);
}

/** 行级判定所需的输入（矩阵与 writer 共用同一口径，避免两处各算一份）。 */
export interface RowBaseInput {
	/** 合并基底（§3.1 的结果，不含草稿）。 */
	merged: Override;
	/** 逐字段来源（`state` 判定用）。 */
	origin: FieldOrigin;
	/** 全局层同名条目（`r` reset 后基底冻结为只取它）。 */
	globalEntry?: Override | undefined;
	draft: Draft;
}

/**
 * `r`(reset) 的**基底效果**：这一行的基底冻结为只取全局层。
 *
 * reset 是会话级意图“不要项目条遮住全局”，一旦用户又改了任何字段，它就不再是
 * “不写”而是“按这个新内容写”（`touched` 非空 ⇒ 行重新参与重建），**但基底仍然是
 * 冻结的全局层**：这正是 `state` 演进链
 * `OVERRIDE ──r──▶ GLOBAL ──改一个字段──▶ MERGE ──改完其余──▶ OVERRIDE` 的来由。
 * （旧实现让 reset 最先判定直接 `continue`，reset 之后改的值会被**静默丢弃**。）
 */
export function resetEffective(row: { draft: Draft }): boolean {
	return row.draft.reset;
}

/** 该行“将写入的基底”：reset 时冻结为只取全局层，否则就是合并基底。 */
export function rowBaseOf(row: RowBaseInput): Override {
	return effectiveBase(row.merged, row.globalEntry, resetEffective(row));
}

/** 逐字段来源：reset 时 base 侧清空。 */
export function rowOriginOf(row: RowBaseInput): FieldOrigin {
	return effectiveOrigin(row.origin, row.globalEntry, resetEffective(row));
}

/**
 * reset 行是否**重新参与重建**：改过任一字段（矩阵两列 `touched` 非空，或 `e` 改过
 * `extra`）就重新参与——否则用户改的值会被静默丢弃（回归项）。
 */
export function resetParticipates(row: { merged: Override; draft: Draft }): boolean {
	return row.draft.touched.size > 0 || !deepEqualOverride(row.draft.extra, initialExtra(row.merged));
}

/** `state` 列的三个值（`GLOBAL` / `MERGE` / `OVERRIDE`），每帧实时重算、不缓存。 */
export function rowMergeState(row: RowBaseInput): MergeState {
	return mergeStateOf({
		base: rowBaseOf(row),
		origin: rowOriginOf(row),
		draft: row.draft,
		// `extra` 的参照恒为草稿原基底（见 `MergeStateInput.extraRef` 的理由）
		extraRef: initialExtra(row.merged),
	});
}

/** 该行按当前草稿最终会写出的条目（`e` 的输入内容与写盘内容都用它）。 */
export function rowMaterialize(row: RowBaseInput): Override {
	return materializeRow(rowBaseOf(row), row.draft);
}

/** dirty 判定：`extra` 的参照是**草稿原基底**，与 `rowMergeState` 同一口径。 */
export function rowDirty(row: RowBaseInput): boolean {
	return isDirty(row.draft, initialExtra(row.merged));
}

/** `r`（reset）后基底冻结为只取全局层，逐字段来源也随之只剩 global 侧。 */
export function effectiveOrigin(origin: FieldOrigin, globalEntry: Override | undefined, reset: boolean): FieldOrigin {
	if (!reset) return origin;
	return { base: [], global: Object.keys(globalEntry ?? {}) };
}

/** `reset`（`r`）后基底冻结为只取全局层；未 reset 时就是原合并基底。 */
export function effectiveBase(merged: Override, globalEntry: Override | undefined, reset: boolean): Override {
	return reset ? (globalEntry ?? {}) : merged;
}

function cloneValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneValue);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneValue(v);
		return out;
	}
	return value;
}

export function deepCloneOverride(value: Override): Override {
	const out: Override = {};
	for (const [k, v] of Object.entries(value)) out[k] = cloneValue(v);
	return out;
}

/** 键序无关的深比较。裸 `JSON.stringify` 会因键序不同误判 dirty。 */
export function deepEqualOverride(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => deepEqualOverride(item, b[i]));
	}
	if (typeof a === "object" && typeof b === "object") {
		const ao = a as Record<string, unknown>;
		const bo = b as Record<string, unknown>;
		const ak = Object.keys(ao).sort();
		const bk = Object.keys(bo).sort();
		if (ak.length !== bk.length) return false;
		if (ak.some((k, i) => k !== bk[i])) return false;
		return ak.every((k) => deepEqualOverride(ao[k], bo[k]));
	}
	return false;
}

/** `extra` 的初值：合并基底里除 model/thinking 之外的全部键（深拷贝）。 */
export function initialExtra(merged: Override): Override {
	const extra: Override = {};
	for (const [k, v] of Object.entries(merged)) {
		if (k === "model" || k === "thinking") continue;
		extra[k] = cloneValue(v);
	}
	return extra;
}

/** 为一行构造初始草稿（未触碰态）。 */
export function createDraft(name: string, merged: Override): Draft {
	return {
		name,
		model: merged.model,
		thinking: merged.thinking,
		touched: new Set<MatrixKey>(),
		extra: initialExtra(merged),
		reset: false,
	};
}

/**
 * §3.3 dirty 三条判定，缺一不可。
 * 第 2 条（extra 有差异）是回归项：只按 `e` 改 tools 的行若不判 dirty 会被静默丢改动。
 */
export function isDirty(draft: Draft, baseExtra: Override): boolean {
	if (draft.reset) return true;
	if (draft.touched.size > 0) return true;
	return !deepEqualOverride(draft.extra, baseExtra);
}

/**
 * §3.3 `applyDraft`：把草稿叠到合并基底上。
 *
 * 遍历集合是 `union(keys(next), keys(extra))`：键在 next 里有、在 extra 里没有
 * ⇒ **删除该键**。否则用户在 `e` 里删键是静默 no-op（基底的同名字段会复活）。
 */
export function applyDraft(next: Override, draft: Draft): Override {
	// e 编辑出来的其它字段（用户主动行为，照写；含未知键）
	for (const [k, v] of Object.entries(draft.extra)) {
		if (k === "model" || k === "thinking") continue; // 这两个以矩阵值为准
		if (v === undefined) delete next[k];
		else next[k] = v;
	}
	// extra 里没有、但 next 里有的键 ⇒ 用户在 e 里删了它 ⇒ 一并删除
	for (const k of Object.keys(next)) {
		if (k !== "model" && k !== "thinking" && !(k in draft.extra)) delete next[k];
	}
	// model / thinking：只在 touched 时改写（undefined = 显式清空 = 删键）
	for (const k of MATRIX_KEYS) {
		if (!draft.touched.has(k)) continue;
		const v = draft[k];
		if (v === undefined) delete next[k];
		else next[k] = v;
	}
	return next;
}

/**
 * `e`（外部编辑器）回填：整条"将写入的条目"同步进草稿。
 *
 * `model` / `thinking` 与矩阵草稿是**同一份数据的两个视图**，所以这里把它们也写进
 * 草稿并标 `touched`（不允许"改了没反应"）；`e` 里删掉的键 = 该键不写入。
 */
export function applyEditedEntry(draft: Draft, edited: Override): void {
	for (const key of MATRIX_KEYS) {
		draft[key] = key in edited ? edited[key] : undefined;
		draft.touched.add(key);
	}
	const extra: Override = {};
	for (const [k, v] of Object.entries(edited)) {
		if (k === "model" || k === "thinking") continue;
		extra[k] = v;
	}
	draft.extra = extra;
}

/** 一行保存后的最终条目（等价 §7.1 里的 `synthesize` + `applyDraft` 两步）。 */
export function materializeRow(merged: Override, draft: Draft): Override {
	return applyDraft(deepCloneOverride(merged), draft);
}

/**
 * 未 dirty 且非新建的行 ⇒ 保留其现有值。
 *
 * 这里显式实现 §7.1 的 `keep existing` 分支：**不可物化的行（`state === "unmerged"`）
 * 也必须走这一支**——因为 `rebuilt` 是从空对象构建的，任何裸 `continue` 都等于
 * *删除*该 agent 原有的项目条目（实测 `{worker:{model:"p/m3"}}` + user 侧有 provider
 * 层，朴素 `continue` 保存后 `p/m3` 消失、回落 `u/m2`）。
 */
export function keepExisting(projectEntry: Override | undefined): Override | undefined {
	if (projectEntry === undefined) return undefined;
	if (Object.keys(projectEntry).length === 0) return undefined; // `{}` 空条目上游视为无条目，不写回
	return deepCloneOverride(projectEntry);
}
