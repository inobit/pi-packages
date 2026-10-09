/**
 * @inobit/pi-subagent-presets — 三层 settings 与 profile 的**纯 IO 读取**（§4.1、§4.2）。
 *
 * 无上游依赖：只读裸 JSON 整体（`agentOverridesByProvider` 与顶层 `disable*` 都要，
 * 因为 §3.1 的两条保护在 L0 也要生效）。
 *
 * 所有读函数**不抛**：语法错误 / 类型不符都通过 `error` 字段回报，调用方负责
 * 决定是红条还是回落——绝不静默吞掉用户数据的解析错误。
 */

import fs from "node:fs";
import path from "node:path";
import { getProfilesDir, getProjectSettingsPath, getUserSettingsPath } from "./context.ts";
import { readMainLayer, type MainLayer } from "./main-row.ts";
import type { Override } from "./merge.ts";
import { isSafeProfileName, validateProfileAgentOverrides, validateProfileMain } from "./validate.ts";

/** provider 条件层：`{ [provider]: { [agentName]: Override } }` */
export type ProviderOverrideMap = Record<string, Record<string, Override>>;

export interface SubagentsLayer {
	/** `subagents.agentOverrides`（原始值，未校验）。 */
	agentOverrides: Record<string, Override>;
	/** `subagents.agentOverridesByProvider`（原始值，未校验）。 */
	agentOverridesByProvider: ProviderOverrideMap;
	/** `subagents.defaultProvider`（顶层，§3.5 的 provider 定位会注入到 `agent.modelProvider`）。 */
	defaultProvider?: string;
	disableBuiltins: boolean;
	disableThinking: boolean;
	/** 是否存在 `agentOverridesByProvider`（任意 scope）——影响是否要传第三参。 */
	hasProviderOverrides: boolean;
}

export interface SettingsLayer {
	settingsPath: string;
	exists: boolean;
	/** 整个 settings 对象（写入时要做"其余键语义保留"）。 */
	settings: Record<string, unknown>;
	subagents: SubagentsLayer;
	/** 顶层 main 三键（§16.2.3，非法类型已剔除）。 */
	main: MainLayer;
	/** 解析/读取错误（语法错误、顶层非对象）。 */
	error?: string;
}

