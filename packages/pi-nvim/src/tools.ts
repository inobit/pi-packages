/**
 * @inobit/pi-nvim — 双工具定义＋execute（方案 §三接口形状定稿）。
 *
 * - `nvim_lsp`（只读诊断）：整批单调用、无队列，绝不写盘。
 * - `nvim_format`（写盘格式化）：逐文件 `withFileMutationQueue(file, fn)` 包裹后调 daemon
 *   （Phase 1 逐文件往返；批量单往返为后续优化项）。
 * - 对外靠 `executionMode: "sequential"` 串行，对内靠 daemon 互斥队列串行。
 * - execute 返回 `{ content（全量诊断文本）, details（完整 JSON 重建用） }`；失败 throw；
 *   `signal.aborted` 跳过剩余文件返回 partial（注：execute 返回无 isError 位，
 *   中断以正文 partial 注记＋details.aborted 表达，真失败才 throw）。
 * - 诊断全量（结构化、可再生，不截断）；错误文本统一走 truncateError（见 result.ts）。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MAX_DIAGNOSTIC_MS, MAX_STARTUP_MS, resolveCallTimeouts, type CallTimeouts, type NvimConfig } from "./config.ts";
import {
	DaemonAbortedError,
	DaemonManager,
	DaemonTimeoutError,
	listenAbort,
} from "./daemon.ts";
import {
	appendRetryHint,
	degradedHeader,
	parseDiagnosePayload,
	parseFormatPayload,
	renderFormatContent,
	renderLspContent,
	type DiagnoseFileResult,
	type FormatFileResult,
} from "./result.ts";
import { partitionFiles } from "./scope.ts";

const FILES_FIELD = {
	files: Type.Array(Type.String(), {
		minItems: 1,
		description: "Required. Absolute file paths (absolute, not relative); pass ALL touched files in ONE call.",
	}),
};

const TIMEOUT_HINT =
	"Optional integer (0-120000 ms); omitted = user config. Timeout failures suggest the value to retry with.";

/** nvim_lsp：启动段（startupMs）＋诊断段（diagnosticMs）可各自覆盖 */
export const NvimLspParams = Type.Object(
	{
		...FILES_FIELD,
		startupMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: MAX_STARTUP_MS,
				description: `Wait budget for LSP clients to attach before diagnostics start. ${TIMEOUT_HINT}`,
			}),
		),
		diagnosticMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: MAX_DIAGNOSTIC_MS,
				description: `Budget for diagnostics collection (pull requests and push observation share it). ${TIMEOUT_HINT}`,
			}),
		),
	},
	{ additionalProperties: false },
);

/** nvim_format：只有启动段可覆盖（写盘有 :w 回执，不需要诊断预算） */
export const NvimFormatParams = Type.Object(
	{
		...FILES_FIELD,
		startupMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: MAX_STARTUP_MS,
				description: `Wait budget for formatter clients to attach before writing. ${TIMEOUT_HINT}`,
			}),
		),
	},
	{ additionalProperties: false },
);

/** 兼容旧名（等价于 nvim_lsp 的参数形状） */
export const NvimFilesParams = NvimLspParams;

export type NvimLspParamsType = Static<typeof NvimLspParams>;
export type NvimFormatParamsType = Static<typeof NvimFormatParams>;
export type NvimFilesParamsType = NvimLspParamsType;

export interface NvimToolDeps {
	cfg: NvimConfig;
	daemon: DaemonManager;
}

function sessionIdOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() ?? "";
	} catch {
		return "";
	}
}

function cwdOf(ctx: ExtensionContext): string {
	return typeof ctx.cwd === "string" && ctx.cwd !== "" ? ctx.cwd : process.cwd();
}

/** nvim_lsp details：全量诊断（不截断诊断数组；错误文走错误截断） */
export interface NvimLspDetails {
	kind: "nvim_lsp";
	files: DiagnoseFileResult[];
	aborted?: boolean;
	/** 启动健康 degraded 行（healthy 时缺省；逐行走错误截断） */
	degraded_lines?: string[];
}

