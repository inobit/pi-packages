/**
 * @inobit/pi-instabox — 远端桌面工具 → pi 工具定义 + 转发（方案 §4.2 D2、§4.3、§4.8、§5.1、T14）。
 *
 * 契约：
 * - 一个远端 `tools/list` 条目 → 一个 pi 工具，名字固定 `instabox_desktop_<remote_name>`。
 *   名字必须稳定：远端换版本只换 schema、不换名字，codemode 脚本里写死的
 *   `instabox_desktop_click` 才不会失效。
 * - `label` 必填（R7）：`instabox desktop <remote_name>`。**口径以此为淮**：plan R7 写的是
 *   `instabox <remote_name>`，但桌面工具的 label 带 `desktop` 更明确（与工具名 `instabox_desktop_*`
 *   同口径），后续文档/T15 如有冲突一律按本文件文案。`description` 透传远端文案（远端缺省时
 *   给一句自解释的兜底，不让模型面对空描述）。
 * - `parameters` = `injectBoxParam(jsonSchemaToTypeBox(remote.inputSchema))`：`box` 只加在**顶层**
 *   `properties`、永不进 `required`。远端自带 `box`（或顶层不是 object schema）→ 不注入、
 *   只 `warn`（解析链退到 2–5 级，方案 §4.8 ④）。
 * - `exposure: "codemode"`（裁决 V2：本模块连 `ExtensionAPI` 都不碰，绝不 `setActiveTools`）；
 *   所有工具共享同一 `namespace`（`instabox-desktop`，别名 `instabox_desktop`），codemode 才会
 *   按组展示、`describeNamespace()` 才找得到它们。
 * - `execute`：取 `box` 参数 → 注入的 `resolve`（5 级解析链）→ `pool.get`（复用/唤醒/建连）→
 *   `client.callTool(remote_name, 其余参数, signal)`。结果**首行固定** `[box=<name>]`（第一个
 *   text content），远端 `content` 原样透传（含 image），`isError` 保留并追加一行修复建议。
 * - 失败一律转 `{ isError: true }` 结果，**绝不 throw**；`signal` 全程透传（abort 由 `pool` /
 *   `remote` 归一成错误文本，本模块不吞也不改写）。
 * - `box` 从转发参数里删掉：它是本层参数，不是远端工具的实参（`injectBoxParam` 没注入成功时
 *   也一样剥掉——`params.box` 的消费不依赖 schema 里有没有它）。
 * - `resolve` 的结果原样使用：`skippedConfig`（配置 `defaultBox` 写错）的每会话一次 warn 由 T15
 *   在闭包里负责，本模块不为它加回调。`ctx` 作为**第二个可选参数**透传给 `resolve`，让装配层
 *   能在每次调用时实时读会话分支（解析链第 2 级是「本轮最后一条 user 消息」，不能缓存）。
 * - 注入面：`resolve` / `pool` / `listBoxes` / `warn` 全部可替；单测不 spawn、不联网、不读盘。
 * - 埋点：每次 `execute` 记一条 `tool.call`（`tool` / `box` / `ok` / `ms` / `isError`），成功、失败、
 *   异常三条路径都经 `finally` 落账；`tool` 用远端名（与 `remote.call` 同一拼写），只记箱名与工具名，
 *   不记参数与结果内容。
 */

