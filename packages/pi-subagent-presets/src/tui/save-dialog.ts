/**
 * @inobit/pi-subagent-presets — 保存流程对话框（§6.5）。
 *
 * 组件内状态机：
 * - `targets`（勾选 project / profile + 二次确认）
 * - `name`（输入 profile 名）
 * - `confirm`（bulk 开关 / 超 ceiling / 未 trust 的二次确认）
 *
 * 关键语义：**只整体替换 `subagents.agentOverrides` 这一个键**；`settings.json`
 * 的其余内容语义保留（键集合与值相等，JSON 重写会规范化格式，字节不保证）。
 */

import { Container, type Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BulkFlag } from "../rowstate.ts";
import type { RebuildPlan } from "../writer.ts";
import { isSafeProfileName, normalizeProfileName } from "../validate.ts";
import { KEY_BACKSPACE, KEY_CTRL_C, KEY_DOWN, KEY_ENTER, KEY_ESC, KEY_UP, isPrintable } from "./keys.ts";

export interface SaveWarning {
	agent: string;
	message: string;
}

export interface SaveDialogOptions {
	projectPath: string;
	profilePath: string;
	plan: RebuildPlan;
	warnings: SaveWarning[];
	bulkFlags: BulkFlag[];
	/** 未 trust 项目：写入需二次确认（配置依然会生效，见 §7.2）。 */
	untrusted: boolean;
	/** 有超 ceiling 的行。 */
	overCeilingAgents: string[];
	defaultProfileName: string;
	theme: Theme;
	onConfirm: (result: SaveResult) => void;
	onCancel: () => void;
}

export interface SaveResult {
	writeProject: boolean;
	writeProfile: boolean;
	profileName: string;
}

type Phase = "targets" | "name" | "confirm";
/** `targets` 阶段的焦点：两个写入目标 + profile name 输入框。 */
type SaveFocus = "project" | "profile" | "name";
const FOCUS_ORDER: readonly SaveFocus[] = ["project", "profile", "name"];

export class SaveDialog extends Container implements Focusable {
	focused = false;
	private readonly opts: SaveDialogOptions;
	private phase: Phase = "targets";
	private focus: SaveFocus = "project";
	private writeProject = true;
	private writeProfile = true;
	private profileName: string;
	private pendingReasons: string[] = [];
	/** 焦点/校验的即时提示（“两个目标都没勾” / “名字不合法”）。 */
	private statusHint = "";

	constructor(opts: SaveDialogOptions) {
		super();
		this.opts = opts;
		this.profileName = opts.defaultProfileName;
		// 二次确认项在构造时就定好：保存屏一打开就停在确认阶段（而不是先选目标再弹）
		this.pendingReasons = this.needsConfirmReasons();
		this.phase = this.pendingReasons.length > 0 ? "confirm" : "targets";
	}

	/**
	 * 需要二次确认的原因（全部指向**行为变更**，提示类不阻止写入）。
	 * bulk 开关：项目开关 ⇒ 复活影响本项目；全局开关 ⇒ 复活只在本项目内发生。
	 */
	private needsConfirmReasons(): string[] {
		const reasons: string[] = [];
		for (const flag of this.opts.bulkFlags) {
			if (flag.key === "disableThinking") {
				reasons.push(
					flag.scope === "project"
						? "Project subagents.disableThinking=true: writing will resurrect thinking for the affected agents in this project"
						: "Global subagents.disableThinking=true: writing will resurrect thinking for the affected agents in this project only",
				);
			} else {
				const carried = this.carriedKeysSummary();
				reasons.push(
					flag.scope === "project"
						? `Project subagents.disableBuiltins=true: writing will resurrect whole entries in this project (carried fields: ${carried})`
						: `Global subagents.disableBuiltins=true: writing will resurrect whole entries in this project only (carried fields: ${carried})`,
				);
			}
		}
		if (this.opts.overCeilingAgents.length > 0) {
			reasons.push(
				`thinking exceeds maxThinking for: ${this.opts.overCeilingAgents.join(", ")} — rejected at run time`,
			);
		}
		if (this.opts.untrusted) reasons.push("Project is not trusted — the written config still takes effect (pi-subagents does no trust check)");
		return reasons;
	}

	/** `disableBuiltins` 复活时会被带回的字段（不只 thinking）。 */
	private carriedKeysSummary(): string {
		const keys = new Set<string>();
		for (const change of this.opts.plan.changed) {
			for (const key of Object.keys(change.after)) keys.add(key);
		}
		if (keys.size === 0) return "none";
		return [...keys].sort().join(", ");
	}

	// 三个分支的正文都是定宽文本，宿主给的 width 用不上（也不该用——截断会让
	// 保存屏的字段对比变得难读）
	override render(_width: number): string[] {
		if (this.phase === "targets") return this.renderTargets();
		if (this.phase === "name") return this.renderName();
		return this.renderConfirm();
	}

