/**
 * @inobit/pi-instabox — `src/boxes.ts` 单测：`ls --json` 字段裁剪、容错解析、
 * 5s TTL 命中/过期、`force`、并发共享同一次 in-flight、失败不缓存。
 *
 * 全部走注入的假 `ExecFn` 与假时钟：不 spawn 真进程、不联网、不 sleep。
 */

import { describe, expect, it } from "vitest";
import { BOXES_TTL_MS, type ClockFn, createBoxLister, parseLsJson } from "../src/boxes.ts";
import type { ExecFn, ExecResultLike } from "../src/cli.ts";

/** 本机 `instabox ls --json` 的实际形状（截取一台箱，保留本包不用的大字段以证明被丢弃）。 */
const REAL_LS_JSON = [
	{
		id: "m_agqycnns32pg33ri3hfoyvlkre",
		name: "libretv",
		desiredState: "suspended",
		state: "suspended",
		revision: 76,
		operationId: null,
		template: {
			id: "agent-browser",
			version: "2026-10-25.23",
			digest: "sha256:a2465775c94f801d9433982b4138b8b587fe54c44c3b2371a09a4580b5ab66db",
		},
		spec: { vcpus: 4, memMiB: 8192 },
		storage: { sizeGiB: 20, mountPath: "/data", persistent: true },
		runtime: { ready: false, processesPreserved: true },
		vault: true,
		createdAt: "2026-10-28T06:32:22.488714Z",
	},
];

/** 成功结果：给定 stdout、exit 0。 */
function okResult(stdout: string): ExecResultLike {
	return { stdout, stderr: "", code: 0, killed: false, truncated: false };
}

/** 可控时钟：注入用的 `ClockFn` + `advance` 推进毫秒，不依赖真实时间。 */
function fakeClock(startMs = 1_000): { clock: ClockFn; advance: (delta: number) => void } {
	let ms = startMs;
	return {
		clock: () => ms,
		advance: (delta: number) => {
			ms += delta;
		},
	};
}

/** 假 ExecFn：每次调用弹出一条脚本化结果（用尽后重复最后一条），并记录调用次数。 */
function scriptedExec(replies: ExecResultLike[]): { exec: ExecFn; calls: () => number } {
	let count = 0;
	const exec: ExecFn = async () => {
		const reply = replies[Math.min(count, replies.length - 1)];
		count += 1;
		if (!reply) throw new Error("scriptedExec: 没有可回放的结果");
		return reply;
	};
	return { exec, calls: () => count };
}

/** 带闸门的假 ExecFn：`release()` 之前调用一直挂着，用于验证并发去重。 */
function gatedExec(reply: ExecResultLike): { exec: ExecFn; release: () => void; calls: () => number } {
	let open = (): void => {};
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	let count = 0;
	const exec: ExecFn = async () => {
		count += 1;
		await gate;
		return reply;
	};
	return { exec, release: () => open(), calls: () => count };
}

describe("parseLsJson", () => {
	it("真实输出：只保留 name/state/desiredState/templateId/templateVersion", () => {
		const boxes = parseLsJson(REAL_LS_JSON);
		expect(boxes).toEqual([
			{
				name: "libretv",
				state: "suspended",
				desiredState: "suspended",
				templateId: "agent-browser",
				templateVersion: "2026-10-25.23",
			},
		]);
		expect(Object.keys(boxes[0] ?? {})).toEqual(["name", "state", "desiredState", "templateId", "templateVersion"]);
	});

	it("非数组输入一律回空数组", () => {
		for (const raw of [null, undefined, 42, "[]", {}, { boxes: [] }, true]) {
			expect(parseLsJson(raw)).toEqual([]);
		}
	});

	it("空数组回空数组", () => {
		expect(parseLsJson([])).toEqual([]);
	});

	it("缺 name 或 name 不可转字符串的条目被跳过，其余保留", () => {
		const boxes = parseLsJson([
			{ state: "running" },
			{ name: null, state: "running" },
			{ name: { value: "x" }, state: "running" },
			{ name: ["a"], state: "running" },
			{ name: "   ", state: "running" },
			{ name: "keep", state: "running" },
			null,
			"libretv",
			42,
			[],
		]);
		expect(boxes.map((box) => box.name)).toEqual(["keep"]);
	});

	it("缺字段回空串：无 template / template 非对象 / 缺 state", () => {
		const boxes = parseLsJson([
			{ name: "bare" },
			{ name: "no-template", state: "running", desiredState: "running", template: "agent-browser" },
			{ name: "partial", template: { id: "agent-browser" } },
		]);
		expect(boxes).toEqual([
			{ name: "bare", state: "", desiredState: "", templateId: "", templateVersion: "" },
			{ name: "no-template", state: "running", desiredState: "running", templateId: "", templateVersion: "" },
			{ name: "partial", state: "", desiredState: "", templateId: "agent-browser", templateVersion: "" },
		]);
	});

	it("数字/布尔字段先判类型再转字符串", () => {
		const boxes = parseLsJson([{ name: "typed", state: true, desiredState: 7, template: { id: 3, version: 20261025 } }]);
		expect(boxes).toEqual([
			{ name: "typed", state: "true", desiredState: "7", templateId: "3", templateVersion: "20261025" },
		]);
	});

	it("名字两端的空白被裁掉", () => {
		expect(parseLsJson([{ name: "  libretv\n" }]).map((box) => box.name)).toEqual(["libretv"]);
	});
});

