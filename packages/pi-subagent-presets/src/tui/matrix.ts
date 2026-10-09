/**
 * @inobit/pi-subagent-presets — 主屏矩阵（§6.1、§6.2）。
 *
 * `extends Container implements Focusable` 并**自带 `handleInput`**：pi-tui 的
 * `Container` 只有 `children/addChild/removeChild/clear/invalidate/handleMouse/render`，
 * 没有 `handleInput` 成员。`ctx.ui.custom` 的 host 会自动 `setFocus`，显式调用可选但无害。
 *
 * 组件内状态机：`matrix`（主屏）→ `model`（选择器）→ `save`（保存屏）
 * → `json`（外部编辑器，需 `tui.stop()`，故由 index 注入回调）。
 *
 * 矩阵只有四列：`agent` / `model` / `thinking` / `state`。
 * - 字段没有值就显示**真正的空白**（不是 `-` / `inherit` / `—`）。
 * - 行级特殊态（`已禁用` / `⚠ 上游已禁用` / `⚠上游已无` / `🔒 provider 作用域`）
 *   **就地**挂在 agent 名上，不进 `state` 列；两种“上游已无”与“上游已禁用”行为相同、
 *   仅 `MISSING` 加删除线。
 * - `state` 只有 `GLOBAL` / `MERGE` / `OVERRIDE` 三个值，由**将写入对象里每个字段的
 *   来源**实时计算（`rowMergeState`），不持久化、不缓存、每帧重算。
 *
 * 显示值口径：输入 = 合并基底 ∪ 草稿（touched 的键用草稿值替换）。基底两层都没有该
 * 字段时**不回落到上游解析值**——那是定义层的值，显示它会让人误以为那是"配好的"。
 */

import { Container, truncateToWidth, visibleWidth, type Focusable, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	applyEditedEntry,
	resetParticipates,
	rowDirty,
	rowMergeState,
	type Draft,
	type FieldOrigin,
	type MatrixKey,
	type MergeState,
	type Override,
	type RowKind,
} from "../merge.ts";
import { applyMainEditedEntry } from "../main-row.ts";
import { agentCellText, isEditable, isStruckThrough, type BulkFlag, type RowClassification } from "../rowstate.ts";
import type { CommitResult, RebuildPlan } from "../writer.ts";
import { ModelPicker, type ModelChoice } from "./model-picker.ts";
import { SaveDialog, type SaveResult, type SaveWarning } from "./save-dialog.ts";
import { KEY_CTRL_C, KEY_DOWN, KEY_ENTER, KEY_ESC, KEY_SHIFT_TAB, KEY_UP } from "./keys.ts";
import { cycleThinkingLevel } from "../thinking.ts";
import type { ModelLike } from "../models.ts";

/** 删除线（`MISSING`：上游已无此 agent）。ANSI 序列不占显示宽度，但会计入 `.length`。 */
export const STRIKE_ON = "[9m";
export const STRIKE_OFF = "[29m";

/** `state` 列永不截断：最宽的值是 `OVERRIDE`（8 字符）。 */
export const STATE_COLUMN_WIDTH = 8;

/** `agent` 列的最小宽度：最长的内置名 `evidence-auditor`（16 字符）。 */
export const AGENT_COLUMN_MIN = 16;

const MODEL_COLUMN_MIN = 12;
/** model 列封顶：再长就截断（完整 id 在选择器 / 保存屏里看）。 */
const MODEL_COLUMN_MAX = 52;
const THINKING_COLUMN_MIN = 8;
/** thinking 列**固定宽度**：最长档名 8 + 空格 + `⚠>medium` 9 + 2 列间隙。 */
const THINKING_COLUMN_WIDTH = 19;
/** 顶部提示区固定行数（不足补空行，避免导航时整体高度变化）。 */

