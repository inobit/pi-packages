/**
 * @inobit/pi-nvim — config.ts 单测：纯校验 normalizeConfig（非法回退默认）。
 */

import { describe, expect, it } from "vitest";
import { applyOverlay, clampTimeoutHierarchy, DEFAULT_CONFIG, normalizeConfig } from "../src/config.ts";

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

describe("clampTimeoutHierarchy（不变式 attachMs+diagMs ≤ requestMs）", () => {
	/** 不变式：单请求内 attach 与 diag 串行相加，其和超 requestMs 则 requestMs 先到点 → 杀健康 daemon 丢温 */
	const holds = (t: ReturnType<typeof clampTimeoutHierarchy>): boolean => t.attachMs + t.diagMs <= t.requestMs;

	it("默认配置原样通过（20000+10000 ≤ 60000）", () => {
		expect(clampTimeoutHierarchy(DEFAULT_CONFIG.timeouts)).toEqual(DEFAULT_CONFIG.timeouts);
	});
	it("diagMs 抬过 requestMs 被钳", () => {
		const out = clampTimeoutHierarchy({ ...DEFAULT_CONFIG.timeouts, diagMs: 99999 });
		expect(holds(out)).toBe(true);
	});
	it("requestMs 收紧时 attachMs 一并被钳（只钳 diagMs 会破不变式）", () => {
		// 修复前：attachMs 恒 20000 不钳，diagMs 落保底 1000 → 21000 > 5000，健康 daemon 被误判卡死
		const out = clampTimeoutHierarchy({ ...DEFAULT_CONFIG.timeouts, requestMs: 5000 });
		expect(out.attachMs).toBeLessThanOrEqual(5000 - 1000);
		expect(holds(out)).toBe(true);
	});
	it("diagMs 保底 1000（落定等待不得压成 0，否则冷 server 首波诊断必漏检）", () => {
		const out = clampTimeoutHierarchy({ ...DEFAULT_CONFIG.timeouts, requestMs: 5000, diagMs: 1 });
		expect(out.diagMs).toBe(1000);
		expect(holds(out)).toBe(true);
	});
	it("requestMs < 2s 病态配置：保底优先，不变式无法同时满足（文档钉死此行为）", () => {
		const out = clampTimeoutHierarchy({ ...DEFAULT_CONFIG.timeouts, requestMs: 1500 });
		expect(out.attachMs).toBe(1000);
		expect(out.diagMs).toBe(1000);
	});
});

describe("normalizeConfig/applyOverlay 超时层级（同一钳制入口）", () => {
	/** applyOverlay 第二参的 timeouts 须完整，故用补丁构造 */
	const overlayOf = (patch: Partial<(typeof DEFAULT_CONFIG)["timeouts"]>) => ({
		timeouts: { ...DEFAULT_CONFIG.timeouts, ...patch },
	});

	it("normalizeConfig 覆盖 requestMs 后闭合", () => {
		const t = normalizeConfig({ timeouts: { requestMs: 5000 } }).timeouts;
		expect(t.attachMs + t.diagMs).toBeLessThanOrEqual(t.requestMs);
	});
	it("applyOverlay 覆盖 requestMs 后闭合", () => {
		const t = applyOverlay(DEFAULT_CONFIG, overlayOf({ requestMs: 5000 })).timeouts;
		expect(t.attachMs + t.diagMs).toBeLessThanOrEqual(t.requestMs);
	});
	it("applyOverlay 抬 diagMs 后闭合", () => {
		const t = applyOverlay(DEFAULT_CONFIG, overlayOf({ diagMs: 99999 })).timeouts;
		expect(t.attachMs + t.diagMs).toBeLessThanOrEqual(t.requestMs);
	});
});
