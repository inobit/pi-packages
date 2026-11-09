import { describe, it, expect } from "vitest";
import {
	DEVTOOLS_TARGET_ENTRY,
	TARGET_ENTRY,
	devtoolsTargetEntryData,
	isTargetEntry,
	readDevtoolsTarget,
	readTarget,
	targetEntryData,
	type SessionEntryLike,
} from "../src/session-target.ts";

const targetEntry = (box: string, at = "2026-01-01T00:00:00.000Z"): SessionEntryLike => ({
	type: "custom",
	customType: TARGET_ENTRY,
	data: { box, at },
});

/** 分支上的一条 DevTools 绑定 entry（`reset` 为 true 时是清除标记） */
const devtoolsEntry = (box: string, reset = false): SessionEntryLike => ({
	type: "custom",
	customType: DEVTOOLS_TARGET_ENTRY,
	data: reset ? { box, at: "2026-01-01T00:00:00.000Z", reset: true } : { box, at: "2026-01-01T00:00:00.000Z" },
});

/** 清除标记（`reset` 子命令写的那种：`box` 空串 + `reset: true`） */
const resetEntry: SessionEntryLike = devtoolsEntry("", true);

const userEntry = (text: string): SessionEntryLike => ({ type: "message", data: { text } });
const otherCustomEntry: SessionEntryLike = { type: "custom", customType: "pi-other", data: { box: "decoy" } };

describe("targetEntryData", () => {
	it("keeps the given timestamp", () => {
		expect(targetEntryData("general", "2026-02-03T04:05:06.789Z")).toEqual({
			box: "general",
			at: "2026-02-03T04:05:06.789Z",
		});
	});

	it("defaults at to an ISO timestamp", () => {
		const data = targetEntryData("agent");
		expect(data.box).toBe("agent");
		expect(data.at).toBe(new Date(data.at).toISOString());
	});
});

describe("isTargetEntry", () => {
	it("matches only type=custom + customType=instabox-target", () => {
		expect(isTargetEntry(targetEntry("general"))).toBe(true);
		expect(isTargetEntry(otherCustomEntry)).toBe(false);
		expect(isTargetEntry(userEntry("general"))).toBe(false);
		expect(isTargetEntry(null)).toBe(false);
		expect(isTargetEntry(undefined)).toBe(false);
		expect(isTargetEntry(TARGET_ENTRY)).toBe(false);
	});
});

describe("readTarget", () => {
	it("returns undefined for an empty branch", () => {
		expect(readTarget([])).toBeUndefined();
	});

	it("returns undefined when the branch has no target entry", () => {
		expect(readTarget([userEntry("hi"), otherCustomEntry])).toBeUndefined();
	});

	it("returns the box of the single target entry", () => {
		expect(readTarget([userEntry("hi"), targetEntry("general")])).toBe("general");
	});

	it("returns the last target entry on the branch", () => {
		expect(readTarget([targetEntry("general"), userEntry("hi"), targetEntry("agent")])).toBe("agent");
	});

	it("ignores other customType entries even when they carry a box field", () => {
		expect(readTarget([targetEntry("general"), otherCustomEntry])).toBe("general");
		expect(readTarget([otherCustomEntry])).toBeUndefined();
	});

	it("ignores non-custom entry types", () => {
		expect(readTarget([userEntry("general")])).toBeUndefined();
	});

	it("ignores target entries whose data or box is missing", () => {
		const noData: SessionEntryLike = { type: "custom", customType: TARGET_ENTRY };
		const noBox: SessionEntryLike = { type: "custom", customType: TARGET_ENTRY, data: { at: "2026-01-01T00:00:00.000Z" } };
		expect(readTarget([noData])).toBeUndefined();
		expect(readTarget([noBox])).toBeUndefined();
		// 残缺条目不能遮蔽更早的有效条目
		expect(readTarget([targetEntry("general"), noData])).toBe("general");
	});

	it("does not read targets from abandoned branches (branch only sees its own path)", () => {
		// 全量条目：分支 A 写 general，随后 /tree 回到 fork point、分支 B 写 agent（general 被放弃）
		const root = userEntry("root");
		const general = targetEntry("general");
		const forkPoint = userEntry("fork point");
		const agent = targetEntry("agent");
		const allEntries: SessionEntryLike[] = [root, general, forkPoint, agent];
		// getBranch() 在分支 B 上返回的路径：根 + fork point + agent
		const branchB: SessionEntryLike[] = [root, forkPoint, agent];
		// getBranch() 在分支 A 上返回的路径：根 + general
		const branchA: SessionEntryLike[] = [root, general];
		// getBranch() 在 fork point 处新开、尚未写目标的分支：根 + fork point
		const branchAtFork: SessionEntryLike[] = [root, forkPoint];

		expect(readTarget(branchB)).toBe("agent");
		expect(readTarget(branchA)).toBe("general");
		// 对照：全量条目会读到「未来的」目标，传分支则读不到
		expect(readTarget(allEntries)).toBe("agent");
		expect(readTarget(branchAtFork)).toBeUndefined();
	});
});

