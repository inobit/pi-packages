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

/** 单条诊断（不含文件内容，只有位置＋消息）；client 为发出它的 lsp 名（pull 已知，
 * push 按 namespace 回查；认不出时缺席，渲染回退为只有 source） */
export interface NvimDiag {
	line: number;
	col: number;
	severity: DiagSeverity;
	source: string;
	message: string;
	client?: string;
}

/** diagnose 单文件结果（HTTP 信封：status 二值＋message 一句话；`diags` 只放真诊断，
 * 失败时也可带已拿到的 partial——status 表动作 complete 与否，diags 表拿到了什么）。
 * - success：检查完成；message 恒缺席；diags 为空即真干净（pull 空返回或 push 空发布）；
 * - failed：检查没完成；message 必填（一句话，多 client 用 "; " 连接）；
 * - skipped：未执行（白名单门卫／零 client）；message 为原因，diags 恒空。
 * pi 框架的 execute 返回无 status 位（`AgentToolResult` 只有 content/details；
 * 失败靠 throw），故 per-file 状态必须落在我们自己的 payload 里。 */
export interface DiagnoseFileResult {
	file: string;
	status: "success" | "failed" | "skipped";
	message?: string;
	diags: NvimDiag[];
	ms: number;
	/** details-only 标记（weak-clean 等）；content 渲染忽略，不进模型行 */
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

/** 单行折叠：诊断 message 可能多行（如 oxlint 的 message＋help），一行一条不能用 \n */
function oneLine(text: string): string {
	return text.replaceAll(/\s*\n+\s*/g, " ").trim();
}

/** 超时失败行追加"下次可调大"的旋钮建议，只认我们自己的两种超时口径。
 * 建议值＝max(生效值×2, 地板, 2s) 再钳到硬顶：诊断的地板取 push 观测地板+5s
 * （push-only 服务器迟到波需要的最短预算），避免模型每次只翻倍、反复失败。 */
export function appendRetryHint(
	message: string,
	eff: { startupMs: number; diagnosticMs: number },
	caps: { maxStartupMs: number; maxDiagnosticMs: number; diagnosticFloorMs?: number; startupFloorMs?: number },
): string {
	const suggest = (v: number, cap: number, floor: number): number => Math.min(cap, Math.max(2000, floor, v * 2));
	if (message.includes("diagnostics timed out")) {
		return `${message} (retry with diagnosticMs=${suggest(eff.diagnosticMs, caps.maxDiagnosticMs, caps.diagnosticFloorMs ?? 2000)})`;
	}
	if (message.includes("initialization timed out")) {
		return `${message} (retry with startupMs=${suggest(eff.startupMs, caps.maxStartupMs, caps.startupFloorMs ?? 20000)})`;
	}
	return message;
}

function formatDiagLine(file: string, d: NvimDiag): string {
	const origin = d.client !== undefined && d.client !== "" ? `${d.client}: ${d.source}` : d.source;
	return `${file}:${d.line}:${d.col} [${severityLabel(d.severity)}] (${origin}) ${oneLine(d.message)}`;
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
 * nvim_lsp 模型侧文本：只用 2 种格式（槽位镜像）＋门卫行。
 * - 正常：`path: clean` ／ 明细 `path:L:C [sev] (client: source) msg`；
 * - 非正常：`path: [failed] (client) reason`（client 槽可选；桥接层失败无括号；
 *   message 空/缺兜底 `unknown error`）；`path: skipped (reason)`（白名单／零 client，未执行）。
 * header 只写计数（不写目录）；行内恒用全路径。
 * `clean`（行与头）只在全 success 且零诊断时出现；header 另计 failed/skipped 文件数。
 */
export function renderLspContent(
	files: Array<{
		file: string;
		status: "success" | "failed" | "skipped";
		message?: string;
		diags: NvimDiag[];
		ms?: number;
		note?: string;
	}>,
	errorCap: number = ERROR_TEXT_LIMIT,
): string {
	let errors = 0;
	let warns = 0;
	let hints = 0;
	let failed = 0;
	let skipped = 0;
	for (const f of files) {
		if (f.status === "skipped") {
			skipped++;
			continue;
		}
		if (f.status === "failed") {
			failed++;
		}
		const c = countErrors(f.diags);
		errors += c.errors;
		warns += c.warns;
		hints += f.diags.length - c.errors - c.warns;
	}
	const lines: string[] = [];
	const headParts = [`${files.length} file${files.length === 1 ? "" : "s"}`];
	if (errors > 0) headParts.push(`${errors} error${errors === 1 ? "" : "s"}`);
	if (warns > 0) headParts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
	if (hints > 0) headParts.push(`${hints} hint${hints === 1 ? "" : "s"}/info`);
	if (failed > 0) headParts.push(`${failed} failed`);
	if (skipped > 0) headParts.push(`${skipped} skipped`);
	if (errors === 0 && warns === 0 && hints === 0 && failed === 0 && skipped === 0) headParts.push("clean");
	lines.push(headParts.join(", "));
	for (const f of files) {
		const name = f.file;
		if (f.status === "skipped") {
			lines.push(`${name}: skipped (${f.message ?? "skipped"})`);
			continue;
		}
		if (f.status === "failed") {
			// 兜底：empty/缺 message 也必须有一行错误（绝不出现 `[failed] ` 裸尾巴）
			const msg = f.message !== undefined && f.message.trim() !== "" ? f.message : "unknown error";
			lines.push(`${name}: [failed] ${truncateError(msg, errorCap)}`);
		}
		// success：clean 或明细行；failed 的 partial 诊断同样照跟（拿到的数据不丢）。
		// success 的 message 恒缺席（HTTP 200 的 data 只有数据）；note（best-effort 标记）
		// 只进 details，不进 content 行——content 保持 2 种格式的纯粹。
		if (f.diags.length > 0) {
			for (const d of f.diags) lines.push(formatDiagLine(name, d));
		} else if (f.status === "success") {
			lines.push(`${name}: clean`);
		}
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
	// 写后诊断缺口注记（pull 不可用/超时时 Lua 记 note；details 同源，content 行内一行）
	for (const f of files) {
		if (f.note === undefined) continue;
		if (f.error !== undefined || f.raw !== undefined || f.reason === "format-error" || f.reason === "write-error") continue;
		lines.push(`${f.file}: ${truncateError(f.note, errorCap)}`);
	}
	if (failed.length > 0) {
		lines.push(`failed (${failed.length}):`);
		for (const item of failed) lines.push(`- ${item.file}: ${item.reason}`);
	}
	return lines.join("\n");
}

/** daemon 原始 JSON（宽容解析：status 非法回退 failed；message 走错误截断；
 * 诊断数组全量，不截断） */
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
				client: typeof r["client"] === "string" && r["client"] !== "" ? r["client"] : undefined,
			});
		}
		const status = e["status"];
		const goodStatus = status === "success" || status === "failed" || status === "skipped";
		out.push({
			file: e["file"],
			status: goodStatus ? status : "failed",
			message:
			typeof e["message"] === "string"
				? truncateError(e["message"], cap)
				: goodStatus
					? undefined
					: "unrecognized file status",
			diags,
			ms: typeof e["ms"] === "number" ? e["ms"] : 0,
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
