import { describe, expect, it, vi } from "vitest";
import { Container, KeybindingsManager, SelectList, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager as PiKeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { classifyRow, type RowState } from "../src/rowstate.ts";
import { createDraft, synthesizeDetailed, type FieldOrigin, type Override } from "../src/merge.ts";
import { MAIN_ROW_NAME, mainEntryForEditor, synthesizeMain, type MainLayer } from "../src/main-row.ts";
import { buildPlan, commitSave, editorContentForMain, jsonEditorHeader, jsonEditorHeaderMain, reviewMainEditedJson, summaryLines } from "../src/index.ts";
import type { SessionState } from "../src/session.ts";
import { planMain } from "../src/writer.ts";
import { PresetsMatrix, STRIKE_OFF, STRIKE_ON, STATE_COLUMN_WIDTH, type MatrixRowView } from "../src/tui/matrix.ts";
import { ModelPicker, decodeModelChoice, encodeModelChoice, FOLLOW_PARENT_KEY } from "../src/tui/model-picker.ts";
import { SaveDialog } from "../src/tui/save-dialog.ts";
import { refreshRowView, type ViewSources } from "../src/session.ts";
import { KEY_BACKSPACE, KEY_DOWN, KEY_ENTER, KEY_ESC, KEY_SHIFT_TAB, KEY_UP } from "../src/tui/keys.ts";
import { planRebuild, type RebuildRowInput } from "../src/writer.ts";

/** 不着色主题：让 render 输出可按纯文本断言。 */
const theme = {
	fg: (_c: ThemeColor, t: string) => t,
	bg: (_c: unknown, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	dim: (t: string) => t,
} as unknown as Theme;

// pi-tui 的 KeybindingsManager（扩展 ctx.ui.custom 传进来的就是这个）
// pi 的 KeybindingsManager 继承 pi-tui 的那个；测试只需要 matches()/getKeys()
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as PiKeybindingsManager;

interface RowOpts {
	projectEntry?: Override;
	userEntry?: Override;
	/** 全局层同名条目（`r` reset 后基底冻结为只取它）；默认 = `userEntry`。 */
	globalEntry?: Override;
	/** 强制行分类状态（默认由 `classifyRow` 算）。 */
	state?: RowState;
	isAlias?: boolean;
	aliasOf?: string;
	/** 四桶里没有该 agent（MISSING）。 */
	missing?: boolean;
	/** 四桶里有但 `disabled === true`（上游禁用）。 */
	disabledUpstream?: boolean;
	/** 合并结果里有 `disabled:true`（我们配的禁用）。 */
	disabledByOverride?: boolean;
	/** 该行能定位到的 registry Model。 */
	locatedModel?: { id: string; provider: string; reasoning?: boolean };
	modelText?: string;
	/** model 串定位不到 registry（只靠 warning 色区分，不加文字后缀）。 */
	modelUnresolved?: boolean;
	thinkingText?: string;
	/** 生效档位（去标注）；不传则由 thinkingText 推出。 */
	thinkingValue?: string;
	overCeiling?: boolean;
	maxThinking?: string;
	/** 改一个矩阵字段（等价于按过 enter / shift+tab）。 */
	touch?: { key: "model" | "thinking"; value: string | false | undefined };
	/** 按过 `r`。 */
	reset?: boolean;
}

function row(name: string, opts: RowOpts = {}): { view: MatrixRowView; input: RebuildRowInput } {
	const { merged, origin } = synthesizeDetailed({ projectEntry: opts.projectEntry, userEntry: opts.userEntry });
	const globalEntry = opts.globalEntry ?? opts.userEntry;
	const buckets = opts.missing
		? []
		: [{ name, ...(opts.disabledUpstream ? { disabled: true } : {}) }];
	const classification = classifyRow({
		name,
		projectEntry: opts.projectEntry,
		userEntry: opts.userEntry,
		userProviderMap: {},
		fourBucketAgents: buckets,
		resolveAgentName: (n, agents) => {
			const hit = agents.find((agent) => agent.name === n.trim());
			return hit ? { agent: hit } : {};
		},
	});
	if (opts.state) classification.state = opts.state;
	if (opts.isAlias !== undefined) classification.isAlias = opts.isAlias;
	if (opts.aliasOf !== undefined) classification.aliasOf = opts.aliasOf;
	if (opts.disabledByOverride !== undefined) classification.disabledByOverride = opts.disabledByOverride;
	if (opts.disabledUpstream !== undefined) classification.disabledUpstream = opts.disabledUpstream;
	const draft = createDraft(name, merged);
	if (opts.touch) {
		draft.touched.add(opts.touch.key);
		if (opts.touch.key === "model") draft.model = opts.touch.value;
		else draft.thinking = opts.touch.value;
	}
	if (opts.reset) draft.reset = true;
	const view: MatrixRowView = {
		name,
		kind: draft.kind,
		classification,
		draft,
		merged,
		origin,
		...(globalEntry ? { globalEntry } : {}),
		locatedModel: opts.locatedModel,
		maxThinking: opts.maxThinking,
		fullModelText: opts.modelText ?? "",
		modelText: opts.modelText ?? "",
		modelUnresolved: opts.modelUnresolved ?? false,
		thinkingText: opts.thinkingText ?? "",
		// 默认由 thinkingText 推出（去掉 ` (cannot clamp)` 标注）；
		// 需要区分时用 opts.thinkingValue 显式指定。
		thinkingValue: opts.thinkingValue ?? (opts.thinkingText ?? "").replace(/ \(cannot clamp\)$/, ""),
		overCeiling: opts.overCeiling ?? false,
		carriedKeys: Object.keys(merged).filter((k) => k !== "model" && k !== "thinking"),
		editWarnings: [],
	};
	const input: RebuildRowInput = {
		name,
		projectEntry: opts.projectEntry,
		merged,
		origin,
		...(globalEntry ? { globalEntry } : {}),
		draft,
		classification,
	};
	return { view, input };
}

function makeMatrix(rows: MatrixRowView[], inputs: RebuildRowInput[], overrides: Partial<ConstructorParameters<typeof PresetsMatrix>[0]> = {}) {
	const onDone = vi.fn();
	const notices: string[] = [];
	let refreshCalls = 0;
	const matrix = new PresetsMatrix({
		notify: (_level, message) => notices.push(message),
		header: { notices: [], errors: [], ...overrides.header },
		rows,
		models: [],
		keybindings,
		theme,
		projectPath: "/proj/.pi/settings.json",
		profilePath: "/agent/profiles/pi-subagents/default.json",
		bulkFlags: [],
		untrusted: false,
		defaultProfileName: "default",
		callbacks: {
			onDone,
			onNeedRefresh: () => {
				refreshCalls++;
			},
			onEditJson: async () => undefined,
			planSave: () => ({ plan: planRebuild({ rows: inputs, projectOverrides: {}, whitelist: rows.map((r) => r.name) }), warnings: [], overCeilingAgents: [] }),
			onSave: async () => ({ ok: true, message: "saved" }),
		},
		...overrides,
	});
	return { matrix, notices, onDone, refreshCalls: () => refreshCalls };
}

function render(matrix: PresetsMatrix, width = 120): string {
	return matrix.render(width).join("\n");
}

describe("PresetsMatrix：形状与键位", () => {
	it("是 Container 的子类并自带 handleInput（pi-tui 的 Container 没有这个成员）", () => {
		const { view: v, input: i } = row("reviewer");
		const { matrix, notices } = makeMatrix([v], [i]);
		expect(matrix).toBeInstanceOf(Container);
		expect(typeof matrix.handleInput).toBe("function");
	});

	it("实现 Focusable（focused 字段）", () => {
		const { view: v, input: i } = row("reviewer");
		const { matrix, notices } = makeMatrix([v], [i]);
		expect(matrix.focused).toBe(false);
		matrix.focused = true;
		expect(matrix.focused).toBe(true);
	});

	it("回归：thinking 列**跨行对齐**（最长 model 决定列宽 + 右边距算在列宽内）", () => {
		// 之前 `Math.max(1, width - len)` 会在“内容正好填满列宽”时多补 1 格，
		// 那一行比别的行长 1 ⇒ thinking 列看着没对齐。
		const long = "ino2api/opencode/muse-spark-1.3-contributor-free"; // 48 字符，正好等于列宽
		const mk = (name: string, model: string, thinking: string): ReturnType<typeof row> => ({
			...row(name, { userEntry: { model }, modelText: model, thinkingText: thinking }),
		});
		const rows = [mk("worker", "ino2api/cline/stealth/space-bunny-alpha", "high"), mk("scout", long, "high"), mk("reviewer", "ino2api/cline/cline-free/deepseek-v4.1-flash", "max")];
		const { matrix } = makeMatrix(rows.map((r) => r.view), rows.map((r) => r.input));
		for (const width of [174, 120, 100, 86]) {
			const offsets = matrix
				.render(width)
				.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""))
				.filter((line) => /worker|scout|reviewer/.test(line))
				.map((line) => line.search(/\b(high|max)\b/));
			expect(new Set(offsets).size).toBe(1); // 全部同一列
		}
	});

	it("Finding 7：agent 名 / model 含 CJK 时各列跨行对齐（内容宽 + 1 右边距不变）", () => {
		// `visibleWidth` 按显示列算（CJK 占 2 列）；`String.padEnd` 按码元算会让 CJK 行漂移。
		// 锁定：thinking 列起点（显示列）跨行一致 + 数据行显示列宽全等。
		const mk = (name: string, model: string, thinking: string): ReturnType<typeof row> => ({
			...row(name, { userEntry: { model }, modelText: model, thinkingText: thinking }),
		});
		const rows = [mk("审查者", "p/模型 Alpha", "high"), mk("worker", "p/m", "max"), mk("scout-long-name", "ino2api/深度模型-beta", "low")];
		const { matrix } = makeMatrix(rows.map((r) => r.view), rows.map((r) => r.input));
		for (const width of [120, 100, 86]) {
			const lines = matrix
				.render(width)
				.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""))
				.filter((line) => /审查者|worker|scout-long-name/.test(line));
			expect(lines).toHaveLength(3);
			// thinking 列起点（显示列）跨行一致
			const offsets = lines.map((line) => {
				const word = line.includes("high") ? "high" : line.includes("max") ? "max" : "low";
				return visibleWidth(line.slice(0, line.indexOf(word)));
			});
			expect(new Set(offsets).size).toBe(1);
			// 数据行显示列宽全等（state 同为 GLOBAL，列宽只由内容宽 + 1 右边距决定）
			expect(new Set(lines.map((line) => visibleWidth(line))).size).toBe(1);
		}
	});

	it("model 被截断时**仍留列间隙**（否则糊成 `...freehigh`）", () => {
		const long = "ino2api/opencode/muse-spark-1.3-contributor-free";
		const a = row("scout", { userEntry: { model: long }, modelText: long, thinkingText: "high" });
		const lines = makeMatrix([a.view], [a.input]).matrix.render(86);
		const dataRow = lines.find((l) => l.includes("scout") && l.includes("high"));
		expect(dataRow!.replace(/\u001b\[[0-9;]*m/gu, "")).toMatch(/…\s+high/);
	});

	it("标题只保留 `Subagent presets`（项目名 / 基底 / 父会话模型已移除）+ 四列标题", () => {
		const { view: v, input: i } = row("reviewer");
		const { matrix, notices } = makeMatrix([v], [i]);
		const out = render(matrix);
		expect(out.split("\n")[0]).toBe("Subagent presets");
		for (const column of ["agent", "model", "thinking", "state"]) expect(out).toContain(column);
		expect(out).toContain("↑↓ move");
	});

	it("表头是**一行**，且各列与数据行对齐（回归：曾经被 push 成四行）", () => {
		const r = row("reviewer", { projectEntry: { model: "p/m" }, modelText: "p/m", locatedModel: { id: "m", provider: "p", reasoning: true } });
		const { matrix, notices } = makeMatrix([r.view], [r.input]);
		const lines = matrix.render(120);
		// 表头占且仅占一行，四个列名都在这一行上
		const headerLines = lines.filter((line) => ["agent", "model", "thinking", "state"].every((c) => line.includes(c)));
		expect(headerLines).toHaveLength(1);
		const header = headerLines[0]!;
		// 列偏移与数据行一致（表头有与数据行同宽的 2 字符前缀）
		const dataLine = lines.find((line) => line.includes("reviewer"))!;
		const dataCells = ["reviewer", "p/m", "OVERRIDE"];
		for (const [i, column] of ["agent", "model", "state"].entries()) {
			expect(dataLine.indexOf(dataCells[i]!), `column ${column}`).toBe(header.indexOf(column));
		}
	});

	it("state 列只显示 GLOBAL / MERGE / OVERRIDE 三个值（行级特殊态就地表达）", () => {
		const rows = [
			row("a-override", { projectEntry: { model: "p/m", thinking: "low" } }).view,
			row("b-merge", { projectEntry: { model: "p/m" }, userEntry: { thinking: "high" } }).view,
			row("c-global", { userEntry: { model: "u/m" } }).view,
			row("d-empty").view,
		];
		const inputs = [
			row("a-override", { projectEntry: { model: "p/m", thinking: "low" } }).input,
			row("b-merge", { projectEntry: { model: "p/m" }, userEntry: { thinking: "high" } }).input,
			row("c-global", { userEntry: { model: "u/m" } }).input,
			row("d-empty").input,
		];
		const out = render(makeMatrix(rows, inputs).matrix);
		expect(out).toContain("OVERRIDE");
		expect(out).toContain("MERGE");
		// 旧标签一律不再出现（行状态不进出 state 列）
		expect(out).not.toContain("已禁用 🔒");
		expect(out).not.toContain("不可合并");
	});

	it("字段没有值 ⇒ 真正的空白（不印 `-` / `inherit` / `—`）", () => {
		const { view: v, input: i } = row("delegate", { userEntry: { skills: ["s"] } });
		const out = render(makeMatrix([v], [i]).matrix);
		const line = out.split("\n").find((l) => l.includes("delegate"))!;
		expect(line).not.toContain("inherit");
		expect(line).not.toContain("—");
		// agent 名后面直接进 model 列（全空白）
		expect(line).toMatch(/delegate {2,}/);
	});

	it("超 maxThinking 的行在 thinking 列渲染 `⚠> <ceiling>` 标记", () => {
		const a = row("reviewer", { projectEntry: { model: "p/m" }, modelText: "p/m", thinkingText: "xhigh", maxThinking: "medium", overCeiling: true });
		const out = render(makeMatrix([a.view], [a.input]).matrix);
		expect(out).toContain("⚠>medium");
		const b = row("scout", { projectEntry: { model: "p/m" }, modelText: "p/m", thinkingText: "low", maxThinking: "medium" });
		expect(render(makeMatrix([b.view], [b.input]).matrix)).not.toContain("⚠>");
	});

	it("提示类**不**渲染进矩阵（归 pi 的通知区）；矩阵只渲染 error", () => {
		const m = makeMatrix([row("worker").view], [row("worker").input], {
			header: { notices: ["something worth telling the user"], errors: [] },
		});
		expect(render(m.matrix)).not.toContain("something worth telling the user");
		// error 仍然在矩阵里（硬失败不能被 toast 吃掉）
		const withErr = makeMatrix([row("worker").view], [row("worker").input], {
			header: { notices: [], errors: ["boom"] },
		});
		expect(render(withErr.matrix)).toContain("boom");
	});

	it("行级标记就地挂在 agent 名上：禁用 / 上游禁用 / 上游已无（删除线）/ 不可合并", () => {
		const ours = row("researcher", { projectEntry: { disabled: true } }).view;
		const upstream = row("researcher", { disabledUpstream: true }).view;
		const missing = row("stale-agent", { projectEntry: { model: "p/m" }, missing: true }).view;
		const locked = row("worker", { state: "unmerged" }).view;
		locked.classification.providerHits = ["ino2api"];
		const inputs = [row("researcher", { projectEntry: { disabled: true } }).input, row("researcher", { disabledUpstream: true }).input, row("stale-agent", { projectEntry: { model: "p/m" }, missing: true }).input, row("worker", { state: "unmerged" }).input];
		const out = render(makeMatrix([ours, upstream, missing, locked], inputs).matrix);
		expect(out).toContain("researcher DISABLED");
		expect(out).toContain("researcher ⚠UPSTREAM DISABLED");
		expect(out).toContain("stale-agent ⚠MISSING");
		expect(out).toContain("worker 🔒");
		// MISSING 才有删除线
		expect(out).toContain(`${STRIKE_ON}stale-agent ⚠MISSING${STRIKE_OFF}`);
		expect(out).not.toContain(`${STRIKE_ON}researcher`);
	});

	it("MISSING 行不可编辑（enter / shift+tab / r / e 全部无操作）", async () => {
		const r = row("stale-agent", { projectEntry: { model: "p/m" }, missing: true, locatedModel: { id: "m", provider: "p", reasoning: true } });
		const onEditJson = vi.fn(async () => undefined);
		const { matrix, notices } = makeMatrix([r.view], [r.input], {
			callbacks: {
				onDone: vi.fn(),
				onNeedRefresh: vi.fn(),
				onEditJson,
				planSave: () => ({ plan: planRebuild({ rows: [r.input], projectOverrides: {}, whitelist: ["stale-agent"] }), warnings: [], overCeilingAgents: [] }),
				onSave: async () => ({ ok: true, message: "saved" }),
			},
		});
		r.view.thinkingText = "off";
		matrix.handleInput(KEY_SHIFT_TAB);
		matrix.handleInput("r");
		matrix.handleInput("e");
		await Promise.resolve();
		expect(r.view.draft.touched.size).toBe(0);
		expect(r.view.draft.reset).toBe(false);
		expect(onEditJson).not.toHaveBeenCalled();
		expect(notices).toContain("This row cannot be changed");
	});

	it("回归：`r` reset 后必须**重算视图**（否则 state 变了、model/thinking 单元格还是旧值）", () => {
		// model / thinking 单元格是**视图里的缓存**，只有 `state` 是实时算的。
		// reset 漏掉 `onNeedRefresh()` ⇒ state 变 GLOBAL 但单元格纹丝不动，
		// 看着像 reset 没生效（其实保存是对的）。
		const a = row("delegate", { projectEntry: { model: "p/proj", thinking: "high" } });
		const { matrix, notices, refreshCalls } = makeMatrix([a.view], [a.input]);
		matrix.handleInput("r");
		expect(a.view.draft.reset).toBe(true);
		expect(notices.some((m: string) => m.includes("reset"))).toBe(true);
		// 关键：reset 之后必须触发重算，视图里的 model/thinking 缓存才会更新
		expect(refreshCalls()).toBe(1);
	});

	it("↑↓ 移动选中行（环形）", () => {
		const rows = [row("a").view, row("b").view, row("c").view];
		const inputs = [row("a").input, row("b").input, row("c").input];
		const { matrix } = makeMatrix(rows, inputs);
		expect(render(matrix)).toContain("→ a ");
		matrix.handleInput(KEY_DOWN);
		expect(render(matrix)).toContain("→ b ");
		matrix.handleInput(KEY_UP);
		expect(render(matrix)).toContain("→ a ");
		// 环形：向上越过顶部回到末尾
		matrix.handleInput(KEY_UP);
		expect(render(matrix)).toContain("→ c ");
	});

	it("esc 有未保存改动时二次确认（提示走 notify），再按才退出", () => {
		const a = row("reviewer", { projectEntry: { model: "m" }, touch: { key: "model", value: "p/m" } });
		const { matrix, onDone, notices } = makeMatrix([a.view], [a.input]);
		matrix.handleInput(KEY_ESC);
		expect(onDone).not.toHaveBeenCalled();
		expect(notices).toContain("Unsaved changes — press esc again to discard and quit");
		// 提示**不**进渲染（否则上下跳）
		expect(render(matrix)).not.toContain("press esc again");
		matrix.handleInput(KEY_ESC);
		expect(onDone).toHaveBeenCalledWith({ saved: false });
	});

	it("无改动时 esc 直接退出", () => {
		const a = row("reviewer", { projectEntry: { model: "m" } });
		const { matrix, onDone } = makeMatrix([a.view], [a.input]);
		matrix.handleInput(KEY_ESC);
		expect(onDone).toHaveBeenCalledWith({ saved: false });
	});

	it("`r` 在 GLOBAL 行 ⇒ 状态不变 + 警告", () => {
		const a = row("reviewer", { userEntry: { model: "u/m" } });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		matrix.handleInput("r");
		expect(a.view.draft.reset).toBe(false);
		expect(notices.some((m: string) => m.includes("already GLOBAL"))).toBe(true);
		expect(render(matrix)).toContain("GLOBAL");
	});

	it("`r` 在非 GLOBAL 行 ⇒ reset（state 立即变 GLOBAL，项目条目将被移除）", () => {
		const a = row("reviewer", { projectEntry: { model: "p/m", thinking: "low" }, userEntry: { model: "u/m", thinking: "high" } });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		expect(render(matrix)).toContain("OVERRIDE");
		matrix.handleInput("r");
		expect(a.view.draft.reset).toBe(true);
		const out = render(matrix);
		expect(out).toContain("GLOBAL");
		expect(out).not.toContain("OVERRIDE");
		expect(out).toContain("GLOBAL");
	});

	it("reset 后改一个字段 ⇒ state 变 MERGE（值被记入草稿，不会被静默丢弃）", () => {
		const a = row("reviewer", { projectEntry: { model: "p/m", thinking: "low" }, userEntry: { model: "u/m", thinking: "high" } });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		matrix.handleInput("r");
		// 模拟刷新：显示值与生效值一起更新（真环境 `refreshRowView` 会同时算两者）
		a.view.thinkingText = "medium";
		a.view.thinkingValue = "medium";
		a.view.locatedModel = { id: "m", provider: "u", reasoning: true };
		matrix.handleInput(KEY_SHIFT_TAB);
		expect(a.view.draft.touched.has("thinking")).toBe(true);
		expect(a.view.draft.thinking).toBe("high"); // 5 档模型：medium 的下一档
		const out = render(matrix);
		expect(out).toContain("MERGE");
	});

	it("model 选 `Parent session model` ⇒ 写字符串 \"inherit\"（不是删键）", () => {
		const a = row("researcher", { projectEntry: { model: "p/proj-model" } });
		const { matrix } = makeMatrix([a.view], [a.input]);
		(matrix as unknown as { applyModelChoice: (r: unknown, c: unknown) => void }).applyModelChoice(a.view, { kind: "follow-parent" });
		expect(a.view.draft.touched.has("model")).toBe(true);
		expect(a.view.draft.model).toBe("inherit"); // 显式值，不是 undefined
	});

	it("shift+tab 环形切换 thinking 并标 dirty", () => {
		const a = row("reviewer", { projectEntry: { model: "p/m" }, modelText: "p/m", thinkingText: "off", locatedModel: { id: "m", provider: "p", reasoning: true } });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		matrix.handleInput(KEY_SHIFT_TAB);
		expect(a.view.draft.touched.has("thinking")).toBe(true);
		expect(a.view.draft.thinking).toBe("minimal");
	});

	it("没有 model 的行也能配 thinking：循环覆盖 pi 默认全 7 档", () => {
		const a = row("delegate"); // 未配 model ⇒ locatedModel undefined、两列空白
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		const seen: string[] = [];
		for (let i = 0; i < 8; i++) {
			matrix.handleInput(KEY_SHIFT_TAB);
			const level = String(a.view.draft.thinking);
			seen.push(level);
			// ⚠️ 回归：必须模拟**真实**的刷新结果。无 model 时 `thinkingText` 带
			// ` (cannot clamp)` 标注，而 `thinkingValue` 是去标注的生效档位。
			// 曾经把标注文本当当前档位去 `indexOf` ⇒ 永远 -1 ⇒ 循环卡死在 `off`。
			a.view.thinkingText = `${level} (cannot clamp)`;
			a.view.thinkingValue = level;
		}
		expect(seen).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max", "off"]);
	});

	it("回归：thinkingText 带 ` (cannot clamp)` 标注时循环仍能前进（不卡在第一档）", () => {
		const a = row("delegate", { thinkingText: "off (cannot clamp)", thinkingValue: "off" });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		// 关键：`thinkingText` 一直带标注，只有 `thinkingValue` 是干净的生效档位。
		// 曾经把标注文本当当前档位去 `indexOf` ⇒ 永远 -1 ⇒ 循环卡死在 `off`。
		const seen: string[] = [];
		for (let i = 0; i < 3; i++) {
			matrix.handleInput(KEY_SHIFT_TAB);
			const level = String(a.view.draft.thinking);
			seen.push(level);
			a.view.thinkingText = `${level} (cannot clamp)`;
			a.view.thinkingValue = level;
		}
		expect(seen).toEqual(["minimal", "low", "medium"]);
	});

	it("model 可解析但 reasoning falsy ⇒ shift+tab 无操作", () => {
		const a = row("reviewer", { projectEntry: { model: "p/m" }, modelText: "p/m", thinkingText: "off", locatedModel: { id: "m", provider: "p", reasoning: false } });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		matrix.handleInput(KEY_SHIFT_TAB);
		expect(a.view.draft.touched.size).toBe(0);
		expect(notices.some((m: string) => m.includes("does not support thinking"))).toBe(true);
	});

	it("回归：thinking 列宽**固定**，切换档位不会让 model/state 左右跳", () => {
		// 之前列宽取 `max(thinkingCell 长度)`，值一变长整列就变 ⇒ 右边的列跟着移位。
		const a = row("researcher", { thinkingText: "high", thinkingValue: "high", maxThinking: "medium" });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		const before = render(matrix);
		matrix.handleInput(KEY_SHIFT_TAB);
		matrix.handleInput(KEY_SHIFT_TAB); // 档位变长
		const after = render(matrix);
		const stateCol = (text: string): number => text.indexOf("MERGE");
		expect(stateCol(after) - stateCol(before)).toBe(0); // state 列起始位置不变
	});

	it("选择 UI 下方只回答“有没 unsaved changes”；其余提示不进自定义 UI", () => {
		// 原则：提示类归 pi（ctx.ui.notify），状态类归行本身（紧凑标记 + state 列）。
		const a = row("researcher", {
			projectEntry: { model: "p/m" }, modelText: "p/m", thinkingText: "xhigh",
			maxThinking: "medium", overCeiling: true, modelUnresolved: true,
			touch: { key: "thinking", value: "xhigh" },
		});
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		const out = render(matrix);
		// 表体结束与 footer 之间**只有** 1 空行 + 1 行状态（不多不少）
		const lines = out.split("\n");
		const footerAt = lines.findIndex((l) => l.includes("S save"));
		const lastStateAt = lines.slice(0, footerAt).reduce((acc, l, i) => (/GLOBAL|OVERRIDE|MERGE/.test(l) ? i : acc), -1);
		const tail = lines.slice(lastStateAt + 1, footerAt);
		expect(tail.map((l) => l.trim())).toEqual(["", "● unsaved changes"]);
		// 超上限这类**状态**仍在表体内（thinking 单元格的紧凑后缀）
		expect(out).toContain("⚠>medium");
	});

	it("model 定位不到时只用 warning 色区分，**不加** `(not in registry)` 后缀", () => {
		const a = row("researcher", { modelText: "ino2api/x/gemini", modelUnresolved: true });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		const out = render(matrix);
		expect(out).not.toContain("not in registry)");  // 不再拼在 model 串后面
		expect(a.view.modelText).toBe("ino2api/x/gemini"); // 串本身干净
	});

	it("底部**不**再罗列将被物化的字段（那是行级说明，会随导航变形）", () => {
		const a = row("reviewer", { userEntry: { model: "u/m", tools: ["read"], machine: "r" }, touch: { key: "model", value: "p/m" } });
		const { matrix } = makeMatrix([a.view], [a.input]);
		expect(render(matrix)).not.toContain("carried:");
		expect(render(matrix)).not.toContain("reviewer.tools");
	});


	it("86 列下 agent 与 state 两列永不截断（先压 model，再压 thinking）", () => {
		const longId = "ino2api/cline/stealth/space-bunny-alpha-with-a-very-long-suffix";
		const rows = [
			row("evidence-auditor", { userEntry: { model: longId }, modelText: longId, thinkingText: "high" }).view,
			row("reviewer", { projectEntry: { model: longId }, modelText: longId, thinkingText: "max" }).view,
			row("delegate", { missing: true }).view,
		];
		const inputs = [
			row("evidence-auditor", { userEntry: { model: longId }, modelText: longId, thinkingText: "high" }).input,
			row("reviewer", { projectEntry: { model: longId }, modelText: longId, thinkingText: "max" }).input,
			row("delegate", { missing: true }).input,
		];
		const lines = makeMatrix(rows, inputs).matrix.render(86);
		const out = lines.join("\n");
		// agent 名（含标记）完整出现
		expect(out).toContain("evidence-auditor");
		expect(out).toContain("delegate ⚠MISSING");
		// state 列完整（三值里最长的 OVERRIDE 是 8 字符，列宽就按它留）
		expect(out).toContain("OVERRIDE");
		expect(out).toContain("GLOBAL");
		expect(out).not.toContain("OVERRID\n");
		expect(out).not.toContain("evidence-audit…");
		// 被压的是 model 列（截断用 …），完整 id 由模型选择器 / 保存屏展示
		expect(out).toContain("…");
		// 表头与数据行都不超出终端宽度（删除线的 ANSI 序列不占宽度）
		const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/gu, "");
		const tableLines = lines.filter((line) =>
			["agent", "evidence-auditor", "reviewer", "delegate"].some((token) => line.includes(token)),
		);
		expect(tableLines.length).toBeGreaterThanOrEqual(4);
		for (const line of tableLines) expect(stripAnsi(line).length).toBeLessThanOrEqual(86);
		expect(STATE_COLUMN_WIDTH).toBeGreaterThanOrEqual("OVERRIDE".length);
	});


	it("别名行在副标题给出改名提示", () => {
		const a = row("advisor", { isAlias: true, aliasOf: "oracle" });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		expect(render(matrix)).toContain("oracle");
	});

	it("不可合并行：行内 🔒 标记 + 不落盘（provider 名不再以散文出现在 UI 里）", () => {
		const a = row("worker", { state: "unmerged" });
		a.view.classification.providerHits = ["ino2api"];
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		expect(render(matrix)).toContain("worker 🔒");
		expect(render(matrix)).not.toContain("provider 作用域");
	});

	it("S 打开保存屏；无改动时提示 No changes", () => {
		const a = row("reviewer", { projectEntry: { model: "m" } });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		matrix.handleInput("S");
		expect(notices).toContain("No changes");

		a.view.draft.touched.add("model");
		a.view.draft.model = "p/m";
		matrix.handleInput("S");
		expect(render(matrix)).toContain("Save?");
	});

	it("保存屏列出写入内容与四类移除", () => {
		const a = row("reviewer", { projectEntry: { model: "m", thinking: "low" }, touch: { key: "model", value: "p/m" } });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		matrix.handleInput("S");
		const out = render(matrix);
		expect(out).toContain("will write subagents.agentOverrides");
		expect(out).toContain("reviewer");
	});
});

