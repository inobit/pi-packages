/**
 * @inobit/pi-nvim — result.ts 单测：截断/解析/渲染/四态推导。
 *
 * 逐字覆盖任务 Correctness 条款：per-file 50／整批 200／单条 500＋`…truncated (N/M)`；
 * 四态必须由内容比较得出；返回不含文件内容。
 */

import { describe, expect, it } from "vitest";
import {
	budgetsOf,
	countChangedLines,
	deriveFormatState,
	parseDiagnosePayload,
	parseFormatPayload,
	renderFormatContent,
	renderLspContent,
	truncateBatch,
	truncateMessage,
	truncationNote,
	type NvimDiag,
} from "../src/result.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const BUDGETS = budgetsOf(DEFAULT_CONFIG.truncation);

function diag(message: string, severity: 1 | 2 | 3 | 4 = 1): NvimDiag {
	return { line: 1, col: 1, severity, source: "ts_ls", message };
}

describe("truncateMessage", () => {
	it("单条 500 字内原样返回", () => {
		expect(truncateMessage("abc", 500)).toBe("abc");
	});
	it("超限截尾＋注记", () => {
		const out = truncateMessage("x".repeat(600), 500);
		expect(out.length).toBeLessThan(600);
		expect(out).toContain("…truncated");
	});
});

describe("truncateBatch", () => {
	it("per-file 50 上限", () => {
		const diags = Array.from({ length: 60 }, (_, i) => diag(`m${i}`));
		const { files, shown, total } = truncateBatch([{ file: "a.ts", diags }], BUDGETS);
		expect(files[0]?.diags.length).toBe(50);
		expect(files[0]?.total).toBe(60);
		expect(shown).toBe(50);
		expect(total).toBe(60);
	});
	it("整批 200 上限（保前序文件）", () => {
		const mk = (f: string) => ({
			file: f,
			diags: Array.from({ length: 50 }, () => diag("m")),
		});
		const { files, shown, total } = truncateBatch(
			[mk("a"), mk("b"), mk("c"), mk("d"), mk("e")],
			BUDGETS,
		);
		expect(total).toBe(250);
		expect(shown).toBe(200);
		// 前 4 个文件完整保留，裁尾部文件
		expect(files[0]?.diags.length).toBe(50);
		expect(files[3]?.diags.length).toBe(50);
		expect(files[4]?.diags.length).toBe(0);
	});
	it("truncationNote 只在超限时出", () => {
		expect(truncationNote(50, 60)).toBe("…truncated (50/60)");
		expect(truncationNote(60, 60)).toBeUndefined();
	});
});

describe("deriveFormatState（四态）", () => {
	it("有变化→formatted:true＋ok", () => {
		expect(
			deriveFormatState("a\n", "a\nb\n", { hasFormatter: true, writeError: false, formatError: false }),
		).toEqual({ formatted: true, reason: "ok", changed_lines: 2 });
	});
	it("无变化→formatted:false＋ok（不以未抛错推导）", () => {
		expect(
			deriveFormatState("a\n", "a\n", { hasFormatter: true, writeError: false, formatError: false }),
		).toEqual({ formatted: false, reason: "ok", changed_lines: 0 });
	});
	it("无 formatter→no-formatter", () => {
		expect(
			deriveFormatState("a\n", "a\nb\n", { hasFormatter: false, writeError: false, formatError: false }),
		).toEqual({ formatted: false, reason: "no-formatter", changed_lines: 2 });
	});
	it(":w 失败→write-error（优先于门控）", () => {
		expect(
			deriveFormatState("a\n", "a\nb\n", { hasFormatter: true, writeError: true, formatError: false }),
		).toMatchObject({ formatted: false, reason: "write-error" });
	});
	it("formatter 显式错→format-error", () => {
		expect(
			deriveFormatState("a\n", "a\n", { hasFormatter: true, writeError: false, formatError: true }),
		).toEqual({ formatted: false, reason: "format-error", changed_lines: 0 });
	});
});

