/**
 * @inobit/pi-instabox — `schema.ts` 单测：远端 `inputSchema` → TypeBox 的子集映射、
 * `box` 顶层注入，以及三类回落（方案 §4.8 D8 的验收点）。
 *
 * 覆盖：9 类子集形态、`$ref`/未知 `format`/`allOf`（+ 白名单外关键字）回落、
 * `box` 注入与两种冲突、`box` 只出现在顶层 `properties` 且不在 `required`、
 * 注入后不保留 typebox 反射标记（只能当 JSON Schema 用）、
 * 深度超限回落、输出键序稳定、非法输入不 throw。
 * 断言尽量打 JSON 文本（键序可见），结构比较用 `toEqual`。
 */

import { describe, expect, it } from "vitest";
import { Type, type TSchema } from "typebox";
import {
	BOX_PARAM_DESCRIPTION,
	MAX_SCHEMA_DEPTH,
	injectBoxParam,
	jsonSchemaToTypeBox,
} from "../src/schema.ts";

/** 只看 JSON 形态：TypeBox 的 `~kind`/`~unsafe` 标记是非枚举属性，不参与序列化。 */
function json(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/** 递归收集所有名为 `box` 的键路径，用来断言它只出现在顶层 `properties`。 */
function boxPaths(value: unknown, path = ""): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => boxPaths(item, `${path}[${index}]`));
	}
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
		const childPath = path === "" ? key : `${path}.${key}`;
		return key === "box" ? [childPath, ...boxPaths(child, childPath)] : boxPaths(child, childPath);
	});
}

/** 取已转换 object schema 的属性节点（返回值仍是 typebox 对象，反射标记可查）。 */
function propertyNode(schema: TSchema, name: string): TSchema {
	return (schema as unknown as { properties: Record<string, TSchema> }).properties[name] as TSchema;
}

/** 逐层套 `{type:"object", properties:{child: …}}`，用于深度上限测试。 */
function nestedObjects(levels: number): unknown {
	let schema: unknown = { type: "string" };
	for (let i = 0; i < levels; i += 1) schema = { type: "object", properties: { child: schema } };
	return schema;
}

