/**
 * @inobit/pi-nvim — daemon 结果解析＋截断＋渲染（纯函数，可单测）。
 *
 * 契约（方案 §三/§九）：
 * - 截断：per-file 至多 50 条、整批至多 200 条、单条 message 至多 500 字；
 *   超限在 content 尾标注 `…truncated (N/M)`（N=已展示，M=原始总数）；
 *   完整 JSON 进 details（此处指 details 侧保留全量，截断只发生在模型侧文本）。
 * - 返回不含文件内容。
 * - format 四态：`formatted`＋`reason(ok/no-formatter/format-error/write-error)`＋
 *   `changed_lines`，`formatted` 必须由写前写后内容比较得出（见 deriveFormatState）。
 */

import type { NvimTruncation } from "./config.ts";

/** 诊断严重度（沿用 vim.diagnostic 1=Error 2=Warn 3=Info 4=Hint） */
export type DiagSeverity = 1 | 2 | 3 | 4;

/** 单条诊断（不含文件内容，只有位置＋消息） */
export interface NvimDiag {
	line: number;
	col: number;
	severity: DiagSeverity;
	source: string;
	message: string;
}

/** diagnose 单文件结果；无 client 的文件记 diags:[]＋no_client:true */
export interface DiagnoseFileResult {
	file: string;
	diags: NvimDiag[];
	ms: number;
	no_client?: boolean;
	/** daemon 侧处理失败（edit 失败等）：渲染为 error 行，绝不静默记 clean */
	error?: string;
}

/** format 四态 reason */
export type FormatReason = "ok" | "no-formatter" | "format-error" | "write-error";

/** format 单文件结果 */
export interface FormatFileResult {
	file: string;
	formatted: boolean;
	reason: FormatReason;
	changed_lines: number;
	diags: NvimDiag[];
	ms: number;
	no_client?: boolean;
	/** daemon 侧处理失败：渲染为 error 行 */
	error?: string;
}

export interface TruncationBudgets {
	perFile: number;
	batch: number;
	message: number;
}

export function budgetsOf(t: NvimTruncation): TruncationBudgets {
	return { perFile: t.perFile, batch: t.batch, message: t.message };
}

/** 严重度数字 → 展示级别 */
export function severityLabel(s: number): string {
	if (s === 1) return "error";
	if (s === 2) return "warn";
	if (s === 3) return "info";
	return "hint";
}

/** 行级 diff 行数：逐行比对＋长度差（纯函数，写前写后比较用） */
export function countChangedLines(before: string, after: string): number {
	if (before === after) return 0;
	const a = before.split("\n");
	const b = after.split("\n");
	const common = Math.min(a.length, b.length);
	let n = Math.abs(a.length - b.length);
	for (let i = 0; i < common; i++) {
		if (a[i] !== b[i]) n++;
	}
	return n;
}

export interface FormatGate {
	/** 是否有支持 textDocument/formatting 的 client（无→no-formatter） */
	hasFormatter: boolean;
	/** :w 是否失败（失败→write-error，留现场） */
	writeError: boolean;
	/** formatter 通道显式报错（预留：用户 autocmd 抛错等） */
	formatError: boolean;
}

/**
 * 四态推导（与 lua/bridge.lua 同逻辑，TS 侧单测即契约）：
 * - write-error 优先（:w 失败，留现场不 wipe）；
 * - 无 formatter 记 no-formatter（buf.format 无 client 仅 notify，必须显式分支）；
 * - formatter 显式错误记 format-error；
 * - 其余比较写前写后：有变化 formatted:true＋ok，无变化 formatted:false＋ok
 *   （不以“未抛错”推导 formatted）。
 */
export function deriveFormatState(
	before: string,
	after: string,
	gate: FormatGate,
): { formatted: boolean; reason: FormatReason; changed_lines: number } {
	const changed_lines = countChangedLines(before, after);
	if (gate.writeError) return { formatted: false, reason: "write-error", changed_lines };
	if (!gate.hasFormatter) return { formatted: false, reason: "no-formatter", changed_lines };
	if (gate.formatError) return { formatted: false, reason: "format-error", changed_lines };
	if (changed_lines === 0) return { formatted: false, reason: "ok", changed_lines };
	return { formatted: true, reason: "ok", changed_lines };
}

/** 单条 message 截断（字符数；超限不断语义，只截尾） */
export function truncateMessage(message: string, max: number): string {
	if (message.length <= max) return message;
	return message.slice(0, max) + "…truncated";
}

