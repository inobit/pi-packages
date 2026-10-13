/**
 * @inobit/pi-nvim — 调用守卫单测：白名单匹配＋pre-check 矩阵＋聚合＋全拦截不 ensure。
 *
 * 矩阵：缺失／目录／二进制／未知后缀／混合聚合／全拦截不 ensure（工具层替身断言）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyOverlay, DEFAULT_CONFIG, normalizeConfig, normalizeConfigOverlay } from "../src/config.ts";
import { renderFormatContent, renderLspContent } from "../src/result.ts";
import {
	classifyFile,
	extOf,
	isWhitelisted,
	partitionFiles,
	probeFileSync,
	SCOPE_SKIP_REASON,
	tableFor,
	type FileProbe,
} from "../src/scope.ts";
import { registerNvimTools } from "../src/tools.ts";

const DIAG = DEFAULT_CONFIG.whitelist.diagnostics;
const FMT = DEFAULT_CONFIG.whitelist.format;

const OK: FileProbe = { exists: true, isFile: true, readable: true, isBinary: false };

describe("extOf", () => {
	it("后缀小写化、无点回空", () => {
		expect(extOf("/a/b.ts")).toBe("ts");
		expect(extOf("/a/Foo.TS")).toBe("ts");
		expect(extOf("/a/Dockerfile")).toBe("");
		expect(extOf("/a/.eslintrc")).toBe("");
	});
});

describe("isWhitelisted", () => {
	it("诊断表含 md＋Dockerfile，format 表不含", () => {
		expect(isWhitelisted("/x/a.md", DIAG, true)).toBe(true);
		expect(isWhitelisted("/x/a.md", FMT, true)).toBe(false);
		expect(isWhitelisted("/x/Dockerfile", DIAG, true)).toBe(true);
		expect(isWhitelisted("/x/Dockerfile", FMT, true)).toBe(false);
	});
	it("未知后缀／未知文件名默认跳过（fail-closed）", () => {
		expect(isWhitelisted("/x/a.exe", DIAG, true)).toBe(false);
		expect(isWhitelisted("/x/Makefile", DIAG, true)).toBe(false);
		expect(isWhitelisted("/x/a", DIAG, true)).toBe(false);
	});
	it("后缀大小写不敏感，文件名大小写敏感", () => {
		expect(isWhitelisted("/x/a.TS", DIAG, true)).toBe(true);
		expect(isWhitelisted("/x/dockerfile", DIAG, true)).toBe(false);
	});
	it("enabled:false 全放行（逃生口）", () => {
		expect(isWhitelisted("/x/a.exe", DIAG, false)).toBe(true);
		expect(isWhitelisted("/x/Makefile", FMT, false)).toBe(true);
	});
	it("tableFor 按 kind 取表", () => {
		expect(tableFor(DEFAULT_CONFIG.whitelist, "diagnostics")).toBe(DIAG);
		expect(tableFor(DEFAULT_CONFIG.whitelist, "format")).toBe(FMT);
	});
});

describe("classifyFile 优先级", () => {
	it("不存在→missing", () => {
		expect(classifyFile("/nope.ts", DIAG, true, { exists: false, isFile: false, readable: false, isBinary: false }).status).toBe("missing");
	});
	it("目录→directory（优先于白名单）", () => {
		expect(classifyFile("/tmp", DIAG, true, { exists: true, isFile: false, readable: false, isBinary: false }).status).toBe("directory");
	});
	it("二进制→binary，0字节可读文本不判二进制由探针表达", () => {
		const binary: FileProbe = { exists: true, isFile: true, readable: true, isBinary: true };
		expect(classifyFile("/x/a.ts", DIAG, true, binary).status).toBe("binary");
		const unreadable: FileProbe = { exists: true, isFile: true, readable: false, isBinary: false };
		expect(classifyFile("/x/a.ts", DIAG, true, unreadable).status).toBe("unreadable");
	});
	it("白名单未命中→whitelist-skip（非错误）", () => {
		expect(classifyFile("/x/a.exe", DIAG, true, OK).status).toBe("whitelist-skip");
	});
	it("命中→ok；存在性优先于白名单", () => {
		expect(classifyFile("/x/a.ts", DIAG, true, OK).status).toBe("ok");
		expect(
			classifyFile("/x/a.exe", DIAG, true, { exists: false, isFile: false, readable: false, isBinary: false }).status,
		).toBe("missing");
	});
});

describe("probeFileSync 真机", () => {
	it("文本／0字节／二进制／目录／缺失", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nvim-scope-"));
		const text = path.join(dir, "a.ts");
		const empty = path.join(dir, "empty.ts");
		const bin = path.join(dir, "b.ts");
		fs.writeFileSync(text, "const x = 1;\n", "utf8");
		fs.writeFileSync(empty, "", "utf8");
		fs.writeFileSync(bin, Buffer.from([0x68, 0x65, 0x00, 0x6c]));
		expect(probeFileSync(text)).toMatchObject({ exists: true, isFile: true, readable: true, isBinary: false });
		expect(probeFileSync(empty)).toMatchObject({ exists: true, isFile: true, readable: true, isBinary: false });
		expect(probeFileSync(bin).isBinary).toBe(true);
		expect(probeFileSync(dir)).toMatchObject({ exists: true, isFile: false });
		expect(probeFileSync(path.join(dir, "nope.ts")).exists).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe("partitionFiles", () => {
	it("混合批量按原序拆分（替身探针）", () => {
		const probes = new Map<string, FileProbe>([
			["/x/a.ts", OK],
			["/x/b.exe", OK],
			["/x/missing.ts", { exists: false, isFile: false, readable: false, isBinary: false }],
		]);
		const p = partitionFiles(["/x/a.ts", "/x/b.exe", "/x/missing.ts"], "diagnostics", DEFAULT_CONFIG.whitelist, (f) => probes.get(f) ?? OK);
		expect(p.daemonFiles).toEqual(["/x/a.ts"]);
		expect(p.locals.get("/x/b.exe")).toEqual({ skipped: SCOPE_SKIP_REASON });
		expect(p.locals.get("/x/missing.ts")).toEqual({ error: "file not found" });
	});
	it("全拦截则 daemonFiles 为空", () => {
		const p = partitionFiles(["/x/a.exe", "/x/b.bin"], "diagnostics", DEFAULT_CONFIG.whitelist, () => OK);
		expect(p.daemonFiles).toEqual([]);
		expect(p.locals.size).toBe(2);
	});
	it("enabled:false 全放行", () => {
		const wl = { ...DEFAULT_CONFIG.whitelist, enabled: false };
		const p = partitionFiles(["/x/a.exe"], "diagnostics", wl, () => OK);
		expect(p.daemonFiles).toEqual(["/x/a.exe"]);
	});
});

describe("normalizeConfig whitelist", () => {
	it("默认即任务给定两表（md 仅诊断＋Dockerfile）", () => {
		const cfg = normalizeConfig(undefined);
		expect(cfg.whitelist.enabled).toBe(true);
		expect(cfg.whitelist.diagnostics.extensions).toContain("md");
		expect(cfg.whitelist.diagnostics.filenames).toEqual(["Dockerfile"]);
		expect(cfg.whitelist.format.extensions).not.toContain("md");
		expect(cfg.whitelist.format.filenames).toEqual([]);
	});
	it("非法项回退默认", () => {
		const cfg = normalizeConfig({ whitelist: { enabled: "x", diagnostics: { extensions: "ts" } } });
		expect(cfg.whitelist.enabled).toBe(true);
		expect(cfg.whitelist.diagnostics.extensions).toContain("ts");
	});
	it("enabled:false 生效", () => {
		expect(normalizeConfig({ whitelist: { enabled: false } }).whitelist.enabled).toBe(false);
	});
	it("errorCap 默认 2000、可覆盖（错误唯一截断用户可调）", () => {
		expect(normalizeConfig(undefined).errorCap).toBe(2000);
		expect(normalizeConfig({ errorCap: 500 }).errorCap).toBe(500);
		expect(normalizeConfig({ errorCap: -3 }).errorCap).toBe(2000);
	});
	it("diagMs 被 overlay 抬过 requestMs 时钳住（防健康 daemon 被误判卡死）", () => {
		const merged = applyOverlay(DEFAULT_CONFIG, { timeouts: { diagMs: 999999 } } as never);
		expect(merged.timeouts.diagMs).toBe(merged.timeouts.requestMs);
	});
	it("全非法后缀回 undefined（保留底包值，不清空表）", () => {
		// asExtension 只认非空字符串：123（非串）/""/"." 全被过滤 → 空表回 undefined
		const cfg = normalizeConfig({ whitelist: { diagnostics: { extensions: [123, "", "."] } } });
		expect(cfg.whitelist.diagnostics.extensions).toEqual(
			DEFAULT_CONFIG.whitelist.diagnostics.extensions,
		);
	});
});

describe("result skipped 行渲染", () => {
	it("lsp skipped 非错误行", () => {
		const text = renderLspContent([
			{ file: "a.ts", diags: [], skipped: SCOPE_SKIP_REASON },
			{ file: "b.ts", diags: [], error: "file not found" },
		]);
		expect(text).toContain("a.ts: skipped (not in whitelist)");
		expect(text).toContain("b.ts: error (file not found)");
	});
	it("format skipped 非错误行", () => {
		const text = renderFormatContent([
			{ file: "a.ts", formatted: false, reason: "unchanged", changed_lines: 0, diags: [], ms: 0, skipped: SCOPE_SKIP_REASON },
		]);
		expect(text).toContain("a.ts: skipped (not in whitelist)");
	});
});

// ---- 工具层：全拦截不 ensure、混合聚合保原序（替身 daemon） ----

function makeHarness(tmp: string): {
	handlers: Record<string, { execute: (...args: any[]) => Promise<any> }>;
	ensureCalls: { n: number };
	requested: { fn: string; files: string[] }[];
} {
	const handlers: Record<string, { execute: (...args: any[]) => Promise<any> }> = {};
	const ensureCalls = { n: 0 };
	const requested: { fn: string; files: string[] }[] = [];
	const daemon = {
		async ensure(): Promise<unknown> {
			ensureCalls.n++;
			return {};
		},
		async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
			return fn();
		},
		async request(_h: unknown, fn: string, files: string[]): Promise<unknown> {
			requested.push({ fn, files: [...files] });
			if (fn === "diagnose") return { per_file: files.map((file) => ({ file, diags: [], ms: 1 })) };
			return { per_file: files.map((file) => ({ file, formatted: false, reason: "unchanged", changed_lines: 0, ms: 1 })) };
		},
		async killStuck(): Promise<void> {},
	};
	const pi = { registerTool(def: { name: string }): void {
		handlers[def.name] = def as never;
	} };
	const cfg = { ...DEFAULT_CONFIG, whitelist: normalizeConfig(undefined).whitelist };
	registerNvimTools(pi as never, { cfg, daemon: daemon as never });
	void tmp;
	return { handlers, ensureCalls, requested };
}

function mockCtx(cwd: string): unknown {
	return { cwd, sessionManager: { getSessionId: () => "test-session" } };
}

describe("工具层调用守卫", () => {
	it("lsp 全拦截不 ensure（未知＋缺失），单次聚合返回", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nvim-tools-"));
		const { handlers, ensureCalls, requested } = makeHarness(dir);
		const missing = path.join(dir, "missing.ts");
		const unknown = path.join(dir, "a.exe");
		fs.writeFileSync(unknown, "x", "utf8");
		const res = await handlers["nvim_lsp"]!.execute("id", { files: [unknown, missing] }, undefined, undefined, mockCtx(dir) as never);
		expect(ensureCalls.n).toBe(0);
		expect(requested.length).toBe(0);
		const text = (res.content[0] as { text: string }).text;
		expect(text).toContain(`skipped (${SCOPE_SKIP_REASON})`);
		expect(text).toContain("error (file not found)");
		fs.rmSync(dir, { recursive: true, force: true });
	});
	it("lsp 混合聚合保原序（daemon 仅收命中文件）", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nvim-tools-"));
		const good = path.join(dir, "good.ts");
		const unknown = path.join(dir, "skip.exe");
		fs.writeFileSync(good, "const x=1\n", "utf8");
		fs.writeFileSync(unknown, "x", "utf8");
		const { handlers, ensureCalls, requested } = makeHarness(dir);
		const res = await handlers["nvim_lsp"]!.execute("id", { files: [unknown, good] }, undefined, undefined, mockCtx(dir) as never);
		expect(ensureCalls.n).toBeGreaterThan(0);
		expect(requested.length).toBe(1);
		expect(requested[0]!.files).toEqual([good]);
		const details = res.details as { files: { file: string }[] };
		expect(details.files.map((f) => f.file)).toEqual([unknown, good]);
		fs.rmSync(dir, { recursive: true, force: true });
	});
	it("format 全拦截不 ensure", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nvim-tools-"));
		const md = path.join(dir, "doc.md");
		fs.writeFileSync(md, "# hi\n", "utf8");
		const { handlers, ensureCalls, requested } = makeHarness(dir);
		// md 不在 format 表：全拦截
		const res = await handlers["nvim_format"]!.execute("id", { files: [md] }, undefined, undefined, mockCtx(dir) as never);
		expect(ensureCalls.n).toBe(0);
		expect(requested.length).toBe(0);
		const text = (res.content[0] as { text: string }).text;
		expect(text).toContain(`skipped (${SCOPE_SKIP_REASON})`);
		fs.rmSync(dir, { recursive: true, force: true });
	});
	it("format 混合聚合保原序（本地 skipped＋daemon 结果）", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nvim-tools-"));
		const good = path.join(dir, "good.ts");
		const md = path.join(dir, "doc.md");
		fs.writeFileSync(good, "const x=1\n", "utf8");
		fs.writeFileSync(md, "# hi\n", "utf8");
		const { handlers, requested } = makeHarness(dir);
		const res = await handlers["nvim_format"]!.execute("id", { files: [md, good] }, undefined, undefined, mockCtx(dir) as never);
		expect(requested.length).toBe(1);
		expect(requested[0]!.files).toEqual([good]);
		const details = res.details as { files: { file: string }[] };
		expect(details.files.map((f) => f.file)).toEqual([md, good]);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe("whitelist overlay（逃生口与深合并）", () => {
	it("{whitelist:{enabled:false}} 熄掉白名单闸", () => {
		const patch = normalizeConfigOverlay({ whitelist: { enabled: false } });
		expect(patch.whitelist?.enabled).toBe(false);
		const merged = applyOverlay(DEFAULT_CONFIG, patch);
		expect(merged.whitelist.enabled).toBe(false);
	});
	it("只覆盖 extensions 时 filenames 保留底包值", () => {
		const patch = normalizeConfigOverlay({ whitelist: { diagnostics: { extensions: ["ts"] } } });
		const merged = applyOverlay(DEFAULT_CONFIG, patch);
		expect(merged.whitelist.diagnostics.extensions).toEqual(["ts"]);
		expect(merged.whitelist.diagnostics.filenames).toEqual(
			DEFAULT_CONFIG.whitelist.diagnostics.filenames,
		);
	});
	it("空 diagnostics 对象不产生 patch（保留底包值）", () => {
		const patch = normalizeConfigOverlay({ whitelist: { diagnostics: {} } });
		const merged = applyOverlay(DEFAULT_CONFIG, patch);
		expect(merged.whitelist.diagnostics).toEqual(DEFAULT_CONFIG.whitelist.diagnostics);
	});
});