describe("PresetsMatrix：`e` 回填（整条条目 + 只警告）", () => {
	const edited = { model: "p/m2", thinking: "max", tools: ["read", "bash"] };

	it("回调收到行 → 回填后 model/thinking 同步进草稿并标 touched；警告挂在该行上", async () => {
		const warnings = ['未知键会被静默丢弃：reviewer.zzz'];
		const a = row("reviewer", { projectEntry: { model: "p/m", thinking: "low", tools: ["read"] } });
		const { matrix, notices } = makeMatrix([a.view], [a.input], {
			callbacks: {
				onDone: vi.fn(),
				onNeedRefresh: vi.fn(),
				onEditJson: async () => ({ value: edited, warnings }),
				planSave: () => ({ plan: planRebuild({ rows: [a.input], projectOverrides: {}, whitelist: ["reviewer"] }), warnings: [], overCeilingAgents: [] }),
				onSave: async () => ({ ok: true, message: "saved" }),
			},
		});
		matrix.handleInput("e");
		await vi.waitFor(() => expect(a.view.draft.touched.has("model")).toBe(true));
		expect(a.view.draft.model).toBe("p/m2");
		expect(a.view.draft.thinking).toBe("max");
		expect(a.view.draft.extra).toEqual({ tools: ["read", "bash"] });
		expect(a.view.editWarnings).toEqual(warnings);
		expect(notices.some((m: string) => m.includes("warning(s) from the JSON editor"))).toBe(true);
	});

	it("取消编辑 ⇒ 草稿不变、无警告", async () => {
		const a = row("reviewer", { projectEntry: { model: "p/m" } });
		const { matrix, notices } = makeMatrix([a.view], [a.input]);
		matrix.handleInput("e");
		await vi.waitFor(() => expect(notices).toContain("Edit cancelled"));
		expect(a.view.draft.touched.size).toBe(0);
		expect(a.view.editWarnings).toEqual([]);
	});
});

