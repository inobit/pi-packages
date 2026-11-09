/**
 * @inobit/pi-instabox — `src/resolve.ts` 单测：5 级解析链逐级命中/逐级失败、
 * 歧义不猜、参数与会话目标硬错误不降级、配置缺失的 skip/fail 两种语义、
 * 精确 token 匹配（子串/大小写/分隔符不误判）、空 `ls` 结果、
 * `resolve` 埋点在默认 `info` 级别下即落盘。
 *
 * 全部是纯函数调用：不 spawn CLI、不读写真实文件（日志走注入的假写入面）、不联网。
 */

import { describe, expect, it } from "vitest";
import type { BoxInfo } from "../src/boxes.ts";
import {
	type LogFileSystem,
	type LogRecord,
	createFileLogger,
	createMemoryLogger,
	logEvent,
	setLogger,
} from "../src/log.ts";
import { findBoxMentions, resolveBox, type ResolveBoxInput } from "../src/resolve.ts";

/** 构造一条 `ls` 结果（只有 `name` 参与解析，其余字段按未知态填） */
const box = (name: string): BoxInfo => ({
	name,
	state: "running",
	desiredState: "running",
	templateId: "agent-browser",
	templateVersion: "2026-10-25.23",
});

/** 三台箱，顺序即 `instabox ls` 的顺序（`general` 是第一台） */
const BOXES: BoxInfo[] = [box("general"), box("agent"), box("libretv")];

const NAMES = BOXES.map((b) => b.name);

/** 只给 `boxes` 的最小输入 */
const input = (patch: Partial<ResolveBoxInput> = {}): ResolveBoxInput => ({ boxes: BOXES, ...patch });

/** 假写入面：内容留在内存里，`lines()` 按 JSONL 拆行（不碰真实磁盘）。 */
function fakeLogIo(): LogFileSystem & { lines(): string[] } {
	const files = new Map<string, string>();
	return {
		mkdir() {},
		append(file, line) {
			files.set(file, (files.get(file) ?? "") + line);
		},
		rename(from, to) {
			files.set(to, files.get(from) ?? "");
			files.delete(from);
		},
		exists(file) {
			return files.has(file);
		},
		size(file) {
			return Buffer.byteLength(files.get(file) ?? "", "utf8");
		},
		setMode() {},
		lines() {
			return [...files.values()].join("").split("\n").filter((line) => line !== "");
		},
	};
}

describe("findBoxMentions", () => {
	it("finds a single exact token", () => {
		expect(findBoxMentions("please use agent for this", NAMES)).toEqual(["agent"]);
	});

	it("returns mentions ordered by first appearance, not by name list order", () => {
		expect(findBoxMentions("libretv first, then agent, then general", NAMES)).toEqual([
			"libretv",
			"agent",
			"general",
		]);
	});

	it("dedupes repeated mentions and keeps the first position", () => {
		expect(findBoxMentions("agent ... agent ... general ... agent", NAMES)).toEqual(["agent", "general"]);
	});

	it("returns [] for empty text, empty names, or no mention", () => {
		expect(findBoxMentions("", NAMES)).toEqual([]);
		expect(findBoxMentions("nothing to see", NAMES)).toEqual([]);
		expect(findBoxMentions("agent", [])).toEqual([]);
	});

	it("ignores empty names in the candidate list", () => {
		expect(findBoxMentions("agent", ["", "agent", ""])).toEqual(["agent"]);
	});

	it("does not match substrings (agentic is not agent)", () => {
		expect(findBoxMentions("agentic workflow", ["agent"])).toEqual([]);
		expect(findBoxMentions("subagent", ["agent"])).toEqual([]);
		expect(findBoxMentions("agents", ["agent"])).toEqual([]);
	});

	it("treats `_` and `-` as token characters on both sides", () => {
		expect(findBoxMentions("agent-browser", ["agent"])).toEqual([]);
		expect(findBoxMentions("my_agent_x", ["agent"])).toEqual([]);
		expect(findBoxMentions("agent_", ["agent"])).toEqual([]);
		expect(findBoxMentions("-agent", ["agent"])).toEqual([]);
		// 反过来：长名字本身作为 token 能命中
		expect(findBoxMentions("agent-browser", ["agent-browser"])).toEqual(["agent-browser"]);
	});

	it("is case sensitive", () => {
		expect(findBoxMentions("Agent", ["agent"])).toEqual([]);
		expect(findBoxMentions("AGENT", ["agent"])).toEqual([]);
		expect(findBoxMentions("Agent", ["Agent"])).toEqual(["Agent"]);
	});

	it("matches at string edges and next to punctuation", () => {
		expect(findBoxMentions("agent", ["agent"])).toEqual(["agent"]);
		expect(findBoxMentions("(agent)", ["agent"])).toEqual(["agent"]);
		expect(findBoxMentions("agent,general", ["agent", "general"])).toEqual(["agent", "general"]);
		expect(findBoxMentions("用agent跑一下", ["agent"])).toEqual(["agent"]);
	});

	it("keeps matching after a rejected substring occurrence", () => {
		// 先出现的 `agentic` 是子串（不算），后面的 `agent` 才是提及
		expect(findBoxMentions("agentic then agent", ["agent"])).toEqual(["agent"]);
	});
});

