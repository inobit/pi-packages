/**
 * @inobit/pi-subagent-presets — 26 字段校验器（§6.6）。
 *
 * 与合并**完全解耦**：本模块只服务用户主动用 `e` 手写 override JSON 时的检查。
 * 两类结果不同：
 * - 未知 key → ⚠️ **警告**但可写回（上游静默丢弃它）
 * - 已知字段的非法值 → ❌ **拒绝**（上游 `parseBuiltinOverrideEntry` 会抛错，
 *   让本项目**所有** agent 的 discovery 失败）
 *
 * 逐条口径对齐上游 `agents.js:700-868`（`parseBuiltinOverrideEntry` +
 * `parseOverrideStringArrayOrFalse` / `parseToolsOverride` / `validateOptionalMachine`），
 * 只在一处有意偏离上游：`thinking` 的非档位字符串上游放行、本模块拒绝
 * （上游会把它拼进模型串 `p/m:turbo`，运行期无意义）。
 */

/** pi-ai / 上游共用的 7 个已知 thinking 档位。 */
export const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 26 个官方字段（顺序与上游 `parseBuiltinOverrideEntry` 内的判定顺序一致）。 */
export const KNOWN_FIELDS: readonly string[] = [
	"description",
	"output",
	"outputMode",
	"model",
	"fast",
	"thinking",
	"systemPromptMode",
	"inheritProjectContext",
	"inheritGlobalContext",
	"inheritSkills",
	"defaultContext",
	"acceptanceRole",
	"disabled",
	"toolBudget",
	"systemPrompt",
	"machine",
	"defaultReads",
	"defaultProvider",
	"skills",
	"tools",
	"excludeTools",
	"allowNestedSubagents",
	"allowedAgents",
	"extensions",
	"subagentOnlyExtensions",
	"mutationTools",
];

const KNOWN_FIELD_SET = new Set(KNOWN_FIELDS);

/**
 * `e` 编辑器注释骨架的一行：字段名 + 值域 + 一句话语义。
 * 值域知识就在上面的 `CHECKERS` 里，这里只是带人读的投影（同一份 26 字段清单）。
 */
export interface FieldGuideEntry {
	field: string;
	/** 合法值域（人类可读）。 */
	domain: string;
	note: string;
}

/** 26 字段的注释骨架（顺序 = `KNOWN_FIELDS`）。 */
export const FIELD_GUIDE: readonly FieldGuideEntry[] = [
	{ field: "description", domain: "non-empty string", note: "agent 描述（列表里显示）" },
	{ field: "output", domain: 'non-empty string | false', note: "输出契约：要交什么" },
	{ field: "outputMode", domain: '"inline" | "file-only"', note: "结果回传方式" },
	{ field: "model", domain: 'string | false', note: "false ≡ inherit（跟随父会话模型）" },
	{ field: "fast", domain: "boolean", note: "启动更快，绕开 heavy harness" },
	{ field: "thinking", domain: `${THINKING_LEVELS.join("|")} | false`, note: "false = 不写 :level 后缀" },
	{ field: "systemPromptMode", domain: '"append" | "replace"', note: "systemPrompt 与内建提示词的关系" },
	{ field: "inheritProjectContext", domain: "boolean", note: "继承项目上下文（AGENTS.md 等）" },
	{ field: "inheritGlobalContext", domain: "boolean", note: "继承全局上下文" },
	{ field: "inheritSkills", domain: "boolean", note: "继承 skills" },
	{ field: "defaultContext", domain: '"fresh" | "fork" | false', note: "子会话上下文起点" },
	{ field: "acceptanceRole", domain: '"read-only" | "writer" | false', note: "验收角色" },
	{ field: "disabled", domain: "boolean", note: "禁用该 agent（false 即重新启用）" },
	{ field: "toolBudget", domain: "object | false", note: "工具调用预算" },
	{ field: "systemPrompt", domain: "string（可为 \"\"）", note: "自定义系统提示" },
	{ field: "machine", domain: "non-empty string ≤128 chars | false", note: "限定运行的机器名" },
	{ field: "defaultReads", domain: "string[] | false", note: "开工前必读的文件清单" },
	{ field: "defaultProvider", domain: "non-empty string | false", note: "该 agent 的默认 provider" },
	{ field: "skills", domain: "string[] | false", note: "可用 skill 白名单" },
	{ field: "tools", domain: 'string[] | "inherit" | false', note: "工具白名单" },
	{ field: "excludeTools", domain: "string[] | false", note: "工具黑名单" },
	{ field: "allowNestedSubagents", domain: "boolean", note: "允许再开子 agent" },
	{ field: "allowedAgents", domain: "string[] | false", note: "可调度白名单" },
	{ field: "extensions", domain: "string[] | false", note: "子会话加载的扩展" },
	{ field: "subagentOnlyExtensions", domain: "string[] | false", note: "仅子会话加载的扩展" },
	{ field: "mutationTools", domain: "string[] | false", note: "允许改文件的工具" },
];

