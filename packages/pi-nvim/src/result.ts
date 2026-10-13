/**
 * @inobit/pi-nvim — daemon 结果解析＋渲染（纯函数，可单测）。
 *
 * 契约（方案 §三/§九）：
 * - 诊断全量返回：诊断结构化、可再生，无界风险由调用方拆文件承担，
 *   故 content＋details 均不截断诊断数组（无 per-file/整批/message 预算）。
 * - 唯一截断是错误文本：所有进入 content 或 details 的错误字符串统一
 *   `truncateError(text, 2000)`＋`…(truncated N chars)` 注记，details 同 cap
 *   （日志保护；错误非结构化、前重后轻）。
 * - 返回不含文件内容。
 * - format 五态：`formatted`＋`reason(ok/unchanged/no-formatter/format-error/write-error)`，
 *   `formatted` 必须由写前写后内容比较得出（布尔，见 lua/bridge.lua content_changed）；
 *   不报改动行数——位置比较会把前部插入虚报成后续每一行都改，数字对模型无意义。
 */

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

/** diagnose 单文件结果；无 client 的文件记 diags:[]＋no_client:true；调用守卫短路记 error/skipped 行内表达 */
export interface DiagnoseFileResult {
	file: string;
	diags: NvimDiag[];
	ms: number;
	no_client?: boolean;
	/** daemon 侧处理失败（edit 失败等）：渲染为 error 行，绝不静默记 clean */
	error?: string;
	/** 调用守卫白名单未命中：渲染为 skipped 行（非错误，不执行） */
	skipped?: string;
	/** 不可识别输出：原文透传（错误 cap 截断）＋note，永不记 clean、永不编造 reason */
	raw?: string;
	note?: string;
}

/** format 五态 reason（unchanged＝写后比较无变化，覆盖“已格式化”与“静默无操作”两义） */
export type FormatReason = "ok" | "unchanged" | "no-formatter" | "format-error" | "write-error";

/** format 单文件结果（另见 skipped：调用守卫白名单未命中，行内 skipped 非错误） */
export interface FormatFileResult {
	file: string;
	formatted: boolean;
	reason: FormatReason;
	diags: NvimDiag[];
	ms: number;
	no_client?: boolean;
	/** daemon 侧处理失败：渲染为 error 行 */
	error?: string;
	/** 调用守卫白名单未命中：渲染为 skipped 行（非错误，不执行） */
	skipped?: string;
	/** 不可识别输出：原文透传（错误 cap 截断）＋note，永不记 clean、永不编造 reason */
	raw?: string;
	note?: string;
}

/** 错误文本上限（字符数；唯一截断，content/details 同 cap） */
export const ERROR_TEXT_LIMIT = 2000;

/**
 * 错误文本截断：错误非结构化、前重后轻，只保留前 2000 字并注记截掉的字数。
 * 所有进入 content 或 details 的错误字符串（daemon `{error}` 信封、per-file
 * error、spawn/kick/wait/abort 异常文、degraded 行）统一走此函数。
 */
export function truncateError(text: string, max: number = ERROR_TEXT_LIMIT): string {
	// 幂等：已带注记即原样返回（parse 截过的不再二次截，避免注记失真）
	if (/…\(truncated \d+ chars\)$/.test(text)) return text;
	if (text.length <= max) return text;
	return text.slice(0, max) + `…(truncated ${text.length - max} chars)`;
}