describe("resolveBox — level 1: box parameter", () => {
	it("returns the param when it exists, with source param", () => {
		expect(resolveBox(input({ paramBox: "agent" }))).toEqual({ ok: true, box: "agent", source: "param" });
	});

	it("wins over every later source", () => {
		const result = resolveBox(
			input({
				paramBox: "libretv",
				lastUserMessage: "use general",
				sessionTarget: "agent",
				configDefaultBox: "general",
			}),
		);
		expect(result).toEqual({ ok: true, box: "libretv", source: "param" });
	});

	it("fails hard (invalid-param + candidates) when the box does not exist", () => {
		const result = resolveBox(input({ paramBox: "no-such" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid-param");
		expect(result.candidates).toEqual(NAMES);
		expect(result.message).toContain('"no-such"');
		expect(result.message).toContain("general, agent, libretv");
	});

	it("does not fall back to a later source when the param is invalid", () => {
		const result = resolveBox(input({ paramBox: "no-such", sessionTarget: "agent", configDefaultBox: "general" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid-param");
	});

	it("is case sensitive", () => {
		const result = resolveBox(input({ paramBox: "Agent" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid-param");
	});

	it("treats empty / whitespace-only params as not provided", () => {
		expect(resolveBox(input({ paramBox: "" }))).toEqual({ ok: true, box: "general", source: "first" });
		expect(resolveBox(input({ paramBox: "   " }))).toEqual({ ok: true, box: "general", source: "first" });
	});

	it("trims surrounding whitespace before matching", () => {
		expect(resolveBox(input({ paramBox: " agent " }))).toEqual({ ok: true, box: "agent", source: "param" });
	});
});

describe("resolveBox — level 2: last user message", () => {
	it("returns the single mentioned box with source message", () => {
		expect(resolveBox(input({ lastUserMessage: "screenshot on agent please" }))).toEqual({
			ok: true,
			box: "agent",
			source: "message",
		});
	});

	it("wins over session / config / first", () => {
		const result = resolveBox(
			input({ lastUserMessage: "libretv", sessionTarget: "agent", configDefaultBox: "general" }),
		);
		expect(result).toEqual({ ok: true, box: "libretv", source: "message" });
	});

	it("is ambiguous (no guess) when two boxes are mentioned", () => {
		const result = resolveBox(input({ lastUserMessage: "compare general and agent" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("ambiguous");
		expect(result.candidates).toEqual(["general", "agent"]);
		expect(result.message).toContain("general, agent");
	});

	it("does not guess even when session / config would disambiguate", () => {
		const result = resolveBox(
			input({ lastUserMessage: "general or agent", sessionTarget: "agent", configDefaultBox: "general" }),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("ambiguous");
	});

	it("counts a box mentioned twice as one mention", () => {
		expect(resolveBox(input({ lastUserMessage: "agent again: agent" }))).toEqual({
			ok: true,
			box: "agent",
			source: "message",
		});
	});

	it("falls through when the message mentions no box", () => {
		expect(resolveBox(input({ lastUserMessage: "just take a screenshot" }))).toEqual({
			ok: true,
			box: "general",
			source: "first",
		});
	});

	it("ignores names that are only substrings or wrong case", () => {
		expect(resolveBox(input({ lastUserMessage: "the agentic workflow on Agent" }))).toEqual({
			ok: true,
			box: "general",
			source: "first",
		});
	});

	it("ignores names that are not existing boxes", () => {
		expect(resolveBox(input({ lastUserMessage: "use ghostbox" }))).toEqual({
			ok: true,
			box: "general",
			source: "first",
		});
	});

	it("handles a missing lastUserMessage", () => {
		expect(resolveBox(input())).toEqual({ ok: true, box: "general", source: "first" });
	});
});

describe("resolveBox — level 3: session target", () => {
	it("returns the session target with source session", () => {
		expect(resolveBox(input({ sessionTarget: "libretv" }))).toEqual({ ok: true, box: "libretv", source: "session" });
	});

	it("wins over config / first", () => {
		expect(resolveBox(input({ sessionTarget: "agent", configDefaultBox: "general" }))).toEqual({
			ok: true,
			box: "agent",
			source: "session",
		});
	});

	it("fails hard (invalid-session + candidates) when the target disappeared", () => {
		// 例：/instabox-use agent 之后 agent 被 rm，或分支里的名字与 ls 结果不再一致
		const result = resolveBox({
			boxes: [box("general"), box("libretv")],
			sessionTarget: "agent",
			configDefaultBox: "general",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid-session");
		expect(result.candidates).toEqual(["general", "libretv"]);
		expect(result.message).toContain('"agent"');
	});

	it("does not fall back to config when the session target is invalid", () => {
		const result = resolveBox({ boxes: [box("general")], sessionTarget: "agent", configDefaultBox: "general" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid-session");
	});
});

describe("resolveBox — level 4: config defaultBox", () => {
	it("returns the configured box with source config", () => {
		expect(resolveBox(input({ configDefaultBox: "libretv" }))).toEqual({
			ok: true,
			box: "libretv",
			source: "config",
		});
	});

	it("skips a missing configured box by default and reports skippedConfig", () => {
		// 默认 onConfigMissing = "skip"：降级到 ls 第一台，但结果里留下可观测标记
		expect(resolveBox(input({ configDefaultBox: "ghost" }))).toEqual({
			ok: true,
			box: "general",
			source: "first",
			skippedConfig: true,
		});
	});

	it("skips with an explicit onConfigMissing: skip", () => {
		expect(resolveBox(input({ configDefaultBox: "ghost", onConfigMissing: "skip" }))).toEqual({
			ok: true,
			box: "general",
			source: "first",
			skippedConfig: true,
		});
	});

	it("fails with invalid-config when onConfigMissing: fail", () => {
		const result = resolveBox(input({ configDefaultBox: "ghost", onConfigMissing: "fail" }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid-config");
		expect(result.candidates).toEqual(NAMES);
		expect(result.message).toContain('"ghost"');
	});

	it("does not set skippedConfig when no config was given", () => {
		const result = resolveBox(input());
		expect(result).toEqual({ ok: true, box: "general", source: "first" });
		expect("skippedConfig" in result).toBe(false);
	});

	it("does not set skippedConfig when the configured box exists", () => {
		const result = resolveBox(input({ configDefaultBox: "agent" }));
		expect("skippedConfig" in result).toBe(false);
	});
});

describe("resolveBox — level 5: first box / no boxes", () => {
	it("returns boxes[0] with source first", () => {
		expect(resolveBox({ boxes: [box("b"), box("a")] })).toEqual({ ok: true, box: "b", source: "first" });
	});

	it("returns no-boxes when ls is empty", () => {
		const result = resolveBox({ boxes: [] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("no-boxes");
		expect(result.candidates).toEqual([]);
	});

	it("ignores a BoxInfo whose name is empty instead of returning an empty box name", () => {
		// 类型合法但名字为空的条目在别处都被当无效：这里既不能当选中的箱，也不能算候选
		const onlyEmptyName = resolveBox({ boxes: [box("")] });
		expect(onlyEmptyName.ok).toBe(false);
		if (onlyEmptyName.ok) return;
		expect(onlyEmptyName.kind).toBe("no-boxes");
		expect(onlyEmptyName.candidates).toEqual([]);

		expect(resolveBox({ boxes: [box(""), box("general")] })).toEqual({
			ok: true,
			box: "general",
			source: "first",
		});
		const skippedWithEmptyName = resolveBox({ boxes: [box("")], configDefaultBox: "ghost" });
		expect(skippedWithEmptyName.ok).toBe(false);
		if (skippedWithEmptyName.ok) return;
		expect(skippedWithEmptyName.kind).toBe("no-boxes");
		expect(skippedWithEmptyName.candidates).toEqual([]);
	});

	it("returns no-boxes when ls is empty even with a message mention", () => {
		const result = resolveBox({ boxes: [], lastUserMessage: "use agent" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("no-boxes");
	});

	it("keeps hard errors first: an invalid param with empty ls is invalid-param, not no-boxes", () => {
		const result = resolveBox({ boxes: [], paramBox: "agent" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("invalid-param");
		expect(result.candidates).toEqual([]);
		expect(result.message).toContain("no boxes");
	});

	it("does not set skippedConfig when boxes is empty after skipping a missing config", () => {
		const result = resolveBox({ boxes: [], configDefaultBox: "ghost" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("no-boxes");
	});
});

describe("resolveBox — precedence matrix and duplicates", () => {
	it("walks the chain in the documented order", () => {
		const full = {
			paramBox: "general",
			lastUserMessage: "agent",
			sessionTarget: "libretv",
			configDefaultBox: "general",
		};
		expect(resolveBox(input(full))).toEqual({ ok: true, box: "general", source: "param" });
		expect(resolveBox(input({ ...full, paramBox: undefined }))).toEqual({
			ok: true,
			box: "agent",
			source: "message",
		});
		expect(resolveBox(input({ ...full, paramBox: undefined, lastUserMessage: "no mention" }))).toEqual({
			ok: true,
			box: "libretv",
			source: "session",
		});
		expect(
			resolveBox(input({ ...full, paramBox: undefined, lastUserMessage: "no mention", sessionTarget: undefined })),
		).toEqual({ ok: true, box: "general", source: "config" });
		expect(
			resolveBox(
				input({
					...full,
					paramBox: undefined,
					lastUserMessage: "no mention",
					sessionTarget: undefined,
					configDefaultBox: undefined,
				}),
			),
		).toEqual({ ok: true, box: "general", source: "first" });
	});

	it("dedupes duplicate box names from ls in mentions and candidates", () => {
		const boxes = [box("agent"), box("agent"), box("general")];
		const ambiguous = resolveBox({ boxes, lastUserMessage: "agent and general" });
		expect(ambiguous.ok).toBe(false);
		if (ambiguous.ok) return;
		expect(ambiguous.kind).toBe("ambiguous");
		expect(ambiguous.candidates).toEqual(["agent", "general"]);

		const invalid = resolveBox({ boxes, paramBox: "ghost" });
		expect(invalid.ok).toBe(false);
		if (invalid.ok) return;
		expect(invalid.candidates).toEqual(["agent", "general"]);
	});
});

describe("埋点", () => {
	it("resolve / resolve.fail 记下命中的箱名、提及与候选（零命中与降级各一条）", () => {
		const logger = createMemoryLogger();
		setLogger(logger);
		try {
			// 1) 消息命中一台；2) 没有任何提及；3) 配置写错降级到第一台；4) 参数硬错误
			resolveBox(input({ lastUserMessage: "screenshot on agent please" }));
			resolveBox(input({ lastUserMessage: "just take a screenshot" }));
			resolveBox(input({ configDefaultBox: "ghost" }));
			resolveBox(input({ paramBox: "ghost" }));
		} finally {
			setLogger(undefined);
		}

		const resolved = logger.records.filter((record) => record.event === "resolve");
		expect(resolved).toHaveLength(3);
		expect(resolved.every((record) => record.level === "info")).toBe(true);
		expect(resolved[0]?.fields).toEqual({
			source: "message",
			box: "agent",
			mentions: ["agent"],
			candidates: NAMES,
			degraded: false,
		});
		// 零命中也会落一条（分析箱提取的关键样本），`param` 未传时整个键缺席
		expect(resolved[1]?.fields).toEqual({
			source: "first",
			box: "general",
			mentions: [],
			candidates: NAMES,
			degraded: false,
		});
		// 配置 `defaultBox` 写错：降级到 ls 第一台，degraded 标出来
		expect(resolved[2]?.fields).toEqual({
			source: "first",
			box: "general",
			mentions: [],
			candidates: NAMES,
			degraded: true,
		});

		const failed = logger.records.filter((record) => record.event === "resolve.fail");
		expect(failed).toHaveLength(1);
		expect(failed[0]?.level).toBe("warn");
		expect(failed[0]?.fields).toMatchObject({ kind: "invalid-param", candidates: NAMES });
		expect(String(failed[0]?.fields?.["message"])).toContain('unknown box "ghost"');
	});

	it("默认 info 级别的文件日志仍然记下 resolve（不靠 PI_INSTABOX_DEBUG）", () => {
		// 走 `createFileLogger` 的级别过滤路径（不传 level ⇒ 默认 info）：同一批事件里
		// `resolve` 必须落盘，`debug` 级事件必须被滤掉，证明过滤开着而 resolve 已升到 info。
		const io = fakeLogIo();
		const logger = createFileLogger({ dir: "/mem/agent/logs/pi-instabox", fs: io });
		setLogger(logger);
		try {
			resolveBox(input({ lastUserMessage: "screenshot on agent please" }));
			// 对照组：debug 级事件在默认级别下不该出现
			logEvent("debug.probe", { box: "agent" }, "debug");
		} finally {
			setLogger(undefined);
		}

		const records = io.lines().map((line) => JSON.parse(line) as LogRecord);
		expect(records.map((record) => record.event)).toEqual(["resolve"]);
		expect(records[0]?.level).toBe("info");
		expect(records[0]?.fields).toMatchObject({ source: "message", box: "agent", degraded: false });
	});
});