export interface MatrixRowView {
	name: string;
	/** 行种类（§16.3.1）：`main` = main 虚拟行（矩阵第 0 行），与 `draft.kind` 一致。 */
	kind: RowKind;
	classification: RowClassification;
	draft: Draft;
	merged: Override;
	/** 逐字段来源（`state` 列判定用）。 */
	origin: FieldOrigin;
	/** 全局层同名条目（`r` reset 后基底冻结为只取它）。 */
	globalEntry?: Override | undefined;
	/** 该行当前展示的 model（剥后缀后定位到的 registry Model，可 undefined）。 */
	locatedModel?: (ModelLike & Record<string, unknown>) | undefined;
	/** `agent.maxThinking`（L0 时由 settings 自读）。 */
	maxThinking: string | undefined;
	/** 完整的 model 串（未截断，副标题用；无值时为空串）。 */
	fullModelText: string;
	/** 已含 `inherit` / `⚠ 不在 registry` 标注；无值时为空串。 */
	modelText: string;
	/**
	 * model 串在当前 registry 里定位不到。
	 *
	 * v1 把它渲染成 `xxx (not in registry)` 后缀，擑占了 model 列的宽度、在窄终端里
	 * 把 thinking 挤到 state 列上，而且重复了 UI 已经能表达的信息。现在只靠颜色区分。
	 */
	modelUnresolved: boolean;
	/** 已 clamp；无值时为空串。 */
	thinkingText: string;
	/**
	 * 生效档位（**去掉了标注**）：后缀 > clamp 后 > 原始值。
	 * `shift+tab` 循环必须用它而不是 `thinkingText`——后者对无 model 行是
	 * `off (cannot clamp)`，`levels.indexOf(...)` 永远 -1 ⇒ 循环卡死在第一档。
	 */
	thinkingValue: string;
	overCeiling: boolean;
	/** 将被物化的非 model/thinking 字段（保存屏摘要用）。 */
	carriedKeys: string[];
	/** `e` 回填时产生的警告（保存屏汇总，只警告不阻止保存）。 */
	editWarnings: string[];
}

/** `e` 回调的返回值：整条编辑后的条目 + 只警告不阻止的校验结果。 */
export interface EditJsonResult {
	value: Override;
	warnings: string[];
}

export interface MatrixHeader {
	/** 黄条（不阻断）。 */
	notices: string[];
	/** 红条（上游抛错）。 */
	errors: string[];
}

export interface MatrixCallbacks {
	onDone: (result: { saved: boolean }) => void;
	onNeedRefresh: () => void;
	/** 打开外部编辑器（返回 undefined 表示取消 / 失败）。 */
	onEditJson: (row: MatrixRowView) => Promise<EditJsonResult | undefined>;
	/** 计算保存计划（可注入以便测试）。 */
	planSave: (rows: MatrixRowView[]) => { plan: RebuildPlan; warnings: SaveWarning[]; overCeilingAgents: string[] };
	/** 执行保存。 */
	onSave: (result: SaveResult, plan: RebuildPlan, warnings: SaveWarning[]) => Promise<CommitResult>;
}

export interface MatrixOptions {
	header: MatrixHeader;
	rows: MatrixRowView[];
	/** 强制重绘（pi 的 custom UI 不会因 handleInput 自动重绘）。 */
	requestRender?: () => void;
	/**
	 * 提示出口：接到 `ctx.ui.notify`（pi 的通知区），默认丢弃。
	 * 提示**不**渲染进矩阵（会随导航出现/消失，导致高度跳动）。
	 */
	notify?: (level: "info" | "warning" | "error", message: string) => void;
	models: readonly (ModelLike & Record<string, unknown>)[];
	keybindings: KeybindingsManager;
	theme: Theme;
	projectPath: string;
	profilePath: string;
	bulkFlags: BulkFlag[];
	untrusted: boolean;
	defaultProfileName: string;
	callbacks: MatrixCallbacks;
}

type Mode = "matrix" | "model" | "save";

/**
 * pi-tui 的 index 不导出 `TuiMouseDispatchResult`，但 `Container.handleMouse` 的
 * 返回类型就是它，所以从 `Container` 反推（而不是手写一个结构兼容的类型）。
 */
type MouseDispatchResult = ReturnType<Container["handleMouse"]>;

export class PresetsMatrix extends Container implements Focusable {
	focused = false;
	private readonly opts: MatrixOptions;
	private mode: Mode = "matrix";
	private rows: MatrixRowView[];
	private selectedIndex = 0;
	/**
	 * ⚠️ 原则：**提示类归 pi**。矩阵内部不写提示行（写了就会让高度跳动），
	 * 统一走这个回调 → `ctx.ui.notify`（pi 的通知区）。
	 */
	private notify!: (level: "info" | "warning" | "error", message: string) => void;
	private picker?: ModelPicker;
	private saveDialog?: SaveDialog;
	private dirtyConfirmPending = false;

