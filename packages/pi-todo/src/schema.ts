/**
 * @inobit/pi-todo — TypeBox 参数 schema（6 核心参数）。
 *
 * 各参数 description 合计须 ≤ 270 chars（侵入性预算），完整预算见 todo.ts 顶部常量注释。
 * 用 StringEnum 保证 Google API 兼容（Type.Union/Type.Literal 不兼容）。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { PUBLIC_STATUSES } from "./state.ts";

export const ACTIONS = ["create", "update", "list", "get", "delete", "clear"] as const;

export const TodoParams = Type.Object({
	action: StringEnum([...ACTIONS], { description: "Action to perform" }),
	subject: Type.Optional(
		Type.String({ description: "Task title (imperative, short); required for create" }),
	),
	description: Type.Optional(Type.String({ description: "Task details (create/update)" })),
	status: Type.Optional(
		StringEnum([...PUBLIC_STATUSES], { description: "Target status (update) or filter (list)" }),
	),
	activeForm: Type.Optional(
		Type.String({ description: "Label while in progress, e.g. 'writing tests' (update)" }),
	),
	id: Type.Optional(Type.Number({ description: "Task id (required for update/get/delete)" })),
}, { additionalProperties: false });

export type TodoParamsType = Static<typeof TodoParams>;