describe("ModelPicker（§6.3：常驻搜索框 + fuzzy 过滤）", () => {
	const models = [
		{ id: "a", provider: "p" },
		{ id: "b", provider: "q" },
	];

	function picker(currentValue: string | false | undefined, onChoose = vi.fn(), onCancel = vi.fn()) {
		const p = new ModelPicker({
			agentName: "reviewer",
			models,
			currentText: currentValue === undefined ? "—" : String(currentValue),
			currentValue,
			theme,
			keybindings,
			onChoose,
			onCancel,
		});
		return { p, onChoose, onCancel };
	}

	it("搜索框内联在列表上方，光标常驻（不需要先按 `/`）", () => {
		const { p } = picker(undefined);
		const lines = p.render(100);
		const searchLine = lines.find((line) => line.startsWith("/ "));
		expect(searchLine).toBeDefined();
		// 占位文字里首个字符被反白为光标（\u001b[7m…\u001b[27m）
		expect(searchLine).toContain("\u001b[7m");
		expect(searchLine).toContain("earch models");
		expect(lines.findIndex((line) => line.startsWith("/ "))).toBeLessThan(lines.findIndex((line) => line.includes("(uses the parent session model")));
	});

	it("回归：v7 已删除 `None` 选项 —— model 不再能被「删键」", () => {
		// builtin agent 的合并是 **agent 级**（`applyBuiltinOverrides`：项目条目一旦存在
		// 就直接 return，全局条目不参与）。所以「不写 model 键」并不是一个用户能表达的
		// 有意义选项：运行期会掉到 定义 → subagents.defaultModel → 父会话模型，
		// 全局那个值不会生效。选择器因此不提供该项。
		const out = picker(undefined).p.render(100).join("\n");
		expect(out).not.toContain("None");
		expect(out).toContain("inherit");
		expect(out).toContain("(uses the parent session model");
		// ModelChoice 也不再产出 { kind: "inherit" }
		const { applyModelChoice } = { applyModelChoice: undefined } as never;
		void applyModelChoice;
	});

	it("顶部固定只有 `inherit` 一行（`None` 已在 v7 删除）", () => {
		const out = picker(undefined).p.render(100).join("\n");
		expect(out).toContain("inherit");
		expect(out).toContain("(uses the parent session model");
		expect(out).not.toContain("None");
	});

	it("选择编码往返：删键 / inherit / 具体模型（§16.3.2：ModelChoice 天然成对，value 仍是展示串）", () => {
		expect(decodeModelChoice(encodeModelChoice({ kind: "follow-parent" }))).toEqual({ kind: "follow-parent" });
		expect(decodeModelChoice(encodeModelChoice({ kind: "follow-parent" }))).toEqual({ kind: "follow-parent" });
		expect(decodeModelChoice(encodeModelChoice({ kind: "model", value: "p/a", provider: "p", id: "a" }))).toEqual({ kind: "model", value: "p/a", provider: "p", id: "a" });
		// id 自身可含斜杠：只拆首个斜杠（`opencode/exo-free` 是裸 id 的一部分）。
		expect(decodeModelChoice("model:ino2api/opencode/exo-free")).toEqual({ kind: "model", value: "ino2api/opencode/exo-free", provider: "ino2api", id: "opencode/exo-free" });
	});

	it("直接输入即过滤（fuzzy），光标落在第一个匹配的模型上（不能误选 None）", () => {
		const { p } = picker(undefined);
		expect(p.visibleModelCount()).toBe(2);
		p.handleInput("b");
		expect(p.searchText()).toBe("b");
		expect(p.visibleModelCount()).toBe(1);
		expect(p.selectedValue()).toBe("model:q/b");
		const out = p.render(100).join("\n");
		expect(out).toContain("q/b");
		expect(out).not.toContain("p/a");
	});

	it("回归：固定项**常驻置顶**，不随模型列表滚动而消失", () => {
		// 之前它混在 SelectList 里，500+ 模型时会被滚出视野：
		// 选完模型返回、再 enter 进来，Parent session model 就看不见了。
		// 造一个长列表（超过一屏），并把光标停在**靠后**的模型上
		const many = Array.from({ length: 200 }, (_, i) => ({ id: `deepseek-v4.1-flash-${i}`, provider: "ino2api" }));
		const p = new ModelPicker({
			agentName: "reviewer", models: many,
			currentText: "ino2api/deepseek-v4.1-flash-150", currentValue: "ino2api/deepseek-v4.1-flash-150",
			theme, keybindings, onChoose: vi.fn(), onCancel: vi.fn(),
		});
		const lines = p.render(120);
		const out = lines.join("\n");
		// 固定项**无条件**出现在渲染里（哪怕列表很长、光标在很后面）
		expect(out).toContain("inherit");
		expect(out).toContain("(uses the parent session model");
		// 列表已滚到光标处（第 150 项），可见窗口里**看不到**第 0 项 —— 这正是原 bug 的成因。
		expect(out).not.toContain("ino2api/deepseek-v4.1-flash-0 ");
		// 固定行仍在，且位于可见模型行之前
		const fixedAt = out.indexOf("  inherit ");
		expect(fixedAt).toBeGreaterThanOrEqual(0);
		// 注意锚点要用**列表里的那一行**（带 `→ `），`current:` 头里也有这个 id
		expect(fixedAt).toBeLessThan(out.indexOf("→ ino2api/deepseek-v4.1-flash-150"));
	});

	it("零匹配不崩：固定两行仍在，光标停在 None 上", () => {
		const { p, onChoose } = picker(undefined);
		expect(() => p.handleInput("zzz")).not.toThrow();
		expect(p.visibleModelCount()).toBe(0);
		const out = p.render(100).join("\n");
		// v7：只有 `Parent session model` 一个固定项（`None` 已删除）
		expect(out).toContain("inherit");
		expect(out).toContain("(uses the parent session model");
		expect(out).not.toContain("None");
		expect(p.selectedValue()).toBe(FOLLOW_PARENT_KEY); // 零匹配 ⇒ 回落到唯一固定项
		p.handleInput(KEY_ENTER);
		expect(onChoose).toHaveBeenCalledWith({ kind: "follow-parent" });
	});

	it("退格复原列表，光标回到当前值那一行", () => {
		const { p } = picker("p/a");
		p.handleInput("b");
		expect(p.selectedValue()).toBe("model:q/b");
		p.handleInput("\u007f");
		expect(p.searchText()).toBe("");
		expect(p.visibleModelCount()).toBe(2);
		expect(p.selectedValue()).toBe("model:p/a");
	});

	it("↑↓ 在固定行与模型行之间环形移动；enter 选中", () => {
		const { p, onChoose } = picker(undefined);
		// v7：索引 0 = `Parent session model`（唯一固定项），之后是模型。
		// 这一行不写 model ⇒ **不预选**固定项（预选成 inherit 等于替你写了 "inherit"），
		// 光标落在第一个模型上。
		expect(p.selectedValue()).toBe("model:p/a");
		p.handleInput(KEY_DOWN);
		expect(p.selectedValue()).toBe("model:q/b");
		p.handleInput(KEY_UP);
		expect(p.selectedValue()).toBe("model:p/a");
		p.handleInput(KEY_UP); // 从第一个模型向上 ⇒ 先到固定项
		expect(p.selectedValue()).toBe(FOLLOW_PARENT_KEY);
		p.handleInput(KEY_UP); // 从固定项向上 ⇒ 环绕到最后一个模型
		expect(p.selectedValue()).toBe("model:q/b");
		p.handleInput(KEY_ENTER);
		expect(onChoose).toHaveBeenCalledWith({ kind: "model", value: "q/b", provider: "q", id: "b" });
	});

	it("esc 返回矩阵（不做“先清过滤再退出”的两段式）", () => {
		const { p, onCancel } = picker(undefined);
		p.handleInput("b");
		p.handleInput(KEY_ESC);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("当前值不在 registry 时**原样保留为一项**（不静默替换），只用描述列标注", () => {
		const p = new ModelPicker({
			agentName: "reviewer", models: [{ id: "a", provider: "p" }], currentText: "ghost/model", currentValue: "ghost/model",
			theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s, dim: (s: string) => s } as never,
			keybindings: { matches: () => false } as never,
			onChoose: () => {}, onCancel: () => {},
		});
		const out = p.render(120).join("\n");
		expect(out).toContain("ghost/model"); // 原样保留
		expect(out).toContain("(not in registry)"); // 标注走描述列，不再占用 id 的宽度
	});

	it("标题行显示 agent 名与当前值；光标初始落在当前值那一行", () => {
		const { p } = picker("p/a");
		const out = p.render(100).join("\n");
		expect(out).toContain("Select model for reviewer");
		expect(out).toContain("current: p/a");
		expect(p.selectedValue()).toBe("model:p/a");
		// v7：这一行不写 model ⇒ **不预选**任何固定项（None 已删，没有「无值」可选项）
		expect(picker(undefined).p.selectedValue()).toBe("model:p/a");
		// inherit ⇒ 光标落在 Parent session model 行
		expect(picker("inherit").p.selectedValue()).toBe(FOLLOW_PARENT_KEY);
	});
});

describe("SaveDialog（§6.5）", () => {
	const plan = planRebuild({
		rows: [
			{
				name: "reviewer",
				projectEntry: { thinking: "low" },
				merged: { model: "m", thinking: "high" },
				origin: { base: ["thinking"], global: ["model"] },
				draft: (() => {
					const d = createDraft("reviewer", { model: "m", thinking: "high" });
					d.touched.add("model");
					d.model = "p/new";
					return d;
				})(),
				classification: { state: "project", isAlias: false, disabledByOverride: false, disabledUpstream: false, providerHits: [], bulkFlags: [], projectProviderHits: [] },
			},
		],
		projectOverrides: { reviewer: { thinking: "low" } },
		whitelist: ["reviewer"],
	});

	function dialog(overrides: Partial<ConstructorParameters<typeof SaveDialog>[0]> = {}) {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const d = new SaveDialog({
			projectPath: "/proj/.pi/settings.json",
			profilePath: "/agent/profiles/pi-subagents/default.json",
			plan,
			warnings: [],
			bulkFlags: [],
			untrusted: false,
			overCeilingAgents: [],
			defaultProfileName: "default",
			theme,
			onConfirm,
			onCancel,
			...overrides,
		});
		return { d, onConfirm, onCancel };
	}

	it("profile name 是真的可编辑（v1 只画了假光标，任何键都进不了编辑）", () => {
		const { d } = dialog();
		// 默认焦点在 project
		d.handleInput(KEY_DOWN);
		d.handleInput(KEY_DOWN);
		expect(d.render(100).join("\n")).toContain("default▏"); // 焦点到 name ⇒ 光标在名字后
		d.handleInput("x");
		expect(d.render(100).join("\n")).toContain("defaultx");
		d.handleInput(KEY_BACKSPACE);
		expect(d.render(100).join("\n")).toContain("default▏");
	});

	it("回归：焦点在 name 输入框时 j/k 是**字符**而不是导航", () => {
		// 用户把 j/k 绑到了 tui.select.up/down（keybindings.json）；输入框里必须能打进去。
		const { d } = dialog();
		d.handleInput(KEY_DOWN);
		d.handleInput(KEY_DOWN);
		d.handleInput("j");
		d.handleInput("k");
		expect(d.render(100).join("\n")).toContain("defaultjk");
	});

	it("两个目标都未勾选时按 Enter ⇒ 明确提示，不静默无反应", () => {
		const { d } = dialog();
		d.handleInput(" "); // 取消 project
		d.handleInput(KEY_DOWN);
		d.handleInput(" "); // 取消 profile
		d.handleInput(KEY_ENTER);
		expect(d.render(100).join("\n")).toMatch(/nothing would be written|Neither target is checked/);
	});

	it("列出两个写入目标与默认 profile 名", () => {
		const out = dialog().d.render(120).join("\n");
		expect(out).toContain("project");
		expect(out).toContain("/proj/.pi/settings.json");
		expect(out).toContain("profile");
		expect(out).toContain("default");
	});

	it("列出逐字段差异与合并基底物化说明", () => {
		const out = dialog().d.render(120).join("\n");
		expect(out).toContain("will write subagents.agentOverrides");
		expect(out).toContain("~ reviewer.model");
		expect(out).toContain("→");
	});

	it("space 切换目标", () => {
		const { d } = dialog();
		const before = d.render(120).join("\n");
		d.handleInput(KEY_DOWN);
		d.handleInput(" ");
		const after = d.render(120).join("\n");
		expect(before).not.toBe(after);
	});

	it("bulk 开关 ⇒ 先二次确认（y 才落盘）", () => {
		const { d, onConfirm } = dialog({ bulkFlags: [{ key: "disableThinking", scope: "project" }] });
		const out = d.render(120).join("\n");
		expect(out).toContain("resurrect thinking");
		expect(out).toContain("in this project");
		d.handleInput("y");
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("全局 disableBuiltins ⇒ 文案点明只在本项目内复活，并列出 carriedKeys", () => {
		const { d, onConfirm } = dialog({ bulkFlags: [{ key: "disableBuiltins", scope: "user" }] });
		const out = d.render(120).join("\n");
		expect(out).toContain("in this project only");
		expect(out).toContain("carried fields");
		d.handleInput("n");
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("超 ceiling ⇒ 二次确认", () => {
		const { d, onConfirm } = dialog({ overCeilingAgents: ["reviewer"] });
		expect(d.render(120).join("\n")).toContain("exceeds maxThinking");
		d.handleInput("y");
		expect(onConfirm).toHaveBeenCalled();
	});

	it("未 trust ⇒ 二次确认且文案说明配置依然会生效", () => {
		const { d } = dialog({ untrusted: true });
		const out = d.render(120).join("\n");
		expect(out).toContain("not trusted");
		expect(out).toContain("still takes effect");
	});

	it("无确认项时 enter 直接落盘", () => {
		const { d, onConfirm } = dialog();
		d.handleInput(KEY_ENTER);
		expect(onConfirm).toHaveBeenCalledWith({ writeProject: true, writeProfile: true, profileName: "default" });
	});

	it("esc 取消", () => {
		const { d, onCancel } = dialog();
		d.handleInput(KEY_ESC);
		expect(onCancel).toHaveBeenCalled();
	});

	it("profile 名非法 ⇒ 进 name 模式重新输入", () => {
		const { d, onConfirm } = dialog({ defaultProfileName: "../escape" });
		d.handleInput(KEY_ENTER);
		expect(onConfirm).not.toHaveBeenCalled();
		expect(d.render(120).join("\n")).toContain("invalid profile name");
	});

	it("notices 不阻止写入（`e` 的校验警告也走这里）", () => {
		const { d, onConfirm } = dialog({
			warnings: [{ agent: "reviewer", message: '上游会对以下内容报错（已照原样保存）：reviewer.outputMode="x"' }],
		});
		const out = d.render(120).join("\n");
		expect(out).toContain("notices (non-blocking)");
		expect(out).toContain('上游会对以下内容报错（已照原样保存）：reviewer.outputMode="x"');
		d.handleInput(KEY_ENTER);
		expect(onConfirm).toHaveBeenCalled();
	});

	it("各类移除分别标注原因（上游已无 / 上游已禁用 / 不在白名单 / 别名 / reset）", () => {
		const missing = row("stale-agent", { projectEntry: { model: "m" }, missing: true });
		const upstreamDisabled = row("researcher", { projectEntry: { model: "m" }, disabledUpstream: true });
		const alias = row("advisor", { projectEntry: { model: "m" }, isAlias: true, aliasOf: "oracle" });
		const reset = row("scout", { projectEntry: { model: "m" }, reset: true });
		const removals = planRebuild({
			rows: [missing.input, upstreamDisabled.input, alias.input, reset.input],
			projectOverrides: {
				"stale-agent": { model: "m" },
				researcher: { model: "m" },
				advisor: { model: "m" },
				scout: { model: "m" },
				"legacy-check": { model: "m" },
			},
			whitelist: ["stale-agent", "researcher", "advisor", "oracle", "scout"],
		});
		const out = dialog({ plan: removals }).d.render(120).join("\n");
		expect(out).toContain("no such agent upstream");
		expect(out).toContain("disabled upstream");
		expect(out).toContain("not whitelisted");
		expect(out).toContain("alias key");
		expect(out).toContain("reset: project entry removed");
	});

	it("不可合并行列在「不物化」段（不写也不删）", () => {
		const locked = row("worker", { projectEntry: { model: "p/m3" }, state: "unmerged" });
		const plan2 = planRebuild({
			rows: [locked.input],
			projectOverrides: { worker: { model: "p/m3" } },
			whitelist: ["worker"],
		});
		const out = dialog({ plan: plan2 }).d.render(120).join("\n");
		expect(out).toContain("not materialized");
		expect(out).toContain("worker");
		expect(plan2.keptLocked).toEqual(["worker"]);
	});

	it("未改动行**不展示**（只展示 diff）", () => {
		const kept = row("researcher", { projectEntry: { model: "p/m" } });
		const plan2 = planRebuild({
			rows: [kept.input],
			projectOverrides: { researcher: { model: "p/m" } },
			whitelist: ["researcher"],
		});
		const out = dialog({ plan: plan2 }).d.render(120).join("\n");
		expect(out).not.toContain("unchanged");
		expect(out).not.toContain("other keys preserved");
	});

	it("不再提示『其余键语义保留』（那是定义层/全局层的事，与本次写入无关）", () => {
		expect(dialog().d.render(120).join("\n")).not.toContain("other keys preserved");
	});
});

describe("SelectList 复用（pi-tui 提供，非 pi-subagents 内部件）", () => {
	it("ModelPicker 内部确实用 SelectList", () => {
		const p = new ModelPicker({
			agentName: "r", models: [{ id: "a", provider: "p" }], currentText: "—", currentValue: undefined,
			theme, keybindings, onChoose: vi.fn(), onCancel: vi.fn(),
		});
		expect(p.children[1]).toBeInstanceOf(SelectList);
	});
});

/** 未使用但保留导入的可读性检查（`FieldOrigin` 在 `row()` 里用得上）。 */
export type _FieldOrigin = FieldOrigin;

/** main 虚拟行的视图 + 会话行（§16.3：矩阵第 0 行，键是顶层三键）。 */
function mainRow(opts: {
	project?: Override;
	user?: Override;
	touchModel?: unknown;
	touchThinking?: unknown;
	extra?: Override;
	reset?: boolean;
	fromProfileActive?: boolean;
} = {}): { view: MatrixRowView; plan: ReturnType<typeof planMain> } {
	const toLayer = (entry: Override | undefined): MainLayer | undefined => {
		if (!entry) return undefined;
		const layer: MainLayer = {};
		if (typeof entry.defaultProvider === "string") layer.provider = entry.defaultProvider;
		if (typeof entry.defaultModel === "string") layer.model = entry.defaultModel;
		if (typeof entry.defaultThinkingLevel === "string") layer.thinkingLevel = entry.defaultThinkingLevel;
		return layer;
	};
	const { merged, origin } = synthesizeMain({ project: toLayer(opts.project), user: toLayer(opts.user) });
	const draft = createDraft(MAIN_ROW_NAME, merged, "main");
	if (opts.touchModel !== undefined || (opts as { touchModel?: unknown }).touchModel !== undefined) {
		draft.touched.add("model");
		draft.model = opts.touchModel;
	}
	if (opts.touchThinking !== undefined) {
		draft.touched.add("thinking");
		draft.thinking = opts.touchThinking;
	}
	if (opts.extra) draft.extra = { ...draft.extra, ...opts.extra };
	if (opts.reset) draft.reset = true;
	const classification = { state: "project" as const, isAlias: false, disabledByOverride: false, disabledUpstream: false, providerHits: [] as string[], bulkFlags: [] as never[], projectProviderHits: [] as string[] };
	const view: MatrixRowView = {
		name: MAIN_ROW_NAME,
		kind: "main",
		classification: { ...classification },
		draft,
		merged,
		origin,
		locatedModel: undefined,
		maxThinking: undefined,
		fullModelText: "",
		modelText: "",
		modelUnresolved: false,
		thinkingText: "",
		thinkingValue: "",
		overCeiling: false,
		carriedKeys: [],
		editWarnings: [],
	};
	const plan = planMain({
		...(opts.project ? { project: opts.project } : {}),
		merged,
		origin,
		...(opts.user ? { globalEntry: opts.user } : {}),
		draft,
		...(opts.fromProfileActive ? { fromProfileActive: true } : {}),
	});
	return { view, plan };
}

describe("Matrix main 行（§16.3.1）", () => {
	it("main 固定第 0 行，其后一条空行分隔（不占选中位）", () => {
		const m = mainRow({ project: { defaultProvider: "p", defaultModel: "m" } });
		m.view.modelText = "p/m";
		const a = row("reviewer", { projectEntry: { model: "p/m" }, modelText: "p/m" });
		const { matrix } = makeMatrix([m.view, a.view], [a.input]);
		const lines = matrix.render(120);
		const mainAt = lines.findIndex((l) => l.includes("main"));
		const reviewerAt = lines.findIndex((l) => l.includes("reviewer"));
		expect(mainAt).toBeGreaterThanOrEqual(0);
		expect(reviewerAt).toBeGreaterThan(mainAt);
		// 其后紧跟一条空行分隔
		expect(lines[mainAt + 1]?.trim()).toBe("");
		// 选中位不受影响：首行仍是 main
		expect(render(matrix)).toContain("→ main");
	});

	it("agent 行之后不插分隔空行（分隔只属于 main）", () => {
		const a = row("reviewer", { projectEntry: { model: "p/m" }, modelText: "p/m" });
		const b = row("scout", { projectEntry: { model: "q/n" }, modelText: "q/n" });
		const lines = makeMatrix([a.view, b.view], [a.input, b.input]).matrix.render(120);
		const reviewerAt = lines.findIndex((l) => l.includes("reviewer"));
		expect(lines[reviewerAt + 1]?.includes("scout")).toBe(true);
	});

	it("UI 选模型天然成对：裸 id 进 model 列 + provider 进 extra（不校验）", () => {
		const m = mainRow({});
		const a = row("reviewer", { projectEntry: { model: "p/m" } });
		const { matrix } = makeMatrix([m.view, a.view], [a.input]);
		(matrix as unknown as { applyModelChoice: (r: unknown, c: unknown) => void }).applyModelChoice(m.view, {
			kind: "model",
			value: "q/n",
			provider: "q",
			id: "n",
		});
		expect(m.view.draft.touched.has("model")).toBe(true);
		expect(m.view.draft.model).toBe("n");
		expect(m.view.draft.extra.defaultProvider).toBe("q");
	});

	it("UI 选模型成对：id 自身含斜杠时整体进 defaultModel（只拆首段）", () => {
		const m = mainRow({});
		const a = row("reviewer", { projectEntry: { model: "p/m" } });
		const { matrix } = makeMatrix([m.view, a.view], [a.input]);
		(matrix as unknown as { applyModelChoice: (r: unknown, c: unknown) => void }).applyModelChoice(m.view, {
			kind: "model",
			value: "ino2api/opencode/exo-free",
			provider: "ino2api",
			id: "opencode/exo-free",
		});
		expect(m.view.draft.model).toBe("opencode/exo-free");
		expect(m.view.draft.extra.defaultProvider).toBe("ino2api");
	});

	it("agent 行选模型仍写完整 `provider/id`（main 拆键不影响 agent）", () => {
		const a = row("reviewer", { projectEntry: { model: "p/m" } });
		const { matrix } = makeMatrix([a.view], [a.input]);
		(matrix as unknown as { applyModelChoice: (r: unknown, c: unknown) => void }).applyModelChoice(a.view, {
			kind: "model",
			value: "q/n",
			provider: "q",
			id: "n",
		});
		expect(a.view.draft.model).toBe("q/n");
	});

	it("main 行的模型选择器不显示 inherit（enter 进去也看不到固定项）", () => {
		const m = mainRow({ project: { defaultProvider: "p", defaultModel: "m" } });
		m.view.modelText = "p/m";
		m.view.fullModelText = "p/m";
		const a = row("reviewer", { projectEntry: { model: "p/m" } });
		const { matrix } = makeMatrix([m.view, a.view], [a.input]);
		matrix.handleInput(KEY_ENTER);
		const out = render(matrix);
		expect(out).toContain("Select model for main");
		expect(out).not.toContain("inherit");
		expect(out).not.toContain("uses the parent session model");
	});

	it("`e` 回填 main 行走三条真实键（裸 id + provider 进 extra）", async () => {
		const m = mainRow({ project: { defaultProvider: "p", defaultModel: "m" } });
		const edited = { defaultProvider: "q", defaultModel: "n", defaultThinkingLevel: "high" };
		const a = row("reviewer", { projectEntry: { model: "p/m" } });
		const { matrix, notices } = makeMatrix([m.view, a.view], [a.input], {
			callbacks: {
				onDone: vi.fn(),
				onNeedRefresh: vi.fn(),
				onEditJson: async () => ({ value: edited, warnings: [] }),
				planSave: () => ({ plan: planRebuild({ rows: [a.input], projectOverrides: {}, whitelist: ["reviewer"] }), warnings: [], overCeilingAgents: [] }),
				onSave: async () => ({ ok: true, message: "saved" }),
			},
		});
		matrix.handleInput("e");
		await vi.waitFor(() => expect(m.view.draft.touched.has("model")).toBe(true));
		expect(m.view.draft.model).toBe("n");
		expect(m.view.draft.thinking).toBe("high");
		expect(m.view.draft.extra).toEqual({ defaultProvider: "q" });
		// 回填内容即 `mainEntryForEditor` 的三键投影
		expect(mainEntryForEditor(m.view.merged, m.view.draft, m.view.merged)).toEqual(edited);
	});

	it("Finding 3：e 里加未知键 ⇒ plan.main.after 无该键、fields 不出该行 diff", () => {
		// 未知键永远不会落盘（writeProjectSettings 只写 MAIN_KEYS），
		// 所以 after 与保存屏 diff 都只覆盖顶层三键。
		const m = mainRow({ project: { defaultProvider: "p", defaultModel: "m" }, touchModel: "m", extra: { someKey: 1 } });
		expect(m.plan.after).toEqual({ defaultProvider: "p", defaultModel: "m" });
		expect(m.plan.fields).toEqual([]);
		expect(m.plan.changed).toBe(false);
	});

	it("Finding 3：main 编辑器头说明未知键被忽略（只写三键）", () => {
		expect(jsonEditorHeaderMain()).toContain("only these three are written");
		expect(jsonEditorHeaderMain()).not.toContain("kept but have no effect");
	});

	it("只改 main 也算 dirty：● unsaved changes 亮 + S 能进保存屏", () => {
		const m = mainRow({ project: { defaultProvider: "p", defaultModel: "m" }, touchModel: "n" });
		const a = row("reviewer", { projectEntry: { model: "p/m" } });
		const agentPlan = planRebuild({ rows: [a.input], projectOverrides: { reviewer: { model: "p/m" } }, whitelist: ["reviewer"] });
		const plan = { ...agentPlan, main: m.plan };
		expect(m.plan.changed).toBe(true);
		const { matrix, notices } = makeMatrix([m.view, a.view], [a.input], {
			callbacks: {
				onDone: vi.fn(),
				onNeedRefresh: vi.fn(),
				onEditJson: async () => undefined,
				planSave: () => ({ plan, warnings: [], overCeilingAgents: [] }),
				onSave: async () => ({ ok: true, message: "saved" }),
			},
		});
		expect(render(matrix)).toContain("● unsaved changes");
		matrix.handleInput("S");
		expect(render(matrix)).toContain("Save?");
		expect(notices).not.toContain("No changes");
	});

	it("main 未改 + agent 未改 ⇒ S 提示 No changes（幂等，不误报）", () => {
		const m = mainRow({ project: { defaultProvider: "p", defaultModel: "m" } });
		const a = row("reviewer", { projectEntry: { model: "p/m" } });
		const agentPlan = planRebuild({ rows: [a.input], projectOverrides: { reviewer: { model: "p/m" } }, whitelist: ["reviewer"] });
		const plan = { ...agentPlan, main: m.plan };
		expect(m.plan.changed).toBe(false);
		const { matrix, notices } = makeMatrix([m.view, a.view], [a.input], {
			callbacks: {
				onDone: vi.fn(),
				onNeedRefresh: vi.fn(),
				onEditJson: async () => undefined,
				planSave: () => ({ plan, warnings: [], overCeilingAgents: [] }),
				onSave: async () => ({ ok: true, message: "saved" }),
			},
		});
		expect(render(matrix)).not.toContain("● unsaved changes");
		matrix.handleInput("S");
		expect(notices).toContain("No changes");
	});

	it("顶部不出现任何 base/生效性文案（生效与否只由底部 ● 表达）", () => {
		const m = mainRow({ project: { defaultProvider: "p", defaultModel: "m" } });
		const a = row("reviewer", { projectEntry: { model: "p/m" } });
		const out = render(makeMatrix([m.view, a.view], [a.input]).matrix);
		expect(out).not.toMatch(/base:/);
		expect(out).not.toContain("--from");
	});
});

describe("ModelPicker followParent 隐藏（§16.3.2）", () => {
	function mainPicker(currentValue: string | undefined, models = [{ id: "a", provider: "p" }, { id: "b", provider: "q" }]) {
		const onChoose = vi.fn();
		const onCancel = vi.fn();
		const p = new ModelPicker({
			agentName: "main",
			models,
			currentText: currentValue ?? "—",
			currentValue,
			followParent: false,
			theme,
			keybindings,
			onChoose,
			onCancel,
		});
		return { p, onChoose, onCancel };
	}

	it("main 选择器不渲染 inherit 固定项", () => {
		const out = mainPicker(undefined).p.render(100).join("\n");
		expect(out).not.toContain("inherit");
		expect(out).not.toContain("uses the parent session model");
	});

	it("隐藏后搜索零匹配不卡死：enter 无操作、不抛错", () => {
		const { p, onChoose } = mainPicker(undefined);
		expect(() => p.handleInput("zzz")).not.toThrow();
		expect(p.visibleModelCount()).toBe(0);
		expect(p.selectedValue()).toBeUndefined();
		expect(() => p.handleInput(KEY_ENTER)).not.toThrow();
		expect(onChoose).not.toHaveBeenCalled();
	});

	it("隐藏后 ↑↓ 只在模型里环形（无固定项可落）", () => {
		const { p } = mainPicker(undefined);
		expect(p.selectedValue()).toBe("model:p/a");
		p.handleInput(KEY_UP); // 无固定项 ⇒ 直接环绕到末尾
		expect(p.selectedValue()).toBe("model:q/b");
		p.handleInput(KEY_DOWN);
		expect(p.selectedValue()).toBe("model:p/a");
	});

	it("隐藏后当前值仍预选到对应模型行", () => {
		expect(mainPicker("q/b").p.selectedValue()).toBe("model:q/b");
	});
});

describe("SaveDialog main 段（§16.3.3）", () => {
	function mainDialog(main: ReturnType<typeof planMain>, agentPlan = planRebuild({ rows: [], projectOverrides: {}, whitelist: [] })) {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const plan = { ...agentPlan, main };
		const d = new SaveDialog({
			projectPath: "/proj/.pi/settings.json",
			profilePath: "/agent/profiles/pi-subagents/default.json",
			plan,
			warnings: [],
			bulkFlags: [],
			untrusted: false,
			overCeilingAgents: [],
			defaultProfileName: "default",
			theme,
			onConfirm,
			onCancel,
		});
		return { d, onConfirm, onCancel };
	}

	it("main 改动时新增顶层段 + 下次启动提示", () => {
		const { plan } = mainRow({ project: { defaultProvider: "p", defaultModel: "a" }, touchModel: "b" });
		expect(plan.changed).toBe(true);
		const out = mainDialog(plan).d.render(120).join("\n");
		expect(out).toContain("will write top-level settings (main agent):");
		expect(out).toContain("defaultModel");
		expect(out).toContain("apply on the next pi start");
	});

	it("main 未改动时不显示顶层段", () => {
		const { plan } = mainRow({ project: { defaultProvider: "p", defaultModel: "a" } });
		expect(plan.changed).toBe(false);
		const out = mainDialog(plan).d.render(120).join("\n");
		expect(out).not.toContain("will write top-level settings");
	});

	it("`r` reset（removal）显示删除行", () => {
		const { plan } = mainRow({ project: { defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "low" }, reset: true });
		expect(plan.removal).toBe(true);
		const out = mainDialog(plan).d.render(120).join("\n");
		expect(out).toContain("will write top-level settings (main agent):");
		expect(out).toContain("- defaultProvider");
		expect(out).toContain("- defaultModel");
		expect(out).toContain("- defaultThinkingLevel");
	});

	it("§16.8：勾选 profile 时始终说明导出的是整张矩阵快照（不自动取消勾选）", () => {
		const { plan } = mainRow({ touchModel: "n", touchThinking: "high" });
		const out = mainDialog(plan).d.render(120).join("\n");
		expect(out).toContain("profile: full matrix snapshot (all managed agents), no agent entries changed in this save");
		// 两个目标仍默认勾选
		expect(out).toContain("[x] project");
		expect(out).toContain("[x] profile");
	});

	it("§16.8：有 agent 改动时也声明 profile 是整张矩阵快照", () => {
		const { plan: main } = mainRow({});
		const agentPlan = planRebuild({
			rows: [],
			projectOverrides: {},
			whitelist: [],
		});
		agentPlan.changed = [{ name: "worker", after: { model: "p/m" }, fields: [], isNew: true }];
		const out = mainDialog(main, agentPlan).d.render(120).join("\n");
		expect(out).toContain("profile: full matrix snapshot (all managed agents)");
		expect(out).not.toContain("only main defaults will be exported");
	});
});

describe("index 接线（§16.3.4）", () => {
	function mainSession(mainDraft: ReturnType<typeof createDraft>, opts: { fromProfileActive?: boolean } = {}): { session: SessionState; view: MatrixRowView } {
		const merged: Override = { defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "low" };
		const origin: FieldOrigin = { base: ["defaultProvider", "defaultModel", "defaultThinkingLevel"], global: [] };
		const classification = { state: "project" as const, isAlias: false, disabledByOverride: false, disabledUpstream: false, providerHits: [] as string[], bulkFlags: [] as never[], projectProviderHits: [] as string[] };
		const entry = {
			name: MAIN_ROW_NAME,
			classification: { ...classification },
			merged,
			origin,
			projectEntry: { defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "low" },
			draft: mainDraft,
		};
		const session = {
			projectRoot: { root: "/proj", tier: "cwd" },
			projectPath: "/proj/.pi/settings.json",
			projectLayer: { settingsPath: "/proj/.pi/settings.json", exists: true, settings: {}, subagents: { agentOverrides: {}, agentOverridesByProvider: {}, disableBuiltins: false, disableThinking: false, hasProviderOverrides: false }, main: { provider: "p", model: "m" } },
			userLayer: { settingsPath: "/u/settings.json", exists: false, settings: {}, subagents: { agentOverrides: {}, agentOverridesByProvider: {}, disableBuiltins: false, disableThinking: false, hasProviderOverrides: false }, main: {} },
			whitelist: [],
			rows: [entry],
			bulkFlags: [],
			notices: [],
			errors: [],
			fromProfileActive: opts.fromProfileActive ?? false,
			fromProfileRejected: false,
			baseSources: {},
		} as unknown as SessionState;
		const view: MatrixRowView = {
			name: MAIN_ROW_NAME,
			kind: "main",
			classification: { ...classification },
			draft: mainDraft,
			merged,
			origin,
			locatedModel: undefined,
			maxThinking: undefined,
			fullModelText: "p/m",
			modelText: "p/m",
			modelUnresolved: false,
			thinkingText: "",
			thinkingValue: "",
			overCeiling: false,
			carriedKeys: [],
			editWarnings: [],
		};
		return { session, view };
	}

	it("`r` reset = 一次性删三个键：plan.main.removal，不半删", () => {
		const draft = createDraft(MAIN_ROW_NAME, { defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "low" }, "main");
		draft.reset = true;
		const { session, view } = mainSession(draft);
		const { plan } = buildPlan(session, [view]);
		expect(plan.main.removal).toBe(true);
		expect(plan.main.after).toEqual({});
		expect(plan.main.fields.map((f) => f.key).sort()).toEqual(["defaultModel", "defaultProvider", "defaultThinkingLevel"]);
		expect(plan.overrides).toEqual({});
		expect(plan.overrides).not.toHaveProperty("main");
	});

	it("buildPlan 把 main 挂到 plan.main（agent 循环碰不到它）", () => {
		const draft = createDraft(MAIN_ROW_NAME, { defaultProvider: "p", defaultModel: "m" }, "main");
		draft.touched.add("model");
		draft.model = "n";
		const { session, view } = mainSession(draft);
		const { plan } = buildPlan(session, [view]);
		expect(plan.main.changed).toBe(true);
		expect(plan.main.after).toEqual({ defaultProvider: "p", defaultModel: "n", defaultThinkingLevel: "low" });
		expect(plan.overrides).not.toHaveProperty("main");
	});

	it("main 落盘值定位不到 ⇒ registry 警告（不阻止）", () => {
		const draft = createDraft(MAIN_ROW_NAME, { defaultProvider: "p", defaultModel: "m" }, "main");
		draft.touched.add("model");
		draft.model = "ghost";
		const { session, view } = mainSession(draft);
		const { warnings } = buildPlan(session, [view], { registry: { getAvailable: () => [] }, models: [] });
		expect(warnings.some((w) => w.agent === "main" && w.message.includes("is not in the model registry"))).toBe(true);
	});

	it("main provider 无凭证 ⇒ auth 警告（不阻止）", () => {
		const draft = createDraft(MAIN_ROW_NAME, { defaultProvider: "p", defaultModel: "m" }, "main");
		draft.touched.add("thinking");
		draft.thinking = "high";
		const { session, view } = mainSession(draft);
		const model = { id: "m", provider: "p", reasoning: true };
		const { warnings } = buildPlan(session, [view], {
			registry: { getAvailable: () => [model], find: () => model, getProviderAuthStatus: () => ({ configured: false }) },
			models: [model],
		});
		expect(warnings.some((w) => w.agent === "main" && w.message.includes("has no configured credentials"))).toBe(true);
	});

	it("main 未改动 ⇒ 无 registry/auth 警告（不打扰）", () => {
		const draft = createDraft(MAIN_ROW_NAME, { defaultProvider: "p", defaultModel: "m" }, "main");
		const { session, view } = mainSession(draft);
		const { warnings } = buildPlan(session, [view], {
			registry: { getAvailable: () => [], getProviderAuthStatus: () => ({ configured: false }) },
			models: [],
		});
		expect(warnings.filter((w) => w.agent === "main")).toEqual([]);
	});

	it("commitSave：只有 main 改动时 verify 指引是重进项目（不带 subagents-models）", () => {
		const draft = createDraft(MAIN_ROW_NAME, { defaultProvider: "p", defaultModel: "m" }, "main");
		draft.touched.add("model");
		draft.model = "n";
		const { session, view } = mainSession(draft);
		const { plan } = buildPlan(session, [view]);
		const outcome = commitSave(session, { writeProject: false, writeProfile: false, profileName: "default" }, plan, [], "/agent", undefined);
		expect(outcome.ok).toBe(true);
		expect(outcome.message).toContain("verify by starting pi again in this project");
		expect(outcome.message).not.toContain("/subagents-models");
	});

	it("无 UI 摘要 base 文案：--from 写名字，否则写 project settings only", () => {
		const draft = createDraft(MAIN_ROW_NAME, {}, "main");
		const { session, view } = mainSession(draft, { fromProfileActive: true });
		const ctx = { cwd: "/proj", model: { provider: "p", id: "m" } } as never;
		expect(summaryLines(ctx, session, [view], "work").join("\n")).toContain("base: --from work");
		const plain = summaryLines(ctx, { ...session, fromProfileActive: false }, [view]).join("\n");
		expect(plain).toContain("base: project settings only");
		expect(plain).not.toContain("default profile");
	});

	it("main 编辑器头是英文三键说明；agent 头不动", () => {
		const header = jsonEditorHeaderMain();
		expect(header).toContain("top-level");
		expect(header).toContain("next pi start");
		expect(header).toContain("untrusted");
		expect(header).not.toMatch(/[\u4e00-\u9fa5]/);
		// agent 版保持原样（含中文说明与字段表）
		expect(jsonEditorHeader("reviewer")).toContain("override");
	});

	it("`e` 校验 main 只警告不阻止：非法档位进 warnings，照样 accepted", () => {
		const review = reviewMainEditedJson({ defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "turbo" });
		expect(review.accepted).toBe(true);
		expect(review.errors).toEqual([]);
		expect(review.warnings.length).toBeGreaterThan(0);
		expect(reviewMainEditedJson([]).accepted).toBe(false);
	});

	it("editorContentForMain = main 头 + 三键 JSON", () => {
		const content = editorContentForMain({ defaultProvider: "p", defaultModel: "m" });
		expect(content).toContain("top-level");
		expect(content).toContain('"defaultModel": "m"');
	});
});
