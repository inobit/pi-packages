import { describe, it, expect } from "vitest";
import {
	TARGET_ENTRY,
	isTargetEntry,
	readTarget,
	targetEntryData,
	type SessionEntryLike,
} from "../src/session-target.ts";

const targetEntry = (box: string, at = "2026-01-01T00:00:00.000Z"): SessionEntryLike => ({
	type: "custom",
	customType: TARGET_ENTRY,
	data: { box, at },
});

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
