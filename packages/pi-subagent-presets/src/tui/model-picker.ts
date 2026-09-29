/**
 * @inobit/pi-subagent-presets — 模型选择器（§6.3）。
 *
 * 基于 pi-tui 的 `SelectList` + `Input` 自实现：上游的 `SelectorComponent` 是
 * pi-subagents 内部件（`src/slash/selector.js`），`exports` 白名单不含 `./src/*`，
 * **不可导入**。
 *
 * 搜索框是 pi-tui 的 `Input`，**内联在列表上方、光标常驻**（对齐 pi 自己的
 * `/model` 选择器），不再是"按 `/` 进输入模式"。导航键（↑↓ / enter / esc）由本组件
 * 先吃掉，其余按键全部交给 `Input`，每次改动后按 `fuzzyFilter` 重建可见列表。
 *
 * ⚠️ `SelectList.setFilter` 只做 `value.startsWith` 前缀匹配，不是 fuzzy，所以过滤
 * 必须自己做（用 `fuzzyFilter` 算可见项再重建 `SelectList`）。**过滤后列表恒非空**：
 * `Inherit` / `Follow parent session model` 两行不参与过滤，永远是退路。
 */

import {
	Container,
	fuzzyFilter,
	Input,
	SelectList,
	type Focusable,
	type SelectItem,
	type SelectListTheme,
	type TuiMouseEvent,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { fullModelId, type ModelLike } from "../models.ts";
import { KEY_CTRL_C, KEY_DOWN, KEY_ENTER, KEY_ESC, KEY_NEWLINE, KEY_UP } from "./keys.ts";

/**
 * 选项 value 的编码前缀。
 *
 * ⚠️ v7 起**没有**「删键 / None」这一项：`model` 一旦不写，对 **builtin** agent 而言
 * 全局条目会被**整体替换**掉（`applyBuiltinOverrides`：项目条目一旦存在就直接 return，
 * 全局条目根本不参与），运行期回落链变成 定义 → `subagents.defaultModel` → 父会话模型。
 * 那个值不是用户能通过本选项表达的，所以不提供；要「这个 agent 不写 model」请用 `r`
 * reset 整行，或在 `e` 里自己删键。
 */
export const FOLLOW_PARENT_KEY = "__follow_parent__";
export const MODEL_PREFIX = "model:";

/**
 * pi-tui 的 index 不导出 `TuiMouseDispatchResult`，但 `Container.handleMouse` 的
 * 返回类型就是它，所以从 `Container` 反推（而不是手写一个结构兼容的类型）。
 */
type MouseDispatchResult = ReturnType<Container["handleMouse"]>;

export type ModelChoice =
	| { kind: "follow-parent" }
	| { kind: "model"; value: string };

export function encodeModelChoice(choice: ModelChoice): string {
	switch (choice.kind) {
		case "follow-parent":
			return FOLLOW_PARENT_KEY;
		case "model":
			return `${MODEL_PREFIX}${choice.value}`;
	}
}

export function decodeModelChoice(raw: string): ModelChoice {
	if (raw === FOLLOW_PARENT_KEY) return { kind: "follow-parent" };
	return { kind: "model", value: raw.slice(MODEL_PREFIX.length) };
}

export interface ModelPickerOptions {
	agentName: string;
	models: readonly (ModelLike & Record<string, unknown>)[];
	/** 当前显示值（标题里印，含 inherit / ⚠ 标注）。 */
	currentText: string;
	/** 当前草稿值：`undefined`（删键）/ `"inherit"`（跟随父会话）/ 具体 id。 */
	currentValue: string | false | undefined;
	theme: Theme;
	keybindings: KeybindingsManager;
	onChoose: (choice: ModelChoice) => void;
	onCancel: () => void;
}

function selectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (t) => `> ${t}`,
		selectedText: (t) => t,
		description: (t) => t,
		scrollInfo: (t) => t,
		noMatch: (t) => t,
	};
}

const MAX_VISIBLE = 15;

/**
 * 列表顶部的唯一固定项（不参与过滤，常驻置顶）。
 *
 * `inherit` 是上游的哨兵值（`runs/shared/model-resolution.js` 的 `INHERIT_MODEL`）
 * ⇒ 直接用父会话模型，**跳过** `subagents.defaultModel`。
 *
 * v7 起不再提供「删键 / None」项：对 builtin agent 而言不写 `model` 键并不是
 * 「用全局那个值」，而是掉到 agent 定义 → `subagents.defaultModel` → 父会话模型。
 * （`model: false` 上游等价于 `delete next.model`，同样不单列。）
 */
function fixedItems(): SelectItem[] {
	// `inherit` 就是**真正的 model id**（上游 `INHERIT_MODEL` 哨兵），与模型列表里的
	// `provider/id` 同一维度；括号里说明它的语义。删除键 / 跟随父会话是**两件事**。
	return [{ value: FOLLOW_PARENT_KEY, label: "inherit", description: "(uses the parent session model, skips subagents.defaultModel)" }];
}