describe("jsonSchemaToTypeBox — 子集形态", () => {
	it("object：properties/required/additionalProperties:false，可选属性不进 required", () => {
		const converted = jsonSchemaToTypeBox({
			type: "object",
			properties: {
				app_name: { type: "string", description: "Application to list" },
				limit: { type: "integer", minimum: 1 },
			},
			required: ["app_name"],
			additionalProperties: false,
		});
		expect(JSON.stringify(converted)).toBe(
			'{"type":"object","required":["app_name"],"properties":{"app_name":{"type":"string","description":"Application to list"},"limit":{"type":"integer","minimum":1}},"additionalProperties":false}',
		);
	});

	it("object：additionalProperties 为子 schema → 递归转换", () => {
		const converted = jsonSchemaToTypeBox({
			type: "object",
			properties: { app_name: { type: "string" } },
			additionalProperties: { type: "integer", minimum: 0 },
		});
		expect(JSON.stringify(converted)).toBe(
			'{"type":"object","properties":{"app_name":{"type":"string"}},"additionalProperties":{"type":"integer","minimum":0}}',
		);
		// 没有 properties 的对象同样保留子 schema 形态（不是 additionalProperties:true）
		expect(JSON.stringify(jsonSchemaToTypeBox({ type: "object", additionalProperties: { type: "string" } }))).toBe(
			'{"type":"object","properties":{},"additionalProperties":{"type":"string"}}',
		);
	});

	it("string：format + minLength/maxLength/pattern，description/default 透传", () => {
		const converted = jsonSchemaToTypeBox({
			type: "string",
			description: "ISO timestamp",
			default: "2026-01-01T00:00:00Z",
			format: "date-time",
			minLength: 1,
			maxLength: 32,
			pattern: "^\\d{4}-",
		});
		expect(JSON.stringify(converted)).toBe(
			'{"type":"string","description":"ISO timestamp","default":"2026-01-01T00:00:00Z","format":"date-time","minLength":1,"maxLength":32,"pattern":"^\\\\d{4}-"}',
		);
	});

	it("number/integer：minimum/maximum 保留", () => {
		expect(JSON.stringify(jsonSchemaToTypeBox({ type: "number", minimum: 0.5, maximum: 9 }))).toBe(
			'{"type":"number","minimum":0.5,"maximum":9}',
		);
		expect(JSON.stringify(jsonSchemaToTypeBox({ type: "integer", minimum: 0 }))).toBe(
			'{"type":"integer","minimum":0}',
		);
	});

	it("boolean：TYPE.Boolean", () => {
		expect(JSON.stringify(jsonSchemaToTypeBox({ type: "boolean" }))).toBe('{"type":"boolean"}');
	});

	it("array/items：minItems/maxItems，且 items 递归转换", () => {
		const converted = jsonSchemaToTypeBox({
			type: "array",
			items: { type: "string" },
			minItems: 1,
			maxItems: 3,
		});
		expect(JSON.stringify(converted)).toBe('{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":3}');
	});

	it("单值 enum → Type.Literal；多值 enum → Union(Literal…)", () => {
		expect(JSON.stringify(jsonSchemaToTypeBox({ type: "string", enum: ["only"] }))).toBe(
			'{"type":"string","const":"only"}',
		);
		expect(JSON.stringify(jsonSchemaToTypeBox({ enum: ["a", 1, true, null] }))).toBe(
			'{"anyOf":[{"type":"string","const":"a"},{"type":"number","const":1},{"type":"boolean","const":true},{"type":"null"}]}',
		);
	});

	it("anyOf / oneOf → Type.Union", () => {
		expect(JSON.stringify(jsonSchemaToTypeBox({ anyOf: [{ type: "string" }, { type: "number" }] }))).toBe(
			'{"anyOf":[{"type":"string"},{"type":"number"}]}',
		);
		expect(JSON.stringify(jsonSchemaToTypeBox({ oneOf: [{ type: "boolean" }] }))).toBe(
			'{"anyOf":[{"type":"boolean"}]}',
		);
	});

	it("null → Type.Null", () => {
		expect(JSON.stringify(jsonSchemaToTypeBox({ type: "null" }))).toBe('{"type":"null"}');
	});

	it("nullable:true → Union([T, Null])", () => {
		expect(JSON.stringify(jsonSchemaToTypeBox({ type: "string", nullable: true }))).toBe(
			'{"anyOf":[{"type":"string"},{"type":"null"}]}',
		);
		expect(JSON.stringify(jsonSchemaToTypeBox({ type: "integer", nullable: true }))).toBe(
			'{"anyOf":[{"type":"integer"},{"type":"null"}]}',
		);
	});
});