describe("devtoolsTargetEntryData", () => {
	it("keeps the given timestamp and no reset flag for a real box", () => {
		expect(devtoolsTargetEntryData("agent", "2026-02-03T04:05:06.789Z")).toEqual({
			box: "agent",
			at: "2026-02-03T04:05:06.789Z",
		});
	});

	it("marks an empty box as a reset entry", () => {
		const data = devtoolsTargetEntryData("", "2026-02-03T04:05:06.789Z");
		expect(data).toEqual({ box: "", at: "2026-02-03T04:05:06.789Z", reset: true });
	});

	it("defaults at to an ISO timestamp", () => {
		const data = devtoolsTargetEntryData("agent");
		expect(data.box).toBe("agent");
		expect(data.reset).toBeUndefined();
		expect(data.at).toBe(new Date(data.at).toISOString());
	});
});

describe("readDevtoolsTarget", () => {
	it("returns undefined for an empty branch", () => {
		expect(readDevtoolsTarget([])).toBeUndefined();
	});

	it("returns the box of the only binding", () => {
		expect(readDevtoolsTarget([userEntry("hi"), devtoolsEntry("agent")])).toBe("agent");
	});

	it("returns the last binding on the branch", () => {
		expect(readDevtoolsTarget([devtoolsEntry("agent"), userEntry("hi"), devtoolsEntry("general")])).toBe("general");
	});

	it("ignores other customType entries even when they carry a box field", () => {
		// 桌面目标 entry 与 DevTools 绑定互不相干
		expect(readDevtoolsTarget([devtoolsEntry("agent"), targetEntry("general")])).toBe("agent");
		expect(readDevtoolsTarget([targetEntry("general"), otherCustomEntry])).toBeUndefined();
	});

	it("stops at a reset entry and does not look further back", () => {
		expect(readDevtoolsTarget([devtoolsEntry("agent"), resetEntry])).toBeUndefined();
		expect(readDevtoolsTarget([devtoolsEntry("agent"), userEntry("hi"), resetEntry, userEntry("hi")])).toBeUndefined();
	});

	it("a binding after a reset entry takes effect again", () => {
		expect(readDevtoolsTarget([devtoolsEntry("agent"), resetEntry, devtoolsEntry("general")])).toBe("general");
	});

	it("ignores binding entries whose data or box is missing", () => {
		const noData: SessionEntryLike = { type: "custom", customType: DEVTOOLS_TARGET_ENTRY };
		const noBox: SessionEntryLike = { type: "custom", customType: DEVTOOLS_TARGET_ENTRY, data: { at: "2026-01-01T00:00:00.000Z" } };
		expect(readDevtoolsTarget([noData])).toBeUndefined();
		expect(readDevtoolsTarget([noBox])).toBeUndefined();
		// 残缺条目不能遮蔽更早的有效绑定
		expect(readDevtoolsTarget([devtoolsEntry("agent"), noData])).toBe("agent");
	});
});