/** 严重度数字 → 展示级别 */
export function severityLabel(s: number): string {
	if (s === 1) return "error";
	if (s === 2) return "warn";
	if (s === 3) return "info";
	return "hint";
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
 * 五态推导（与 lua/bridge.lua 同逻辑，TS 侧单测即契约）：
 * - write-error 优先（:w 失败，留现场不 wipe）；
 * - 无 formatter 记 no-formatter（buf.format 无 client 仅 notify，必须显式分支）；
 * - formatter 显式错误记 format-error；
 * - 其余比较写前写后：有变化 formatted:true＋ok，无变化 formatted:false＋unchanged
 *   （unchanged 覆盖“已格式化，无事可做”与“formatter 静默无操作”两义，不以
 *   “未抛错”推导 formatted；ok 只表示“本次写盘产生了变化”）。
 *
 * 注：真实推导在 Lua（format_write），TS 侧只合成调用守卫短路结果（恒 unchanged/format-error），
 * 故此函数仅作契约留档＋单测，不参与渲染。
 */
export function deriveFormatState(
	before: string,
	after: string,
	gate: FormatGate,
): { formatted: boolean; reason: FormatReason } {
	if (gate.writeError) return { formatted: false, reason: "write-error" };
	if (!gate.hasFormatter) return { formatted: false, reason: "no-formatter" };
	if (gate.formatError) return { formatted: false, reason: "format-error" };
	return { formatted: before !== after, reason: before === after ? "unchanged" : "ok" };
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

/** degraded 头行一句话（content 首行，调用方在渲染结果前 prepend） */
export function degradedHeader(lines: string[]): string {
	return `daemon degraded: startup log shows ${lines.length} error line${lines.length === 1 ? "" : "s"} (config may be broken; results may be incomplete)`;
}

/**
 * nvim_lsp 模型侧文本：头行计数＋正常文件行内＋全量诊断行＋末尾 failed 节。
 * 例：`3 files, 2 errors, 1 warning`／`a.ts: 2 errors`／`a.ts: clean`。
 * 二分法：无需动作的行内（clean／诊断／skipped／no_client），需动作的打包
 * 进末尾 `failed (N)` 节（一文件一行＋原因）；error/raw 文走错误截断，
 * 诊断数组全量（结构化、可再生，不截断）。
 */
export function renderLspContent(
	files: Array<{ file: string; diags: NvimDiag[]; no_client?: boolean; error?: string; skipped?: string; raw?: string; note?: string }>,
	errorCap: number = ERROR_TEXT_LIMIT,
): string {
	let errors = 0;
	let warns = 0;
	for (const f of files) {
		const c = countErrors(f.diags);
		errors += c.errors;
		warns += c.warns;
	}
	const failed: Array<{ file: string; reason: string }> = [];
	for (const f of files) {
		if (f.error !== undefined) failed.push({ file: f.file, reason: truncateError(f.error, errorCap) });
		else if (f.raw !== undefined)
			failed.push({ file: f.file, reason: `unrecognized (${f.note ?? "unknown"}): ${truncateError(f.raw, errorCap)}` });
	}
	const lines: string[] = [];
	const headParts = [`${files.length} file${files.length === 1 ? "" : "s"}`];
	if (errors > 0) headParts.push(`${errors} error${errors === 1 ? "" : "s"}`);
	if (warns > 0) headParts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
	if (failed.length > 0) headParts.push(`${failed.length} failed`);
	if (errors === 0 && warns === 0 && failed.length === 0) headParts.push("clean");
	lines.push(headParts.join(", "));
	for (const f of files) {
		if (f.error !== undefined || f.raw !== undefined) continue;
		if (f.skipped) {
			lines.push(`${f.file}: skipped (${f.skipped})`);
			continue;
		}
		if (f.diags.length === 0) {
			lines.push(f.no_client === true ? `${f.file}: clean (no LSP client)` : `${f.file}: clean`);
			continue;
		}
		const c = countErrors(f.diags);
		const status: string[] = [];
		if (c.errors > 0) status.push(`${c.errors} error${c.errors === 1 ? "" : "s"}`);
		if (c.warns > 0) status.push(`${c.warns} warning${c.warns === 1 ? "" : "s"}`);
		const rest = f.diags.length - c.errors - c.warns;
		if (rest > 0) status.push(`${rest} hint${rest === 1 ? "" : "s"}/info`);
		lines.push(`${f.file}: ${status.join(", ")}`);
		for (const d of f.diags) lines.push(formatDiagLine(f.file, d));
	}
	if (failed.length > 0) {
		lines.push(`failed (${failed.length}):`);
		for (const item of failed) lines.push(`- ${item.file}: ${item.reason}`);
	}
	return lines.join("\n");
}

/**
 * nvim_format 模型侧文本：`formatted X/Y`＋逐文件一行＋写后全量诊断。
 * format 状态逐文件一行：`path: formatted (12 lines)`／`path: unchanged`／
 * `path: skipped (no-formatter)` 等；调用守卫短路另有 `path: skipped (not in whitelist)`／
 * `path: error (…)` 行内表达（error 行走错误截断）；reason 原样展示供模型判断。
 * 兼容旧 daemon 的 `ok`＋未变化：同样渲染为 `unchanged`。
 */
export function renderFormatContent(files: FormatFileResult[], errorCap: number = ERROR_TEXT_LIMIT): string {
	const failed: Array<{ file: string; reason: string }> = [];
	for (const f of files) {
		if (f.error !== undefined) failed.push({ file: f.file, reason: truncateError(f.error, errorCap) });
		else if (f.raw !== undefined)
			failed.push({ file: f.file, reason: `unrecognized (${f.note ?? "unknown"}): ${truncateError(f.raw, errorCap)}` });
		else if (f.reason === "format-error" || f.reason === "write-error")
			failed.push({ file: f.file, reason: f.error !== undefined ? truncateError(f.error, errorCap) : f.reason });
	}
	const done = files.filter((f) => f.formatted).length;
	const lines: string[] = [`formatted ${done}/${files.length}`];
	if (failed.length > 0) lines[0] += `, ${failed.length} failed`;
	for (const f of files) {
		if (f.error !== undefined || f.raw !== undefined || f.reason === "format-error" || f.reason === "write-error") {
			continue;
		} else if (f.skipped) {
			lines.push(`${f.file}: skipped (${f.skipped})`);
		} else if (f.formatted) {
			lines.push(`${f.file}: formatted`);
		} else if (f.reason === "unchanged" || f.reason === "ok") {
			lines.push(`${f.file}: unchanged`);
		} else {
			lines.push(`${f.file}: skipped (${f.reason})`);
		}
	}
	for (const f of files) {
		for (const d of f.diags) lines.push(formatDiagLine(f.file, d));
	}
	if (failed.length > 0) {
		lines.push(`failed (${failed.length}):`);
		for (const item of failed) lines.push(`- ${item.file}: ${item.reason}`);
	}
	return lines.join("\n");
}

/** daemon 原始 JSON（宽容解析：字段缺失回退空值，不抛错；error 文进 details 前走错误截断） */
export function parseDiagnosePayload(payload: unknown, cap: number = ERROR_TEXT_LIMIT): DiagnoseFileResult[] {
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
			error: typeof e["error"] === "string" ? truncateError(e["error"] as string, cap) : undefined,
			raw: typeof e["raw"] === "string" ? truncateError(e["raw"] as string, cap) : undefined,
			note: typeof e["note"] === "string" ? e["note"] : undefined,
		});
	}
	return out;
}

