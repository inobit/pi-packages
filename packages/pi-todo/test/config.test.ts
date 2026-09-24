import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "../src/config.ts";
import { DEFAULT_MAX_LINES, DEFAULT_TARGET_LINES } from "../src/overlay.ts";

describe("todo config", () => {
	it("默认值：硬上限 7 / 软目标 5", () => {
		expect(DEFAULT_CONFIG).toEqual({ maxLines: 7, targetLines: 5 });
		expect(DEFAULT_MAX_LINES).toBe(7);
		expect(DEFAULT_TARGET_LINES).toBe(5);
	});

	it("VITEST 下恒返回默认（忽略文件）", () => {
		expect(process.env.VITEST).toBeTruthy();
		expect(loadConfig("/nonexistent")).toEqual(DEFAULT_CONFIG);
	});

	it("normalizeConfig：合法值通过", () => {
		expect(normalizeConfig({ maxLines: 10, targetLines: 4 })).toEqual({ maxLines: 10, targetLines: 4 });
	});

	it("normalizeConfig：非法值回退默认", () => {
		expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig({ maxLines: 1, targetLines: 0 })).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig({ maxLines: "7", targetLines: 2.5 })).toEqual(DEFAULT_CONFIG);
	});

	it("normalizeConfig：target 越界钳制到 max", () => {
		expect(normalizeConfig({ maxLines: 4, targetLines: 9 })).toEqual({ maxLines: 4, targetLines: 4 });
		expect(normalizeConfig({ maxLines: 4 })).toEqual({ maxLines: 4, targetLines: 4 });
	});
});