/** 截断后的诊断列表＋计数（原始总数 M，展示 N） */
export interface TruncatedDiags {
	diags: NvimDiag[];
	shown: number;
	total: number;
}

/**
 * 整批截断：先 per-file 上限，再整批上限（保文件顺序，先到先得）；
 * message 逐条按上限截断。返回展示列表＋`…truncated (N/M)` 注记用计数。
 */
export function truncateBatch(
	files: Array<{ file: string; diags: NvimDiag[] }>,
	budgets: TruncationBudgets,
): { files: TruncatedDiags[] & Array<TruncatedDiags & { file: string }>; shown: number; total: number } {
	let total = 0;
	const perCapped = files.map(({ file, diags }) => {
		total += diags.length;
		const capped = diags.slice(0, budgets.perFile).map((d) => ({
			...d,
			message: truncateMessage(d.message, budgets.message),
		}));
		return { file, diags: capped, shown: capped.length, total: diags.length };
	});
	let shown = 0;
	for (const f of perCapped) shown += f.diags.length;
	// 整批上限：超了从尾部文件向前裁（保前序文件完整可读）
	if (shown > budgets.batch) {
		let overflow = shown - budgets.batch;
		for (let i = perCapped.length - 1; i >= 0 && overflow > 0; i--) {
			const f = perCapped[i];
			if (!f) continue;
			const cut = Math.min(overflow, f.diags.length);
			f.diags = f.diags.slice(0, f.diags.length - cut);
			f.shown = f.diags.length;
			overflow -= cut;
		}
		shown = budgets.batch;
	}
	return { files: perCapped, shown, total };
}

/** 截断注记：有截断才出（N=展示，M=原始总数） */
export function truncationNote(shown: number, total: number): string | undefined {
	if (total <= shown) return undefined;
	return `…truncated (${shown}/${total})`;
}

function formatDiagLine(file: string, d: NvimDiag): string {
	return `${file}:${d.line}:${d.col} [${severityLabel(d.severity)}] (${d.source}) ${d.message}`;
}

function countErrors(diags: NvimDiag[]): { errors: number; warns: number } {
	let errors = 0;
	let warns = 0;
	for (const d of diags) {
		if (d.severity === 1) errors++;
		else if (d.severity === 2) warns++;
	}
	return { errors, warns };
}

/**
 * nvim_lsp 模型侧文本：头行计数＋逐文件一行状态＋诊断行＋截断注记。
 * 例：`3 files, 2 errors, 1 warning`／`a.ts: 2 errors`／`a.ts: clean`。
 */
export function renderLspContent(
	files: Array<{ file: string; diags: NvimDiag[]; no_client?: boolean; error?: string }>,
	budgets: TruncationBudgets,
): string {
	const { files: capped, shown, total } = truncateBatch(files, budgets);
	let errors = 0;
	let warns = 0;
	for (const f of files) {
		const c = countErrors(f.diags);
		errors += c.errors;
		warns += c.warns;
	}
	const lines: string[] = [];
	const headParts = [`${files.length} file${files.length === 1 ? "" : "s"}`];
	if (errors > 0) headParts.push(`${errors} error${errors === 1 ? "" : "s"}`);
	if (warns > 0) headParts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
	if (errors === 0 && warns === 0) headParts.push("clean");
	lines.push(headParts.join(", "));
	for (const f of capped) {
		const orig = files.find((x) => x.file === f.file);
		if (orig?.error) {
			lines.push(`${f.file}: error (${orig.error})`);
			continue;
		}
		const noClient = orig?.no_client === true;
		if (f.total === 0) {
			lines.push(noClient ? `${f.file}: clean (no LSP client)` : `${f.file}: clean`);
			continue;
		}
		const c = countErrors(orig?.diags ?? []);
		const status: string[] = [];
		if (c.errors > 0) status.push(`${c.errors} error${c.errors === 1 ? "" : "s"}`);
		if (c.warns > 0) status.push(`${c.warns} warning${c.warns === 1 ? "" : "s"}`);
		const rest = f.total - c.errors - c.warns;
		if (rest > 0) status.push(`${rest} hint${rest === 1 ? "" : "s"}/info`);
		lines.push(`${f.file}: ${status.join(", ")}`);
		for (const d of f.diags) lines.push(formatDiagLine(f.file, d));
		if (f.shown < f.total) lines.push(`${f.file}: …truncated (${f.shown}/${f.total})`);
	}
	const note = truncationNote(shown, total);
	if (note) lines.push(note);
	return lines.join("\n");
}

