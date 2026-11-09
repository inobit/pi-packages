/**
 * @inobit/pi-instabox — 远端 `inputSchema` → TypeBox，并注入 `box` 目标参数（方案 §4.8 D8）。
 *
 * 保守子集转换：认识的形态用 `Type.*` 顶层工厂重建（模型看到的是可读 schema）；
 * 其余（`$ref`/`allOf`/`not`/未知 `format`/白名单外的关键字/超深递归）把该节点**整体**交给
 * `Type.Unsafe(raw)`——pi 的工具参数按 JSON Schema 校验，原样透传仍然可校验，只是不美化。
 * 只用 `Type.*` 顶层工厂（typebox 1.3.x 稳定面），不用 `typebox/compile`、`typebox/value`。
 *
 * 两条方案未覆盖处的选择：
 * - 非法输入（`null`/数组/标量）→ `Type.Any()`：没有可保留的 raw，用 typebox 原生的「任意值」，
 *   不用 `Type.Unsafe({})`（那会假装存在一份 raw schema）。
 * - `injectBoxParam` 只认顶层像 object 的 schema（`type: "object"` 或带 `properties`）；否则
 *   不注入、只回 warning —— 与「远端自带 `box`」走同一降级（解析链退到 2–5 级），
 *   绝不改动远端 schema 的形状（凭空挂一个参数名会让调用语义变味）。
 */

import {
	Type,
	type TArrayOptions,
	type TNumberOptions,
	type TObjectOptions,
	type TSchema,
	type TSchemaOptions,
	type TStringOptions,
} from "typebox";

type JsonRecord = Record<string, unknown>;

/**
 * 递归深度上限（层数，不是最大下标）：`depth` 为 0-based 层号，`depth >= MAX_SCHEMA_DEPTH`
 * 的节点整体交给 `Type.Unsafe` —— 至多 `MAX_SCHEMA_DEPTH` 层（depth `0..MAX_SCHEMA_DEPTH-1`）
 * 被转换（方案 §4.8 ③）。
 */
export const MAX_SCHEMA_DEPTH = 8;

/** 注入的 `box` 参数文案：一次调用指定目标箱，缺省走会话目标，失败不静默换箱。 */
export const BOX_PARAM_DESCRIPTION =
	"Target instabox box for this call. Omit to use the session's target box. A failure is reported; it never falls back to another box silently.";

/** 远端 schema 已自带 `box` → 不注入（方案 §4.8 ④：解析链退到 2–5 级，由调用方记一次 warning）。 */
const BOX_CONFLICT_WARNING =
	"remote inputSchema already declares a `box` property, so the instabox `box` parameter was not injected; per-call box targeting is unavailable for this tool";

/** 顶层不是 object schema → `box` 无处安放，同一降级。 */
const NON_OBJECT_SCHEMA_WARNING =
	"remote inputSchema is not an object schema, so the instabox `box` parameter was not injected; per-call box targeting is unavailable for this tool";

