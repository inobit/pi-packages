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

describe("clampTimeoutHierarchy（不变式 startupMs+diagnosticMs ≤ requestMs）", () => {
	/** 不变式：启动段与诊断段串行；其和超 requestMs 则 requestMs 先到点 → 杀健康 daemon 丢温 */
	const holds = (t: ReturnType<typeof clampTimeoutHierarchy>): boolean => t.startupMs + t.diagnosticMs <= t.requestMs;

	it("默认配置原样通过（10000+20000 ≤ 60000）", () => {
		expect(clampTimeoutHierarchy(DEFAULT_CONFIG.timeouts)).toEqual(DEFAULT_CONFIG.timeouts);
	});
	it("diagnosticMs 抬过 requestMs 被钳", () => {
		const out = clampTimeoutHierarchy({ ...DEFAULT_CONFIG.timeouts, diagnosticMs: 99999 });
		expect(holds(out)).toBe(true);
	});
	it("requestMs 收紧时 startupMs 一并被钳（只钳 diagnosticMs 会破不变式）", () => {
		const out = clampTimeoutHierarchy({ ...DEFAULT_CONFIG.timeouts, requestMs: 8000 });
		expect(out.startupMs).toBe(7000);
		expect(out.diagnosticMs).toBe(1000);
		expect(holds(out)).toBe(true);
	});
	it("pushObserveMs 默认 15000；可用 0 显式关闭；超 diagnosticMs 被钳", () => {
		expect(DEFAULT_CONFIG.timeouts.pushObserveMs).toBe(15000);
		expect(normalizeConfig({ timeouts: { pushObserveMs: 0 } }).timeouts.pushObserveMs).toBe(0);
		expect(normalizeConfig({ timeouts: { pushObserveMs: 3000 } }).timeouts.pushObserveMs).toBe(3000);
		const clamped = normalizeConfig({ timeouts: { diagnosticMs: 5000, pushObserveMs: 99999 } }).timeouts;
		expect(clamped.pushObserveMs).toBeLessThanOrEqual(clamped.diagnosticMs);
	});
	it("requestMs 够大时不变式闭合", () => {
		const out = clampTimeoutHierarchy({ ...DEFAULT_CONFIG.timeouts, requestMs: 25000 });
		expect(holds(out)).toBe(true);
	});
	it("diagnosticMs 保底 1000（单次等待不得压成 0，否则 server 现场计算必超时）", () => {
		const out = clampTimeoutHierarchy({ ...DEFAULT_CONFIG.timeouts, requestMs: 25000, diagnosticMs: 1 });
		expect(out.diagnosticMs).toBe(1000);
	});
	it("requestMs < 3s 病态配置：保底优先，不变式无法同时满足（文档钉死此行为）", () => {
		const out = clampTimeoutHierarchy({ ...DEFAULT_CONFIG.timeouts, requestMs: 1500 });
		expect(out.startupMs).toBe(1000);
		expect(out.diagnosticMs).toBe(1000);
	});
});

describe("normalizeConfig/applyOverlay 超时层级（同一钳制入口）", () => {
	/** applyOverlay 第二参的 timeouts 须完整，故用补丁构造 */
	const overlayOf = (patch: Partial<(typeof DEFAULT_CONFIG)["timeouts"]>) => ({
		timeouts: { ...DEFAULT_CONFIG.timeouts, ...patch },
	});

	it("normalizeConfig 覆盖 requestMs 后闭合", () => {
		const t = normalizeConfig({ timeouts: { requestMs: 25000 } }).timeouts;
		expect(t.startupMs + t.diagnosticMs).toBeLessThanOrEqual(t.requestMs);
	});
	it("applyOverlay 覆盖 requestMs 后闭合", () => {
		const t = applyOverlay(DEFAULT_CONFIG, overlayOf({ requestMs: 25000 })).timeouts;
		expect(t.startupMs + t.diagnosticMs).toBeLessThanOrEqual(t.requestMs);
	});
	it("applyOverlay 抬 diagnosticMs 后闭合", () => {
		const t = applyOverlay(DEFAULT_CONFIG, overlayOf({ diagnosticMs: 99999 })).timeouts;
		expect(t.startupMs + t.diagnosticMs).toBeLessThanOrEqual(t.requestMs);
	});
	it("旧 key 别名：attachMs/diagMs 在新 key 缺席时生效（不断档）", () => {
		const t = normalizeConfig({ timeouts: { attachMs: 3000, diagMs: 4000 } } as unknown as Record<string, unknown>).timeouts;
		expect(t.startupMs).toBe(3000);
		expect(t.diagnosticMs).toBe(4000);
	});
	it("新 key 优先于旧 key 别名", () => {
		const t = normalizeConfig({
			timeouts: { startupMs: 7000, attachMs: 3000, diagnosticMs: 8000, diagMs: 4000 },
		} as unknown as Record<string, unknown>).timeouts;
		expect(t.startupMs).toBe(7000);
		expect(t.diagnosticMs).toBe(8000);
	});
});