describe("createBoxLister", () => {
	it("首次调用 spawn 一次 ls，TTL 内再次调用命中缓存", async () => {
		const { clock } = fakeClock();
		const { exec, calls } = scriptedExec([okResult(JSON.stringify(REAL_LS_JSON))]);
		const lister = createBoxLister({ exec, clock });

		const first = await lister.list();
		const second = await lister.list();

		expect(first.ok).toBe(true);
		expect(first.boxes.map((box) => box.name)).toEqual(["libretv"]);
		expect(second).toEqual(first);
		expect(calls()).toBe(1);
	});

	it("TTL 边界：ttl-1 仍命中，ttl 时过期重拉", async () => {
		const { clock, advance } = fakeClock();
		const { exec, calls } = scriptedExec([
			okResult('[{"name":"a","state":"running"}]'),
			okResult('[{"name":"b","state":"running"}]'),
		]);
		const lister = createBoxLister({ exec, clock });

		await lister.list();
		advance(BOXES_TTL_MS - 1);
		const hit = await lister.list();
		expect(hit.boxes.map((box) => box.name)).toEqual(["a"]);
		expect(calls()).toBe(1);

		advance(1);
		const expired = await lister.list();
		expect(expired.boxes.map((box) => box.name)).toEqual(["b"]);
		expect(calls()).toBe(2);
	});

	it("默认 TTL 是 5s", () => {
		expect(BOXES_TTL_MS).toBe(5_000);
	});

	it("force 跳过 TTL 重拉", async () => {
		const { clock } = fakeClock();
		const { exec, calls } = scriptedExec([
			okResult('[{"name":"a","state":"running"}]'),
			okResult('[{"name":"a","state":"suspended","desiredState":"suspended"}]'),
		]);
		const lister = createBoxLister({ exec, clock });

		await lister.list();
		const forced = await lister.list({ force: true });

		expect(forced.boxes[0]?.state).toBe("suspended");
		expect(calls()).toBe(2);
	});

	it("并发调用共享同一 in-flight Promise，只 spawn 一次", async () => {
		const { clock } = fakeClock();
		const { exec, release, calls } = gatedExec(okResult(JSON.stringify(REAL_LS_JSON)));
		const lister = createBoxLister({ exec, clock });

		const first = lister.list();
		const second = lister.list();
		const third = lister.list({ force: true });
		expect(calls()).toBe(1);
		expect(second).toBe(first);
		expect(third).toBe(first);

		release();
		const results = await Promise.all([first, second, third]);
		expect(results.map((result) => result.boxes.map((box) => box.name))).toEqual([
			["libretv"],
			["libretv"],
			["libretv"],
		]);
		expect(calls()).toBe(1);
	});

	it("in-flight 结束后下一次调用重新走 TTL 判定（不再复用旧 Promise）", async () => {
		const { clock, advance } = fakeClock();
		const { exec, calls } = scriptedExec([okResult('[{"name":"a","state":"running"}]')]);
		const lister = createBoxLister({ exec, clock });

		const first = lister.list();
		await first;
		advance(BOXES_TTL_MS);
		const second = lister.list();

		expect(second).not.toBe(first);
		expect(calls()).toBe(2);
	});

	it("失败不缓存：一次失败后下一次调用立即重试", async () => {
		const { clock } = fakeClock();
		const { exec, calls } = scriptedExec([
			okResult("not json at all"),
			okResult('[{"name":"a","state":"running"}]'),
		]);
		const lister = createBoxLister({ exec, clock });

		const failed = await lister.list();
		expect(failed.ok).toBe(false);
		expect(failed.boxes).toEqual([]);
		expect(failed.error).toContain("invalid JSON");

		const retried = await lister.list();
		expect(retried.ok).toBe(true);
		expect(retried.boxes.map((box) => box.name)).toEqual(["a"]);
		expect(calls()).toBe(2);
	});

	it("非 0 退出的 ls 也走失败分支且不缓存", async () => {
		const { clock } = fakeClock();
		const { exec, calls } = scriptedExec([
			{ stdout: "", stderr: "box service unreachable", code: 2, killed: false, truncated: false },
			okResult("[]"),
		]);
		const lister = createBoxLister({ exec, clock });

		const failed = await lister.list();
		expect(failed.ok).toBe(false);
		expect(failed.error).toContain("box service unreachable");

		const retried = await lister.list();
		expect(retried).toEqual({ ok: true, boxes: [] });
		expect(calls()).toBe(2);
	});

	it("invalidate 丢弃缓存，下次调用重拉", async () => {
		const { clock } = fakeClock();
		const { exec, calls } = scriptedExec([
			okResult('[{"name":"a","state":"running"}]'),
			okResult('[{"name":"a","state":"suspended"}]'),
		]);
		const lister = createBoxLister({ exec, clock });

		await lister.list();
		lister.invalidate();
		const afterInvalidate = await lister.list();

		expect(afterInvalidate.boxes[0]?.state).toBe("suspended");
		expect(calls()).toBe(2);
	});

	it("ttlMs 可覆盖（0 = 每次都重拉）", async () => {
		const { clock } = fakeClock();
		const { exec, calls } = scriptedExec([okResult("[]")]);
		const lister = createBoxLister({ exec, clock, ttlMs: 0 });

		await lister.list();
		await lister.list();

		expect(calls()).toBe(2);
	});

	it("ls 输出是合法 JSON 但不是数组时算成功、结果为空", async () => {
		const { clock } = fakeClock();
		const { exec } = scriptedExec([okResult('{"boxes":[]}')]);
		const lister = createBoxLister({ exec, clock });

		expect(await lister.list()).toEqual({ ok: true, boxes: [] });
	});
});