	private renderTargets(): string[] {
		const t = this.opts.theme;
		const lines: string[] = [];
		lines.push(t.bold("Save?"));
		lines.push("");
		lines.push(`${this.mark("project")} ${this.writeProject ? "[x]" : "[ ]"} project  ${this.opts.projectPath}`);
		lines.push(`${this.mark("profile")} ${this.writeProfile ? "[x]" : "[ ]"} profile  ${this.opts.profilePath}${this.profileExistsHint()}`);
		lines.push("");
		for (const line of this.bodyLines(t)) lines.push(line);
		lines.push("");
		// profile name 是**真的可编辑**：焦点停在这里时光标 `▏` 就在名字后面。
		// （v1 只画了个假光标，`targets` 阶段丢弃所有可打印字符，且进入 name 阶段的
		//   唯一途径是“名字非法”——而默认值 default 恰好合法，于是永远改不了。）
		if (this.writeProfile) {
			const nameText = `profile name: ${this.profileName}`;
			lines.push(this.focus === "name" ? t.fg("accent", `${nameText}▏`) : t.fg("muted", nameText));
		}
		if (this.statusHint) lines.push(t.fg("warning", this.statusHint));
		lines.push(t.fg("dim", "space toggle   ↑↓ move   enter confirm   esc cancel"));
		return lines;
	}

	/** 焦点标记 `→`（只在 targets 阶段用）。 */
	private mark(where: SaveFocus): string {
		return this.phase === "targets" && this.focus === where ? "→" : " ";
	}

	private profileExistsHint(): string {
		return this.profileName ? "  (overwrite)" : "";
	}

	private renderName(): string[] {
		const t = this.opts.theme;
		const lines: string[] = [];
		lines.push(t.bold("Save?"));
		lines.push("");
		lines.push(`profile name: ${this.profileName}▏`);
		const valid = isSafeProfileName(normalizeProfileName(this.profileName));
		lines.push(valid ? t.fg("muted", "must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ (trailing .json is stripped)") : t.fg("error", "invalid profile name"));
		lines.push("");
		for (const line of this.bodyLines(t)) lines.push(line);
		lines.push("");
		lines.push(t.fg("dim", "enter confirm   esc cancel"));
		return lines;
	}

	private renderConfirm(): string[] {
		const t = this.opts.theme;
		const lines: string[] = [];
		lines.push(t.bold("Save?"));
		lines.push("");
		for (const reason of this.pendingReasons) lines.push(t.fg("warning", `⚠ ${reason}`));
		lines.push("");
		for (const line of this.bodyLines(t)) lines.push(line);
		lines.push("");
		lines.push(t.fg("dim", "y confirm   n cancel"));
		return lines;
	}

	/** 保存屏正文：写入 / 移除 / 不物化 / 模板未生效字段 / 提示 / 未改动。 */
	private bodyLines(t: Theme): string[] {
		const plan = this.opts.plan;
		const lines: string[] = [];
		if (plan.changed.length > 0) {
			lines.push("will write subagents.agentOverrides:");
			for (const change of plan.changed) {
				if (change.isNew) {
					lines.push(`  + ${change.name}  new entry${change.fields.length > 0 ? `: ${change.fields.map((f) => `${f.key}=${formatValue(f.after)}`).join(", ")}` : ""}`);
					continue;
				}
				for (const field of change.fields) {
					lines.push(`  ~ ${change.name}.${field.key}  ${formatValue(field.before)} → ${formatValue(field.after)}`);
				}
			}
			lines.push("");
		}
		if (plan.removals.length > 0) {
			lines.push("remove:");
			for (const removal of plan.removals) lines.push(`  - ${removal.name}  ${removal.detail}`);
			lines.push("");
		}
		if (plan.keptLocked.length > 0) {
			lines.push("not materialized (kept as-is, neither written nor deleted):");
			for (const name of plan.keptLocked) {
				lines.push(`  🔒 ${name}  a provider-scoped config exists under some provider; materializing would kill it`);
			}
			lines.push("");
		}
		if (plan.dropped.length > 0) {
			lines.push("not applied (--from blueprint, project entry wins):");
			for (const drop of plan.dropped) lines.push(`  - ${drop.name}.${drop.keys.join(", ")}`);
			lines.push("");
		}
		if (plan.emptyBase.length > 0) {
			lines.push("merged base is empty; these rows will be removed:");
			for (const name of plan.emptyBase) lines.push(`  - ${name}`);
			lines.push("");
		}
		if (this.opts.warnings.length > 0) {
			lines.push("notices (non-blocking):");
			for (const warning of this.opts.warnings) lines.push(`  ⚠ ${warning.agent}  ${warning.message}`);
			lines.push("");
		}
		if (plan.unchanged.length > 0) {
			// 只展示 diff。`unchanged (existing values kept): …` 与
			// `other keys preserved: subagents.defaultModel / maxThinking / …` 都是噪音：
			// 前者是“我们什么都没改”，后者列的是定义层/全局层的键，与本次写入无关。
			void plan.unchanged;
		}
		lines.push("");
		return lines;
	}