describe("jsonSchemaToTypeBox — 整节点回落 Unsafe", () => {
	it("$ref：原样透传", () => {
		const raw = { $ref: "#/$defs/AppName" };
		const converted = jsonSchemaToTypeBox(raw);
		expect(Type.IsUnsafe(converted)).toBe(true);
		expect(json(converted)).toEqual(raw);
	});

	it("非标准 format：原样透传（不用 Format.Set 之类的无效修饰）", () => {
		const raw = { type: "string", format: "instabox-bogus" };
		const converted = jsonSchemaToTypeBox(raw);
		expect(Type.IsUnsafe(converted)).toBe(true);
		expect(json(converted)).toEqual(raw);
	});

	it("allOf：原样透传", () => {
		const raw = { allOf: [{ type: "object", properties: { a: { type: "string" } } }, { required: ["a"] }] };
		const converted = jsonSchemaToTypeBox(raw);
		expect(Type.IsUnsafe(converted)).toBe(true);
		expect(json(converted)).toEqual(raw);
	});

	it("白名单外的关键字与表达不了的形态同样回落（不静默丢校验）", () => {
		const unsupported: unknown[] = [
			{ type: "object", patternProperties: { "^x": { type: "string" } } },
			{ type: "object", properties: { a: { type: "string" } }, required: ["b"] },
			{ type: "array", items: [{ type: "string" }] },
			{ type: ["string", "null"] },
			{ anyOf: [{ type: "string" }], oneOf: [{ type: "number" }] },
			{ type: "string", const: "fixed" },
		];
		for (const raw of unsupported) {
			const converted = jsonSchemaToTypeBox(raw);
			expect(Type.IsUnsafe(converted)).toBe(true);
			expect(json(converted)).toEqual(raw);
		}
	});

	it("required 不是字符串数组：整节点回落，不静默丢校验", () => {
		for (const required of ["app_name", 42, { 0: "app_name" }, [1]]) {
			const raw = { type: "object", properties: { app_name: { type: "string" } }, required };
			const converted = jsonSchemaToTypeBox(raw);
			expect(Type.IsUnsafe(converted)).toBe(true);
			expect(json(converted)).toEqual(raw);
		}
		// “整节点”就是出问题的那个节点：父 object 仍然是转换后的 schema
		const parent = jsonSchemaToTypeBox({
			type: "object",
			properties: { child: { type: "object", properties: { a: { type: "string" } }, required: "a" } },
		});
		expect(Type.IsUnsafe(parent)).toBe(false);
		expect(Type.IsUnsafe(propertyNode(parent, "child"))).toBe(true);
	});

	it("递归到 depth === MAX_SCHEMA_DEPTH 才回落 Unsafe（0-based：至多 MAX_SCHEMA_DEPTH 层被转换）", () => {
		const levels = MAX_SCHEMA_DEPTH + 2;
		let node: TSchema = jsonSchemaToTypeBox(nestedObjects(levels));
		for (let depth = 0; depth < MAX_SCHEMA_DEPTH; depth += 1) {
			expect(Type.IsUnsafe(node)).toBe(false);
			node = propertyNode(node, "child");
		}
		expect(Type.IsUnsafe(node)).toBe(true);
		// 回落层保留原样：这一层的 child 树没有被继续转换（键序仍是远端顺序）
		expect(json(node)).toEqual(nestedObjects(levels - MAX_SCHEMA_DEPTH));
	});

	it("非法输入 → Type.Any()，不 throw", () => {
		for (const input of [null, undefined, 42, "nope", [], [1, 2], true]) {
			const converted = jsonSchemaToTypeBox(input);
			expect(Type.IsUnsafe(converted)).toBe(false);
			expect(json(converted)).toEqual({});
		}
	});
});

describe("jsonSchemaToTypeBox — 键序稳定", () => {
	it("属性按名字排序后构造：与远端 key 顺序无关，required 也随之一致", () => {
		const first = jsonSchemaToTypeBox({
			type: "object",
			properties: { zeta: { type: "string" }, alpha: { type: "number" } },
			required: ["zeta", "alpha"],
		});
		const second = jsonSchemaToTypeBox({
			required: ["alpha", "zeta"],
			properties: { alpha: { type: "number" }, zeta: { type: "string" } },
			type: "object",
		});
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(JSON.stringify(first)).toBe(
			'{"type":"object","required":["alpha","zeta"],"properties":{"alpha":{"type":"number"},"zeta":{"type":"string"}}}',
		);
	});
});