export function isKnownField(field: string): boolean {
	return KNOWN_FIELD_SET.has(field);
}

export interface ValidationResult {
	/** ❌ 拒绝项：非空时整份草稿不写回。 */
	errors: string[];
	/** ⚠️ 警告项：可写回（如未知 key，上游会静默丢弃）。 */
	warnings: string[];
}

/**
 * 逐字段的结构化问题（`e` 编辑器要按字段拼“已照原样保存”的提示行）。
 * `validateOverrideEntry` 的 `errors` / `warnings` 就是它按 `kind` 切分后的产物。
 */
export interface OverrideIssue {
	/** 字段名（条目本身非对象时为空串）。 */
	field: string;
	/** `rejects` = 上游解析时抛错；`warns` = 上游静默丢弃。 */
	kind: "rejects" | "warns";
	/** 面向开发/排错的完整文案（英文）。 */
	message: string;
}

export function isThinkingLevel(value: unknown): value is string {
	return typeof value === "string" && THINKING_LEVELS.includes(value);
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type FieldChecker = (value: unknown, field: string, fail: (msg: string) => void) => void;

const stringArrayOrFalse: FieldChecker = (value, field, fail) => {
	if (value === undefined || value === false) return;
	if (!Array.isArray(value)) {
		fail(`'${field}' must be an array of strings or false`);
		return;
	}
	for (const item of value) {
		if (typeof item !== "string") {
			fail(`'${field}' must contain only strings`);
			return;
		}
	}
};

const CHECKERS: Record<string, FieldChecker> = {
	// 上游：非空串（trim 后）才合法，`""` 抛错
	description: (value, field, fail) => {
		if (typeof value !== "string" || !value.trim()) fail(`'${field}' must be a non-empty string`);
	},
	// 上游：非空串或 false
	output: (value, field, fail) => {
		if (typeof value === "string" && value.trim()) return;
		if (value === false) return;
		fail(`'${field}' must be a non-empty string or false`);
	},
	outputMode: (value, field, fail) => {
		if (value !== "inline" && value !== "file-only") fail(`'${field}' must be 'inline' or 'file-only'`);
	},
	// 项目 settings 侧允许 `model: false`（agents.js:1171-1177）
	model: (value, field, fail) => {
		if (typeof value !== "string" && value !== false) fail(`'${field}' must be a string or false`);
	},
	fast: (value, field, fail) => {
		if (typeof value !== "boolean") fail(`'${field}' must be a boolean`);
	},
	// 上游放行任意 string；本模块额外拒绝非档位串（会被拼进模型串）
	thinking: (value, field, fail) => {
		if (typeof value === "string") {
			if (value === "") {
				fail(`'${field}' must be a known level or false — an empty string is neither inherit nor a level`);
				return;
			}
			if (!THINKING_LEVELS.includes(value)) {
				fail(`'${field}' must be one of ${THINKING_LEVELS.join(", ")} or false; got '${value}'`);
			}
			return;
		}
		if (value !== false) fail(`'${field}' must be a string or false`);
	},
	systemPromptMode: (value, field, fail) => {
		if (value !== "append" && value !== "replace") fail(`'${field}' must be 'append' or 'replace'`);
	},
	inheritProjectContext: (value, field, fail) => {
		if (typeof value !== "boolean") fail(`'${field}' must be a boolean`);
	},
	inheritGlobalContext: (value, field, fail) => {
		if (typeof value !== "boolean") fail(`'${field}' must be a boolean`);
	},
	inheritSkills: (value, field, fail) => {
		if (typeof value !== "boolean") fail(`'${field}' must be a boolean`);
	},
	defaultContext: (value, field, fail) => {
		if (value !== "fresh" && value !== "fork" && value !== false) fail(`'${field}' must be 'fresh', 'fork', or false`);
	},
	acceptanceRole: (value, field, fail) => {
		if (value !== "read-only" && value !== "writer" && value !== false) fail(`'${field}' must be 'read-only', 'writer', or false`);
	},
	disabled: (value, field, fail) => {
		if (typeof value !== "boolean") fail(`'${field}' must be a boolean`);
	},
	toolBudget: (value, field, fail) => {
		if (value === false) return;
		if (!isPlainObject(value)) fail(`'${field}' must be an object or false`);
	},
	// 上游只判 `typeof === "string"`，`""` 合法（本模块同样放行）
	systemPrompt: (value, field, fail) => {
		if (typeof value !== "string") fail(`'${field}' must be a string`);
	},
	// validateOptionalMachine：非空串或 false；≤128 字符；无控制字符
	machine: (value, field, fail) => {
		if (value === undefined || value === false) return;
		if (typeof value !== "string" || !value.trim()) {
			fail(`'${field}' must be a non-empty string or false`);
			return;
		}
		const machine = value.trim();
		if (machine.length > 128) {
			fail(`'${field}' must be 128 characters or fewer`);
			return;
		}
		if (CONTROL_CHARS.test(machine)) fail(`'${field}' contains control characters`);
	},
	defaultProvider: (value, field, fail) => {
		if (value === false) return;
		if (typeof value !== "string" || !value.trim()) fail(`'${field}' must be a non-empty string or false`);
	},
	// parseToolsOverride：`"inherit"` / 字符串数组 / false
	tools: (value, field, fail) => {
		if (value === undefined || value === false) return;
		if (typeof value === "string" && value.trim() === "inherit") return;
		if (!Array.isArray(value)) {
			fail(`'${field}' must be an array of strings, "inherit", or false`);
			return;
		}
		for (const item of value) {
			if (typeof item !== "string") {
				fail(`'${field}' must contain only strings`);
				return;
			}
		}
	},
	allowNestedSubagents: (value, field, fail) => {
		if (typeof value !== "boolean") fail(`'${field}' must be a boolean`);
	},
	defaultReads: stringArrayOrFalse,
	skills: stringArrayOrFalse,
	excludeTools: stringArrayOrFalse,
	allowedAgents: stringArrayOrFalse,
	extensions: stringArrayOrFalse,
	subagentOnlyExtensions: stringArrayOrFalse,
	mutationTools: stringArrayOrFalse,
};

/**
 * 逐字段收集问题（校验器的**唯一**实现）。
 *
 * 两类结果不同：
 * - `rejects`（已知字段的非法值、`null`、`fallbackModels`）：上游 `parseBuiltinOverrideEntry` 抛错，
 *   会让本项目**所有** agent 的 discovery 失败
 * - `warns`（未知 key）：上游静默丢弃它
 */
export function overrideIssues(name: string, value: unknown): OverrideIssue[] {
	if (!isPlainObject(value)) {
		return [{ field: "", kind: "rejects", message: `Override '${name}' must be a JSON object` }];
	}
	const issues: OverrideIssue[] = [];
	// 上游对 fallbackModels 是无条件抛错（"removed field"）
	if (Object.hasOwn(value, "fallbackModels")) {
		issues.push({
			field: "fallbackModels",
			kind: "rejects",
			message: `Override '${name}' uses removed field 'fallbackModels'; configure one model instead`,
		});
	}

	const knownCount = Object.keys(value).filter((k) => KNOWN_FIELD_SET.has(k)).length;

	for (const [field, raw] of Object.entries(value)) {
		if (raw === undefined) continue; // 不会来自 JSON.parse，留作防御
		const checker = CHECKERS[field];
		if (!checker) {
			// 未知 key ⇒ ⚠️ 警告（上游静默丢弃），与 §6.6 的「未知 → 警告」一致。
			// 未知 key 的 `null` 也走这条路：上游根本不读它，不会抛错。
			if (field === "fallbackModels") continue; // 上面已按 rejects 报过
			issues.push({ field, kind: "warns", message: unknownFieldMessage(name, field, knownCount) });
			continue;
		}
		if (raw === null) {
			// 上游对**已知字段**走 `typeof` 判定，null 一律落到 else 分支抛错
			issues.push({ field, kind: "rejects", message: `Override '${name}' field '${field}' must not be null` });
			continue;
		}
		checker(raw, field, (msg) => issues.push({ field, kind: "rejects", message: `Override '${name}': ${msg}` }));
	}
	return issues;
}

/**
 * 校验一条 override 条目（`agentOverrides.<name>` 的值）。
 *
 * 拒绝项会让整个项目 discovery 抛错，所以措辞按上游口径；未知 key 只警告
 * （上游静默丢弃它；但条目**唯一**的键未知时整条会消失，必须写进警告文案）。
 */
export function validateOverrideEntry(name: string, value: unknown): ValidationResult {
	const issues = overrideIssues(name, value);
	return {
		errors: issues.filter((i) => i.kind === "rejects").map((i) => i.message),
		warnings: issues.filter((i) => i.kind === "warns").map((i) => i.message),
	};
}

/** 未知 key 的警告文案（条目唯一的键未知时，上游会把整条丢掉，必须点明）。 */
function unknownFieldMessage(name: string, field: string, knownCount: number): string {
	return (
		`Unknown field '${field}' in '${name}' will be silently dropped upstream (kept in the file as you typed it)` +
		(knownCount === 0 ? "; it is the only key, so the whole entry will disappear upstream" : "")
	);
}

/**
 * 校验整份 `agentOverrides` 映射（profile 与 settings 共用）。
 * 顶层非对象也拒绝——上游 profile 加载器对此抛错。
 */
export function validateAgentOverrides(value: unknown, label = "agentOverrides"): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!isPlainObject(value)) {
		return { errors: [`'${label}' must be a JSON object`], warnings };
	}
	for (const [name, entry] of Object.entries(value)) {
		const result = validateOverrideEntry(name, entry);
		errors.push(...result.errors);
		warnings.push(...result.warnings);
	}
	return { errors, warnings };
}

/**
 * profile 额外的两条上游加载器约束（`profiles.js:38-68`，模块私有、不可调用，故在此复刻）：
 * - `model` **必须是 string**（`model: false` 在 profile 侧抛错，项目 settings 侧却允许）
 * - 条目必须是非数组对象
 */
export function validateProfileAgentOverrides(value: unknown): ValidationResult {
	const base = validateAgentOverrides(value);
	const errors = [...base.errors];
	const warnings = [...base.warnings];
	if (isPlainObject(value)) {
		for (const [name, entry] of Object.entries(value)) {
			if (isPlainObject(entry) && entry.model !== undefined && typeof entry.model !== "string") {
				errors.push(`Profile override '${name}' has invalid model; expected a string`);
			}
		}
	}
	return { errors, warnings };
}

/** 官方 `SAFE_PATH_TOKEN`（`profiles.js:20`）+ `normalizeProfileName` 剥 `.json`。 */
export function normalizeProfileName(raw: string): string {
	return raw.trim().endsWith(".json") ? raw.trim().slice(0, -5) : raw.trim();
}

export function isSafeProfileName(name: string): boolean {
	if (!name) return false;
	if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) return false;
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}