	handleInput(data: string): void {
		if (this.phase === "confirm") {
			if (data === "y" || data === "Y") {
				this.confirm();
				return;
			}
			if (data === "n" || data === "N" || data === KEY_ESC || data === KEY_CTRL_C) {
				this.opts.onCancel();
			}
			return;
		}
		if (this.phase === "name") {
			if (data === KEY_ENTER) {
				const name = normalizeProfileName(this.profileName);
				if (!isSafeProfileName(name) || !name) {
					this.opts.onCancel();
					return;
				}
				this.profileName = name;
				this.enterTargets();
				return;
			}
			if (data === KEY_ESC || data === KEY_CTRL_C) {
				this.opts.onCancel();
				return;
			}
			if (data === KEY_BACKSPACE) {
				this.profileName = this.profileName.slice(0, -1);
				this.invalidate();
				return;
			}
			if (isPrintable(data)) {
				this.profileName += data;
				this.invalidate();
			}
			return;
		}
		// targets
		// ⚠️ 焦点在 profile name 输入框时，必须**先当文本处理**：j/k 已被用户绑成
		// 导航键，若先判导航就会把 `j`/`k` 吞掉（打不进名字）。输入框里 j/k 是字符。
		if (this.focus === "name") {
			if (data === KEY_ENTER) {
				const name = normalizeProfileName(this.profileName);
				if (!isSafeProfileName(name) || !name) {
					this.statusHint = "invalid profile name — type one here (letters/digits/._- only)";
					this.invalidate();
					return;
				}
				this.profileName = name;
				this.enterTargets();
				return;
			}
			if (data === KEY_ESC || data === KEY_CTRL_C) {
				this.opts.onCancel();
				return;
			}
			if (data === KEY_BACKSPACE) {
				this.profileName = this.profileName.slice(0, -1);
				this.statusHint = "";
				this.invalidate();
				return;
			}
			if (isPrintable(data)) {
				this.profileName += data;
				this.statusHint = "";
				this.invalidate();
			}
			return;
		}
		if (data === KEY_UP || data === "k") {
			this.moveFocus(-1);
			return;
		}
		if (data === KEY_DOWN || data === "j") {
			this.moveFocus(1);
			return;
		}
		if (data === " ") {
			if (this.focus === "project") this.writeProject = !this.writeProject;
			else if (this.focus === "profile") this.writeProfile = !this.writeProfile;
			this.invalidate();
			return;
		}
		if (data === KEY_ENTER) {
			if (!this.writeProject && !this.writeProfile) {
				this.statusHint = "Neither target is checked — nothing would be written. Check at least one.";
				this.invalidate();
				return;
			}
			if (this.writeProfile) {
				const name = normalizeProfileName(this.profileName);
				if (!isSafeProfileName(name) || !name) {
					this.phase = "name";
					this.statusHint = "Invalid profile name — type one here (letters, digits, . _ - only)";
					this.invalidate();
					return;
				}
				this.profileName = name;
			}
			this.enterTargets();
			return;
		}
		if (data === KEY_ESC || data === KEY_CTRL_C) this.opts.onCancel();
	}

	/** 焦点在 project → profile → name 之间循环；`name` 仅在勾选 profile 时可达。 */
	private moveFocus(delta: number): void {
		const reachable = this.writeProfile ? FOCUS_ORDER : FOCUS_ORDER.slice(0, 2);
		const at = reachable.indexOf(this.focus);
		const next = reachable[(at + delta + reachable.length) % reachable.length] ?? reachable[0]!;
		this.focus = next;
		this.statusHint = "";
		this.invalidate();
	}

	private enterTargets(): void {
		const reasons = this.needsConfirmReasons();
		if (reasons.length > 0) {
			this.pendingReasons = reasons;
			this.phase = "confirm";
			this.invalidate();
			return;
		}
		this.confirm();
	}

	private confirm(): void {
		this.opts.onConfirm({
			writeProject: this.writeProject,
			writeProfile: this.writeProfile,
			profileName: this.profileName,
		});
	}
}

function formatValue(value: unknown): string {
	if (value === undefined) return "(unset)";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

/** 供 index 组装：项目 settings 里"其余键"的提示性列举。 */
export function preservedKeysSummary(settings: Record<string, unknown>): string[] {
	return Object.keys(settings).filter((key) => key !== "subagents");
}
