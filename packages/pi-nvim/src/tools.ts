/**
 * @inobit/pi-nvim — 双工具定义＋execute（方案 §三接口形状定稿）。
 *
 * - `nvim_lsp`（只读诊断）：整批单调用、无队列，绝不写盘。
 * - `nvim_format`（写盘格式化）：逐文件 `withFileMutationQueue(file, fn)` 包裹后调 daemon
 *   （Phase 1 逐文件往返；批量单往返为后续优化项）。
 * - 对外靠 `executionMode: "sequential"` 串行，对内靠 daemon 互斥队列串行。
 * - execute 返回 `{ content（截断后文本）, details（完整 JSON 重建用） }`；失败 throw；
 *   `signal.aborted` 跳过剩余文件返回 partial（注：execute 返回无 isError 位，
 *   中断以正文 partial 注记＋details.aborted 表达，真失败才 throw）。
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
	budgetsOf,
	parseDiagnosePayload,
	parseFormatPayload,
	renderFormatContent,
	renderLspContent,
	truncateBatch,
	type FormatFileResult,
} from "./result.ts";

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

/** nvim_lsp details：完整诊断（未截断）＋截断计数 */
export interface NvimLspDetails {
	kind: "nvim_lsp";
	files: Array<{ file: string; diags: unknown[]; no_client?: boolean; error?: string }>;
	shown: number;
	total: number;
	aborted?: boolean;
}

/** nvim_format details：完整 per-file 四态（未截断）＋截断计数 */
export interface NvimFormatDetails {
	kind: "nvim_format";
	files: FormatFileResult[];
	shown: number;
	total: number;
	aborted?: boolean;
	partial?: boolean;
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
	"After editing files, check them with nvim_lsp once in a single batch call.",
	"Call nvim_format only when formatting is explicitly needed; it MODIFIES files.",
	"Never call these tools in a per-file loop; always batch ALL files in ONE call.",
];

async function ensureHandles(deps: NvimToolDeps, ctx: ExtensionContext): Promise<{
	sessionId: string;
	handles: Awaited<ReturnType<DaemonManager["ensure"]>>;
}> {
	const sessionId = sessionIdOf(ctx);
	const handles = await deps.daemon.ensure({ sessionId, cwd: cwdOf(ctx) });
	return { sessionId, handles };
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
			const budgets = budgetsOf(deps.cfg.truncation);
			const { handles } = await deps.daemon.runExclusive(() => ensureHandles(deps, ctx));
			let payload: unknown;
			try {
				payload = await deps.daemon.runExclusive(() =>
					deps.daemon.request(handles, "diagnose", [...params.files], signal),
				);
			} catch (err) {
				if (err instanceof DaemonTimeoutError) {
					await deps.daemon.killStuck(handles).catch(() => undefined);
				}
				if (err instanceof DaemonAbortedError) {
					return textResult("nvim_lsp aborted before any result (partial: 0 files checked).", {
						kind: "nvim_lsp",
						files: [],
						shown: 0,
						total: 0,
						aborted: true,
					});
				}
				throw err;
			}
			const parsed = parseDiagnosePayload(payload);
			// 按请求文件补齐：daemon 未回的文件记空诊断（不虚构 no_client）
			const byFile = new Map(parsed.map((p) => [p.file, p]));
			const full = params.files.map((f) => byFile.get(f) ?? { file: f, diags: [], ms: 0 });
			const { shown, total } = truncateBatch(
				full.map((f) => ({ file: f.file, diags: f.diags })),
				budgets,
			);
			return textResult(renderLspContent(full, budgets), {
				kind: "nvim_lsp",
				files: full,
				shown,
				total,
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
			const budgets = budgetsOf(deps.cfg.truncation);
			const results: FormatFileResult[] = [];
			let aborted = false;
			// 整批占住 daemon 互斥（串行），逐文件再走 per-file mutation queue
			await deps.daemon.runExclusive(async () => {
				const { handles } = await ensureHandles(deps, ctx);
				for (const file of params.files) {
					if (signal?.aborted) {
						aborted = true;
						break;
					}
					try {
						const one = await withFileMutationQueue(file, () =>
							deps.daemon.request(handles, "format", [file], signal),
						);
						const parsed = parseFormatPayload(one);
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
			let text = renderFormatContent(results, budgets);
			if (aborted) {
				const missing = params.files.length - results.length;
				text += `\n…aborted (partial: ${results.length}/${params.files.length} files, ${missing} skipped)`;
			}
			const { shown, total } = truncateBatch(
				results.map((f) => ({ file: f.file, diags: f.diags })),
				budgets,
			);
			return textResult(text, {
				kind: "nvim_format",
				files: results,
				shown,
				total,
				aborted: aborted ? true : undefined,
				partial: aborted ? true : undefined,
			});
		},
	});
}