describe("countChangedLines", () => {
	it("相同内容为 0", () => {
		expect(countChangedLines("a\nb", "a\nb")).toBe(0);
	});
	it("改行＋增删行累加", () => {
		expect(countChangedLines("a\nb\nc", "a\nB\nc\nd")).toBe(2);
	});
});

describe("parseDiagnosePayload", () => {
	it("无 client 文件记 diags:[]＋no_client:true", () => {
		const out = parseDiagnosePayload({ per_file: [{ file: "a.ts", diags: [], ms: 5, no_client: true }] });
		expect(out).toEqual([{ file: "a.ts", diags: [], ms: 5, no_client: true, error: undefined }]);
	});
	it("宽容解析：非法输入回空", () => {
		expect(parseDiagnosePayload(undefined)).toEqual([]);
		expect(parseDiagnosePayload({ per_file: "x" })).toEqual([]);
	});
	it("severity 非法回退 hint", () => {
		const out = parseDiagnosePayload({
			per_file: [{ file: "a", diags: [{ line: 1, col: 1, severity: 9, source: "s", message: "m" }], ms: 0 }],
		});
		expect(out[0]?.diags[0]?.severity).toBe(4);
	});
});

describe("parseFormatPayload", () => {
	it("reason 非法回退 format-error（不静默记 ok）", () => {
		const out = parseFormatPayload({
			per_file: [{ file: "a", formatted: true, reason: "weird", changed_lines: 3, ms: 1 }],
		});
		expect(out[0]?.reason).toBe("format-error");
	});
});

describe("renderLspContent", () => {
	it("头行计数＋逐文件状态＋诊断行", () => {
		const text = renderLspContent(
			[
				{ file: "a.ts", diags: [diag("boom"), diag("warn!", 2)] },
				{ file: "b.ts", diags: [] },
			],
			BUDGETS,
		);
		expect(text).toContain("2 files, 1 error, 1 warning");
		expect(text).toContain("a.ts: 1 error, 1 warning");
		expect(text).toContain("b.ts: clean");
		expect(text).toContain("a.ts:1:1 [error] (ts_ls) boom");
	});
	it("无 client 文件标 no LSP client", () => {
		const text = renderLspContent([{ file: "a.ts", diags: [], no_client: true }], BUDGETS);
		expect(text).toContain("a.ts: clean (no LSP client)");
	});
	it("超限尾注 …truncated (N/M)", () => {
		const diags = Array.from({ length: 60 }, (_, i) => diag(`m${i}`));
		const text = renderLspContent([{ file: "a.ts", diags }], BUDGETS);
		expect(text).toContain("…truncated (50/60)");
	});
	it("error 文件渲染 error 行（不静默 clean）", () => {
		const text = renderLspContent([{ file: "a.ts", diags: [], error: "edit failed" }], BUDGETS);
		expect(text).toContain("a.ts: error (edit failed)");
	});
	it("渲染不含文件内容", () => {
		const text = renderLspContent([{ file: "a.ts", diags: [diag("secret-body")] }], BUDGETS);
		expect(text).not.toContain("function body");
	});
});

describe("renderFormatContent", () => {
	it("formatted X/Y＋逐文件一行", () => {
		const text = renderFormatContent(
			[
				{ file: "a.ts", formatted: true, reason: "ok", changed_lines: 12, diags: [], ms: 1 },
				{ file: "b.ts", formatted: false, reason: "ok", changed_lines: 0, diags: [], ms: 1 },
				{ file: "c.ts", formatted: false, reason: "no-formatter", changed_lines: 0, diags: [], ms: 1 },
			],
			BUDGETS,
		);
		expect(text).toContain("formatted 1/3");
		expect(text).toContain("a.ts: formatted (12 lines)");
		expect(text).toContain("b.ts: unchanged");
		expect(text).toContain("c.ts: skipped (no-formatter)");
	});
	it("写后诊断同屏＋截断注记", () => {
		const diags = Array.from({ length: 60 }, () => diag("m"));
		const text = renderFormatContent(
			[{ file: "a.ts", formatted: true, reason: "ok", changed_lines: 1, diags, ms: 1 }],
			BUDGETS,
		);
		expect(text).toContain("…truncated (50/60)");
	});
});