	constructor(opts: MatrixOptions) {
		super();
		this.opts = opts;
		this.rows = [...opts.rows];
		// 提示默认丢弃（测试里可不接）；生产由 index.ts 接到 `ctx.ui.notify`
		this.notify = opts.notify ?? (() => {});
	}

	private get theme(): Theme {
		return this.opts.theme;
	}

	private currentRow(): MatrixRowView | undefined {
		return this.rows[this.selectedIndex];
	}

	override render(width: number): string[] {
		if (this.mode === "save" && this.saveDialog) return this.saveDialog.render(width);
		if (this.mode === "model" && this.picker) return this.picker.render(width);
		return this.renderMatrix(width);
	}

	private renderMatrix(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		const header = this.opts.header;
		lines.push(t.bold("Subagent presets"));
		lines.push("");
		// ⚠️ 这里**只**渲染 error（硬失败）。提示类一律走 `ctx.ui.notify`（pi 的通知区），
		//   状态类走行内紧凑标记 + state 列 —— 自定义 UI 里不堆散文。
		for (const error of header.errors) lines.push(t.fg("error", `✖ ${error}`));

		const columns = this.columnWidths(width);
		// 表头是**一行**（§6.1），前缀与数据行的 "→ " / "  " 对齐，两列之间不再换行
		lines.push(
			"  " +
				this.pad("agent", columns.agent, (s) => t.fg("dim", s)) +
				this.pad("model", columns.model, (s) => t.fg("dim", s)) +
				this.pad("thinking", columns.thinking, (s) => t.fg("dim", s)) +
				t.fg("dim", "state"),
		);

		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			if (!row) continue;
			const selected = i === this.selectedIndex;
			const prefix = selected ? "→ " : "  ";
			const missing = row.classification.state === "unresolved";
			// main 行恒走 `accent`（它永不可灰），agent 行保持 dim/accent 现状；
			// 置顶 + 其后空行分隔就是 main 的全部区分（§16.3.1，不加行级标记）。
			const style = (text: string): string => {
				if (missing) return t.fg("dim", text);
				return t.fg("accent", text);
			};
			const nameText = agentCellText(row.name, row.classification);
			// 定位不到 registry 的 model 用 warning 色（不用文字后缀）
			const modelStyle = (text: string): string => (row.modelUnresolved ? t.fg("warning", text) : style(text));
			const line =
				prefix +
				this.padCell(nameText, columns.agent, style, strikeOf(row)) +
				this.pad(row.modelText, columns.model, modelStyle) +
				this.pad(this.thinkingCellOf(row), columns.thinking, style) +
				style(this.stateTextOf(row));
			lines.push(selected ? t.bold(line) : line);
			// main 行固定第 0 行，其后一条空行分隔（只渲染，不占 `selectedIndex`）。
			if (i === 0 && isMainRow(row)) lines.push("");
		}

