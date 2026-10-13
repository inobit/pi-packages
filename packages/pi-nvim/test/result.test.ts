/**
 * @inobit/pi-nvim — result.ts 单测：全量诊断／错误截断／五态推导／degraded 头行。
 *
 * 诊断数组全量返回（content＋details），无 per-file/整批/message 预算；
 * 唯一截断是错误文本 truncateError（2000＋`…(truncated N chars)`）。
 */

import { describe, expect, it } from "vitest";
import {
	degradedHeader,
	deriveFormatState,
	ERROR_TEXT_LIMIT,
	parseDiagnosePayload,
	parseFormatPayload,
	renderFormatContent,
	renderLspContent,
	truncateError,
	type NvimDiag,
} from "../src/result.ts";

function diag(message: string, severity: 1 | 2 | 3 | 4 = 1): NvimDiag {
	return { line: 1, col: 1, severity, source: "ts_ls", message };
}

describe("truncateError（唯一截断）", () => {
	it("2000 字内原样返回", () => {
		expect(truncateError("abc")).toBe("abc");
		expect(ERROR_TEXT_LIMIT).toBe(2000);
	});
	it("超限截尾＋截掉字数注记", () => {
		const out = truncateError("x".repeat(2500));
		expect(out).toContain("…(truncated 500 chars)");
		expect(out.length).toBeLessThan(2500);
	});
	it("刚好 2000 不截", () => {
		expect(truncateError("y".repeat(2000))).toHaveLength(2000);
	});
	it("raw 透传行：不可识别不归一化、原文截断＋note", () => {
		const parsed = parseDiagnosePayload({ per_file: [{ file: "a.ts", raw: "x".repeat(2500), note: "mid-request change" }] }, 100);
		expect(parsed[0]?.raw).toHaveLength(100 + "…(truncated 2400 chars)".length);
		const text = renderLspContent([{ file: "a.ts", diags: [], raw: parsed[0]?.raw, note: "mid-request change" }], 100);
		expect(text).toContain("failed (1):");
		expect(text).toContain("- a.ts: unrecognized (mid-request change)");
	});
	it("已带注记不再二次截断（parse＋render 双层调用注记一致）", () => {
		const once = truncateError("z".repeat(2500));
		expect(truncateError(once)).toBe(once);
	});
});

describe("诊断全量", () => {
	it("60 条诊断全量渲染（无截断注记）", () => {
		const diags = Array.from({ length: 60 }, (_, i) => diag(`m${i}`));
		const text = renderLspContent([{ file: "a.ts", diags }]);
		expect(text).toContain("a.ts:1:1 [error] (ts_ls) m59");
		expect(text).not.toContain("…truncated");
	});
	it("250 条整批全量渲染", () => {
		const mk = (f: string) => ({
			file: `${f}.ts`,
			diags: Array.from({ length: 50 }, () => diag("m")),
		});
		const text = renderLspContent([mk("a"), mk("b"), mk("c"), mk("d"), mk("e")]);
		expect(text).not.toContain("…truncated");
		expect(text).toContain("e.ts: 50 errors");
	});
	it("format 写后诊断全量", () => {
		const diags = Array.from({ length: 60 }, () => diag("m"));
		const text = renderFormatContent([
			{ file: "a.ts", formatted: true, reason: "ok", diags, ms: 1 },
		]);
		expect(text).not.toContain("…truncated");
		expect(text).toContain("a.ts:1:1 [error] (ts_ls) m");
	});
});