/** 固定项数量（选择索引空间：0..FIXED_COUNT-1 是固定项，之后是模型）。 */
const FIXED_COUNT = 1;

export class ModelPicker extends Container implements Focusable {
	private _focused = false;
	private readonly opts: ModelPickerOptions;
	/** 全部模型行（过滤只在这一组上做）。 */
	private readonly modelItems: SelectItem[];
	private readonly searchInput: Input;
	private list: SelectList;
	/** 选中的是固定项时记其下标（0/1）；`null` = 选中在模型列表里。 */
	private fixedSelected: number | null = null;

	constructor(opts: ModelPickerOptions) {
		super();
		this.opts = opts;
		const currentId = typeof opts.currentValue === "string" && opts.currentValue !== "inherit" ? opts.currentValue : undefined;
		const known = new Set<string>();
		const modelItems: SelectItem[] = [];
		for (const model of opts.models) {
			const id = fullModelId(model);
			known.add(id);
			// 不加 `[provider]` 描述列：完整 id 本身就以 provider 段开头（`ino2api/…`），
			// 那一列是冗余的，却要吃掉 ~10 字符，导致长 id 被截断。
			// 本页只有「id + 说明」两列，宽度全给 id。
			modelItems.push({ value: `${MODEL_PREFIX}${id}`, label: id, description: "" });
		}
		// 当前值不在列表中 ⇒ 原样保留为一个选项并标注，不静默替换
		if (currentId && !known.has(currentId)) {
			modelItems.push({ value: `${MODEL_PREFIX}${currentId}`, label: currentId, description: "(not in registry)" });
		}
		this.modelItems = modelItems;

		this.searchInput = new Input({ prompt: "/ ", placeholder: "search models" });
		this.searchInput.onSubmit = () => this.selectCurrent();
		this.addChild(this.searchInput);

		const target = currentTarget(opts.currentValue);
		if (target === FOLLOW_PARENT_KEY) {
			this.fixedSelected = 0;
			this.list = this.buildList(undefined);
		} else {
			this.list = this.buildList(target);
		}
		this.addChild(this.list);
	}

	/** Focusable：把焦点透给搜索框（IME 光标定位需要它）。 */
	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	/** 过滤后的可见模型行（不含固定行）。 */
	private visibleModelItems(): SelectItem[] {
		const query = this.searchInput.getValue().trim();
		if (!query) return this.modelItems;
		return fuzzyFilter(this.modelItems, query, (item) => item.label);
	}

	private buildList(selectedValue: string | undefined): SelectList {
		// ⚠️ 只装**模型**：固定两项由 `renderFixedRows` 常驻置顶。
		//   之前它们混在列表里，列表一长（500+ 模型）就被滚出视野——
		//   选完模型返回、再进来时 `inherit` 看不见了。
		const items = this.visibleModelItems();
		// `maxPrimaryColumnWidth` 放宽：完整 model id 是这一页的主要信息，
		// 不该因为终端窄就截掉（说明列已经去掉了冗余的 [provider]）。
		const list = new SelectList(items, MAX_VISIBLE, selectListTheme(), { maxPrimaryColumnWidth: 56 });
		list.onSelect = (item) => {
			this.opts.onChoose(decodeModelChoice(item.value));
		};
		list.onCancel = () => this.opts.onCancel();
		if (selectedValue !== undefined) {
			const index = items.findIndex((item) => item.value === selectedValue);
			if (index >= 0) list.setSelectedIndex(index);
		}
		return list;
	}

	/**
	 * 搜索词变化后重建列表。
	 *
	 * 有搜索词时光标直接落在**第一个匹配的模型**上（固定两行不参与过滤，不能让 enter
	 * 误选 `Inherit`）；没有搜索词时回到当前值那一行。
	 */
	private rebuildList(): void {
		const query = this.searchInput.getValue().trim();
		// 有搜索词时光标落到第一个匹配模型（固定项不参与过滤，不能让 enter 误选 `inherit`）
		const models = this.visibleModelItems();
		const target = query ? models[0]?.value : currentTarget(this.opts.currentValue);
		// 选中落在哪儿：
		// - 零匹配 ⇒ 没有模型可选 ⇒ 回落到唯一固定项（`inherit`），
		//   否则选中态无处安放，enter 会“什么都没发生”。
		// - 当前值本身就是固定项（`inherit`）⇒ 选中它。
		// - 其余（无搜索词且当前值是某模型 / 有搜索词）⇒ 选中模型。
		let fixed: number | null = null;
		if (query && models.length === 0) fixed = 0;
		else if (target === FOLLOW_PARENT_KEY) fixed = 0;
		this.fixedSelected = fixed;
		const next = this.buildList(fixed === null ? target : undefined);
		this.removeChild(this.list);
		this.list = next;
		this.addChild(next);
		this.invalidate();
	}