/** nvim_format details：完整 per-file 五态（不截断诊断数组；错误文走错误截断） */
export interface NvimFormatDetails {
	kind: "nvim_format";
	files: FormatFileResult[];
	aborted?: boolean;
	partial?: boolean;
	/** 启动健康 degraded 行（healthy 时缺省；逐行走错误截断） */
	degraded_lines?: string[];
}

function textResult(text: string, details: NvimLspDetails | NvimFormatDetails): {
	content: Array<{ type: "text"; text: string }>;
	details: NvimLspDetails | NvimFormatDetails;
} {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export const NVIM_LSP_DESCRIPTION =
	"Run your Neovim LSP setup over the given files and return diagnostics (errors/warnings/hints from language servers and bridged linters). Read-only: never modifies files.";

export const NVIM_FORMAT_DESCRIPTION =
	"Format the given files with your Neovim LSP formatters and write the result back, then return remaining diagnostics. MODIFIES files on disk.";

const NVIM_GUIDELINES = [
	"nvim_lsp returns LSP diagnostics without modifying files; suitable for verifying edited files.",
	"nvim_format formats through your Neovim setup and writes back; use it only when formatting is explicitly needed.",
	"Both tools accept multiple files in ONE call; per-file loops are unnecessary.",
	"Timeout failures suggest the value to retry with; pass the same files again with that override instead of giving up.",
	"Scope is allowlisted (code plus md/Dockerfile for diagnostics, code only for format); out-of-scope files return per-file skipped.",
];

/** 系统提示词 Available tools 段的一行短语（缺失则工具不出现在该段） */
const NVIM_LSP_SNIPPET = "read-only LSP diagnostics for given files";
const NVIM_FORMAT_SNIPPET = "format files through your Neovim setup (writes to disk)";

async function ensureHandles(deps: NvimToolDeps, ctx: ExtensionContext): Promise<{
	sessionId: string;
	handles: Awaited<ReturnType<DaemonManager["ensure"]>>;
}> {
	const sessionId = sessionIdOf(ctx);
	const handles = await deps.daemon.ensure({ sessionId, cwd: cwdOf(ctx) });
	return { sessionId, handles };
}

/** degraded 头行 prepend（healthy 时原样返回） */
function withDegraded(text: string, degraded: string[] | undefined): string {
	if (!degraded || degraded.length === 0) return text;
	return `${degradedHeader(degraded)}\n${text}`;
}

/** 调用级时间解析：不传即配置默认；传了按硬顶与窗口联合钳制（见 resolveCallTimeouts） */
function effectiveOf(cfg: NvimConfig, call: CallTimeouts) {
	return resolveCallTimeouts(cfg.timeouts, call);
}

/** 生效值明细（details 用，机器可读） */
function effectiveDetails(eff: ReturnType<typeof effectiveOf>): Record<string, unknown> {
	return {
		effective: { startupMs: eff.startupMs, diagnosticMs: eff.diagnosticMs, windowMs: eff.windowMs },
		...(eff.clamped
			? { clamped_from: { startupMs: eff.requestedStartupMs, diagnosticMs: eff.requestedDiagnosticMs } }
			: {}),
	};
}

/** 被钳制时在正文首行提示（不钳则原样返回）：模型才知道自己实际拿到多少 */
function withClampNote(text: string, eff: ReturnType<typeof effectiveOf>): string {
	if (!eff.clamped) return text;
	return `note: timeouts clamped to startupMs=${eff.startupMs}, diagnosticMs=${eff.diagnosticMs} (request window ${eff.windowMs}ms)\n${text}`;
}

function degradedDetails(degraded: string[] | undefined): { degraded_lines?: string[] } {
	if (!degraded || degraded.length === 0) return {};
	return { degraded_lines: [...degraded] };
}

export function registerNvimTools(pi: ExtensionAPI, deps: NvimToolDeps): void {
	pi.registerTool({
		name: "nvim_lsp",
		label: "Nvim LSP",
		description: NVIM_LSP_DESCRIPTION,
		promptSnippet: NVIM_LSP_SNIPPET,
		promptGuidelines: [...NVIM_GUIDELINES],
		parameters: NvimLspParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const eff = effectiveOf(deps.cfg, { startupMs: params.startupMs, diagnosticMs: params.diagnosticMs });
			// 诊断建议值地板：push 观测地板 + 5s（够 push-only 的迟到波落地）
			const hintCaps = {
				maxStartupMs: MAX_STARTUP_MS,
				maxDiagnosticMs: MAX_DIAGNOSTIC_MS,
				diagnosticFloorMs: deps.cfg.timeouts.pushObserveMs + 5000,
			};
			// 调用守卫（TS 侧、ensure() 之前）：存在→是文件→可读文本→本工具白名单；
			// 本地项行内表达，daemon-bound 走整批单调用，最后按请求原序合并单次返回。
			const scope = partitionFiles(params.files, "diagnostics", deps.cfg.whitelist);
			const localOf = (file: string): DiagnoseFileResult | undefined => {
				const local = scope.locals.get(file);
				if (!local) return undefined;
				if (local.skipped) return { file, status: "skipped", message: local.skipped, diags: [], ms: 0 };
				return { file, status: "failed", message: local.error ?? "unreadable file", diags: [], ms: 0 };
			};
			if (scope.daemonFiles.length === 0) {
				// 全拦截：根本不 ensure()（daemon 零惊动，冷启动不变量）
				const full = params.files.map((f) => localOf(f) ?? { file: f, status: "failed" as const, message: "guard error", diags: [], ms: 0 });
				return textResult(renderLspContent(full, deps.cfg.errorCap), {
					kind: "nvim_lsp",
					files: full,
				});
			}
			const { handles } = await deps.daemon.runExclusive(() => ensureHandles(deps, ctx));
			let payload: unknown;
			try {
				payload = await deps.daemon.runExclusive(() =>
					deps.daemon.request(handles, "diagnose", [...scope.daemonFiles], signal, eff),
				);
			} catch (err) {
				if (err instanceof DaemonTimeoutError) {
					await deps.daemon.killStuck(handles).catch(() => undefined);
				}
				if (err instanceof DaemonAbortedError) {
					const failedNow = scope.daemonFiles.map((file) => ({ file, status: "failed" as const, message: "aborted before processing", diags: [], ms: 0 }));
					const full = params.files.map((f) => localOf(f) ?? failedNow.find((x) => x.file === f) ?? { file: f, status: "failed" as const, message: "aborted before processing", diags: [], ms: 0 });
					return textResult(withDegraded(renderLspContent(full, deps.cfg.errorCap), handles.degradedLines), {
						kind: "nvim_lsp",
						files: full,
						aborted: true,
						...degradedDetails(handles.degradedLines),
					});
				}
				throw err;
			}
			const parsed = parseDiagnosePayload(payload, deps.cfg.errorCap).map((f) =>
				f.message !== undefined
					? { ...f, message: appendRetryHint(f.message, eff, hintCaps) }
					: f,
			);
			// 按请求原序合并：本地项行内表达，daemon 未回的文件记失败（不虚构干净）
			const byFile = new Map(parsed.map((p) => [p.file, p]));
			const full = params.files.map((f) => localOf(f) ?? byFile.get(f) ?? { file: f, status: "failed" as const, message: "no result from daemon", diags: [], ms: 0 });
			return textResult(
				withClampNote(withDegraded(renderLspContent(full, deps.cfg.errorCap), handles.degradedLines), eff),
				{
					kind: "nvim_lsp",
					files: full,
					...effectiveDetails(eff),
					...degradedDetails(handles.degradedLines),
				},
			);
		},
	});

	pi.registerTool({
		name: "nvim_format",
		label: "Nvim Format",
		description: NVIM_FORMAT_DESCRIPTION,
		promptSnippet: NVIM_FORMAT_SNIPPET,
		promptGuidelines: [...NVIM_GUIDELINES],
		parameters: NvimFormatParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const eff = effectiveOf(deps.cfg, { startupMs: params.startupMs });
			// 调用守卫（TS 侧、ensure() 之前）：本地项行内表达，daemon-bound 逐文件走
			// per-file mutation queue 环，最后按请求原序合并单次返回。
			const scope = partitionFiles(params.files, "format", deps.cfg.whitelist);
			const localFormatOf = (file: string): FormatFileResult | undefined => {
				const local = scope.locals.get(file);
				if (!local) return undefined;
				// P2-8 注记：skipped 是“未执行”（白名单短路），借用 unchanged 槽位是因为 FormatReason 无空转值；渲染优先 skipped 分支，details 语义以 skipped 字段为准
				if (local.skipped) return { file, formatted: false, reason: "unchanged", diags: [], ms: 0, skipped: local.skipped };
				return { file, formatted: false, reason: "format-error", diags: [], ms: 0, error: local.error ?? "unreadable file" };
			};
			const results: FormatFileResult[] = [];
			let aborted = false;
			const offAbort = listenAbort(signal, () => {
				aborted = true;
			});
			let degraded: string[] | undefined;
			try {
			if (scope.daemonFiles.length === 0) {
				// 全拦截：根本不 ensure()（daemon 零惊动），本地项按原序单次聚合返回
				for (const file of params.files) results.push(localFormatOf(file) ?? { file, formatted: false, reason: "format-error", diags: [], ms: 0, error: "unreadable file" });
			} else {
			// 整批占住 daemon 互斥（串行），daemon-bound 逐文件再走 per-file mutation queue
				await deps.daemon.runExclusive(async () => {
					const { handles } = await ensureHandles(deps, ctx);
					degraded = handles.degradedLines ? [...handles.degradedLines] : undefined;
					for (const file of params.files) {
						const local = localFormatOf(file);
						if (local) {
							results.push(local);
							continue;
						}
						if (aborted) {
							break;
						}
						try {
							const one = await withFileMutationQueue(file, () =>
								deps.daemon.request(handles, "format", [file], signal, eff),
							);
							let parsed = parseFormatPayload(one, deps.cfg.errorCap);
							parsed = parsed.map((f) =>
								f.note !== undefined
									? { ...f, note: appendRetryHint(f.note, eff, { maxStartupMs: MAX_STARTUP_MS, maxDiagnosticMs: MAX_DIAGNOSTIC_MS }) }
									: f,
							);
							const got = parsed.find((p) => p.file === file);
							results.push(
								got ?? {
									file,
									formatted: false,
									reason: "format-error",
									diags: [],
									ms: 0,
								},
							);
						} catch (err) {
							if (err instanceof DaemonAbortedError) {
								aborted = true;
								break;
							}
							if (err instanceof DaemonTimeoutError) {
								await deps.daemon.killStuck(handles).catch(() => undefined);
							}
							throw err;
						}
					}
				});
			}
			if (aborted) {
				const seen = new Set(results.map((r) => r.file));
				for (const file of params.files) {
					if (!seen.has(file)) {
						results.push({ file, formatted: false, reason: "format-error", diags: [], ms: 0, error: "aborted before processing" });
					}
				}
			}
			let text = withDegraded(renderFormatContent(results, deps.cfg.errorCap), degraded);
			if (aborted) {
				text += `\n…aborted (partial: ${params.files.length} files attempted, see failed section)`;
			}
			return textResult(withClampNote(text, eff), {
				kind: "nvim_format",
				files: results,
				...effectiveDetails(eff),
				aborted: aborted ? true : undefined,
				partial: aborted ? true : undefined,
				...degradedDetails(degraded),
			});
			} finally {
				offAbort();
			}
		},
	});
}
