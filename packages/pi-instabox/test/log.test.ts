/**
 * @inobit/pi-instabox — `src/log.ts` 单测：JSONL 一行一条、`ts` 取注入时钟、字段预处理（丢
 * `undefined` / 截断 2000 字符 / `token|secret|password|api[-_]?key` 脱敏）、三级过滤
 * （`off` 全关 / `info` 不记 `debug` 但 `warn`·`error` 照常落盘 / `debug` 全记）、写入后按大小
 * 轮转（`.1` 为最新、最多 `maxBackups` 份、滚动后主文件为空、下次写入重新创建）、IO 失败吞掉且
 * 同一错误只回调一次 `onError`、内存记录器可断言与 `setLogger(undefined)` 后 `logEvent` 为 no-op。
 *
 * 全部走注入的假 `LogFileSystem`（内存 Map）与假时钟：不写真实磁盘、不依赖真实时间。
 */

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type LogFileSystem,
	type LogRecord,
	createFileLogger,
	createMemoryLogger,
	logEvent,
	setLogger,
} from "../src/log.ts";

/** 假目录：`createFileLogger` 只做路径拼接，目录不必真实存在。 */
const DIR = "/mem/agent/logs/pi-instabox";
/** 主文件名与 `src/log.ts` 的 `<dir>/pi-instabox.jsonl` 契约一致。 */
const FILE = path.join(DIR, "pi-instabox.jsonl");
const START_TS = "2026-02-03T04:05:06.000Z";
const START_MS = Date.parse(START_TS);

/** 假写入面：文件内容与权限模式都留在内存 Map，绝不碰真实磁盘。 */
class FakeLogIo implements LogFileSystem {
	/** path → 文件全文（无键即文件不存在） */
	readonly files = new Map<string, string>();
	/** path → 最近一次 `setMode` 的模式 */
	readonly modes = new Map<string, number>();
	/** 被要求创建的目录 */
	readonly dirs = new Set<string>();
	/** 非空时 `append` 抛出该错误（模拟 IO 失败） */
	appendError: Error | undefined;

	mkdir(dir: string): void {
		this.dirs.add(dir);
	}

	append(file: string, line: string): void {
		if (this.appendError !== undefined) throw this.appendError;
		this.files.set(file, (this.files.get(file) ?? "") + line);
	}

	rename(from: string, to: string): void {
		const content = this.files.get(from);
		if (content === undefined) throw new Error(`ENOENT: no such file or directory, rename '${from}'`);
		this.files.delete(from);
		this.files.set(to, content);
	}

	exists(file: string): boolean {
		return this.files.has(file);
	}

	size(file: string): number {
		return Buffer.byteLength(this.files.get(file) ?? "", "utf8");
	}

	setMode(target: string, mode: number): void {
		this.modes.set(target, mode);
	}
}

/** 假时钟：起点固定，测试手动推进。 */
function fakeClock(start: number = START_MS): { now: () => number; advance: (ms: number) => void } {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
	};
}

/** 把文件内容按 JSONL 解析（空文件 → 空数组）。 */
function parseLines(content: string | undefined): LogRecord[] {
	if (content === undefined || content === "") return [];
	const lines = content.split("\n");
	expect(lines.at(-1)).toBe("");
	return lines.slice(0, -1).map((line) => JSON.parse(line) as LogRecord);
}

/** 读某个日志文件并解析（文件不存在时报出路径，而不是静默返回空数组）。 */
function recordsOf(io: FakeLogIo, file: string): LogRecord[] {
	if (!io.exists(file)) throw new Error(`log file missing: ${file}`);
	return parseLines(io.files.get(file));
}

/** 取第 `index` 条记录（缺失即失败，避免 `noUncheckedIndexedAccess` 下散落断言符）。 */
function recordAt(records: LogRecord[], index: number): LogRecord {
	const record = records[index];
	if (record === undefined) throw new Error(`missing log record #${index}`);
	return record;
}

/** 断言记录带 `fields` 并返回。 */
function fieldsOf(record: LogRecord): Record<string, unknown> {
	if (record.fields === undefined) throw new Error(`record "${record.event}" has no fields`);
	return record.fields;
}