/** 每个 kind 允许出现且会被转换的关键字；白名单外的键 → 整节点回落，不静默丢校验语义。 */
const KEYWORDS_BY_KIND = {
	object: ["type", "properties", "required", "additionalProperties"],
	array: ["type", "items", "minItems", "maxItems"],
	string: ["type", "format", "minLength", "maxLength", "pattern"],
	number: ["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
	integer: ["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
	boolean: ["type"],
	null: ["type"],
	enum: ["type", "enum"],
	union: ["anyOf", "oneOf"],
	any: [],
} as const;

type Kind = keyof typeof KEYWORDS_BY_KIND;

/** 任何 kind 都允许的键：注释类关键字（透传给模型）+ OpenAPI 的 `nullable`（转成 `Union([T, Null])`）。 */
const SHARED_KEYS: readonly string[] = [
	"title",
	"description",
	"default",
	"examples",
	"readOnly",
	"writeOnly",
	"nullable",
];

/** 标准 `format` 白名单（JSON Schema 标准集）；白名单外一律回落（方案 §4.8 ②）。 */
const STANDARD_FORMATS: ReadonlySet<string> = new Set([
	"date-time",
	"date",
	"time",
	"duration",
	"email",
	"idn-email",
	"hostname",
	"idn-hostname",
	"ipv4",
	"ipv6",
	"uri",
	"uri-reference",
	"uri-template",
	"iri",
	"iri-reference",
	"uuid",
	"json-pointer",
	"relative-json-pointer",
	"regex",
]);

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `TSchema` 是 typebox 的空接口（运行时就是 JSON Schema 对象）；读/改顶层关键字前转成键值视图。 */
function jsonView(schema: TSchema): JsonRecord {
	return schema as JsonRecord;
}

/** 键序稳定（方案 §4.8 ⑤）：按名字码位序重排，输出与远端 key 顺序无关。 */
function sortByKey<T>(source: Record<string, T>): Record<string, T> {
	return Object.fromEntries(
		Object.entries(source).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	);
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

/** 注释类关键字按固定顺序重建，保证键序稳定。 */
function annotationsOf(node: JsonRecord): TSchemaOptions {
	const options: TSchemaOptions = {};
	const title = node["title"];
	if (typeof title === "string") options.title = title;
	const description = node["description"];
	if (typeof description === "string") options.description = description;
	const defaultValue = node["default"];
	if (defaultValue !== undefined) options.default = defaultValue;
	const examples = node["examples"];
	if (Array.isArray(examples)) options.examples = examples;
	if (node["readOnly"] === true) options.readOnly = true;
	if (node["writeOnly"] === true) options.writeOnly = true;
	return options;
}

/** 整节点回落：原样透传给 pi 的 JSON Schema 校验器（方案 §4.8 ②）。 */
function unsafeCopy(node: JsonRecord): TSchema {
	return Type.Unsafe<Record<string, unknown>>(node);
}

/** 标量 → `Type.Literal`／`Type.Null`；对象、数组、大整数等用 `Literal` 表达不了。 */
function scalarVariant(value: unknown, options: TSchemaOptions): TSchema | undefined {
	if (value === null) return Type.Null(options);
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return Type.Literal(value, options);
	}
	return undefined;
}

function resolveKind(node: JsonRecord): Kind | undefined {
	if (Array.isArray(node["enum"])) return "enum";
	const anyOf = node["anyOf"];
	const oneOf = node["oneOf"];
	if (anyOf !== undefined || oneOf !== undefined) {
		// 两种分支语义不同（`oneOf` 要求恰好命中一个），同时出现无法用一个 `Union` 表达
		return anyOf !== undefined && oneOf !== undefined ? undefined : "union";
	}
	const type = node["type"];
	if (
		type === "object" ||
		type === "array" ||
		type === "string" ||
		type === "number" ||
		type === "integer" ||
		type === "boolean" ||
		type === "null"
	) {
		return type;
	}
	// 数组型 `type`（`["string", "null"]`）与未知/非字符串 `type` 都不在子集里
	if (type !== undefined) return undefined;
	if (isRecord(node["properties"])) return "object";
	if (node["items"] !== undefined) return "array";
	return "any";
}

function hasOnlySupportedKeywords(node: JsonRecord, kind: Kind): boolean {
	const allowed = new Set<string>([...SHARED_KEYS, ...KEYWORDS_BY_KIND[kind]]);
	return Object.keys(node).every((key) => allowed.has(key));
}

function readRequired(node: JsonRecord): readonly string[] | undefined {
	const required = node["required"];
	if (required === undefined) return [];
	if (Array.isArray(required) && required.every((name): name is string => typeof name === "string")) {
		return required;
	}
	return undefined;
}

function buildObject(node: JsonRecord, depth: number): TSchema {
	const required = readRequired(node);
	if (required === undefined) return unsafeCopy(node);
	const requiredNames = new Set(required);
	const rawProperties = node["properties"];
	// `required` 由 properties 的 `~optional` 标记派生，所以可选性在这里落；
	// 用 `Object.fromEntries` 而不是逐键赋值，属性名不经过 `__proto__` 之类的 setter。
	const converted: [string, TSchema][] = [];
	if (rawProperties !== undefined) {
		if (!isRecord(rawProperties)) return unsafeCopy(node);
		for (const [name, property] of Object.entries(sortByKey(rawProperties))) {
			const schema = toTypeBox(property, depth + 1);
			converted.push([name, requiredNames.has(name) ? schema : Type.Optional(schema)]);
		}
	}
	// `required` 指向一个没有 properties 条目的名字：`Type.Optional` 表达不了，整节点回落
	if ([...requiredNames].some((name) => !converted.some(([key]) => key === name))) return unsafeCopy(node);
	const properties = Object.fromEntries(converted);
	const options: TObjectOptions = { ...annotationsOf(node) };
	const additional = node["additionalProperties"];
	if (additional === false || additional === true) options.additionalProperties = additional;
	else if (isRecord(additional)) options.additionalProperties = toTypeBox(additional, depth + 1);
	else if (additional !== undefined) return unsafeCopy(node);
	return Type.Object(properties, options);
}

function buildArray(node: JsonRecord, depth: number): TSchema {
	const items = node["items"];
	let element: TSchema;
	if (items === undefined) element = Type.Any();
	else if (isRecord(items)) element = toTypeBox(items, depth + 1);
	else return unsafeCopy(node); // 元组型 `items: [...]` 不在子集里
	const options: TArrayOptions = { ...annotationsOf(node) };
	const minItems = numberOrUndefined(node["minItems"]);
	if (minItems !== undefined) options.minItems = minItems;
	const maxItems = numberOrUndefined(node["maxItems"]);
	if (maxItems !== undefined) options.maxItems = maxItems;
	return Type.Array(element, options);
}

function buildString(node: JsonRecord): TSchema {
	const options: TStringOptions = { ...annotationsOf(node) };
	const format = node["format"];
	if (typeof format === "string") {
		if (!STANDARD_FORMATS.has(format)) return unsafeCopy(node);
		options.format = format;
	}
	const minLength = numberOrUndefined(node["minLength"]);
	if (minLength !== undefined) options.minLength = minLength;
	const maxLength = numberOrUndefined(node["maxLength"]);
	if (maxLength !== undefined) options.maxLength = maxLength;
	const pattern = node["pattern"];
	if (typeof pattern === "string") options.pattern = pattern;
	return Type.String(options);
}

function numericOptions(node: JsonRecord): TNumberOptions {
	const options: TNumberOptions = { ...annotationsOf(node) };
	const minimum = numberOrUndefined(node["minimum"]);
	if (minimum !== undefined) options.minimum = minimum;
	const maximum = numberOrUndefined(node["maximum"]);
	if (maximum !== undefined) options.maximum = maximum;
	const exclusiveMinimum = numberOrUndefined(node["exclusiveMinimum"]);
	if (exclusiveMinimum !== undefined) options.exclusiveMinimum = exclusiveMinimum;
	const exclusiveMaximum = numberOrUndefined(node["exclusiveMaximum"]);
	if (exclusiveMaximum !== undefined) options.exclusiveMaximum = exclusiveMaximum;
	const multipleOf = numberOrUndefined(node["multipleOf"]);
	if (multipleOf !== undefined) options.multipleOf = multipleOf;
	return options;
}

function buildEnum(node: JsonRecord): TSchema {
	const values = node["enum"];
	if (!Array.isArray(values) || values.length === 0) return unsafeCopy(node);
	const options = annotationsOf(node);
	// 单值 `enum` → `Type.Literal`（注释挂在该节点上）；多值 → `Union`（注释挂在 union 上）
	const single = values.length === 1;
	const variants: TSchema[] = [];
	for (const value of values) {
		const variant = scalarVariant(value, single ? options : {});
		if (variant === undefined) return unsafeCopy(node);
		variants.push(variant);
	}
	const [only] = variants;
	if (only !== undefined && variants.length === 1) return only;
	return Type.Union(variants, options);
}

function buildUnion(node: JsonRecord, depth: number): TSchema {
	const branches = node["anyOf"] ?? node["oneOf"];
	if (!Array.isArray(branches) || branches.length === 0) return unsafeCopy(node);
	const variants = branches.map((branch) => toTypeBox(branch, depth + 1));
	return Type.Union(variants, annotationsOf(node));
}

function buildBase(node: JsonRecord, kind: Kind, depth: number): TSchema {
	switch (kind) {
		case "object":
			return buildObject(node, depth);
		case "array":
			return buildArray(node, depth);
		case "string":
			return buildString(node);
		case "number":
			return Type.Number(numericOptions(node));
		case "integer":
			return Type.Integer(numericOptions(node));
		case "boolean":
			return Type.Boolean(annotationsOf(node));
		case "null":
			return Type.Null(annotationsOf(node));
		case "enum":
			return buildEnum(node);
		case "union":
			return buildUnion(node, depth);
		case "any":
			return Type.Any(annotationsOf(node));
	}
}

/** 一个 JSON Schema 节点 → TypeBox（`depth` 为当前递归深度，顶层为 0）。 */
function toTypeBox(node: unknown, depth: number): TSchema {
	if (!isRecord(node)) return Type.Any();
	// 深度上限只截断递归本身：该层整节点原样透传，校验语义不丢（方案 §4.8 ③）
	if (depth >= MAX_SCHEMA_DEPTH) return unsafeCopy(node);
	const kind = resolveKind(node);
	if (kind === undefined) return unsafeCopy(node);
	if (!hasOnlySupportedKeywords(node, kind)) return unsafeCopy(node);
	const base = buildBase(node, kind, depth);
	return node["nullable"] === true ? Type.Union([base, Type.Null()], annotationsOf(node)) : base;
}

/**
 * 远端 `inputSchema` → TypeBox。不 throw：非法输入 → `Type.Any()`，不支持的节点 → `Type.Unsafe(raw)`。
 *
 * `depth` 只给递归内部用；外部调用保持默认 0。
 */
export function jsonSchemaToTypeBox(schema: unknown, depth = 0): TSchema {
	return toTypeBox(schema, depth);
}

export interface InjectBoxParamOptions {
	/** 覆盖 `box` 参数文案（默认 `BOX_PARAM_DESCRIPTION`）。 */
	description?: string;
}

export interface InjectBoxParamResult {
	schema: TSchema;
	injected: boolean;
	warning?: string;
}

/**
 * 在**顶层 `properties`** 加一个可选 `box` 参数（方案 §4.8 ④）。
 *
 * - 只改顶层：返回值是替换了顶层 `properties` 的 JSON Schema 对象，其它顶层关键字
 *   （含 Unsafe 回落带过来的 `allOf` 等）原样保留。
 * - 返回值是**纯 JSON Schema 视图**（`{ ...node, properties }`）：对象展开只复制可枚举键，
 *   typebox 的 `~kind`/`~unsafe` 反射标记是非枚举属性，注入后不保留。pi 按 JSON Schema
 *   校验工具参数，运行时无影响；要判断某节点是否为 Unsafe 回落，用**注入前**的对象统计。
 * - 不进 `required`：`box` 是可选参数，缺省走会话目标。
 * - 远端已有 `box`（属性或 `required` 里的名字）→ 不注入、原样返回并给 warning。
 * - 顶层不是 object schema → 同样不注入、原样返回并给 warning。
 */
export function injectBoxParam(schema: TSchema, opts: InjectBoxParamOptions = {}): InjectBoxParamResult {
	const node = jsonView(schema);
	const rawProperties = node["properties"];
	if (node["type"] !== "object" && !isRecord(rawProperties)) {
		return { schema, injected: false, warning: NON_OBJECT_SCHEMA_WARNING };
	}
	const existing: JsonRecord = isRecord(rawProperties) ? rawProperties : {};
	const required = readRequired(node) ?? [];
	if ("box" in existing || required.includes("box")) {
		return { schema, injected: false, warning: BOX_CONFLICT_WARNING };
	}
	const description = opts.description ?? BOX_PARAM_DESCRIPTION;
	const properties = sortByKey({
		...existing,
		box: Type.Optional(Type.String({ description })),
	});
	return { schema: { ...node, properties }, injected: true };
}