describe("injectBoxParam — 注入", () => {
	const remote = {
		type: "object",
		properties: {
			app_name: { type: "string", description: "Application to list" },
			count: { type: "integer", minimum: 0 },
		},
		required: ["app_name"],
	};

	it("顶层 properties 加可选 box，不进 required", () => {
		const params = jsonSchemaToTypeBox(remote);
		const result = injectBoxParam(params);
		expect(result.injected).toBe(true);
		expect(result.warning).toBeUndefined();
		const injected = json(result.schema) as {
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(Object.keys(injected.properties)).toEqual(["app_name", "box", "count"]);
		expect(injected.required).toEqual(["app_name"]);
		expect(injected.properties["box"]).toEqual({ type: "string", description: BOX_PARAM_DESCRIPTION });
	});

	it("box 只出现在顶层 properties（嵌套 object 不会被加参数）", () => {
		const params = jsonSchemaToTypeBox({
			type: "object",
			properties: {
				opts: {
					type: "object",
					properties: { label: { type: "string" }, mode: { type: "string" } },
				},
			},
		});
		const result = injectBoxParam(params);
		expect(result.injected).toBe(true);
		expect(boxPaths(json(result.schema))).toEqual(["properties.box"]);
		expect(boxPaths(json(params))).toEqual([]);
	});

	it("Unsafe 回落过的顶层也能注入，其它顶层关键字原样保留", () => {
		const params = jsonSchemaToTypeBox({
			type: "object",
			allOf: [{ type: "object", properties: { a: { type: "string" } } }],
		});
		expect(Type.IsUnsafe(params)).toBe(true);
		const result = injectBoxParam(params);
		expect(result.injected).toBe(true);
		const injected = json(result.schema) as { allOf: unknown; properties: Record<string, unknown> };
		expect(injected.allOf).toEqual([{ type: "object", properties: { a: { type: "string" } } }]);
		expect(Object.keys(injected.properties)).toEqual(["box"]);
	});

	it("注入后是纯 JSON Schema 视图：typebox 反射标记（`~kind`/`~unsafe`）不保留", () => {
		const converted = jsonSchemaToTypeBox({ type: "object", properties: { a: { type: "string" } } });
		expect(Type.IsUnsafe(converted)).toBe(false);
		// 对象展开只复制可枚举键，`~kind`/`~unsafe` 是非枚举属性 → 注入后不再是 typebox 反射对象
		const injected = injectBoxParam(converted);
		expect(injected.injected).toBe(true);
		expect(Type.IsUnsafe(injected.schema)).toBe(false);
		expect(json(injected.schema)).toEqual({
			type: "object",
			properties: { a: { type: "string" }, box: { type: "string", description: BOX_PARAM_DESCRIPTION } },
		});
		// 原本 Unsafe 回落的顶层注入后同样不再被认成 Unsafe：Unsafe 统计只能用注入前的对象
		const unsafe = jsonSchemaToTypeBox({ type: "object", allOf: [{ type: "string" }] });
		expect(Type.IsUnsafe(unsafe)).toBe(true);
		expect(Type.IsUnsafe(injectBoxParam(unsafe).schema)).toBe(false);
	});

	it("自定义 description 覆盖默认文案", () => {
		const result = injectBoxParam(jsonSchemaToTypeBox({ type: "object", properties: {} }), {
			description: "box override",
		});
		expect(result.injected).toBe(true);
		const injected = json(result.schema) as { properties: Record<string, unknown> };
		expect(injected.properties["box"]).toEqual({ type: "string", description: "box override" });
	});
});

describe("injectBoxParam — 不注入（降级到 2–5 级解析链）", () => {
	it("远端已声明 box：原样返回 + warning", () => {
		const params = jsonSchemaToTypeBox({ type: "object", properties: { box: { type: "string" } } });
		const result = injectBoxParam(params);
		expect(result.injected).toBe(false);
		expect(result.warning).toMatch(/box/);
		expect(result.schema).toBe(params);
	});

	it("box 出现在 required 里：同样视为冲突", () => {
		const params = jsonSchemaToTypeBox({ type: "object", properties: {}, required: ["box"] });
		const result = injectBoxParam(params);
		expect(result.injected).toBe(false);
		expect(result.warning).toMatch(/box/);
		expect(result.schema).toBe(params);
	});

	it("顶层不是 object schema：不注入 + warning", () => {
		const params = jsonSchemaToTypeBox({ type: "string" });
		const result = injectBoxParam(params);
		expect(result.injected).toBe(false);
		expect(result.warning).toMatch(/object/);
		expect(result.schema).toBe(params);
	});

	it("非法输入（Type.Any）也没有可注入的 properties", () => {
		const result = injectBoxParam(jsonSchemaToTypeBox(null));
		expect(result.injected).toBe(false);
		expect(result.warning).toBeTypeOf("string");
	});
});