// 截断单步点：parse 收 cap（默认 2000），调用方传配置值；render 同 cap 二次调用由幂等守卫吸收。

/** format 原始 JSON 宽容解析（reason 非法回退 format-error，不静默记 ok；error 文走错误截断） */
export function parseFormatPayload(payload: unknown, cap: number = ERROR_TEXT_LIMIT): FormatFileResult[] {
	if (!payload || typeof payload !== "object") return [];
	const perFile = (payload as { per_file?: unknown }).per_file;
	if (!Array.isArray(perFile)) return [];
	const out: FormatFileResult[] = [];
	const diagnosed = parseDiagnosePayload(payload, cap);
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
				reason === "ok" || reason === "unchanged" || reason === "no-formatter" || reason === "write-error"
					? reason
					: "format-error",
			skipped: typeof e["skipped"] === "string" ? e["skipped"] : undefined,
			diags: diagByFile.get(file)?.diags ?? [],
			ms: typeof e["ms"] === "number" ? e["ms"] : 0,
			no_client: e["no_client"] === true ? true : undefined,
			error: typeof e["error"] === "string" ? truncateError(e["error"] as string, cap) : undefined,
			raw: typeof e["raw"] === "string" ? truncateError(e["raw"] as string, cap) : undefined,
			note: typeof e["note"] === "string" ? e["note"] : undefined,
		});
	}
	return out;
}
