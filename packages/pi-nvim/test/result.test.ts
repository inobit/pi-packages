/**
 * @inobit/pi-nvim — result.ts 单测：全量诊断／错误截断／五态推导／degraded 头行。
 *
 * 诊断数组全量返回（content＋details），无 per-file/整批/message 预算；
 * 唯一截断是错误文本 truncateError（2000＋`…(truncated N chars)`）。
 */

import { describe, expect, it } from "vitest";
import {
	appendRetryHint,
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
	it("daemon 侧旧字段直接忽略（只认 status 信封）", () => {
		const out = parseDiagnosePayload({ per_file: [{ file: "a.ts", raw: "xxx", error: "yyy", diags: [], ms: 1 }] });
		expect(out[0]?.status).toBe("failed");
		expect(out[0]?.message).toBe("unrecognized file status");
	});
	it("已带注记不再二次截断（parse＋render 双层调用注记一致）", () => {
		const once = truncateError("z".repeat(2500));
		expect(truncateError(once)).toBe(once);
	});
});

describe("诊断全量", () => {
	it("60 条诊断全量渲染（无截断注记）", () => {
		const diags = Array.from({ length: 60 }, (_, i) => diag(`m${i}`));
		const text = renderLspContent([{ file: "a.ts", status: "success", diags }]);
		expect(text).toContain("a.ts:1:1 [error] (ts_ls) m59");
		expect(text).not.toContain("…truncated");
	});
	it("250 条整批全量渲染", () => {
		const mk = (f: string) => ({
			file: `${f}.ts`,
			status: "success" as const,
			diags: Array.from({ length: 50 }, () => diag("m")),
		});
		const text = renderLspContent([mk("a"), mk("b"), mk("c"), mk("d"), mk("e")]);
		expect(text).not.toContain("…truncated");
		expect(text).toContain("e.ts:1:1 [error] (ts_ls) m");
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
	it("skipped／成功透传（message 缺席即 success 干净）", () => {
		const out = parseDiagnosePayload({ per_file: [
			{ file: "a.ts", status: "skipped", message: "no LSP client", diags: [], ms: 5 },
			{ file: "b.ts", status: "success", diags: [], ms: 1 },
		] });
		expect(out[0]?.status).toBe("skipped");
		expect(out[0]?.message).toBe("no LSP client");
		expect(out[1]?.status).toBe("success");
		expect(out[1]?.message).toBeUndefined();
	});
	it("宽容解析：非法输入回空", () => {
		expect(parseDiagnosePayload(undefined)).toEqual([]);
		expect(parseDiagnosePayload({ per_file: "x" })).toEqual([]);
	});
	it("severity 非法回退 hint", () => {
		const out = parseDiagnosePayload({
			per_file: [{ file: "a", status: "success", diags: [{ line: 1, col: 1, severity: 9, source: "s", message: "m" }], ms: 0 }],
		});
		expect(out[0]?.diags[0]?.severity).toBe(4);
	});
	it("failed message 进 details 前走错误截断", () => {
		const out = parseDiagnosePayload({
			per_file: [{ file: "a", status: "failed", message: "e".repeat(2500), diags: [], ms: 0 }],
		});
		expect(out[0]?.message).toContain("…(truncated 500 chars)");
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

describe("renderLspContent（HTTP 信封）", () => {
	it("头行计数＋诊断行＋clean", () => {
		const text = renderLspContent([
			{ file: "a.ts", status: "success", diags: [diag("boom"), diag("warn!", 2)] },
			{ file: "b.ts", status: "success", diags: [] },
		]);
		expect(text).toContain("2 files, 1 error, 1 warning");
		expect(text).toContain("b.ts: clean");
		expect(text).toContain("a.ts:1:1 [error] (ts_ls) boom");
	});
	it("逐文件汇总行已删（header 已有总数）", () => {
		const text = renderLspContent([{ file: "a.ts", status: "success", diags: [diag("boom"), diag("warn!", 2)] }]);
		expect(text).not.toContain("a.ts: 1 error");
		expect(text).toContain("a.ts:1:1 [error] (ts_ls) boom");
	});
	it("header 只计数（不写目录）；行内恒用全路径", () => {
		const text = renderLspContent([
			{ file: "/r/app/a.go", status: "success", diags: [diag("m", 4)] },
			{ file: "/r/app/b.go", status: "failed", message: "(gopls) diagnostics timed out", diags: [] },
		]);
		expect(text).toContain("2 files, 1 hint/info, 1 failed");
		expect(text).not.toContain(" in /r/app");
		expect(text).toContain("/r/app/a.go:1:1 [hint] (ts_ls) m");
		expect(text).toContain("/r/app/b.go: [failed] (gopls) diagnostics timed out");
	});
	it("跨目录同形（无任何前缀上提）", () => {
		const text = renderLspContent([
			{ file: "/x/a.go", status: "success", diags: [] },
			{ file: "/y/b.go", status: "success", diags: [] },
		]);
		expect(text).toContain("2 files, clean");
		expect(text).toContain("/x/a.go: clean");
		expect(text).toContain("/y/b.go: clean");
	});
	it("skipped：门卫行（白名单／零 client 都走这里）", () => {
		const text = renderLspContent([
			{ file: "a.ts", status: "skipped", message: "not in whitelist", diags: [] },
			{ file: "b.ts", status: "skipped", message: "no LSP client", diags: [] },
		]);
		expect(text).toContain("2 files, 2 skipped");
		expect(text).toContain("a.ts: skipped (not in whitelist)");
		expect(text).toContain("b.ts: skipped (no LSP client)");
		expect(text).not.toContain("clean");
	});
	it("failed：一句话＋partial 诊断照跟", () => {
		const text = renderLspContent([{ file: "a.go", status: "failed", message: "pull timed out: slow", diags: [diag("boom")] }]);
		expect(text).toContain("1 file, 1 error, 1 failed");
		expect(text).toContain("a.go: [failed] pull timed out: slow");
		expect(text).toContain("a.go:1:1 [error] (ts_ls) boom");
	});
	it("failed 无诊断：只出失败行，绝不记 clean", () => {
		const text = renderLspContent([{ file: "a.go", status: "failed", message: "server initialization timed out: gopls", diags: [] }]);
		expect(text).toContain("1 file, 1 failed");
		expect(text).toContain("a.go: [failed] server initialization timed out: gopls");
		expect(text).not.toMatch(/a\.go: clean/);
	});
	it("hint 计入头行，不写 clean", () => {
		const text = renderLspContent([{ file: "a.ts", status: "success", diags: [diag("s", 4)] }]);
		expect(text).toContain("1 file, 1 hint/info");
		expect(text).not.toContain("clean");
	});
	it("message 超长走错误截断", () => {
		const text = renderLspContent([{ file: "a.ts", status: "failed", message: "e".repeat(2500), diags: [] }]);
		expect(text).toContain("a.ts: [failed] eeee");
		expect(text).toContain("…(truncated 500 chars)");
		expect(text.split("\n")).toHaveLength(2);
	});
	it("status 非法回退 failed＋unrecognized", () => {
		const out = parseDiagnosePayload({ per_file: [{ file: "a", status: "weird", diags: [], ms: 0 }] });
		expect(out[0]?.status).toBe("failed");
		expect(out[0]?.message).toBe("unrecognized file status");
	});
	it("多 lsp 同文件：每行标 client（client: source 槽位）", () => {
		const text = renderLspContent([{
			file: "a.py",
			status: "success",
			diags: [
				{ line: 5, col: 1, severity: 1, source: "undefined-name", message: "x", client: "ty" },
				{ line: 9, col: 4, severity: 4, source: "F401", message: "y", client: "ruff" },
			],
		}]);
		expect(text).toContain("a.py:5:1 [error] (ty: undefined-name) x");
		expect(text).toContain("a.py:9:4 [hint] (ruff: F401) y");
	});
	it("client 缺席回退为只有 source（不断链）", () => {
		const text = renderLspContent([{ file: "a.ts", status: "success", diags: [diag("boom")] }]);
		expect(text).toContain("a.ts:1:1 [error] (ts_ls) boom");
	});
	it("parse 透传 client（非字符串丢弃）", () => {
		const out = parseDiagnosePayload({
			per_file: [{ file: "a", status: "success", diags: [{ line: 1, col: 1, severity: 1, source: "s", message: "m", client: "gopls" }], ms: 0 }],
		});
		expect(out[0]?.diags[0]?.client).toBe("gopls");
		const bad = parseDiagnosePayload({
			per_file: [{ file: "a", status: "success", diags: [{ line: 1, col: 1, severity: 1, source: "s", message: "m", client: 7 }], ms: 0 }],
		});
		expect(bad[0]?.diags[0]?.client).toBeUndefined();
	});
	it("failed 兜底：空 message 也出 unknown error（不出裸 [failed]）", () => {
		const text = renderLspContent([{ file: "a.ts", status: "failed", message: "   ", diags: [] }]);
		expect(text).toContain("a.ts: [failed] unknown error");
	});
	it("失败行：lsp 名在括号槽，桥接层失败无括号", () => {
		const text = renderLspContent([
			{ file: "a.ts", status: "failed", message: "(tsc) diagnostics timed out", diags: [] },
			{ file: "b.ts", status: "failed", message: "buffer lost mid-request", diags: [] },
		]);
		expect(text).toContain("a.ts: [failed] (tsc) diagnostics timed out");
		expect(text).toContain("b.ts: [failed] buffer lost mid-request");
	});
	it("多行诊断 message 折叠为一行（oxlint 的 message＋help 不可换行）", () => {
		const text = renderLspContent([{
			file: "a.ts",
			status: "success",
			diags: [
				{ line: 7, col: 5, severity: 2, source: "oxc", client: "oxlint", message: "Variable 'legacy' is declared but never used.\nUnused variables should start with a '_'.\n help: Consider removing this declaration.\n" },
			],
		}]);
		const lines = text.split("\n");
		expect(lines).toHaveLength(2); // 头行＋一条诊断行
		expect(lines[1]).toBe(
			"a.ts:7:5 [warn] (oxlint: oxc) Variable 'legacy' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.",
		);
	});
	it("渲染不含文件内容", () => {
		const text = renderLspContent([{ file: "a.ts", status: "success", diags: [diag("secret-body")] }]);
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

describe("appendRetryHint（超时失败给出可调大的旋钮）", () => {
	const caps = { maxStartupMs: 120000, maxDiagnosticMs: 120000 };
	it("诊断超时 → 建议 diagnosticMs（生效值×2）", () => {
		expect(appendRetryHint("(gopls) diagnostics timed out", { startupMs: 10000, diagnosticMs: 20000 }, caps)).toBe(
			"(gopls) diagnostics timed out (retry with diagnosticMs=40000)",
		);
	});
	it("启动超时 → 建议 startupMs", () => {
		expect(appendRetryHint("(gopls) initialization timed out", { startupMs: 10000, diagnosticMs: 20000 }, caps)).toBe(
			"(gopls) initialization timed out (retry with startupMs=20000)",
		);
	});
	it("建议值不低于地板（push 地板+5s），避免每次翻倍反复失败", () => {
		expect(
			appendRetryHint("(gopls) diagnostics timed out", { startupMs: 10000, diagnosticMs: 2000 }, { maxStartupMs: 120000, maxDiagnosticMs: 120000, diagnosticFloorMs: 20000 }),
		).toContain("diagnosticMs=20000");
	});
	it("建议值不超硬顶", () => {
		expect(appendRetryHint("(x) diagnostics timed out", { startupMs: 10000, diagnosticMs: 120000 }, caps)).toContain(
			"diagnosticMs=120000",
		);
	});
	it("非超时失败原样返回", () => {
		expect(appendRetryHint("(tsc) server not initialized", { startupMs: 1, diagnosticMs: 1 }, caps)).toBe(
			"(tsc) server not initialized",
		);
	});
});

describe("degradedHeader", () => {
	it("头行一句话含行数", () => {
		expect(degradedHeader(["E123: bad", "Error detected while processing x"])).toContain(
			"daemon degraded: startup log shows 2 error lines",
		);
	});
});