		// 下方区域**高度恒定**（1 空行 + 1 行状态 + footer），且只回答一件事：“整份配置改了东西、还没存”。
		// 其余上下文（完整 model id / 别名 / provider 作用域 / 上游已无 / 超上限 / 已重置）
		// 归 pi 的通知区或行内紧凑标记，不在这里堆。
		// 下方只留「1 空行 + 1 行状态 + footer」。
		// 之前这里堆了 dirty/carried 等多行（空行也算高度），导航时下半部分大片留白。
		lines.push("");
		lines.push(this.dirtyLine());
		lines.push(t.fg("dim", "↑↓ move   enter model   shift+tab thinking   r reset   e edit entry   S save   esc quit"));
		return lines;
	}

	/**
	 * 状态行：只回答一件事——**整份配置**有没有未保存修改（恒 1 行）。
	 *
	 * 口径与保存屏一致（同一个 `planSave`）：任一 agent 会写入或删除项目条目即算未保存。
	 * 被物化的非 model/thinking 字段不再在这里逐行罗列（那是行级说明，会随导航变形），
	 * 保存屏与 `e` 编辑器里都能看到。
	 */
	private dirtyLine(): string {
		return this.anyDirty() ? this.theme.fg("warning", "  ● unsaved changes") : "";
	}

	/**
	 * `state` 列的当前值（实时计算，不缓存）。
	 *
	 * 语义 = 将要写入项目条目的那个对象里字段的来源集合：改过 / 新增的字段算基底侧，
	 * 显式清空（键不写入）算全局侧。按过 `r` 时基底只剩全局层 ⇒ 恒为 `GLOBAL`，
	 * 改一个字段后立即变 `MERGE`。
	 */
	private stateTextOf(row: MatrixRowView): MergeState {
		return rowMergeState(row);
	}

	/** thinking 单元格：超 `maxThinking` 时追加硬上限标记（§6.1 的 `xhigh ⚠>medium`）。
	 *
	 * 标记是**运行期必失败**的唯一预兆，所以档位名让位、标记本身不截断。
	 */
	private thinkingCellOf(row: MatrixRowView): string {
		if (!row.overCeiling) return row.thinkingText;
		return `${row.thinkingText} ⚠>${row.maxThinking ?? "?"}`;
	}


	/**
	 * 同 `pad`，但可把**正文**（不含补白空格）另交给一个装饰器。
	 * 删除线必须只包住名字：把补白空格也包进去的话，终端会在整列空隙上画一条横线。
	 */
	private padCell(text: string, width: number, style: (t: string) => string, decorate?: (t: string) => string): string {
		// 与 `pad()` 同一套规则：内容宽 = `width`，右边距额外 1 空格
		const contentWidth = Math.max(1, width);
		// 宽度按 `visibleWidth` 算（CJK 占 2 列，`String.length` 会算窄）。截断符沿用 `…`。
		const truncated = visibleWidth(text) <= contentWidth ? text : truncateToWidth(text, contentWidth, "…");
		const body = decorate ? decorate(truncated) : truncated;
		return style(body + " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated))) + " ");
	}

	/**
	 * 左对齐截断 + 补空格。
	 *
	 * 截断在**未加样式**的文本上做：ANSI 序列不占显示宽度，但会计入 `.length`，
	 * 所以不能拿加过样式的串去算宽度。
	 */
	private pad(text: string, width: number, style: (text: string) => string): string {
		// ⚠️ `width` 是**内容宽**，右边距由本函数额外追加 1 个空格（不占内容宽）。
		//   这样每格恒为 `width + 1` 字符 ⇒ 跨行严格对齐；而列宽又是按最长内容算的，
		//   最长的那行正好填满内容宽、不会被 margin 挤掉一格。
		//   （曾经用 `Math.max(1, width - len)`：内容正好等宽时多补 1 格 ⇒ 那一行长 1，
		//     thinking 列看着没对齐；补 0 格又会两列糊在一起。）
		// 宽度按 `visibleWidth` 算（CJK 占 2 列，`String.length` 会算窄）。截断符沿用 `…`。
		const contentWidth = Math.max(1, width);
		const truncated = visibleWidth(text) <= contentWidth ? text : truncateToWidth(text, contentWidth, "…");
		return style(truncated) + " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated))) + " ";
	}

	/**
	 * 列宽分配：终端不够宽时**先压 model 列，再压 thinking 列**。
	 *
	 * `agent` 与 `state` 两列永不截断：前者要容纳最长的内置名 + 全部行级标记
	 * （` ⚠上游已无` / ` 已禁用` / ` 🔒 provider 作用域`），后者最宽 8 字符（`OVERRIDE`）。
	 * model / thinking 本来就设计成可截断 + 副标题看全文。
	 *
	 * ⚠ 宽度一律按**未加样式**的文本算：删除线的 ANSI 序列不占显示宽度但计入 `.length`，
	 * 拿 `agentCellText()` 的**未加装饰**版本去量（删除线不占显示宽度但计入 `.length`）。
	 */
	private columnWidths(width: number): { agent: number; model: number; thinking: number } {
		const agent = Math.max(AGENT_COLUMN_MIN, ...this.rows.map((row) => visibleWidth(agentCellText(row.name, row.classification))));
		// ⚠️ thinking 列宽**固定**，不按当前内容取。
		//   之前用 `max(thinkingCellOf(row).length)`，于是每按一次 shift+tab、值一变长
		//   整列宽度就变，model/state 两列**跟着左右跳**（观感极差）。
		//   固定值取“最长档名(8) + 空格 + ⚠>maxThinking(9) + 2 列间隙”。
		const thinking = THINKING_COLUMN_WIDTH;
		// "  " 前缀 + agent + state + 三处单列间隙
		const available = width - 2 - agent - STATE_COLUMN_WIDTH - 3;
		if (available < MODEL_COLUMN_MIN + THINKING_COLUMN_MIN) {
			return { agent, model: Math.max(4, Math.floor(available * 0.6)), thinking: Math.max(3, available - Math.max(4, Math.floor(available * 0.6))) };
		}
		// model 列**贴合内容**（封顶 MODEL_COLUMN_MAX），不吞掉剩余宽度。
		// 之前是 `model = available - thinking`，宽终端上 model 列能涨到 100+ 字符，
		// thinking/state 被推到最右边，中间一大片空白。现在列间距紧凑，多余宽度留白。
		const contentMax = Math.max(MODEL_COLUMN_MIN, ...this.rows.map((row) => visibleWidth(row.modelText)));
		const model = Math.min(MODEL_COLUMN_MAX, Math.max(MODEL_COLUMN_MIN, Math.min(contentMax, available - thinking)));
		return { agent, model, thinking };
	}

	/** 本次会被物化进项目文件的非 model/thinking 字段。 */
	private isRowDirty(row: MatrixRowView): boolean {
		return rowDirty(row);
	}

	handleInput(data: string): void {
		// ⚠️ pi 的 custom UI **不会**因为 `handleInput` 自动重绘：子组件调
		//   `invalidate()` 只清自己的渲染缓存，得显式 `requestRender()` 才会真正上屏。
		//   少了这一句，按键**其实生效了但屏幕不刷新**（表现为“enter 没反应，
		//   按别的键才看到结果”）。用 try/finally 保证任何分支都会重绘。
		try {
			switch (this.mode) {
				case "model":
					this.picker?.handleInput(data);
					return;
				case "save":
					this.saveDialog?.handleInput(data);
					return;
				case "matrix":
					break;
			}
			this.handleMatrixInput(data);
		} finally {
			this.opts.requestRender?.();
		}
	}

	private handleMatrixInput(data: string): void {
		const kb = this.opts.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(data, "app.thinking.cycle") || data === KEY_SHIFT_TAB) {
			this.cycleThinking();
			return;
		}
		if (data === KEY_ENTER) {
			void this.openModelPicker();
			return;
		}
		if (data === "r" || data === "R") {
			this.toggleReset();
			return;
		}
		if (data === "e" || data === "E") {
			void this.editJson();
			return;
		}
		if (data === "S") {
			void this.openSaveDialog();
			return;
		}
		if (data === KEY_ESC || data === KEY_CTRL_C) {
			if (this.anyDirty()) {
				if (this.dirtyConfirmPending) {
					this.opts.callbacks.onDone({ saved: false });
					return;
				}
				this.dirtyConfirmPending = true;
				this.notify("warning", "Unsaved changes — press esc again to discard and quit");
				this.invalidate();
				return;
			}
			this.opts.callbacks.onDone({ saved: false });
		}
	}

	// 矩阵本体是键盘驱动的（行高不定，无法可靠地把 y 坐标映射到行），鼠标一律不处理。
	override handleMouse(_event: TuiMouseEvent): MouseDispatchResult | undefined {
		return undefined;
	}

	private move(delta: number): void {
		if (this.rows.length === 0) return;
		const next = this.selectedIndex + delta;
		this.selectedIndex = next < 0 ? this.rows.length - 1 : next >= this.rows.length ? 0 : next;

		this.invalidate();
	}

	/**
	 * 「有没有未保存修改」是**整份配置**的属性，不是当前行的属性：
	 * 只要任一 agent 会写入或删除项目条目（含 main 行的顶层三键）就算未保存。
	 * 判定口径与保存屏一致（同一个 `planSave`），避免两处口径打架。
	 */
	private anyDirty(): boolean {
		try {
			const { plan } = this.opts.callbacks.planSave(this.rows);
			return plan.changed.length > 0 || plan.removals.length > 0 || plan.main.changed || plan.main.removal;
		} catch {
			// 计划算不出来时退回逐行判断（保守：有改动就当有改动）
			return this.rows.some((row) => this.isRowDirty(row));
		}
	}

	/**
	 * 改一个矩阵字段：标 `touched`。
	 *
	 * ⚠️ **不在这里清 `reset`**：reset 行改字段后重新参与重建（否则改的值会被静默
	 * 丢弃），但基底仍冻结在全局层（`merge.ts` 的 `rowBaseOf`）——这正是
	 * `GLOBAL ──改一个字段──▶ MERGE ──改完其余──▶ OVERRIDE` 那两步的来由。
	 */
	private touch(row: MatrixRowView, key: MatrixKey, value: unknown): void {
		row.draft[key] = value;
		row.draft.touched.add(key);
	}

	/**
	 * `r` = reset：这个 agent 不写项目条目，基底冻结为只取全局层。
	 *
	 * ⚠ 定位：reset 后 `state` 就是 `GLOBAL`，与“本来就没项目配置”的行在结果上完全
	 * 一致，所以**不渲染任何标记**，也**不再用 `r` 撤销**——`GLOBAL` 行上一律警告
	 * “无意义”。要让这行重新写进项目条目，改任一字段即可（基底仍只取全局层）。
	 */
	private toggleReset(): void {
		const row = this.currentRow();
		if (!row) return;
		if (!isEditable(row.classification.state, row.classification.isAlias)) {
			this.notify("warning", "This row cannot be changed");
			this.invalidate();
			return;
		}
		if (this.stateTextOf(row) === "GLOBAL") {
			this.notify("warning", `${row.name} is already GLOBAL — nothing to reset`);
			this.invalidate();
			return;
		}
		row.draft.reset = true;
		// 状态变化由 state 列表达；这里只做一次性提示（归 pi 的通知区）
		this.notify("info", `${row.name} reset — the project entry is removed, base falls back to the global layer`);
		// ⚠️ 必须重算：model / thinking 单元格是**视图里的缓存**，`state` 才是实时算的。
		//   漏掉这次刷新 ⇒ state 变 GLOBAL 但单元格还显示着旧值（看着像 reset 没生效）。
		this.opts.callbacks.onNeedRefresh();
		this.invalidate();
	}

	/** §3.6 环形切换；模型不可解析 ⇒ 覆盖 pi 默认的全 7 档（对齐 `agent-session.js` 的回落）。 */
	private cycleThinking(): void {
		const row = this.currentRow();
		if (!row) return;
		if (!isEditable(row.classification.state, row.classification.isAlias)) {
			this.notify("warning", "This row cannot be changed");
			this.invalidate();
			return;
		}
		// ⚠️ 用 `thinkingValue`（去标注的生效档位），**不能**用 `thinkingText`：
		// 无 model 行的 `thinkingText` 带 ` (cannot clamp)` 标注，拿去 `indexOf`
		// 永远得 -1，每次都算出 `levels[0]` ⇒ 循环卡死。
		const result = cycleThinkingLevel(row.thinkingValue, row.locatedModel);
		if (result.level === undefined) {
			this.notify("warning", result.reason ?? "Cannot cycle thinking");
			this.invalidate();
			return;
		}
		this.touch(row, "thinking", result.level);

		this.opts.callbacks.onNeedRefresh();
		this.invalidate();
	}

	private async openModelPicker(): Promise<void> {
		const row = this.currentRow();
		if (!row) return;
		if (!isEditable(row.classification.state, row.classification.isAlias)) {
			this.notify("warning", "This row cannot be changed");
			this.invalidate();
			return;
		}
		// ⚠ 不在这里刷新模型列表：刷新最多阻塞 5 秒，而结果没有消费方
		// （`this.opts.models` 始终是命令开始时的快照）——“按了 enter 没反应”的根源之一。
		this.mode = "model";
		this.clear();
		// main 行没有“跟随父会话”概念 ⇒ 隐藏 `inherit` 固定项（§16.3.1）。
		const main = isMainRow(row);
		this.picker = new ModelPicker({
			agentName: row.name,
			models: this.opts.models,
			currentText: row.modelText,
			currentValue: main ? mainPickerValue(row) : draftModelValue(row.draft),
			...(main ? { followParent: false } : {}),
			theme: this.theme,
			keybindings: this.opts.keybindings,
			onChoose: (choice) => this.applyModelChoice(row, choice),
			onCancel: () => this.backToMatrix(),
		});
		this.addChild(this.picker);
		this.invalidate();
	}

	private applyModelChoice(row: MatrixRowView, choice: ModelChoice): void {
		switch (choice.kind) {
			case "follow-parent":
				this.touch(row, "model", "inherit");
				break;
			case "model":
				if (isMainRow(row)) {
					// UI 选模型天然成对（§16.0 决策 2）：裸 id 进 model 列，provider 进 extra；
					// 落盘写 `defaultProvider=provider + defaultModel=id`，不做任何配对校验。
					this.touch(row, "model", choice.id);
					row.draft.extra.defaultProvider = choice.provider;
				} else {
					this.touch(row, "model", choice.value);
				}
				break;
		}
		this.backToMatrix();
	}

	/**
	 * `e` = 编辑**整条将写入的条目**（不是除 model/thinking 之外的字段）。
	 *
	 * 打开时内容 = 合并基底（reset 时只取全局层）+ 草稿里已改的值；回填时
	 * `model` / `thinking` 同步进草稿并标 `touched`——两处是同一份数据的两个视图。
	 * 校验**只警告**：绝不阻止保存、绝不改写用户的值。
	 */
	private async editJson(): Promise<void> {
		const row = this.currentRow();
		if (!row) return;
		if (!isEditable(row.classification.state, row.classification.isAlias)) {
			this.notify("warning", "This row cannot be changed");
			this.invalidate();
			return;
		}
		const next = await this.opts.callbacks.onEditJson(row);
		if (next === undefined) {
			this.notify("info", "Edit cancelled");
			this.invalidate();
			return;
		}
		// 只存草稿；行是否重新参与写盘由 `merge.ts` 的 `resetParticipates` 判定
		// （`e` 回填会把 model/thinking 标 touched ⇒ 行重新参与）
		// main 行回填三条真实键（`applyMainEditedEntry`），agent 行走 `applyEditedEntry`。
		if (isMainRow(row)) applyMainEditedEntry(row.draft, next.value);
		else applyEditedEntry(row.draft, next.value);
		// 校验只警告：保存屏会把这些行汇总出来
		row.editWarnings = next.warnings;
		this.notify(next.warnings.length > 0 ? "warning" : "info", next.warnings.length > 0 ? `${next.warnings.length} warning(s) from the JSON editor (not blocking)` : "Entry updated");
		this.opts.callbacks.onNeedRefresh();
		this.invalidate();
	}

	private backToMatrix(): void {
		this.mode = "matrix";
		this.picker = undefined;
		this.clear();
		this.opts.callbacks.onNeedRefresh();
		this.invalidate();
	}

	private async openSaveDialog(): Promise<void> {
		// ⚠️ `S` **总是**打开保存屏，不看有没有未保存修改：导出/改名 profile 是一个**独立目的**
		//   （profile = 整张矩阵快照，与“项目侧有没有待写入”解耦）。零改动时项目侧是空操作 ——
		//   `writeProjectSettings` 对等值内容早退、不改文件；保存屏会明确标注“nothing to write”。
		let plan: RebuildPlan;
		let warnings: SaveWarning[];
		let overCeilingAgents: string[];
		try {
			const computed = this.opts.callbacks.planSave(this.rows);
			plan = computed.plan;
			warnings = computed.warnings;
			overCeilingAgents = computed.overCeilingAgents;
		} catch (e) {
			this.notify("error", `Cannot build the save plan: ${e instanceof Error ? e.message : String(e)}`);
			this.invalidate();
			return;
		}
		this.mode = "save";
		this.clear();
		this.saveDialog = new SaveDialog({
			projectPath: this.opts.projectPath,
			profilePath: this.opts.profilePath,
			plan,
			warnings,
			bulkFlags: this.opts.bulkFlags,
			untrusted: this.opts.untrusted,
			overCeilingAgents,
			defaultProfileName: this.opts.defaultProfileName,
			theme: this.theme,
			onConfirm: (result) => {
				void this.commit(result, plan, warnings);
			},
			onCancel: () => this.backToMatrix(),
		});
		this.addChild(this.saveDialog);
		this.invalidate();
	}

	private async commit(result: SaveResult, plan: RebuildPlan, warnings: SaveWarning[]): Promise<void> {
		const outcome = await this.opts.callbacks.onSave(result, plan, warnings);
		this.mode = "matrix";
		this.saveDialog = undefined;
		this.clear();
		this.dirtyConfirmPending = false;
		// ⚠️ 提示一律走 pi 的通知区（原则：提示归 pi）。成功就一句“写到哪了”，不报摘要。
		if (outcome.ok) {
			this.notify("info", `Saved to ${this.savedTargetPath(result, outcome)}`);
			// 写盘后草稿会被 `resetAfterSave` 清空 ⇒ `e` 的警告也不该再留着
			for (const row of this.rows) row.editWarnings = [];
		} else {
			this.notify("error", outcome.message);
		}
		// 草稿的重置由 `resetAfterSave`（index 侧）统一做：它同时重算合并基底
		this.opts.callbacks.onNeedRefresh();
		this.opts.requestRender?.();
	}

	/** profile 名 ⇒ 完整路径（从默认 profile 路径反推目录，换名不换目录）。 */
	private profilePathFor(name: string): string {
		const dir = this.opts.profilePath.replace(/[/\\][^/\\]*$/, "");
		return `${dir}/${name}.json`;
	}

	/** 保存成功提示里的一句话：写到哪个文件（两个都写时用 `+` 连接）。 */
	private savedTargetPath(result: SaveResult, outcome?: CommitResult): string {
		// 只报**真的写了**的目标：零改动时项目侧是空操作（等值内容不重写文件）。
		const wroteProject = outcome?.wroteProject ?? result.writeProject;
		const wroteProfile = outcome?.wroteProfile ?? result.writeProfile;
		const parts: string[] = [];
		if (wroteProject) parts.push(this.opts.projectPath);
		if (wroteProfile) parts.push(this.profilePathFor(result.profileName));
		return parts.join(" + ");
	}

	/** 供 index 在保存后用新基线整表重建视图。 */
	replaceRows(rows: MatrixRowView[]): void {
		this.rows = [...rows];
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
		this.invalidate();
	}

	/** 当前全部行的视图快照（index 重算脏行时用）。 */
	currentViews(): MatrixRowView[] {
		return this.rows;
	}
}

