import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { TodoParams, type TodoParamsType } from "../src/schema.ts";

function check(value: unknown): boolean {
	return Value.Check(TodoParams, value);
}

describe("TodoParams 参数校验", () => {
	it("action 枚举：合法值通过，非法值拒绝", () => {
		for (const action of ["create", "update", "list", "get", "delete", "clear"]) {
			expect(check({ action })).toBe(true);
		}
		expect(check({ action: "bogus" })).toBe(false);
		expect(check({})).toBe(false);
		expect(check({ action: 42 })).toBe(false);
	});

	it("create 缺 subject：schema 层可通过（运行时校验），subject 类型必须 string", () => {
		expect(check({ action: "create" })).toBe(true); // subject 为可选字段
		expect(check({ action: "create", subject: 123 })).toBe(false);
		expect(check({ action: "create", subject: "write tests" })).toBe(true);
	});

	it("update 缺 id：schema 层可通过（运行时校验），id 类型必须 number", () => {
		expect(check({ action: "update" })).toBe(true);
		expect(check({ action: "update", id: 3 })).toBe(true);
		expect(check({ action: "update", id: "3" })).toBe(false);
	});

	it("status 枚举只接受 pending/in_progress/completed（无 deleted）", () => {
		expect(check({ action: "update", id: 1, status: "completed" })).toBe(true);
		expect(check({ action: "update", id: 1, status: "deleted" })).toBe(false); // tombstone 不暴露
		expect(check({ action: "update", id: 1, status: "chores" })).toBe(false);
	});

	it("activeForm / description 为字符串", () => {
		expect(check({ action: "update", id: 1, activeForm: "writing tests" })).toBe(true);
		expect(check({ action: "update", id: 1, activeForm: 5 })).toBe(false);
		expect(check({ action: "create", subject: "a", description: "long" })).toBe(true);
		expect(check({ action: "create", subject: "a", description: ["x"] })).toBe(false);
	});

	it("未知额外字段被拒绝", () => {
		expect(check({ action: "list", extra: 1 })).toBe(false);
	});

	it("Static 类型推断出字面量联合（编译期即可验证）", () => {
		const params: TodoParamsType = { action: "update", id: 1, status: "in_progress" };
		expect(params.action).toBe("update");
		// @ts-expect-error action 为字面量联合，非法值在类型层即报错
		const bad: TodoParamsType = { action: "nope" };
		void bad;
	});
});