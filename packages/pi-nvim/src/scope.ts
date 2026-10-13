/**
 * @inobit/pi-nvim — 调用守卫：pre-check＋白名单匹配（方案 §三 L4／§九调用时白名单）。
 *
 * - 内聚为一处：存在→是文件→可读文本→本工具白名单，顺序即优先级。
 * - 未知类型默认跳过（fail-closed）：无后缀／未知后缀／未知文件名一律走
 *   per-file skipped（非错误），绝不放行进 daemon。
 * - 仅调用时短路：无自动触发、无文件监听，`enabled:false` 仅关白名单闸（存在/是文件/可读文本三闸仍生效）。
 * - 本模块除 `probeFileSync` 外皆纯函数（可单测）；`partitionFiles` 接受探针
 *   回调，单测可用替身断言全拦截不 `ensure()` 等矩阵。
 */

import fs from "node:fs";
import path from "node:path";
import type { NvimWhitelist, NvimWhitelistTable } from "./config.ts";

/** 调用守卫适用表：诊断／格式化各一张 */
export type ScopeKind = "diagnostics" | "format";

/** 8KB 嗅探窗口：含 NUL 即二进制 */
export const BINARY_PROBE_BYTES = 8192;

/** per-file 本地短路注记（行内表达，不 throw） */
export const SCOPE_SKIP_REASON = "not in whitelist";

export function tableFor(whitelist: NvimWhitelist, kind: ScopeKind): NvimWhitelistTable {
	return kind === "format" ? whitelist.format : whitelist.diagnostics;
}

/** 后缀（不带点，小写；无点返回空串） */
export function extOf(file: string): string {
	const base = path.basename(file);
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return "";
	return base.slice(dot + 1).toLowerCase();
}

/**
 * 白名单命中：文件名精确匹配（大小写敏感，如 Dockerfile）或后缀命中
 * （大小写不敏感，如 Foo.TS 命中 ts）。`enabled:false` 仅关白名单闸。
 */
export function isWhitelisted(file: string, table: NvimWhitelistTable, enabled: boolean): boolean {
	if (!enabled) return true;
	const base = path.basename(file);
	if (table.filenames.includes(base)) return true;
	const ext = extOf(file);
	if (ext === "") return false;
	return table.extensions.includes(ext);
}

/** 文件探针结果（probeFileSync 薄封装；单测可注入替身） */
export interface FileProbe {
	/** 路径存在 */
	exists: boolean;
	/** 存在且为普通文件（目录／socket 等一律 false） */
	isFile: boolean;
	/** 可读（读前 8KB 成功） */
	readable: boolean;
	/** 前 8KB 含 NUL（0 字节算文本，即 false） */
	isBinary: boolean;
}

/**
 * 真实探针：stat 判定存在／是文件；读前 8KB 判定可读／二进制。
 * 优先级：不存在→非文件→不可读／二进制（调用方按序短路）。
 */
export function probeFileSync(file: string): FileProbe {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return { exists: false, isFile: false, readable: false, isBinary: false };
	}
	if (!stat.isFile()) return { exists: true, isFile: false, readable: false, isBinary: false };
	let fd = -1;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, Math.max(stat.size, 1)));
		// 0 字节文件：无需读取，直接算文本
		if (stat.size === 0) return { exists: true, isFile: true, readable: true, isBinary: false };
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		for (let i = 0; i < n; i++) {
			if (buf[i] === 0) return { exists: true, isFile: true, readable: true, isBinary: true };
		}
		return { exists: true, isFile: true, readable: true, isBinary: false };
	} catch {
		return { exists: true, isFile: true, readable: false, isBinary: false };
	} finally {
		if (fd >= 0) {
			try {
				fs.closeSync(fd);
			} catch {
				// 忽略
			}
		}
	}
}

/** pre-check 单文件结论（顺序即优先级） */
export type PrecheckStatus =
	| { status: "ok" }
	| { status: "missing" }
	| { status: "directory" }
	| { status: "unreadable" }
	| { status: "binary" }
	| { status: "whitelist-skip" };

/** 状态→行内 error 文案（skipped 另有 SCOPE_SKIP_REASON） */
export function precheckErrorOf(status: PrecheckStatus["status"]): string | undefined {
	if (status === "missing") return "file not found";
	if (status === "directory") return "not a file (directory or special)";
	if (status === "unreadable") return "unreadable file";
	if (status === "binary") return "binary file";
	return undefined;
}

/** 单文件分类（纯函数；探针由调用方注入） */
export function classifyFile(
	file: string,
	table: NvimWhitelistTable,
	enabled: boolean,
	probe: FileProbe,
): PrecheckStatus {
	if (!probe.exists) return { status: "missing" };
	if (!probe.isFile) return { status: "directory" };
	if (!probe.readable || probe.isBinary) return { status: probe.isBinary ? "binary" : "unreadable" };
	if (!isWhitelisted(file, table, enabled)) return { status: "whitelist-skip" };
	return { status: "ok" };
}

/** 分区结果：daemon-bound 文件＋本地短路表（保请求原序由调用方合并） */
export interface ScopePartition {
	daemonFiles: string[];
	/** 本地项：error 文案（行内 error）或 skipped 注记（非错误） */
	locals: Map<string, { error?: string; skipped?: string }>;
}

/**
 * 批量分区：逐文件按优先级短路，daemon-bound 保持原序。
 * 全部被拦截时 `daemonFiles` 为空，调用方根本不 `ensure()`（daemon 零惊动）。
 */
export function partitionFiles(
	files: string[],
	kind: ScopeKind,
	whitelist: NvimWhitelist,
	probeFn: (file: string) => FileProbe = probeFileSync,
): ScopePartition {
	const table = tableFor(whitelist, kind);
	const daemonFiles: string[] = [];
	const locals = new Map<string, { error?: string; skipped?: string }>();
	for (const file of files) {
		// 重复路径以后者为准不影响原序：重复出现时 daemon 侧同样重复请求，保持简单
		const probe = probeFn(file);
		const verdict = classifyFile(file, table, whitelist.enabled, probe);
		if (verdict.status === "ok") {
			daemonFiles.push(file);
			continue;
		}
		if (verdict.status === "whitelist-skip") {
			locals.set(file, { skipped: SCOPE_SKIP_REASON });
			continue;
		}
		locals.set(file, { error: precheckErrorOf(verdict.status) ?? "unreadable file" });
	}
	return { daemonFiles, locals };
}