const EMPTY_SUBAGENTS: SubagentsLayer = {
	agentOverrides: {},
	agentOverridesByProvider: {},
	disableBuiltins: false,
	disableThinking: false,
	hasProviderOverrides: false,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSubagentsLayer(value: unknown): SubagentsLayer {
	if (!isPlainObject(value)) return EMPTY_SUBAGENTS;
	const rawOverrides = isPlainObject(value.agentOverrides) ? value.agentOverrides : {};
	const agentOverrides: Record<string, Override> = {};
	for (const [name, entry] of Object.entries(rawOverrides)) {
		if (isPlainObject(entry)) agentOverrides[name] = entry;
	}
	const agentOverridesByProvider: ProviderOverrideMap = {};
	if (isPlainObject(value.agentOverridesByProvider)) {
		for (const [provider, map] of Object.entries(value.agentOverridesByProvider)) {
			if (!isPlainObject(map)) continue;
			const bucket: Record<string, Override> = {};
			for (const [name, entry] of Object.entries(map)) {
				if (isPlainObject(entry)) bucket[name] = entry;
			}
			agentOverridesByProvider[provider] = bucket;
		}
	}
	return {
		agentOverrides,
		agentOverridesByProvider,
		...(typeof value.defaultProvider === "string" ? { defaultProvider: value.defaultProvider } : {}),
		disableBuiltins: value.disableBuiltins === true,
		disableThinking: value.disableThinking === true,
		hasProviderOverrides: Object.keys(agentOverridesByProvider).length > 0,
	};
}

/** 从一层 settings 顶层读 main 三键（非法类型已剔除；档位值域由调用方校验）。 */
function parseMainLayer(parsed: Record<string, unknown>): MainLayer {
	return readMainLayer(parsed);
}

/** 读一层 settings；文件不存在是正常情况（`exists: false`），语法错误则带 `error`。 */
export function readSettingsLayer(settingsPath: string): SettingsLayer {
	if (!fs.existsSync(settingsPath)) {
		return { settingsPath, exists: false, settings: {}, subagents: EMPTY_SUBAGENTS, main: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		return {
			settingsPath,
			exists: true,
			settings: {},
			subagents: EMPTY_SUBAGENTS,
			main: {},
			error: `Failed to parse '${settingsPath}': ${detail}`,
		};
	}
	if (!isPlainObject(parsed)) {
		return {
			settingsPath,
			exists: true,
			settings: {},
			subagents: EMPTY_SUBAGENTS,
			main: {},
			error: `Settings file '${settingsPath}' must contain a JSON object.`,
		};
	}
	return {
		settingsPath,
		exists: true,
		settings: parsed,
		subagents: parseSubagentsLayer(parsed.subagents),
		main: parseMainLayer(parsed),
	};
}

export function readUserLayer(agentDir?: string): SettingsLayer {
	return readSettingsLayer(getUserSettingsPath(agentDir));
}

export function readProjectLayer(projectRoot: string): SettingsLayer {
	return readSettingsLayer(getProjectSettingsPath(projectRoot));
}

export interface ProfileEntry {
	name: string;
	filePath: string;
	/** `subagents.agentOverrides`（已过 profile 校验器）。 */
	agentOverrides: Record<string, Override>;
	/** 顶层 main 三键（§16.2.3，已过 `validateProfileMain`）。 */
	main: MainLayer;
	errors: string[];
	warnings: string[];
}

function readProfileFile(filePath: string): { parsed: unknown; error?: string } {
	try {
		return { parsed: JSON.parse(fs.readFileSync(filePath, "utf8")) };
	} catch (e) {
		return { parsed: undefined, error: `Failed to read '${filePath}': ${e instanceof Error ? e.message : String(e)}` };
	}
}

/** 列可用 profile 名（只列 `*.json`，已剥后缀，升序）。 */
export function listProfileNames(agentDir?: string): string[] {
	const dir = getProfilesDir(agentDir);
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => entry.name.slice(0, -5))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

export function profileExists(name: string, agentDir?: string): boolean {
	if (!isSafeProfileName(name)) return false;
	return fs.existsSync(path.join(getProfilesDir(agentDir), `${name}.json`));
}

/**
 * 读一个 profile。
 *
 * 用本扩展 §6.6 校验器逐字段校验（上游的 `validateSubagentProfile` 是模块私有、未导出，
 * 调不到），并额外保证上游 profile 加载器特有的两条：`model` 必须是 string、
 * `fallbackModels` 抛错。非法 ⇒ `errors` 非空，调用方红条并拒绝合并。
 */
export function readProfile(name: string, agentDir?: string): ProfileEntry | undefined {
	if (!isSafeProfileName(name)) return undefined;
	const filePath = path.join(getProfilesDir(agentDir), `${name}.json`);
	if (!fs.existsSync(filePath)) return undefined;
	const { parsed, error } = readProfileFile(filePath);
	if (error) return { name, filePath, agentOverrides: {}, main: {}, errors: [error], warnings: [] };
	if (!isPlainObject(parsed)) {
		return { name, filePath, agentOverrides: {}, main: {}, errors: [`Profile '${filePath}' must contain a JSON object.`], warnings: [] };
	}
	const subagents = parsed.subagents;
	if (!isPlainObject(subagents)) {
		return {
			name,
			filePath,
			agentOverrides: {},
			main: {},
			errors: [`Profile '${filePath}' must contain a 'subagents' object.`],
			warnings: [],
		};
	}
	const validation = validateProfileAgentOverrides(subagents.agentOverrides);
	// 顶层 main 三键与 agent 条目同规则：非法 ⇒ 进 errors，调用方红条拒绝合并
	const mainValidation = validateProfileMain(parsed);
	const errors = [...validation.errors, ...mainValidation.errors];
	const warnings = [...validation.warnings, ...mainValidation.warnings];
	if (errors.length > 0) {
		return { name, filePath, agentOverrides: {}, main: {}, errors, warnings };
	}
	const raw = isPlainObject(subagents.agentOverrides) ? subagents.agentOverrides : {};
	const agentOverrides: Record<string, Override> = {};
	for (const [agent, entry] of Object.entries(raw)) {
		if (isPlainObject(entry)) agentOverrides[agent] = entry;
	}
	return { name, filePath, agentOverrides, main: readMainLayer(parsed), errors: [], warnings };
}

