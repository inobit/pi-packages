/**
 * @inobit/pi-todo — 面板显示预算配置。
 *
 * 参照 pi-undo `src/config.ts` 模式：全局 `~/.pi/agent/extensions/pi-todo/config.json`，
 * 项目级 `<cwd>/.pi/extensions/pi-todo/config.json`（仅 trusted 时读取）。
 * VITEST 下恒返回默认值（测试确定性），校验逻辑走纯函数 `normalizeConfig` 单测。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_LINES, DEFAULT_TARGET_LINES } from "./overlay.ts";

export interface TodoConfig {
	/** 面板硬上限行数（含标题），超了走 +N more 溢出 */
	maxLines: number;
	/** 清理软目标行数（含标题），3s 清理/轮切换时把已完成藏到总量不超过它（best-effort，未完成必留） */
	targetLines: number;
}

export const DEFAULT_CONFIG: TodoConfig = {
	maxLines: DEFAULT_MAX_LINES,
	targetLines: DEFAULT_TARGET_LINES,
};

export function getAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR;
	if (env) {
		if (env === "~" || env.startsWith("~/") || env.startsWith("~\\")) return path.join(os.homedir(), env.slice(2));
		return env;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

export interface LoadConfigOptions {
	globalPath?: string;
	projectPath?: string;
	trusted?: boolean;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function asInt(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isInteger(raw)) return undefined;
	return raw;
}

/**
 * 纯校验：非法字段回退默认值；target 钳制到 [2, max]（标题占 1 行，target < 2 无意义）。
 * 约束：2 <= targetLines <= maxLines（maxLines 自身下限 2）。
 */
export function normalizeConfig(raw: Record<string, unknown> | undefined): TodoConfig {
	let maxLines = DEFAULT_CONFIG.maxLines;
	let targetLines = DEFAULT_CONFIG.targetLines;
	if (raw) {
		const m = asInt(raw.maxLines ?? raw.max_lines);
		if (m !== undefined && m >= 2) maxLines = m;
		const t = asInt(raw.targetLines ?? raw.target_lines);
		if (t !== undefined && t >= 2) targetLines = t;
	}
	if (targetLines > maxLines) targetLines = maxLines;
	return { maxLines, targetLines };
}

export function loadConfig(cwd: string, options: LoadConfigOptions = {}): TodoConfig {
	if ((process as unknown as Record<string, unknown>).env && (process.env as Record<string, string>).VITEST) {
		return { ...DEFAULT_CONFIG };
	}
	const globalPath = options.globalPath ?? path.join(getAgentDir(), "extensions", "pi-todo", "config.json");
	const projectPath = options.projectPath ?? path.join(cwd, ".pi", "extensions", "pi-todo", "config.json");
	let merged: Record<string, unknown> | undefined;
	for (const file of [globalPath, options.trusted === true ? projectPath : undefined]) {
		if (!file) continue;
		const j = readJson(file);
		if (j) merged = { ...merged, ...j };
	}
	return normalizeConfig(merged);
}