/**
 * nvim_format 模型侧文本：`formatted X/Y`＋逐文件一行＋写后诊断＋截断注记。
 * format 状态逐文件一行：`path: formatted (12 lines)`／`path: unchanged (ok)`／
 * `path: skipped (no-formatter)` 等；reason 原样展示供模型判断。
 */
export function renderFormatContent(
	files: FormatFileResult[],
	budgets: TruncationBudgets,
): string {
	const done = files.filter((f) => f.formatted).length;
	const lines: string[] = [`formatted ${done}/${files.length}`];
	for (const f of files) {
		if (f.error) {
			lines.push(`${f.file}: error (${f.error})`);
		} else if (f.formatted) {
			lines.push(`${f.file}: formatted (${f.changed_lines} line${f.changed_lines === 1 ? "" : "s"})`);
		} else if (f.reason === "ok") {
			lines.push(`${f.file}: unchanged`);
		} else {
			lines.push(`${f.file}: skipped (${f.reason})`);
		}
	}
	const { files: capped, shown, total } = truncateBatch(
		files.map((f) => ({ file: f.file, diags: f.diags })),
		budgets,
	);
	for (const f of capped) {
		for (const d of f.diags) lines.push(formatDiagLine(f.file, d));
		if (f.shown < f.total) lines.push(`${f.file}: …truncated (${f.shown}/${f.total})`);
	}
	const note = truncationNote(shown, total);
	if (note) lines.push(note);
	return lines.join("\n");
}

/** daemon 原始 JSON（宽容解析：字段缺失回退空值，不抛错） */
export function parseDiagnosePayload(payload: unknown): DiagnoseFileResult[] {
	if (!payload || typeof payload !== "object") return [];
	const perFile = (payload as { per_file?: unknown }).per_file;
	if (!Array.isArray(perFile)) return [];
	const out: DiagnoseFileResult[] = [];
	for (const entry of perFile) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (typeof e["file"] !== "string") continue;
		const diagsRaw = Array.isArray(e["diags"]) ? e["diags"] : [];
		const diags: NvimDiag[] = [];
		for (const d of diagsRaw) {
			if (!d || typeof d !== "object") continue;
			const r = d as Record<string, unknown>;
			diags.push({
				line: typeof r["line"] === "number" ? r["line"] : 0,
				col: typeof r["col"] === "number" ? r["col"] : 0,
				severity: r["severity"] === 1 || r["severity"] === 2 || r["severity"] === 3 ? r["severity"] : 4,
				source: typeof r["source"] === "string" ? r["source"] : "lsp",
				message: typeof r["message"] === "string" ? r["message"] : "",
			});
		}
		out.push({
			file: e["file"],
			diags,
			ms: typeof e["ms"] === "number" ? e["ms"] : 0,
			no_client: e["no_client"] === true ? true : undefined,
			error: typeof e["error"] === "string" ? (e["error"] as string) : undefined,
		});
	}
	return out;
}

/** format 原始 JSON 宽容解析（reason 非法回退 format-error，不静默记 ok） */
export function parseFormatPayload(payload: unknown): FormatFileResult[] {
	if (!payload || typeof payload !== "object") return [];
	const perFile = (payload as { per_file?: unknown }).per_file;
	if (!Array.isArray(perFile)) return [];
	const out: FormatFileResult[] = [];
	const diagnosed = parseDiagnosePayload(payload);
	const diagByFile = new Map(diagnosed.map((d) => [d.file, d]));
	for (const entry of perFile) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (typeof e["file"] !== "string") continue;
		const reason = e["reason"];
		const file = e["file"];
		out.push({
			file,
			formatted: e["formatted"] === true,
			reason:
				reason === "ok" || reason === "no-formatter" || reason === "write-error"
					? reason
					: "format-error",
			changed_lines: typeof e["changed_lines"] === "number" ? e["changed_lines"] : 0,
			diags: diagByFile.get(file)?.diags ?? [],
			ms: typeof e["ms"] === "number" ? e["ms"] : 0,
			no_client: e["no_client"] === true ? true : undefined,
			error: typeof e["error"] === "string" ? (e["error"] as string) : undefined,
		});
	}
	return out;
}