import type {
	AgentToolResult,
	ExtensionToolContext,
	ToolDefinition,
	ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import type { BoxInfo } from "./boxes.ts";
import { logEvent } from "./log.ts";
import type { Pool } from "./pool.ts";
import { type CallToolResult, type RemoteClient, type RemoteTool } from "./remote.ts";
import type { ResolveResult } from "./resolve.ts";
import { injectBoxParam, jsonSchemaToTypeBox } from "./schema.ts";

/** 工具名前缀：远端工具名原样拼在后面，不做大小写/分隔符变换（名字要可预测）。 */
export const DESKTOP_TOOL_PREFIX = "instabox_desktop_";

/** codemode 命名空间名（codemode 列表按组展示时用的键）。 */
export const DESKTOP_NAMESPACE_NAME = "instabox-desktop";

/** 命名空间别名：`describeNamespace()` / `searchTools({ namespace })` 用短名查找。 */
export const DESKTOP_NAMESPACE_ALIASES = ["instabox_desktop"] as const;

/** 每调用目标箱的参数名（顶层、可选；解析链第 1 级）。 */
export const BOX_PARAM = "box";

/** 命名空间摘要（按组展示一次）。 */
export const DESKTOP_NAMESPACE_DESCRIPTION =
	"instabox sandbox desktops (remote instabox-computer-use): screenshots, clicks, typing and app control on a box's X11 desktop. Every call targets exactly one box; pass box=… to choose it per call.";

/** 命名空间用法说明（`describeNamespace()` 才返回，不进工具列表）。 */
export const DESKTOP_NAMESPACE_INSTRUCTIONS = [
	"Each tool takes an optional `box` parameter; omit it to use the session target box (set with /instabox-use <box>). An unknown box name is an error — the extension never falls back to a different box silently.",
	"The first line of every result is [box=<name>]: it states which box actually ran the call, so check it whenever more than one box is in play.",
	'Desktop screenshots are expensive. For browser work prefer the DevTools server when one is configured: discover it with describeNamespace("mcp__instabox_devtools") or searchTools("devtools") and only use desktop clicks/screenshots when DevTools cannot do the job.',
].join("\n");

/** `isError` 结果追加的一行：说清「没有自动重试、也没有换箱」，给出两条可执行补救。 */
const IS_ERROR_REMEDY =
	'instabox: the remote tool reported an error (shown above unchanged). Nothing was retried and no other box was used — pass box="<name>" to target a different box, or run /instabox-status to review targets.';

/** 候选箱名的行前缀（与 `resolve.ts` 的失败文案同一口径，用于去重判断）。 */
const CANDIDATES_PREFIX = "available boxes: ";

/**
 * `injectBoxParam` 没给 warning 时的兜底文案。
 *
 * `injectBoxParam` 目前**总**会在 `injected === false` 时带上 `warning`（两种降级各有文案），所以
 * 这条正常路径走不到；保留是因为该字段在类型上是可选的，真走到这里说明调用点漏传文案，日志里
 * 也不该冒出 `undefined`。
 */
const NOT_INJECTED_FALLBACK =
	"the remote inputSchema could not take the instabox `box` parameter, so per-call box targeting is unavailable for this tool";

/** 工具结果的内容数组类型（`TextContent | ImageContent`，不额外 import `pi-ai`）。 */
type ToolContent = AgentToolResult["content"];

/** 本模块的注入面：宿主运行时只以类型出现（`import type`，编译后擦除）。 */
export interface BuildToolDefinitionsInput {
	/** 当前目标箱模板里的远端工具（per-box，来自 `template.ts` 的缓存/拉取结果） */
	remoteTools: readonly RemoteTool[];
	/** per-box 客户端池（复用 / 唤醒 / 建连都在池里，本模块只调 `get`） */
	pool: Pool;
	/**
	 * 解析链闭包（T15 里包 `resolveBox` + `ls` + 会话目标 + 配置）；**失败不 throw，回结果**。
	 * 第二个参数是本次调用的 `ExtensionToolContext`，装配层据此**实时**读会话分支；
	 * 只取 `paramBox` 的单参实现仍然合法（可选参数，向后兼容）。
	 */
	resolve: (paramBox?: string, ctx?: ExtensionToolContext) => Promise<ResolveResult>;
	/** 当前可用箱（解析失败且 `message` 未带候选时，用它在错误文本里补一行候选） */
	listBoxes: () => Promise<{ boxes: BoxInfo[] }>;
	/** 降级/冲突出口（远端 schema 放不下 `box` 时各报一次） */
	warn?: (message: string) => void;
}

/** 远端工具名 → pi 工具名（稳定、可预测）。 */
export function desktopToolName(remoteName: string): string {
	return `${DESKTOP_TOOL_PREFIX}${remoteName}`;
}

/** 远端工具名 → `label`（R7：必填，带前缀，单测断言唯一）；文案口径见文件头。 */
export function desktopToolLabel(remoteName: string): string {
	return `instabox desktop ${remoteName}`;
}

/**
 * 把当前箱的远端工具定义成 pi 工具（每个 `tools/list` 条目一个）。
 *
 * 纯构造：不读配置、不连远端、不注册；`remoteTools` 为空时返回 `[]`（无 CLI/无缓存即零工具）。
 */
export function buildToolDefinitions(input: BuildToolDefinitionsInput): ToolDefinition[] {
	const namespace: ToolNamespace = {
		name: DESKTOP_NAMESPACE_NAME,
		aliases: DESKTOP_NAMESPACE_ALIASES,
		description: DESKTOP_NAMESPACE_DESCRIPTION,
		instructions: DESKTOP_NAMESPACE_INSTRUCTIONS,
	};
	const definitions: ToolDefinition[] = [];
	const seen = new Set<string>();
	for (const remote of input.remoteTools) {
		// 同名远端工具 → 只保留第一个并 warn 一次：`registerTool` 同名是静默替换，留两份会让模型
		// 看到重复声明，而实际只有后注册的那份生效（描述/schema 到底哪份对，肉眼看不出来）。
		if (seen.has(remote.name)) {
			input.warn?.(
				`instabox desktop tool "${remote.name}" appears more than once in the remote tools/list; only the first definition is kept`,
			);
			continue;
		}
		seen.add(remote.name);
		definitions.push(buildToolDefinition(input, remote, namespace));
	}
	return definitions;
}

function buildToolDefinition(
	input: BuildToolDefinitionsInput,
	remote: RemoteTool,
	namespace: ToolNamespace,
): ToolDefinition {
	const { schema, injected, warning } = injectBoxParam(jsonSchemaToTypeBox(remote.inputSchema));
	if (!injected) input.warn?.(`instabox desktop tool "${remote.name}": ${warning ?? NOT_INJECTED_FALLBACK}`);
	return {
		name: desktopToolName(remote.name),
		label: desktopToolLabel(remote.name),
		description: descriptionOf(remote),
		parameters: schema,
		exposure: "codemode",
		namespace,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const startedAt = Date.now();
			// 埋点面：`box` 在解析成功后才知；`ok` = 远端正常回了结果，`isError` = 返回给宿主的错误标记
			let box: string | undefined;
			let ok = false;
			let isError = true;
			try {
				const boxParam = boxParamOf(params);
				let resolution: ResolveResult;
				try {
					// `ctx` 透传给解析链：每次调用都要实时读分支（解析链第 2 级不能缓存）
					resolution = await input.resolve(boxParam, ctx);
				} catch (error) {
					return errorResult(`instabox: box resolution failed: ${messageOf(error)}`);
				}
				if (!resolution.ok) return errorResult(await failureText(resolution, input.listBoxes));
				box = resolution.box;

				let client: RemoteClient;
				try {
					const got = await input.pool.get(box, {
						signal,
						onProgress: (message) => onUpdate?.({ content: [textItem(message)], details: undefined }),
					});
					if (!got.ok) return errorResult(`instabox: cannot use box "${box}": ${got.error}`);
					client = got.client;
				} catch (error) {
					return errorResult(`instabox: cannot use box "${box}": ${messageOf(error)}`);
				}

				let called: CallToolResult;
				try {
					called = await client.callTool(remote.name, forwardArgs(params), signal);
				} catch (error) {
					return errorResult(`instabox: ${remote.name} on box "${box}" failed: ${messageOf(error)}`);
				}

				const content: ToolContent = [textItem(`[box=${box}]`), ...remoteContent(called.content)];
				if (called.isError === true) {
					content.push(textItem(IS_ERROR_REMEDY));
					return { content, details: undefined, isError: true };
				}
				ok = true;
				isError = false;
				return { content, details: undefined };
			} finally {
				// 三条路径（成功 / 远端报错或本层失败 / 抛错）都在这里收口，埋点本身绝不外抛。
				// `tool` 用远端名（与 `remote.call` 同一拼写，便于跨层对账）；pi 工具名只多一层前缀。
				logEvent("tool.call", {
					tool: remote.name,
					box,
					ok,
					ms: Date.now() - startedAt,
					isError,
				});
			}
		},
	};
}