	private selectCurrent(): void {
		if (this.fixedSelected !== null) {
			const item = fixedItems()[this.fixedSelected];
			if (item) this.opts.onChoose(decodeModelChoice(item.value));
			return;
		}
		const item = this.list.getSelectedItem();
		if (!item) return;
		this.opts.onChoose(decodeModelChoice(item.value));
	}

	override render(width: number): string[] {
		const t = this.opts.theme;
		const lines: string[] = [];
		lines.push(t.bold(`Select model for ${this.opts.agentName}`));
		lines.push(t.fg("muted", `current: ${this.opts.currentText || "—"}`));
		lines.push("");
		for (const line of this.searchInput.render(width)) lines.push(line);
		lines.push("");
		for (const line of this.renderFixedRows(width, t)) lines.push(line);
		const listLines = this.list.render(width);
		if (this.fixedSelected !== null) {
			// 光标在固定项上 ⇒ 模型列表不能同时画一个（否则整页两个 `→`）。
			// `SelectList` 总会给自己的 selectedIndex 画前缀，这里抹掉那一处。
			const at = listLines.findIndex((entry: string) => entry.startsWith("→ "));
			if (at >= 0) {
				const row = listLines[at] as string;
				listLines[at] = `  ${row.slice(2)}`;
			}
		}
		for (const line of listLines) lines.push(line);
		lines.push("");
		lines.push(t.fg("dim", "type to filter   ↑↓ move   enter select   esc back"));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.opts.keybindings;
		if (kb.matches(data, "tui.select.up") || data === KEY_UP) {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === KEY_DOWN) {
			this.move(1);
			return;
		}
		if (data === KEY_ENTER || data === KEY_NEWLINE) {
			this.selectCurrent();
			return;
		}
		if (data === KEY_ESC || data === KEY_CTRL_C) {
			this.opts.onCancel();
			return;
		}
		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== before) this.rebuildList();
	}

	/** 上下移动：在「固定项 + 可见模型」这一个索引空间里环形走。 */
	private move(delta: number): void {
		const total = FIXED_COUNT + this.visibleModelItems().length;
		if (total === 0) return;
		this.setSelectedIndex(this.selectedIndex() + delta);
	}

	/** 当前选中项在「固定项 + 模型」空间里的下标。 */
	private selectedIndex(): number {
		if (this.fixedSelected !== null) return this.fixedSelected;
		const models = this.visibleModelItems();
		const item = this.list.getSelectedItem();
		const index = item ? models.findIndex((entry) => entry.value === item.value) : -1;
		return FIXED_COUNT + Math.max(0, index);
	}

	private setSelectedIndex(next: number): void {
		const total = FIXED_COUNT + this.visibleModelItems().length;
		if (total === 0) return;
		const wrapped = ((next % total) + total) % total;
		if (wrapped < FIXED_COUNT) {
			this.fixedSelected = wrapped;
			this.list.setSelectedIndex(0);
		} else {
			this.fixedSelected = null;
			this.list.setSelectedIndex(wrapped - FIXED_COUNT);
		}
		this.invalidate();
	}

	/** 固定两行 + 分隔线（**常驻置顶**，不随模型列表滚动）。 */
	private renderFixedRows(width: number, t: Theme): string[] {
		const items = fixedItems();
		const labelWidth = Math.max(...items.map((item) => item.label.length));
		const lines = items.map((item, i) => {
			const selected = this.fixedSelected === i;
			const prefix = selected ? "→ " : "  ";
			const label = item.label.padEnd(labelWidth);
			const row = `${prefix}${label}  ${item.description ?? ""}`;
			return selected ? t.bold(truncateToWidth(row, width)) : t.fg("muted", truncateToWidth(row, width));
		});
		lines.push(t.fg("dim", `  ${"─".repeat(Math.max(4, Math.min(width - 2, labelWidth + 2)))}`));
		return lines;
	}


	override handleMouse(event: TuiMouseEvent): MouseDispatchResult | undefined {
		return this.list.handleMouse(event) as MouseDispatchResult | undefined;
	}

	/** 供测试断言：当前过滤后可见的**模型**行数。 */
	visibleModelCount(): number {
		return this.visibleModelItems().length;
	}

	/** 供测试断言：当前光标落在哪个 value 上。 */
	/** 当前选中项的 value（固定项与模型统一口径）。 */
	selectedValue(): string | undefined {
		if (this.fixedSelected !== null) return fixedItems()[this.fixedSelected]?.value;
		return this.list.getSelectedItem()?.value ?? undefined;
	}

	/** 供测试断言：搜索框当前内容。 */
	searchText(): string {
		return this.searchInput.getValue();
	}
}

/**
 * 当前草稿值 ⇒ 打开选择器时的初始选中项。
 *
 * `undefined`（这一行不写 model）**不再**映射到任何固定项 —— `None` 已删除，
 * 没有「无值」这个可选项，直接不预选（光标落在第一个模型上）。
 */
function currentTarget(value: string | false | undefined): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value === "inherit" ? FOLLOW_PARENT_KEY : `${MODEL_PREFIX}${value}`;
}