describe("createFileLogger — JSONL 写入", () => {
	it("一行一条记录，`ts` 由注入 clock 决定，字段落在 fields 子对象", () => {
		const io = new FakeLogIo();
		const clock = fakeClock();
		const logger = createFileLogger({ dir: DIR, fs: io, clock: clock.now });

		logger.event("box.resolved", { box: "dev-1", attempt: 2 });
		clock.advance(1_500);
		logger.event("pool.reuse", { box: "dev-1" });

		expect(io.dirs.has(DIR)).toBe(true);
		const content = io.files.get(FILE) ?? "";
		expect(content.endsWith("\n")).toBe(true);
		expect(content.split("\n")).toHaveLength(3);
		expect(parseLines(content)).toEqual([
			{
				ts: START_TS,
				level: "info",
				event: "box.resolved",
				fields: { box: "dev-1", attempt: 2 },
			},
			{
				ts: "2026-02-03T04:05:07.500Z",
				level: "info",
				event: "pool.reuse",
				fields: { box: "dev-1" },
			},
		]);
	});

	it("丢 `undefined` 字段；字段全丢光时 `fields` 整体缺席", () => {
		const io = new FakeLogIo();
		const logger = createFileLogger({ dir: DIR, fs: io, clock: fakeClock().now, maxBytes: 1_024 });

		logger.event("probe.partial", { box: "dev-1", missing: undefined });
		logger.event("probe.all-undefined", { a: undefined, b: undefined });
		logger.event("probe.no-fields");

		const [partial, allUndefined, noFields] = recordsOf(io, FILE);
		if (partial === undefined || allUndefined === undefined || noFields === undefined) {
			throw new Error("expected three records");
		}
		expect(fieldsOf(partial)).toEqual({ box: "dev-1" });
		expect("fields" in allUndefined).toBe(false);
		expect("fields" in noFields).toBe(false);
	});

	it("字符串字段截断到 2000 字符，非字符串原样保留", () => {
		const io = new FakeLogIo();
		// 不设 maxBytes：一条 ~4.5 KB 的记录会被小阈值立刻滚走，本用例只看字段预处理
		const logger = createFileLogger({ dir: DIR, fs: io, clock: fakeClock().now });

		logger.event("probe.long", { text: "x".repeat(2_500), exact: "y".repeat(2_000), attempt: 3 });

		const fields = fieldsOf(recordAt(recordsOf(io, FILE), 0));
		expect(fields["text"]).toBe("x".repeat(2_000));
		expect(fields["exact"]).toBe("y".repeat(2_000));
		expect(fields["attempt"]).toBe(3);
	});

	it("`token|secret|password|api[-_]?key` 形态的键整值变 `[redacted]`（不分值类型）", () => {
		const io = new FakeLogIo();
		const logger = createFileLogger({ dir: DIR, fs: io, clock: fakeClock().now, maxBytes: 4_096 });

		logger.event("probe.secrets", {
			token: "ghp_xxx",
			accessToken: "xxx",
			client_secret: "xxx",
			password: "xxx",
			api_key: "xxx",
			"api-key": "xxx",
			apiKey: "xxx",
			tokenTtl: 3_600,
			attempt: 2,
			box: "dev-1",
		});

		expect(fieldsOf(recordAt(recordsOf(io, FILE), 0))).toEqual({
			token: "[redacted]",
			accessToken: "[redacted]",
			client_secret: "[redacted]",
			password: "[redacted]",
			api_key: "[redacted]",
			"api-key": "[redacted]",
			apiKey: "[redacted]",
			tokenTtl: "[redacted]",
			attempt: 2,
			box: "dev-1",
		});
	});
});