/** 远端描述透传；远端没给（或只有空白）时给一句自解释的兜底，避免模型面对空描述。 */
function descriptionOf(remote: RemoteTool): string {
	const description = remote.description?.trim() ?? "";
	if (description !== "") return description;
	return `instabox desktop tool "${remote.name}" (the remote tools/list entry has no description)`;
}

/**
 * 事件流上的 `params` 形状由 schema 校验保证，但校验层之外（如直接调用 `execute`）什么都可能传进来，
 * 所以这里一律按 `unknown` 读：读不到就是「没传 `box`」，落到解析链第 2 级。
 */
function boxParamOf(params: unknown): string | undefined {
	if (!isRecord(params)) return undefined;
	const value = params[BOX_PARAM];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** 转发给远端的实参：去掉本层的 `box`（远端工具不需要它，留着会被 schema 拒绝）。 */
function forwardArgs(params: unknown): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	if (!isRecord(params)) return args;
	for (const [key, value] of Object.entries(params)) {
		if (key !== BOX_PARAM) args[key] = value;
	}
	return args;
}

/**
 * 远端 MCP `content` 原样透传：MCP 的 text/image 项与 pi 的 `TextContent`/`ImageContent` 同形
 * （`{type:"text",text}` / `{type:"image",data,mimeType}`），本层不重排、不截断、不裁剪——
 * 能否渲染由宿主决定，替远端决定会静默丢结果。
 *
 * 断言里也包含非 text/image block（`resource`/`resource_link` 等）：它们原样透传，provider 侧
 * 若不支持该 block 类型，由上游（pi 的 provider 适配层）处理，本层不做转换。
 */
