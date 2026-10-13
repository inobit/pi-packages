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
import type { NvimConfig } from "./config.ts";
import {
	DaemonAbortedError,
	DaemonManager,
	DaemonTimeoutError,
} from "./daemon.ts";
import {
	degradedHeader,
	parseDiagnosePayload,
	parseFormatPayload,
	renderFormatContent,
	renderLspContent,
	type DiagnoseFileResult,
	type FormatFileResult,
} from "./result.ts";
import { partitionFiles } from "./scope.ts";

export const NvimFilesParams = Type.Object(
	{
		files: Type.Array(Type.String(), {
			minItems: 1,
			description: "Absolute file paths; pass ALL touched files in ONE call",
		}),
	},
	{ additionalProperties: false },
);

export type NvimFilesParamsType = Static<typeof NvimFilesParams>;

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
	"Run your Neovim LSP setup over the given files and return diagnostics (errors/warnings/hints from language servers and bridged linters). Read-only: never modifies files. Pass ALL touched files in ONE call.";

export const NVIM_FORMAT_DESCRIPTION =
	"Format the given files with your Neovim LSP formatters and write the result back, then return remaining diagnostics. MODIFIES files on disk.";

const NVIM_GUIDELINES = [
	"nvim_lsp returns LSP diagnostics without modifying files; suitable for verifying edited files.",
	"nvim_format formats through your Neovim setup and writes back; use it only when formatting is explicitly needed.",
	"Both tools accept multiple files in ONE call; per-file loops are unnecessary.",
	"Scope is allowlisted (diagnostics cover code plus md/Dockerfile, format covers code only); out-of-scope files return per-file skipped and are not executed.",
];

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

function degradedDetails(degraded: string[] | undefined): { degraded_lines?: string[] } {
	if (!degraded || degraded.length === 0) return {};
	return { degraded_lines: [...degraded] };
}

export function registerNvimTools(pi: ExtensionAPI, deps: NvimToolDeps): void {
	pi.registerTool({
		name: "nvim_lsp",
		label: "Nvim LSP",
		description: NVIM_LSP_DESCRIPTION,
		promptGuidelines: [...NVIM_GUIDELINES],
		parameters: NvimFilesParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// 调用守卫（TS 侧、ensure() 之前）：存在→是文件→可读文本→本工具白名单；
			// 本地项行内表达，daemon-bound 走整批单调用，最后按请求原序合并单次返回。
			const scope = partitionFiles(params.files, "diagnostics", deps.cfg.whitelist);
			const localOf = (file: string): DiagnoseFileResult | undefined => {
				const local = scope.locals.get(file);
				if (!local) return undefined;
				if (local.skipped) return { file, diags: [], ms: 0, skipped: local.skipped };
				return { file, diags: [], ms: 0, error: local.error ?? "unreadable file" };
			};
			if (scope.daemonFiles.length === 0) {
				// 全拦截：根本不 ensure()（daemon 零惊动，冷启动不变量）
				const full = params.files.map((f) => localOf(f) ?? { file: f, diags: [], ms: 0 });
				return textResult(renderLspContent(full, deps.cfg.errorCap), {
					kind: "nvim_lsp",
					files: full,
				});
			}
			const { handles } = await deps.daemon.runExclusive(() => ensureHandles(deps, ctx));
			let payload: unknown;
			try {
				payload = await deps.daemon.runExclusive(() =>
					deps.daemon.request(handles, "diagnose", [...scope.daemonFiles], signal),
				);
			} catch (err) {
				if (err instanceof DaemonTimeoutError) {
					await deps.daemon.killStuck(handles).catch(() => undefined);
				}
				if (err instanceof DaemonAbortedError) {
					return textResult(withDegraded("nvim_lsp aborted before any result (partial: 0 files checked).", handles.degradedLines), {
						kind: "nvim_lsp",
						files: [],
						aborted: true,
						...degradedDetails(handles.degradedLines),
					});
				}
				throw err;
			}
			const parsed = parseDiagnosePayload(payload, deps.cfg.errorCap);
			// 按请求原序合并：本地项（error/skipped）行内表达，daemon 未回的文件记空诊断（不虚构 no_client）
			const byFile = new Map(parsed.map((p) => [p.file, p]));
			const full = params.files.map((f) => localOf(f) ?? byFile.get(f) ?? { file: f, diags: [], ms: 0 });
			return textResult(withDegraded(renderLspContent(full, deps.cfg.errorCap), handles.degradedLines), {
				kind: "nvim_lsp",
				files: full,
				...degradedDetails(handles.degradedLines),
			});
		},
	});

	pi.registerTool({
		name: "nvim_format",
		label: "Nvim Format",
		description: NVIM_FORMAT_DESCRIPTION,
		promptGuidelines: [...NVIM_GUIDELINES],
		parameters: NvimFilesParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// 调用守卫（TS 侧、ensure() 之前）：本地项行内表达，daemon-bound 逐文件走
			// per-file mutation queue 环，最后按请求原序合并单次返回。
			const scope = partitionFiles(params.files, "format", deps.cfg.whitelist);
			const localFormatOf = (file: string): FormatFileResult | undefined => {
				const local = scope.locals.get(file);
				if (!local) return undefined;
				// P2-8 注记：skipped 是“未执行”（白名单短路），借用 unchanged 槽位是因为 FormatReason 无空转值；渲染优先 skipped 分支，details 语义以 skipped 字段为准
				if (local.skipped) return { file, formatted: false, reason: "unchanged", changed_lines: 0, diags: [], ms: 0, skipped: local.skipped };
				return { file, formatted: false, reason: "format-error", changed_lines: 0, diags: [], ms: 0, error: local.error ?? "unreadable file" };
			};
			const results: FormatFileResult[] = [];
			let aborted = false;
			let degraded: string[] | undefined;
			if (scope.daemonFiles.length === 0) {
				// 全拦截：根本不 ensure()（daemon 零惊动），本地项按原序单次聚合返回
				for (const file of params.files) results.push(localFormatOf(file) ?? { file, formatted: false, reason: "format-error", changed_lines: 0, diags: [], ms: 0, error: "unreadable file" });
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
						if (signal?.aborted) {
							aborted = true;
							break;
						}
						try {
							const one = await withFileMutationQueue(file, () =>
								deps.daemon.request(handles, "format", [file], signal),
							);
							const parsed = parseFormatPayload(one, deps.cfg.errorCap);
							const got = parsed.find((p) => p.file === file);
							results.push(
								got ?? {
									file,
									formatted: false,
									reason: "format-error",
									changed_lines: 0,
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
			let text = withDegraded(renderFormatContent(results, deps.cfg.errorCap), degraded);
			if (aborted) {
				const missing = params.files.length - results.length;
				text += `\n…aborted (partial: ${results.length}/${params.files.length} files, ${missing} skipped)`;
			}
			return textResult(text, {
				kind: "nvim_format",
				files: results,
				aborted: aborted ? true : undefined,
				partial: aborted ? true : undefined,
				...degradedDetails(degraded),
			});
		},
	});
}