describe("createFileLogger — 级别过滤", () => {
	it("默认 `info`：不记 `debug` 事件，`warn` / `error` 照常落盘", () => {
		const io = new FakeLogIo();
		const logger = createFileLogger({ dir: DIR, fs: io, clock: fakeClock().now });

		logger.event("lifecycle");
		logger.event("detail", { step: 1 }, "debug");
		logger.event("degraded", { reason: "wake timeout" }, "warn");
		logger.event("broken", { reason: "handshake" }, "error");

		const records = recordsOf(io, FILE);
		expect(records.map((record) => record.event)).toEqual(["lifecycle", "degraded", "broken"]);
		expect(records.map((record) => record.level)).toEqual(["info", "warn", "error"]);
	});

	it("`debug` 全记（含 `debug` 事件）", () => {
		const io = new FakeLogIo();
		const logger = createFileLogger({ dir: DIR, fs: io, clock: fakeClock().now, level: "debug" });

		logger.event("detail", { step: 1 }, "debug");
		logger.event("lifecycle");

		const records = recordsOf(io, FILE);
		expect(records.map((record) => record.event)).toEqual(["detail", "lifecycle"]);
		expect(records.map((record) => record.level)).toEqual(["debug", "info"]);
	});

	it("`off` 全关：`info` / `debug` / `warn` / `error` 一条都不落盘", () => {
		const io = new FakeLogIo();
		const logger = createFileLogger({ dir: DIR, fs: io, clock: fakeClock().now, level: "off" });

		logger.event("lifecycle");
		logger.event("detail", {}, "debug");
		logger.event("degraded", {}, "warn");
		logger.event("broken", {}, "error");

		expect(io.exists(FILE)).toBe(false);
		expect(io.size(FILE)).toBe(0);
	});
});

describe("createFileLogger — 大小轮转", () => {
	/** 单条记录写盘后的字节数：用一次性探针 logger 量，不在测试里复刻序列化格式。 */
	function recordBytes(event: string, fields: Record<string, unknown>): number {
		const probe = new FakeLogIo();
		createFileLogger({ dir: DIR, fs: probe, clock: fakeClock().now }).event(event, fields);
		return probe.size(FILE);
	}

	it("未超 `maxBytes` 不轮转", () => {
		const io = new FakeLogIo();
		const logger = createFileLogger({ dir: DIR, fs: io, clock: fakeClock().now, maxBytes: 1_024 });

		logger.event("box.start", { box: "dev-1" });
		logger.event("box.started", { box: "dev-1" });

		expect(io.exists(`${FILE}.1`)).toBe(false);
		expect(recordsOf(io, FILE).map((record) => record.event)).toEqual(["box.start", "box.started"]);
	});

	it("写入后才判定：超 `maxBytes` 整份滚到 `.1`、主文件为空、下次写入重新创建", () => {
		const io = new FakeLogIo();
		// 放行第一条、写完第二条即超限（阈值来自真实记录长度，避免测试写死字节数）
		const maxBytes = recordBytes("box.start", { box: "dev-1", attempt: 1 }) + 1;
		const logger = createFileLogger({ dir: DIR, fs: io, clock: fakeClock().now, maxBytes });

		logger.event("box.start", { box: "dev-1", attempt: 1 });
		expect(io.exists(`${FILE}.1`)).toBe(false);

		logger.event("box.started", { box: "dev-1" });
		expect(io.size(FILE)).toBe(0);
		expect(recordsOf(io, `${FILE}.1`).map((record) => record.event)).toEqual(["box.start", "box.started"]);

		logger.event("pool.reuse", { box: "dev-1" });
		expect(recordsOf(io, FILE).map((record) => record.event)).toEqual(["pool.reuse"]);
		expect(recordsOf(io, `${FILE}.1`).map((record) => record.event)).toEqual(["box.start", "box.started"]);
	});

	it("最多保留 `maxBackups` 份（默认 3）：`.1` 最新、`.4` 不出现、更旧的被丢弃", () => {
		const io = new FakeLogIo();
		// maxBytes: 1 → 每次写入后都判定为超限，轮转链每一步都可观测
		const logger = createFileLogger({ dir: DIR, fs: io, clock: fakeClock().now, maxBytes: 1 });

		for (const event of ["e1", "e2", "e3", "e4", "e5"]) logger.event(event, { event });

		expect(io.exists(`${FILE}.4`)).toBe(false);
		expect(recordsOf(io, `${FILE}.1`).map((record) => record.event)).toEqual(["e5"]);
		expect(recordsOf(io, `${FILE}.2`).map((record) => record.event)).toEqual(["e4"]);
		expect(recordsOf(io, `${FILE}.3`).map((record) => record.event)).toEqual(["e3"]);
		expect(io.size(FILE)).toBe(0);
	});

	it("`maxBackups` 取配置值：2 份时 `.3` 不出现", () => {
		const io = new FakeLogIo();
		const logger = createFileLogger({
			dir: DIR,
			fs: io,
			clock: fakeClock().now,
			maxBytes: 1,
			maxBackups: 2,
		});

		for (const event of ["e1", "e2", "e3"]) logger.event(event, { event });

		expect(io.exists(`${FILE}.3`)).toBe(false);
		expect(recordsOf(io, `${FILE}.1`).map((record) => record.event)).toEqual(["e3"]);
		expect(recordsOf(io, `${FILE}.2`).map((record) => record.event)).toEqual(["e2"]);
	});
});

