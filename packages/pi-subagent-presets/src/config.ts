/**
 * @inobit/pi-subagent-presets — 扩展配置读写（唯一一份配置）。
 *
 * 双层模式对齐 pi-todo / pi-undo：
 * - 全局 `<agentDir>/extensions/pi-subagent-presets/config.json`
 * - 项目 `<cwd>/<CONFIG_DIR_NAME>/extensions/pi-subagent-presets/config.json`（仅 trusted 时读取）
 * 项目层的 `agents` 整体替换全局层（不是并集）：白名单是"托管清单"，用户删一个
 * 就是不想再托管它，并集语义会让"删掉"永远不生效。
 */

import fs from "node:fs";
import path from "node:path";
import { getAgentDir, getConfigDirName } from "./context.ts";

export interface PresetsConfig {
	/** 托管清单：参与矩阵的 agent，也是项目 agentOverrides 里允许出现的全部 agent。 */
	agents: string[];
}

/**
 * 内置默认值：7 个纯 Pi runner 的 builtin。
 * 14 个 builtin 里 `advisor` 是 `oracle` 的别名（键必须是 canonical name），
 * 另 6 个（claude-code* / codex-exec* / cursor-agent*）是外部 CLI runner，
 * 运行期忽略 model/thinking，故默认排除。
 */
export const DEFAULT_AGENTS: readonly string[] = [
	"worker",
	"scout",
	"reviewer",
	"oracle",
	"researcher",
	"delegate",
	"evidence-auditor",
];

export const DEFAULT_CONFIG: PresetsConfig = { agents: [...DEFAULT_AGENTS] };

export interface LoadConfigOptions {
	globalPath?: string;
	projectPath?: string;
	trusted?: boolean;
	/** VITEST 下不落盘（测试确定性），只返回合并结果。 */
	skipWrite?: boolean;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** 纯归一化：非字符串元素丢弃、去首尾空白、去重（保持首次出现顺序）、去空。 */
export function normalizeAgents(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const t = item.trim();
		if (!t || out.includes(t)) continue;
		out.push(t);
	}
	return out;
}

/** 纯函数：合并两层 config.json，项目层整体替换。 */
export function normalizeConfig(globalRaw: unknown, projectRaw: unknown): PresetsConfig {
	const projectAgents = normalizeAgents((projectRaw as { agents?: unknown } | undefined)?.agents);
	if (projectAgents) return { agents: projectAgents };
	const globalAgents = normalizeAgents((globalRaw as { agents?: unknown } | undefined)?.agents);
	if (globalAgents) return { agents: globalAgents };
	return { agents: [...DEFAULT_CONFIG.agents] };
}

export function configPaths(cwd: string, agentDir = getAgentDir()): { globalPath: string; projectPath: string } {
	return {
		globalPath: path.join(agentDir, "extensions", "pi-subagent-presets", "config.json"),
		projectPath: path.join(cwd, getConfigDirName(), "extensions", "pi-subagent-presets", "config.json"),
	};
}

function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	fs.renameSync(tmp, file);
}

export function loadConfig(cwd: string, options: LoadConfigOptions = {}): PresetsConfig {
	const defaults = configPaths(cwd);
	const globalPath = options.globalPath ?? defaults.globalPath;
	const projectPath = options.projectPath ?? defaults.projectPath;
	const globalRaw = readJson(globalPath);
	const projectRaw = options.trusted === true ? readJson(projectPath) : undefined;
	const config = normalizeConfig(globalRaw, projectRaw);

	// 首次运行生成默认配置文件（项目层受 trust 门控，不写）。
	const skipWrite = options.skipWrite ?? Boolean(process.env.VITEST);
	if (!skipWrite) {
		if (!fs.existsSync(globalPath)) {
			try {
				writeJsonAtomic(globalPath, { agents: config.agents });
			} catch {
				// 配置目录不可写不影响本次运行，回落到内存默认值
			}
		}
	}
	return config;
}