/** 行种类：`MatrixRowView.kind`（必填，与 `draft.kind` 一致）。 */
function kindOfRow(row: MatrixRowView): RowKind {
	return row.kind;
}

/**
 * 是否 main 虚拟行：**只看 kind**，不按名字判。
 *
 * ⚠️ 不能拿 `row.name === MAIN_ROW_NAME` 兜底：`main` 是保留名（`config.ts` 的
 * `normalizeAgents` 会丢弃它），一旦真出现同名 agent，按名字判就会把它错认成虚拟行，
 * 它的项目条目会被当成"零贡献"删掉。同 `index.ts` 的 `isMainView` 口径。
 */
function isMainRow(row: MatrixRowView): boolean {
	return kindOfRow(row) === "main";
}

/**
 * main 行的选择器初值：touched 时由草稿拼 `provider/id`，否则用展示串
 * （`fullModelText` 即 `provider/id`，与列表 value 同一维度）。
 */
function mainPickerValue(row: MatrixRowView): string | false | undefined {
	if (row.draft.touched.has("model")) {
		const model = row.draft.model;
		if (typeof model !== "string" || model === "") return undefined;
		const provider = row.draft.extra.defaultProvider;
		return typeof provider === "string" && provider !== "" ? `${provider}/${model}` : model;
	}
	return row.fullModelText !== "" ? row.fullModelText : undefined;
}

/** 草稿里的 model 值 → 选择器初值（只有 string / false 有意义）。 */
function draftModelValue(draft: Draft): string | false | undefined {
	const value = draft.touched.has("model") ? draft.model : undefined;
	return typeof value === "string" || value === false ? value : undefined;
}

/** `MISSING`（上游已无）才加删除线；上游已禁用不加（agent 还在，只是被上游禁了）。 */
function strikeOf(row: MatrixRowView): ((text: string) => string) | undefined {
	if (!isStruckThrough(row.classification)) return undefined;
	return (text: string) => `${STRIKE_ON}${text}${STRIKE_OFF}`;
}

/** 导出供测试断言：当前行的 `state` 值。 */
export function stateTextOfRow(row: MatrixRowView): MergeState {
	return rowMergeState(row);
}
