/**
 * @inobit/pi-instabox — 运行期事件日志（JSONL，参考 `pi-permission/src/audit.ts` 的写入纪律）。
 *
 * 契约：
 * - 文件：`<dir>/pi-instabox.jsonl`，一行一条记录；目录 0700、文件 0600（`setMode` 失败忽略，
 *   权限不是写入的前提）。`dir` 由装配层给（`<agentDir>/logs/pi-instabox`），本模块不推导路径。
 * - 级别：`off` 全关；`info`（默认，记生命周期）不记 `debug` 事件；`debug` 全记。
 *   单条记录的级别由 `event(event, fields, level)` 指定，默认 `info`。
 * - 字段：丢掉 `undefined`；字符串截断到 2000 字符；键名命中 `token|secret|password|api[-_]?key`
 *   的字段值整体替换为 `"[redacted]"`（字段在记录里是 `fields` 子对象，不摊平到顶层）。
 * - 轮转：默认 1 MiB / 3 份备份，命名 `pi-instabox.jsonl.1..3`（`.` 为最旧）。
 *   **写入后**才判定大小并滚动，因此滚动后的主文件为空、下次写入时重新创建。
 * - IO 失败一律吞掉，同一错误只回调一次 `onError`，绝不 throw 到会话层（与 `cli.ts` 同一口径）。
 * - `logEvent` 读模块级单例；未 `setLogger` 时是 no-op，故 `VITEST` 下默认不写盘。
 */

import fs from "node:fs";
import path from "node:path";

/** 日志级别（`off` 全关 / `info` 记生命周期 / `debug` 记细节）。 */
export type LogLevel = "off" | "info" | "debug";

/** 单条记录的级别（`warn` / `error` 在 `info` 级别下同样落盘）。 */
type LogEventLevel = "info" | "debug" | "warn" | "error";

/** 一条日志记录：写盘时序列化成一行 JSON。 */
export interface LogRecord {
	ts: string;
	level: LogEventLevel;
	event: string;
	fields?: Record<string, unknown>;
}

/** 日志写入器（文件实现与内存实现共用）。 */
export interface Logger {
	event(event: string, fields?: Record<string, unknown>, level?: LogEventLevel): void;
}

/** 写入面（注入替身用：单测不碰真实磁盘）。 */
export interface LogFileSystem {
	mkdir(dir: string): void;
	append(file: string, line: string): void;
	rename(from: string, to: string): void;
	exists(file: string): boolean;
	size(file: string): number;
	setMode(path: string, mode: number): void;
}

const LOG_FILE_NAME = "pi-instabox.jsonl";
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 3;
/** 单个字符串字段的字符上限（防日志膨胀，与 `pi-permission` 的 2000 对齐）。 */
const MAX_FIELD_CHARS = 2000;
const REDACTED = "[redacted]";
const SENSITIVE_KEY_RE = /token|secret|password|api[-_]?key/i;

/** 默认真实磁盘实现：尺寸读取失败视为 0（文件不存在时与「空文件」同义）。 */
const nodeLogFileSystem: LogFileSystem = {
	mkdir(dir) {
		fs.mkdirSync(dir, { recursive: true });
	},
	append(file, line) {
		fs.appendFileSync(file, line);
	},
	rename(from, to) {
		fs.renameSync(from, to);
	},
	exists(file) {
		return fs.existsSync(file);
	},
	size(file) {
		try {
			return fs.statSync(file).size;
		} catch {
			return 0;
		}
	},
	setMode(target, mode) {
		fs.chmodSync(target, mode);
	},
};

function trySetMode(io: LogFileSystem, target: string, mode: number): void {
	try {
		io.setMode(target, mode);
	} catch {
		// 权限设置失败不影响写入
	}
}

/** 字段预处理：丢 `undefined`、敏感键脱敏、字符串截断；全丢光时字段整体缺席。 */
function prepareFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (fields === undefined) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		if (SENSITIVE_KEY_RE.test(key)) {
			out[key] = REDACTED;
			continue;
		}
		out[key] = typeof value === "string" && value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function buildRecord(
	clock: () => number,
	event: string,
	fields: Record<string, unknown> | undefined,
	level: LogEventLevel,
): LogRecord {
	const record: LogRecord = { ts: new Date(clock()).toISOString(), level, event };
	const prepared = prepareFields(fields);
	if (prepared !== undefined) record.fields = prepared;
	return record;
}

/** 级别过滤：`off` 全关，`info` 不记 `debug` 事件，`debug` 全记。 */
function shouldLog(configured: LogLevel, level: LogEventLevel): boolean {
	if (configured === "off") return false;
	if (configured === "debug") return true;
	return level !== "debug";
}

/** 文件日志：JSONL 追加 + 大小轮转；IO 失败吞掉并去重回调 `onError`。 */
export function createFileLogger(options: {
	dir: string;
	level?: LogLevel;
	clock?: () => number;
	fs?: LogFileSystem;
	maxBytes?: number;
	maxBackups?: number;
	onError?: (message: string) => void;
}): Logger {
	const file = path.join(options.dir, LOG_FILE_NAME);
	const level = options.level ?? "info";
	const clock = options.clock ?? Date.now;
	const io = options.fs ?? nodeLogFileSystem;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxBackups = Math.max(1, Math.floor(options.maxBackups ?? DEFAULT_MAX_BACKUPS));
	const reported = new Set<string>();

	const report = (err: unknown): void => {
		const message = err instanceof Error ? err.message : String(err);
		if (reported.has(message)) return;
		reported.add(message);
		try {
			options.onError?.(`[pi-instabox] failed to write log: ${message}`);
		} catch {
			// onError 自身抛错也不能冒泡
		}
	};

	const roll = (): void => {
		for (let i = maxBackups - 1; i >= 1; i--) {
			const from = `${file}.${i}`;
			if (io.exists(from)) io.rename(from, `${file}.${i + 1}`);
		}
		io.rename(file, `${file}.1`);
	};

	const write = (record: LogRecord): void => {
		try {
			io.mkdir(options.dir);
			trySetMode(io, options.dir, 0o700);
			io.append(file, `${JSON.stringify(record)}\n`);
			trySetMode(io, file, 0o600);
			if (io.size(file) >= maxBytes) roll();
		} catch (err) {
			report(err);
		}
	};

	return {
		event(event, fields, recordLevel = "info") {
			if (!shouldLog(level, recordLevel)) return;
			write(buildRecord(clock, event, fields, recordLevel));
		},
	};
}

/** 内存日志：只收集记录（字段预处理与文件实现一致），供单测与装配层断言。 */
export function createMemoryLogger(): Logger & { records: LogRecord[] } {
	const records: LogRecord[] = [];
	return {
		records,
		event(event, fields, level = "info") {
			records.push(buildRecord(Date.now, event, fields, level));
		},
	};
}

let currentLogger: Logger | undefined;

/** 配置模块级单例；传 `undefined` 复位成 no-op。 */
export function setLogger(logger: Logger | undefined): void {
	currentLogger = logger;
}

/** 记录一条事件；未配置单例时什么都不做。 */
export function logEvent(event: string, fields?: Record<string, unknown>, level: LogEventLevel = "info"): void {
	currentLogger?.event(event, fields, level);
}