describe("createFileLogger — IO 失败", () => {
	it("`append` 抛错不冒泡，同一错误只回调一次 `onError`", () => {
		const io = new FakeLogIo();
		const errors: string[] = [];
		const logger = createFileLogger({
			dir: DIR,
			fs: io,
			clock: fakeClock().now,
			onError: (message) => errors.push(message),
		});

		io.appendError = new Error("ENOSPC: no space left on device");
		expect(() => logger.event("box.start", { box: "dev-1" })).not.toThrow();
		logger.event("pool.wake", { box: "dev-1" });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("[pi-instabox] failed to write log");
		expect(errors[0]).toContain("ENOSPC: no space left on device");

		// 换一条错误信息 → 属于新错误，再回调一次
		io.appendError = new Error("EACCES: permission denied");
		expect(() => logger.event("pool.woken", { box: "dev-1" })).not.toThrow();
		expect(errors).toHaveLength(2);
		expect(errors[1]).toContain("EACCES: permission denied");
		expect(io.exists(FILE)).toBe(false);
	});

	it("`onError` 自身抛错也不冒泡", () => {
		const io = new FakeLogIo();
		io.appendError = new Error("EROFS: read-only file system");
		const logger = createFileLogger({
			dir: DIR,
			fs: io,
			clock: fakeClock().now,
			onError: () => {
				throw new Error("handler blew up");
			},
		});

		expect(() => logger.event("box.start")).not.toThrow();
	});
});

describe("createMemoryLogger / setLogger", () => {
	afterEach(() => {
		setLogger(undefined);
	});

	it("记录可直接断言，字段预处理与文件实现一致", () => {
		const logger = createMemoryLogger();
		logger.event("box.resolved", { box: "dev-1", missing: undefined, token: "t", note: "x".repeat(2_100) }, "debug");

		expect(logger.records).toHaveLength(1);
		const [record] = logger.records;
		if (record === undefined) throw new Error("expected one record");
		expect(record.event).toBe("box.resolved");
		expect(record.level).toBe("debug");
		expect(new Date(record.ts).toISOString()).toBe(record.ts);
		expect(fieldsOf(record)).toEqual({
			box: "dev-1",
			token: "[redacted]",
			note: "x".repeat(2_000),
		});
	});

	it("`setLogger` 装配后 `logEvent` 生效，`setLogger(undefined)` 后是 no-op", () => {
		const logger = createMemoryLogger();
		setLogger(logger);

		logEvent("pool.wake", { box: "dev-1" });
		logEvent("pool.detail", { box: "dev-1" }, "debug");
		expect(logger.records.map((record) => [record.event, record.level])).toEqual([
			["pool.wake", "info"],
			["pool.detail", "debug"],
		]);

		setLogger(undefined);
		logEvent("pool.reuse", { box: "dev-1" });
		logEvent("pool.failed", {}, "error");
		expect(logger.records.map((record) => record.event)).toEqual(["pool.wake", "pool.detail"]);
	});
});
