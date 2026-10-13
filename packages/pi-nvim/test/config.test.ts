/**
 * @inobit/pi-nvim — config.ts 单测：纯校验 normalizeConfig（非法回退默认）。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.ts";

describe("normalizeConfig", () => {
	it("空输入回默认（含 idleMs 300000／parentPollMs 15000／pollMs 50，无 truncation 节）", () => {
		const cfg = normalizeConfig(undefined);
		expect(cfg.idleMs).toBe(300000);
		expect(cfg.parentPollMs).toBe(15000);
		expect(cfg.timeouts.pollMs).toBe(50);
		// 诊断全量：无 truncation 配置节（多余字段直接忽略）
		expect((cfg as unknown as Record<string, unknown>)["truncation"]).toBeUndefined();
		expect(normalizeConfig({ truncation: { perFile: 1 } } as unknown as Record<string, unknown>)).toMatchObject({
			timeouts: cfg.timeouts,
		});
	});
	it("合法覆盖生效", () => {
		const cfg = normalizeConfig({ idleMs: 60000, timeouts: { pollMs: 25 }, nvimPath: "/usr/bin/nvim" });
		expect(cfg.idleMs).toBe(60000);
		expect(cfg.timeouts.pollMs).toBe(25);
		expect(cfg.nvimPath).toBe("/usr/bin/nvim");
		// 未覆盖项保留默认
		expect(cfg.timeouts.spawnMs).toBe(DEFAULT_CONFIG.timeouts.spawnMs);
	});
	it("非法值回退默认（不污染）", () => {
		const cfg = normalizeConfig({
			idleMs: -1,
			parentPollMs: 0,
			timeouts: { pollMs: 1.5, spawnMs: "x" },
			nvimPath: "",
		});
		expect(cfg.idleMs).toBe(DEFAULT_CONFIG.idleMs);
		expect(cfg.parentPollMs).toBe(DEFAULT_CONFIG.parentPollMs);
		expect(cfg.timeouts.pollMs).toBe(50);
		expect(cfg.timeouts.spawnMs).toBe(DEFAULT_CONFIG.timeouts.spawnMs);
		expect(cfg.nvimPath).toBe("nvim");
	});
});