function remoteContent(raw: unknown): ToolContent {
	if (!Array.isArray(raw)) return [];
	return raw as ToolContent;
}

/**
 * 解析失败的可展示文本：`resolve` 的 `message` 已自带候选时原样用；否则从 `listBoxes` 补一行
 * 候选（`message + 候选`，不重复列同一批名字，也不把候选当默认值——解析失败不降级）。
 *
 * 三条出口都有用例覆盖：无候选（只留 message）、`message` 已含候选（不重复）、需补候选。
 */
async function failureText(
	failure: { message: string; candidates: string[] },
	listBoxes: () => Promise<{ boxes: BoxInfo[] }>,
): Promise<string> {
	const candidates = await candidatesFor(failure.candidates, listBoxes);
	if (candidates.length === 0) return failure.message;
	const line = `${CANDIDATES_PREFIX}${candidates.join(", ")}`;
	return failure.message.includes(line) ? failure.message : `${failure.message}\n${line}`;
}

/** 候选来源：解析结果优先；为空（或只有空名）时才去问 `listBoxes`，失败就当没有候选。 */
async function candidatesFor(
	candidates: readonly string[],
	listBoxes: () => Promise<{ boxes: BoxInfo[] }>,
): Promise<string[]> {
	const fromResult = uniqueNames(candidates);
	if (fromResult.length > 0) return fromResult;
	try {
		const listed = await listBoxes();
		return uniqueNames(listed.boxes.map((box) => box.name));
	} catch {
		return [];
	}
}

/** 去重并丢掉空名（保持传入顺序）。 */
function uniqueNames(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const name of names) {
		if (name === "" || seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

/** 失败结果：单条 text、无 details、`isError: true`（plan §4.7 ⑦：绝不 throw 到会话层）。 */
function errorResult(text: string): AgentToolResult {
	return { content: [textItem(text)], details: undefined, isError: true };
}

/** text content 项（不用字符串字面量对象，避免漏掉 `type` 的收窄）。 */
function textItem(text: string): ToolContent[number] {
	return { type: "text", text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