describe("deriveFormatState（五态）", () => {
	it("有变化→formatted:true＋ok", () => {
		expect(
			deriveFormatState("a\n", "a\nb\n", { hasFormatter: true, writeError: false, formatError: false }),
		).toEqual({ formatted: true, reason: "ok", });
	});
	it("无变化→formatted:false＋unchanged（覆盖已格式化＋静默无操作）", () => {
		expect(
			deriveFormatState("a\n", "a\n", { hasFormatter: true, writeError: false, formatError: false }),
		).toEqual({ formatted: false, reason: "unchanged", });
	});
	it("无 formatter→no-formatter", () => {
		expect(
			deriveFormatState("a\n", "a\nb\n", { hasFormatter: false, writeError: false, formatError: false }),
		).toEqual({ formatted: false, reason: "no-formatter", });
	});
	it(":w 失败→write-error（优先于门控）", () => {
		expect(
			deriveFormatState("a\n", "a\nb\n", { hasFormatter: true, writeError: true, formatError: false }),
		).toMatchObject({ formatted: false, reason: "write-error" });
	});
	it("formatter 显式错→format-error", () => {
		expect(
			deriveFormatState("a\n", "a\n", { hasFormatter: true, writeError: false, formatError: true }),
		).toEqual({ formatted: false, reason: "format-error", });
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
	it("per-file error 进 details 前走错误截断", () => {
		const out = parseDiagnosePayload({
			per_file: [{ file: "a", diags: [], ms: 0, error: "e".repeat(2500) }],
		});
		expect(out[0]?.error).toContain("…(truncated 500 chars)");
	});
});

describe("parseFormatPayload", () => {
	it("reason 非法回退 format-error（不静默记 ok）", () => {
		const out = parseFormatPayload({
			per_file: [{ file: "a", formatted: true, reason: "weird", ms: 1 }],
		});
		expect(out[0]?.reason).toBe("format-error");
	});
	it("unchanged 合法通过", () => {
		const out = parseFormatPayload({
			per_file: [{ file: "a", formatted: false, reason: "unchanged", ms: 1 }],
		});
		expect(out[0]?.reason).toBe("unchanged");
	});
});

describe("renderLspContent", () => {
	it("头行计数＋逐文件状态＋诊断行", () => {
		const text = renderLspContent([
			{ file: "a.ts", diags: [diag("boom"), diag("warn!", 2)] },
			{ file: "b.ts", diags: [] },
		]);
		expect(text).toContain("2 files, 1 error, 1 warning");
		expect(text).toContain("a.ts: 1 error, 1 warning");
		expect(text).toContain("b.ts: clean");
		expect(text).toContain("a.ts:1:1 [error] (ts_ls) boom");
	});
	it("无 client 文件标 no LSP client", () => {
		const text = renderLspContent([{ file: "a.ts", diags: [], no_client: true }]);
		expect(text).toContain("a.ts: clean (no LSP client)");
	});
	it("error 文件渲染 error 行（超长走错误截断）", () => {
		const text = renderLspContent([{ file: "a.ts", diags: [], error: "e".repeat(2500) }]);
		expect(text).toContain("- a.ts: eeee");
		expect(text).toContain("…(truncated 500 chars)");
	});
	it("渲染不含文件内容", () => {
		const text = renderLspContent([{ file: "a.ts", diags: [diag("secret-body")] }]);
		expect(text).not.toContain("function body");
	});
});

describe("renderFormatContent", () => {
	it("formatted X/Y＋逐文件一行（unchanged 与 ok 未变化并列）", () => {
		const text = renderFormatContent([
			{ file: "a.ts", formatted: true, reason: "ok", diags: [], ms: 1 },
			{ file: "b.ts", formatted: false, reason: "unchanged", diags: [], ms: 1 },
			{ file: "c.ts", formatted: false, reason: "no-formatter", diags: [], ms: 1 },
		]);
		expect(text).toContain("formatted 1/3");
		expect(text).toContain("a.ts: formatted");
		expect(text).toContain("b.ts: unchanged");
		expect(text).toContain("c.ts: skipped (no-formatter)");
	});
	it("旧 daemon 的 ok＋未变化兼容渲染为 unchanged", () => {
		const text = renderFormatContent([
			{ file: "b.ts", formatted: false, reason: "ok", diags: [], ms: 1 },
		]);
		expect(text).toContain("b.ts: unchanged");
	});
});

describe("degradedHeader", () => {
	it("头行一句话含行数", () => {
		expect(degradedHeader(["E123: bad", "Error detected while processing x"])).toContain(
			"daemon degraded: startup log shows 2 error lines",
		);
	});
});
