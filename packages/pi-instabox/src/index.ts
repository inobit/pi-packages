/**
 * @inobit/pi-instabox — 扩展入口（装配层，方案 §4.2/§4.4/§4.5/§4.6、§5.1、T15）。
 *
 * 装配顺序：
 * 0. **加载期第一件事**：`loadConfig()` + `resolvePaths(getAgentDir())`，随即接上文件日志
 *    `<agentDir>/logs/pi-instabox/pi-instabox.jsonl`（渠道与级别见 {@link attachLogger}）。
 *    接线必须早于探测：否则 `cli.probe`（尤其失败/超时那条）会被丢掉，而它正是事后判断
 *    「扩展为什么自禁用」的第一手证据。
 * 1. 之后**加载期**只做一件事：`probeVersion`（`cli.ts` 默认 3000ms 预算），失败按原因分两种：
 *    - **明确没有 CLI**（`reason: "missing"` / 非 0 退出 / 无版本串）→ 只挂一条 `session_start`
 *      warning，不注册任何工具/命令/MCP、不写缓存与 helper、不 throw，也不重试。
 *      （这条「零注册」是方案 §7 验收 1 的硬要求；§6 的 T18 冒烟行只验证「无工具 / 无 MCP /
 *      一条 warning / 无残留文件」，它不以 `/instabox-status` 为前提。）
 *    - **被超时击杀**（`reason: "timeout"`，实测 `instabox version` 803–1178ms，pi 加载期并发下
 *      5 次里 2 次吃满预算）**不等于没有 CLI**：本次仍零注册，但等第一次 `session_start` 用
 *      {@link RETRY_PROBE_TIMEOUT_MS}（5000ms）重试一次——成功就当场走完整装配并在本会话补跑
 *      后台任务，仍失败才按「无 CLI」禁用。只重试一次（一次性状态机）。
 * 2. 有 CLI：建 `BoxLister` / `Pool` / `TemplateStore` 三个会话级单例（`cfg` / `paths` 已在第 0 步备好）；
 *    **模板缓存命中就立刻注册工具**（加载期绝不跑 `ls`、
 *    绝不连远端），未命中等到 `session_start` 的**后台**拉取。整段装配在 `assemble()` 里，
 *    加载期与「超时后重试成功」共用同一份逻辑。日志已在第 0 步接上，因此装配全程的埋点都落盘；
 *    装配失败 / 无 CLI 时**只**写日志，不建 `templates.json`、`bin/` 等运行期目录。
 * 3. 命令 `/instabox-use`（含冷启动唯一重试入口）、`/instabox-status`（诊断）与
 *    `/instabox-devtools`（`status` / `on [box]` / `off` / `reset`，动态开关远端 MCP）、目标 entry
 *    renderer、两个 CLI flag（`--instabox-devtools` / `--instabox-devtools-box`，必须在工厂最前面登记，
 *    否则 pi 会把它们当成未知选项直接 exit(1)）。
 *    **DevTools MCP 默认关闭**：只有 `--instabox-devtools`（或 `/instabox-devtools on`）能开启；
 *    box 的优先级是**会话绑定 > `--instabox-devtools-box` > `config.devToolsBox`**，会话绑定由
 *    `/instabox-devtools on <box>` 写成一条 entry（`reset` 写清除标记，不改开关、不注销）。
 *    加载期读不到命令行 flag 值，所以判定一律在 `session_start` 之后。
 * 4. `session_start`：**同步段只做内存赋值与通知 drain**（`sessionCtx` 赋值、清一次性提示键、
 *    drain 队列），随后把后台任务丢到一个宏任务之后再跑。后台先按 flag 处理 DevTools、再拉模板声明
 *    「成功即静默」，来源按
 *    「有缓存 → 会话目标 / `config.defaultBox` / 最近拉取」「无缓存 → 第一台 running，
 *    没有 running 才用列表第一台」选；**连接即唤醒**（后台同步也允许唤醒暂停的箱），
 *    只有**真的同步不了**才提示一次；成功后实时读 codemode 状态，三分支里至多提示一次。
 *    连「后台任务的同步前奏」都不放进事件处理器：`TemplateStore` / `readCache` 是同步磁盘读，
 *    放在 handler 帧里就等于阻塞会话启动（gate 型单测也测不出这一层，见 §4.4）。
 *    内部日志默认静音，只有 `PI_INSTABOX_DEBUG=1` 时才写（见 {@link debug}）。
 * 5. `session_tree`：只换掉本次事件的 ctx（不写 prompt、不注入上下文）；目标状态本就不缓存，
 *    见下一条。
 * 6. `session_shutdown`：`pool.disposeAll()` 收掉本实例持有的远端连接（否则换会话 / `/reload`
 *    之后会残留 ssh 子进程），并丢掉已失效的 ctx；随后 `setLogger(undefined)` 复位日志，
 *    不留进程内残留（下一个会话重新装配时再建）。
 *
 * 会话状态一律**实时读** `ctx.sessionManager.getBranch()`：解析链第 2 级是「本轮最后一条 user
 * 消息」，缓存它会让这一级永远读到会话开始时的快照而失效；因此每次工具调用都用工具自带的
 * `ExtensionToolContext`（`tools.ts` 新增的可选第二参数）重新取分支。
 *
 * 硬约束（裁决 V2）：**从不调用 `pi.setActiveTools`**，不改用户工具选择集；codemode 未激活
 * 时只说清补救命令。所有异常吞掉转 `notify` / 工具 `isError`，绝不 throw 到会话层。
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	SessionStartEvent,
	ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { type BoxInfo, createBoxLister } from "./boxes.ts";
import { type ExecFn, type ProbeVersionResult, probeVersion } from "./cli.ts";
import { getAgentDir, loadConfig, resolvePaths } from "./config.ts";
import { buildMcpServerConfig, ensureHelperScript } from "./devtools.ts";
import { createTargetRendererWithHostText } from "./entry-render.ts";
import { type LogLevel, type Logger, createFileLogger, logEvent, setLogger } from "./log.ts";
import { type Pool, createPool } from "./pool.ts";
import type { RemoteClient, RemoteTool } from "./remote.ts";
import { resolveBox, type ResolveResult } from "./resolve.ts";
import {
	DEVTOOLS_TARGET_ENTRY,
	TARGET_ENTRY,
	devtoolsTargetEntryData,
	readDevtoolsTarget,
	readTarget,
	targetEntryData,
} from "./session-target.ts";
import { createTemplateStore, nodeReadText, readCache } from "./template.ts";
import { buildToolDefinitions } from "./tools.ts";

/** 无 `instabox` CLI 时的唯一提示（每会话一条；方案 §7 验收 1）。 */
const NO_CLI_MESSAGE = "未找到 instabox CLI，instabox 扩展已禁用";

/** `ls` 里唯一算「健康」的状态：后台声明优先挑它（连它不需要唤醒）。 */
const RUNNING_STATE = "running";

/** 没有可用沙箱（`ls` 空或失败）：不可恢复，每会话至多一条。 */
const NO_BOX_MESSAGE =
	"instabox: 没有可用沙箱（instabox ls 返回空或失败），桌面工具未注册；请检查 instabox CLI 与沙箱状态";

/** codemode 工具的注册名（只读判定用，绝不用来 `setActiveTools`）。 */
const CODEMODE_TOOL = "codemode";

/** codemode 未激活（条目存在）时的补救提示（方案 §4.2 检测分支②，原文口径）。 */
const CODEMODE_INACTIVE_MESSAGE =
	'instabox 桌面工具需要 codemode 处于激活状态：pi --tools +codemode，或在 settings 里设 defaultTools: ["+codemode"]';

/** codemode 条目根本不存在时的提示（被 `--tools` 白名单 / 替换掉的内置扩展剔除，分支③）。 */
const CODEMODE_UNAVAILABLE_MESSAGE =
	"本会话没有 codemode 工具，instabox 桌面工具不可调用；请允许 codemode（--tools +codemode 或内置扩展）";

/** `/instabox-status` 里 codemode 状态的展示文案。 */
const CODEMODE_LABELS = {
	active: "active",
	inactive: "registered, not active",
	unavailable: "unavailable (no codemode tool in this session)",
} as const;

/** 开关 flag：**唯一**能开启远端 DevTools MCP 的入口（config 只补默认 box）。 */
const DEVTOOLS_FLAG = "instabox-devtools";

/** box flag：覆盖 `config.devToolsBox` 的默认箱名；空串＝没给。 */
const DEVTOOLS_BOX_FLAG = "instabox-devtools-box";

/** 只给了 box flag、没给开关：明说怎么开启，不静默启用（config 里的 box 同理）。 */
const DEVTOOLS_SWITCH_MISSING_MESSAGE = "instabox: 已指定 box 但未开启 devtools，请加 --instabox-devtools";

/** 开关开着但三个来源都没给箱名：不猜，直接不注册。 */
const DEVTOOLS_NO_BOX_MESSAGE =
	"instabox: 未指定 devtools box（--instabox-devtools-box 或 config.devToolsBox），DevTools MCP 未注册";

/** `reset` 的提示：entry 已清，注册与开关都没动，下一次 `on` 才会回退。 */
const DEVTOOLS_RESET_MESSAGE = "instabox: 已清除会话绑定的 devtools box，下次 on 将回退到 flag/config";

/** `/instabox-devtools` 的用法提示（未知子命令时才出现）。 */
const DEVTOOLS_USAGE = "用法：/instabox-devtools [status|on [box]|off|reset]";

/** 扩展内部排查日志前缀（H6：内部日志只作排查，不进验收）。 */
const LOG_PREFIX = "[pi-instabox]";

/** codemode 三态：已激活 / 有条目但未激活 / 本会话没有该条目。 */
type CodemodeState = keyof typeof CODEMODE_LABELS;

/**
 * DevTools box 的三个来源（优先级同序）：会话绑定 > `--instabox-devtools-box` > `config.devToolsBox`。
 */
type DevtoolsBoxSource = "session" | "flag" | "config";

/**
 * 一次 DevTools 注册的来源（`devtools.enabled` 与 `status` 回显）：
 * 启动路径取实际生效的 box 来源，`/instabox-devtools on` 路径一律 `command`。
 */
type DevtoolsRegistrationSource = DevtoolsBoxSource | "command";

/**
 * 一条没有 UI 出口时排队、等 `session_start` drain 的提示。
 *
 * `key` 存在表示它来自 `notifyOnce`（每会话至多一条）：只有 drain 真正发出去之后才置位
 * `notified`，否则「已通知」会提前标记、把提示吞掉（加载期 `warn`、工具执行期的 `skippedConfig`）。
 */
interface PendingNotification {
	/** `notifyOnce` 的去重键；加载期固定提示（helper 写盘失败等）没有键 */
	key?: string;
	message: string;
	type: "info" | "warning" | "error";
}

/**
 * 日志构造参数（`createFileLogger` 的子集）：单测注入替身只需实现这些。
 */
export interface InstaboxLoggerOptions {
	/** 日志目录（装配层给 `<agentDir>/logs/pi-instabox`） */
	dir: string;
	/** `PI_INSTABOX_DEBUG=1` → `debug`（含 `debug` 事件），否则 `info`（只记生命周期） */
	level: LogLevel;
	/** 写盘失败回调（默认转 {@link debug}，因此只有开 debug 时才见到） */
	onError: (message: string) => void;
}

/**
 * 装配注入面：真实调用由 pi 只传 `pi`（默认值即生产行为），单测用它替掉会 spawn 的真远端客户端。
 */
export interface InstaboxAssemblyDeps {
	/** 覆盖 `pool` 的远端客户端工厂（默认 `createRemoteClient`，会 spawn `instabox ssh`） */
	clientFactory?: (box: string) => RemoteClient;
	/**
	 * 覆盖文件日志构造（默认 `createFileLogger`）。
	 *
	 * 注入即视为显式测试接缝：`VITEST` 下**只有**注入时才建 logger，否则一律不建、不碰磁盘。
	 */
	loggerFactory?: (options: InstaboxLoggerOptions) => Logger;
}

/**
 * 内部排查日志：**默认完全静音**，只有 `PI_INSTABOX_DEBUG=1` 才写一条。
 *
 * 后台同步成功即静默（不发 notice），日志也只在显式开启时出现，免得把会话输出搅乱；
 * 排查时 `PI_INSTABOX_DEBUG=1 pi …` 就能看到来源选择、唤醒、握手失败这些细节。
 */
function debug(message: string): void {
	if (process.env.PI_INSTABOX_DEBUG !== "1") return;
	try {
		console.warn(`${LOG_PREFIX} ${message}`);
	} catch {
		// 日志本身失败不能变成用户可见错误
	}
}

/** `unknown` → message 文本（错误文本里不出现 `[object Object]`）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 分支里**最后一条 user 消息**的纯文本（解析链第 2 级；只取 text 段，图片忽略）。 */
function lastUserText(entries: readonly SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry === undefined || entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		return textOfContent(message.content);
	}
	return undefined;
}

/** user 消息内容 → 纯文本：`string` 原样，内容数组只拼 `type === "text"` 段。 */
function textOfContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** 候选箱名：去空、去重、保持 `ls` 顺序。 */
function namesOf(boxes: readonly BoxInfo[]): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const box of boxes) {
		if (box.name === "" || seen.has(box.name)) continue;
		seen.add(box.name);
		names.push(box.name);
	}
	return names;
}

/**
 * 把异步的 `pool.get` 桥成 `template.ts` 要的**同步**客户端工厂。
 *
 * 工厂只记下 box；第一次 RPC 才去池里取连接。`allowWake` 由 `template.ensure()` 透传，
 * 省略时按 `true` 处理：**连接即唤醒**（池自己只在箱不是 running 时才跑 wake/start/resume），
 * 后台同步也遵守同一条规则——否则「声明了工具却因为箱在暂停而永远连不上」会变成静默降级。
 * 取不到就把原因抛给 `template.ensure`，由它自己收成 `{ ok: false, error }` 并保留旧缓存。
 * 连接归 `pool` 所有，这里不 `close()`。
 */
function lazyPoolClient(pool: Pool, box: string, options?: { allowWake?: boolean }): RemoteClient {
	let client: RemoteClient | undefined;

	async function use(): Promise<RemoteClient> {
		if (client !== undefined && !client.isDead()) return client;
		const got = await pool.get(box, { allowWake: options?.allowWake ?? true });
		if (!got.ok) throw new Error(got.error);
		client = got.client;
		// `remote.ts` 的 initialize 幂等（重复调用共享同一次握手），因此这里只是把
		// `initialize` 的结果（含 `serverInfo.version`）取回来，不会再发一轮握手。
		return client;
	}

	return {
		initialize: async (signal) => (await use()).initialize(signal),
		listTools: async (signal) => (await use()).listTools(signal),
		callTool: async (name, args, signal) => (await use()).callTool(name, args, signal),
		close: () => {
			// 连接由 pool 持有并负责关停，模板层只借用
		},
		isDead: () => client !== undefined && client.isDead(),
	};
}

/** 超时后的会话重试预算（毫秒）：`instabox version` 冷启动实测 803–1178ms，留足余量。 */
const RETRY_PROBE_TIMEOUT_MS = 5_000;

/**
 * 探测失败是否只是「被超时击杀」。
 *
 * 只有 `reason: "timeout"`（宿主 `killed: true`）才算；`missing`（ENOENT / command not found）、
 * `error`（非 0 退出、无版本串）都是真的没有可用 CLI，重试没有意义。
 */
function probeTimedOut(probe: ProbeVersionResult): boolean {
	return !probe.ok && probe.reason === "timeout";
}

/** 扩展默认导出：加载期探测 → 装配（或按「无 CLI」降级，超时则等 `session_start` 重试一次）。 */
export default async function instaboxExtension(
	pi: ExtensionAPI,
	deps: InstaboxAssemblyDeps = {},
): Promise<void> {
	// —— 工厂最前面：登记两个 CLI flag ——
	// pi 只在扩展加载期判定 flag 合法性，未登记的 flag 会让进程直接 exit(1)，所以这两条必须
	// 早于配置解析、日志接线与 CLI 探测。这里只登记；加载期 `getFlag()` 读到的仍是默认值
	// （命令行值在扩展加载完成之后才写进 `runtime.flagValues`），真正的判定在 `session_start`
	// 之后（见 `assemble()` 里的 `devToolsSwitchOn`）。
	pi.registerFlag(DEVTOOLS_FLAG, {
		type: "boolean",
		default: false,
		description: "Enable the remote chrome-devtools-mcp server (default: disabled)",
	});
	pi.registerFlag(DEVTOOLS_BOX_FLAG, {
		type: "string",
		default: "",
		description: "Box that hosts chrome-devtools-mcp (default: config.devToolsBox)",
	});

	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);

	// —— 加载期第 0 步：配置与路径（探测之前，因此配置只在这里解析一次） ——
	const cfg = loadConfig();
	const paths = resolvePaths(getAgentDir());

	/**
	 * 接上文件日志（`<agentDir>/logs/pi-instabox/pi-instabox.jsonl`）：级别由 `PI_INSTABOX_DEBUG` 定。
	 *
	 * **探测之前**就调（配置与路径解析完之后立刻），这样 `cli.probe`（含失败/超时）与装配失败
	 * 都有记录；`log.ts` 的 `createFileLogger` 只在写入时建目录，因此「只写日志、不建运行期目录」
	 * 由写入路径本身保证。`VITEST` 下不建（否则单测会写真实磁盘），此时 `logEvent` 就是 no-op；
	 * 注入 `loggerFactory` 即视为显式测试接缝，跳过这个短路。
	 */
	function attachLogger(): void {
		if (deps.loggerFactory === undefined && process.env.VITEST) return;
		const factory = deps.loggerFactory ?? createFileLogger;
		setLogger(
			factory({
				dir: paths.logDir,
				level: process.env.PI_INSTABOX_DEBUG === "1" ? "debug" : "info",
				onError: (message) => debug(message),
			}),
		);
	}

	attachLogger();

	/**
	 * 成功路径的完整装配：池 / 模板缓存 / 命令 / renderer / DevTools MCP / 事件。
	 *
	 * `cfg` / `paths` 来自加载期（第 0 步），日志已在那时接上。加载期探测通过时调一次；
	 * 「探测超时 → `session_start` 重试通过」时也调它（同一份逻辑，不复制）。
	 * 返回的 `startSession` 供重试路径在当前会话补跑后台任务。
	 */
	function assemble(): { startSession: (ctx: ExtensionContext, source?: SessionStartEvent["reason"]) => void } {
		const boxLister = createBoxLister({ exec });
		const pool = createPool({
			exec,
			listBoxes: boxLister.list,
			timeouts: cfg.timeouts,
			...(deps.clientFactory === undefined ? {} : { clientFactory: deps.clientFactory }),
		});
		const templateStore = createTemplateStore({
			paths,
			clientFactory: (box, options) => lazyPoolClient(pool, box, options),
			warn: (message) => debug(message),
		});

		/** 最近一次事件的 ctx（工具执行期没有装配层的 ctx，一次性提示都走这里） */
		let sessionCtx: ExtensionContext | undefined;
		/** 本会话已发出的一次性提示键（`session_start` 清空） */
		const notified = new Set<string>();
		/** 已注册的桌面工具名 → exposure（`/instabox-status` 与「是否有工具」判定都读它） */
		const registeredTools = new Map<string, ToolExposure>();
		/** 当前工具声明来自哪台箱的模板缓存（**不是**解析链结果：实际目标在调用时解析） */
		let declaredFromBox: string | undefined;
		/** 加载期产生、等 `session_start` 才有的 UI 出口 */
		const pendingNotifications: PendingNotification[] = [];

		/**
		 * 实时读当前分支：传进来的 ctx 优先（工具调用用工具自带 ctx，命令用命令 ctx），
		 * 否则退回最近一次事件的 ctx。**不缓存**：解析链第 2 级必须看到本轮最新的 user 消息。
		 */
		function branchOf(ctx: ExtensionContext | undefined): SessionEntry[] {
			const source = ctx ?? sessionCtx;
			if (source === undefined) return [];
			try {
				return source.sessionManager.getBranch();
			} catch (error) {
				debug(`instabox: cannot read session branch: ${messageOf(error)}`);
				logEvent("error", { where: "session branch", message: messageOf(error) }, "warn");
				return [];
			}
		}

		/**
		 * 每会话至多一条（同键只发一次）。
		 *
		 * 没有 UI 出口时（加载期、或 `session_shutdown` 之后放掉了 ctx）先入队、**不**置位去重键：
		 * 键只在真正发出去时（{@link flushPendingNotifications} 或这里）才标记，否则那条提示会被
		 * 「已通知」静默吞掉。
		 */
		function notifyOnce(key: string, message: string, type: "info" | "warning" = "warning"): void {
			if (notified.has(key)) return;
			const ctx = sessionCtx;
			if (ctx === undefined) {
				if (!pendingNotifications.some((item) => item.key === key)) pendingNotifications.push({ key, message, type });
				return;
			}
			notified.add(key);
			ctx.ui.notify(message, type);
		}

		/** drain 排队的提示：**先发再标记**（去重键已置位的跳过），所以加载期那条不会丢也不会重复。 */
		function flushPendingNotifications(ctx: ExtensionContext): void {
			for (const item of pendingNotifications.splice(0)) {
				if (item.key !== undefined) {
					if (notified.has(item.key)) continue;
					notified.add(item.key);
				}
				ctx.ui.notify(item.message, item.type);
			}
		}

		/**
		 * 兜底：任何未预料的异常都只记日志 + 一条 warning，**绝不 throw 到会话层**
		 * （命令与事件处理器共用；正常的失败路径各自有更具体的提示）。
		 */
		async function safely(ctx: ExtensionContext, label: string, body: () => Promise<void>): Promise<void> {
			try {
				await body();
			} catch (error) {
				debug(`instabox: ${label} failed: ${messageOf(error)}`);
				logEvent("error", { where: label, message: messageOf(error) }, "warn");
				ctx.ui.notify(`instabox: ${label} 失败：${messageOf(error)}`, "warning");
			}
		}

		/**
		 * 解析链（方案 §4.3、T6）：`box` 参数 → 本轮最后一条 user 消息 → 会话目标 →
		 * `config.defaultBox` → `ls` 第一台。`skippedConfig` 每会话只 warn 一次。
		 *
		 * `toolCtx` 是 `tools.ts` 透传的本次调用上下文：分支**每次**都重新读，因此第 2 级不会
		 * 退化成「会话开始时的快照」。
		 */
		async function resolveTarget(paramBox?: string, toolCtx?: ExtensionContext): Promise<ResolveResult> {
			const branch = branchOf(toolCtx);
			const listed = await boxLister.list();
			if (!listed.ok) {
				const reason = listed.error ?? "unknown error";
				return { ok: false, kind: "no-boxes", message: `cannot list boxes: ${reason}`, candidates: [] };
			}
			const result = resolveBox({
				paramBox,
				lastUserMessage: lastUserText(branch),
				sessionTarget: readTarget(branch),
				configDefaultBox: cfg.defaultBox,
				boxes: listed.boxes,
			});
			if (result.ok && result.skippedConfig === true) {
				notifyOnce(
					"skipped-config",
					`instabox: config.defaultBox "${cfg.defaultBox}" 不是现有箱子，已回落到 ls 第一台（${result.box}）`,
				);
			}
			return result;
		}

		/** 注册某箱模板里的工具（同名替换由宿主保证），返回本次声明的条数。 */
		function registerDesktopTools(remoteTools: readonly RemoteTool[], box: string): number {
			const definitions = buildToolDefinitions({
				remoteTools,
				pool,
				resolve: resolveTarget,
				listBoxes: () => boxLister.list(),
				warn: (message) => notifyOnce(`register-warning:${message}`, message),
			});
			for (const definition of definitions) {
				pi.registerTool(definition);
				registeredTools.set(definition.name, definition.exposure ?? "direct");
			}
			declaredFromBox = box;
			return definitions.length;
		}

		/**
		 * 缓存里**最近拉取**的那台箱（`fetchedAt` 最新，平局按名字字典序），**不是**解析链结果。
		 *
		 * 它只回答「加载期/后台用哪份缓存声明工具」，取决于缓存本身而不是当前目标；
		 * `/instabox-status` 会把这一点显式标注出来（`tool declarations: …`）。
		 *
		 * **同步磁盘读**（`readCache`）：只能在加载期或 `backgroundSessionStart` 的异步体里调用，
		 * 绝不要放进 `session_start` 的同步段。
		 */
		function mostRecentlyFetchedCachedBox(): string | undefined {
			const { boxes } = readCache(nodeReadText, paths.templateCacheFile);
			let best: { box: string; at: number } | undefined;
			for (const [box, entry] of Object.entries(boxes)) {
				if (box === "") continue;
				const parsed = Date.parse(entry.fetchedAt);
				const at = Number.isNaN(parsed) ? 0 : parsed;
				if (best === undefined || at > best.at || (at === best.at && box < best.box)) best = { box, at };
			}
			return best?.box;
		}

		/**
		 * 缓存优先的声明来源（**不跑 `ls`**）：会话目标 → `config.defaultBox` →
		 * 缓存里最近拉取的那台。只有「该箱在 per-box 模板缓存里确实有条目」才算命中。
		 *
		 * 首访会同步读 `templates.json`（`TemplateStore` 惰性加载），因此同样只允许在加载期或
		 * `backgroundSessionStart` 的异步体里调用。
		 */
		function cachedTargetBox(ctx?: ExtensionContext): string | undefined {
			const sessionTarget = readTarget(branchOf(ctx));
			for (const candidate of [sessionTarget, cfg.defaultBox]) {
				if (candidate !== undefined && candidate !== "" && templateStore.get(candidate) !== undefined) {
					return candidate;
				}
			}
			return mostRecentlyFetchedCachedBox();
		}

		/** codemode 三态：实时读 `getActiveTools()` / `getAllTools()`（加载期一律不判定）。 */
		function codemodeState(): CodemodeState {
			if (pi.getActiveTools().includes(CODEMODE_TOOL)) return "active";
			const registered = pi.getAllTools().some((tool) => tool.name === CODEMODE_TOOL);
			return registered ? "inactive" : "unavailable";
		}

		/**
		 * codemode 三态 + 是否有 codemode-exposure 的 MCP server，落一条 `codemode` 埋点。
		 * 日志里的 `missing` 对应内部三态的 `unavailable`（本会话根本没有 codemode 条目）。
		 */
		function logCodemode(): void {
			const state = codemodeState();
			logEvent(
				"codemode",
				{ state: state === "unavailable" ? "missing" : state, server: hasCodemodeExposureServer() },
				"debug",
			);
		}

		/**
		 * 是否存在 enabled 且 `codemode` exposure 的 MCP server。
		 * `exposure` 缺省即 `codemode`（`mcp-servers.d.ts` 的默认值），所以不能只比字面量。
		 *
		 * 局限（已确认，非实现选择）：`pi.getMcpServers()` 只返回**扩展注册**的 server
		 * （`loader.js` 里就是 `runtime.mcpServers.list()`，即 `registerMcpServer()` 的登记簿），
		 * 拿不到 `mcp.json` 里的条目，所以这里也判不了它们。`mcp.json` 的 codemode server 连上后
		 * pi 会自动激活 codemode，结果体现在 {@link codemodeState} 的 `active` 分支；
		 * 只有在自动激活尚未发生（连接中、或 `autoEnableCodemode: false`）时，本扩展才可能多报一条
		 * 「需要激活」的提示——每会话至多一条，且给了可执行补救，属可接受的保守提示。
		 */
		function hasCodemodeExposureServer(): boolean {
			const servers = typeof pi.getMcpServers === "function" ? pi.getMcpServers() : [];
			return servers.some(
				(server) => (server.config.exposure ?? "codemode") === "codemode" && server.config.enabled !== false,
			);
		}

		/**
		 * 需要给用户的 codemode 提示（无则 `undefined`）：
		 * 已激活 → 无；有 codemode exposure 的 MCP server → 无（pi 会自动激活，提示只会是噪音）；
		 * 有条目未激活 → 补救命令；没有条目 → 明说本会话不可用。**绝不激活、绝不改选择集**。
		 */
		function codemodeNotice(): string | undefined {
			const state = codemodeState();
			if (state === "active") return undefined;
			if (hasCodemodeExposureServer()) return undefined;
			return state === "inactive" ? CODEMODE_INACTIVE_MESSAGE : CODEMODE_UNAVAILABLE_MESSAGE;
		}

		/** `session_start` 的 codemode 判定：至多一次，且只在确实有桌面工具时才有意义。 */
		function notifyCodemodeOnce(): void {
			logCodemode();
			if (registeredTools.size === 0) return;
			const notice = codemodeNotice();
			if (notice !== undefined) notifyOnce("codemode", notice);
		}

		/** 同步失败的可操作提示（每会话至多一条）：只给 `/instabox-use <box>` 这条重试入口。 */
		function notifySyncFailure(box: string, reason: string): void {
			debug(`instabox: cannot sync desktop tools for "${box}": ${reason}`);
			notifyOnce(
				"sync-failed",
				`instabox: 未能同步沙箱 "${box}" 的桌面工具（${reason}）；执行 /instabox-use ${box} 唤醒并重试。`,
			);
		}

		/**
		 * `session_start` 的后台声明：**成功一律静默**，只有真的同步不了才提示。
		 *
		 * 来源（按顺序）：
		 * 1. 有缓存：会话目标 → `config.defaultBox` → 最近拉取的那台（都要有缓存条目才算）；
		 *    `ensure(box, { allowWake: true })` 只做一次版本校验，失败**静默**沿用 `stale`。
		 * 2. 无缓存：`ls --json`（`force: true`，跳过 5s 缓存）
		 *    - 有 `state === "running"` 的箱 → 取**第一台** running（连上它不需要唤醒）；
		 *    - 全是非 running（列表非空）→ 取**列表第一台**。
		 *    两条都传 `allowWake: true`：**连接即唤醒**，后台同步也允许把暂停的箱拉起来
		 *    （不传 `onProgress`，因此不会往会话里塞进度提示）。
		 * 3. `ls` 空或失败 → 一条「没有可用沙箱」warning（不可恢复，每会话一次）。
		 * 4. 拉到失败（无缓存、唤醒失败、认证/网络）→ 一条带 `/instabox-use <box>` 的 warning。
		 */
		async function refreshTemplateInBackground(ctx: ExtensionContext): Promise<void> {
			const cachedBox = cachedTargetBox(ctx);
			if (cachedBox !== undefined) {
				// 一次握手做版本校验；失败沿用旧缓存（新鲜度放弃），静默不提示
				const fetched = await templateStore.ensure(cachedBox, { allowWake: true });
				const template = fetched.ok ? fetched.template : fetched.stale;
				if (template === undefined) {
					notifySyncFailure(cachedBox, fetched.ok ? "no cached template" : fetched.error);
					return;
				}
				if (!fetched.ok) debug(`instabox: version check failed for "${cachedBox}", using cached tools: ${fetched.error}`);
				registerDesktopTools(template.tools, cachedBox);
				return;
			}

			const listed = await boxLister.list({ force: true });
			const names = listed.ok ? namesOf(listed.boxes) : [];
			const running = listed.ok ? listed.boxes.find((box) => box.state === RUNNING_STATE) : undefined;
			const box = running?.name ?? names[0];
			if (box === undefined) {
				debug(
					`instabox: no boxes available (${listed.ok ? "empty list" : (listed.error ?? "unknown error")})`,
				);
				notifyOnce("no-box", NO_BOX_MESSAGE);
				return;
			}
			// 连接即唤醒：有 running 的优先连它，否则第一台由池拉起（不传 onProgress，不阻塞会话）
			const fetched = await templateStore.ensure(box, { allowWake: true });
			if (!fetched.ok) {
				notifySyncFailure(box, fetched.error);
				return;
			}
			registerDesktopTools(fetched.template.tools, box);
		}

		/**
		 * 冷启动的唯一重试入口（方案 §4.5 D5）：唤醒 → 拉模板 → 注册。
		 * 箱子起不来但已有缓存时仍按缓存声明（新鲜度放弃），并说明原因。
		 */
		async function retryRegistration(box: string, ctx: ExtensionCommandContext): Promise<void> {
			const woken = await pool.get(box, {
				signal: ctx.signal,
				onProgress: (message) => ctx.ui.notify(message, "info"),
			});
			const fetched = woken.ok ? await templateStore.ensure(box) : undefined;
			const template = fetched?.ok === true ? fetched.template : templateStore.get(box);
			const reason = woken.ok ? (fetched?.ok === true ? undefined : fetched?.error) : woken.error;
			if (template === undefined) {
				ctx.ui.notify(
					`instabox: 未能注册桌面工具（${reason ?? "unknown error"}）；修好箱子后再执行 /instabox-use ${box} 重试。`,
					"warning",
				);
				return;
			}
			const count = registerDesktopTools(template.tools, box);
			if (reason === undefined) {
				ctx.ui.notify(`instabox: registered ${count} desktop tool(s) for box "${box}"`, "info");
				return;
			}
			ctx.ui.notify(`instabox: registered ${count} desktop tool(s) from cache; box "${box}" is not usable yet: ${reason}`, "warning");
		}

		// —— 加载期缓存命中：立刻声明工具（不跑 `ls`、不连远端；缓存是唯一来源） ——
		const loadTarget = cachedTargetBox();
		if (loadTarget !== undefined) {
			const cached = templateStore.get(loadTarget);
			if (cached !== undefined) registerDesktopTools(cached.tools, loadTarget);
		}
		logEvent("load.assembled", {
			cacheHit: declaredFromBox !== undefined,
			box: declaredFromBox,
			tools: registeredTools.size,
		});

		/** `/instabox-use`：空参数列目标 + 候选；无效名拒绝；有效名写 entry（冷启动再唤醒 + 注册）。 */
		async function handleUse(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const current = readTarget(branchOf(ctx));
			const requested = args.trim();
			if (requested === "") {
				const listed = await boxLister.list();
				const candidates = listed.ok ? namesOf(listed.boxes).join(", ") || "(none)" : `ls failed: ${listed.error ?? "unknown error"}`;
				ctx.ui.notify(`instabox target: ${current ?? "not set"}\ncandidates: ${candidates}`, "info");
				return;
			}
			const listed = await boxLister.list();
			if (!listed.ok) {
				ctx.ui.notify(`instabox: cannot list boxes: ${listed.error ?? "unknown error"}`, "warning");
				return;
			}
			if (!listed.boxes.some((box) => box.name === requested)) {
				const candidates = namesOf(listed.boxes).join(", ") || "(none)";
				ctx.ui.notify(
					`instabox: unknown box "${requested}"; available boxes: ${candidates}; target unchanged (${current ?? "not set"})`,
					"warning",
				);
				return;
			}
			pi.appendEntry(TARGET_ENTRY, targetEntryData(requested));
			ctx.ui.notify(`instabox target: ${requested}`, "info");
			// 已有工具时只写 entry（缓存命中即可），冷启动才走唤醒 + 拉取 + 注册
			if (registeredTools.size > 0) return;
			await retryRegistration(requested, ctx);
		}

		/** `/instabox-status`：一次性打印配置 / 目标 / 工具 / codemode / MCP server。 */
		async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
			const lines: string[] = [];
			lines.push(
				`config: defaultBox=${cfg.defaultBox || "(unset)"} devToolsBox=${cfg.devToolsBox || "(unset)"} autoInstallDevTools=${String(cfg.autoInstallDevTools)} remotePath=${cfg.remotePath}`,
			);
			lines.push(`session target: ${readTarget(branchOf(ctx)) ?? "(not set)"}`);
			try {
				const resolved = await resolveTarget(undefined, ctx);
				lines.push(
					`resolved target: ${resolved.ok ? `${resolved.box} (via ${resolved.source})` : `${resolved.kind}: ${resolved.message}`}`,
				);
			} catch (error) {
				lines.push(`resolved target: unavailable (${messageOf(error)})`);
			}
			const tools = [...registeredTools.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([name, exposure]) => `${name} (${exposure})`);
			lines.push(`tools: ${tools.join(", ") || "(none)"}`);
			lines.push(
				declaredFromBox === undefined
					? "tool declarations: (none registered yet)"
					: `tool declarations: from the cached template of box "${declaredFromBox}" (the per-call target is resolved at call time)`,
			);
			lines.push(`active tools: ${pi.getActiveTools().join(", ") || "(none)"}`);
			const state = codemodeState();
			const label = state === "active" && hasCodemodeExposureServer() ? "active (auto via MCP)" : CODEMODE_LABELS[state];
			lines.push(`codemode: ${label}`);
			if (typeof pi.getMcpServers === "function") {
				const servers = pi.getMcpServers().map((server) => server.name);
				lines.push(`mcp servers: ${servers.join(", ") || "(none)"}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		}

		// —— 命令：设置/查看目标箱 ——
		pi.registerCommand("instabox-use", {
			description: "Set (or show) the instabox target box for this session",
			handler: async (args, ctx) => {
				sessionCtx = ctx;
				await safely(ctx, "/instabox-use", () => handleUse(args, ctx));
			},
		});

		// —— 命令：诊断 ——
		pi.registerCommand("instabox-status", {
			description: "Show instabox config, resolved target, registered tools, codemode state and MCP servers",
			handler: async (_args, ctx) => {
				sessionCtx = ctx;
				await safely(ctx, "/instabox-status", () => handleStatus(ctx));
			},
		});

		// —— 目标 entry 的转录渲染（R5：返回 Component，`Text` 只收到着色字符串） ——
		pi.registerEntryRenderer(TARGET_ENTRY, createTargetRendererWithHostText());

		// —— DevTools MCP：**默认关闭**，只有 `--instabox-devtools`（或 `/instabox-devtools on`）
		//    能开启；box 的来源优先级是会话绑定 > `--instabox-devtools-box` > `config.devToolsBox` ——
		/** 本会话已注册的 DevTools MCP（`undefined` = 未注册）；`source` 只在 `devtools.enabled` 与 `status` 里回显 */
		let registeredDevTools: { box: string; name: string; source: DevtoolsRegistrationSource } | undefined;

		/**
		 * 开关 flag 的当前值（**只在装配完成后读**）。
		 *
		 * pi 在扩展加载结束之后才把命令行里的 flag 值写进 `runtime.flagValues`
		 * （`applyExtensionFlagValues` 在 `resourceLoader.reload()` 之后跑），加载期读到的永远只是
		 * 注册时的默认值 `false`。所以判定放在 `session_start` 与命令里，不要挤回加载期。
		 */
		function devToolsSwitchOn(): boolean {
			return pi.getFlag(DEVTOOLS_FLAG) === true;
		}

		/** `--instabox-devtools-box`：空串＝没给（两侧空白裁掉，与 box 名匹配口径一致） */
		function devToolsFlagBox(): string {
			const value = pi.getFlag(DEVTOOLS_BOX_FLAG);
			return typeof value === "string" ? value.trim() : "";
		}

		/**
		 * box 的解析结果：箱名 + 它从哪个来源来。三个来源都没给（或会话绑定已被 `reset` 清掉）时
		 * 返回 `undefined`。
		 *
		 * 会话绑定必须实时读分支：`on <box>` 写的是 entry，`/tree` 换分支后绑定会跟着变，
		 * 缓存它会让「切分支后回退到 flag/config」这条承诺失效。
		 */
		function devToolsBoxChoice(ctx?: ExtensionContext): { box: string; source: DevtoolsBoxSource } | undefined {
			const sessionBox = readDevtoolsTarget(branchOf(ctx));
			if (sessionBox !== undefined) return { box: sessionBox, source: "session" };
			const fromFlag = devToolsFlagBox();
			if (fromFlag !== "") return { box: fromFlag, source: "flag" };
			if (cfg.devToolsBox !== "") return { box: cfg.devToolsBox, source: "config" };
			return undefined;
		}

		/** `ls` 的候选箱名（失败直说，不假装「没有箱子」） */
		async function devToolsCandidates(): Promise<string> {
			const listed = await boxLister.list();
			return listed.ok
				? namesOf(listed.boxes).join(", ") || "(none)"
				: `ls failed: ${listed.error ?? "unknown error"}`;
		}

		/**
		 * 写 helper + 注册（替换）MCP server：启动路径与 `/instabox-devtools on` 共用。
		 *
		 * `source` 记录本次注册的 box 是从哪来的：启动路径取实际生效的来源（session / flag / config），
		 * 命令路径一律 `command`（即使最终 box 由 flag/config 提供）。
		 * helper 写盘失败只 warn（远端可能早就装好了 `chrome-devtools-mcp`，不该连带放弃注册）；
		 * 已注册时先 `unregister` 再注册，换 box 不会留下旧连接。
		 * 返回是否注册成功（失败已经提示过，调用方不必再报一次）。
		 */
		function registerDevTools(box: string, source: DevtoolsRegistrationSource): boolean {
			const helper = ensureHelperScript({
				remotePath: cfg.remotePath,
				autoInstall: cfg.autoInstallDevTools,
				paths,
			});
			if (!helper.ok) {
				notifyOnce(
					`devtools-helper:${box}`,
					`instabox: 无法写入 DevTools helper（${helper.error ?? "unknown error"}）；远端 DevTools MCP 可能起不来。`,
				);
			}
			const registration = buildMcpServerConfig(cfg, paths, box);
			let ok = true;
			try {
				if (registeredDevTools !== undefined) pi.unregisterMcpServer(registeredDevTools.name);
				pi.registerMcpServer(registration.name, registration.config);
			} catch (error) {
				ok = false;
				notifyOnce(
					`devtools-register:${box}`,
					`instabox: 远端 DevTools MCP 注册失败（${messageOf(error)}）；桌面工具不受影响。`,
				);
			}
			logEvent("devtools.register", { box, ok });
			if (!ok) {
				registeredDevTools = undefined;
				return false;
			}
			registeredDevTools = { box, name: registration.name, source };
			logEvent("devtools.enabled", { box, source });
			return true;
		}

		/**
		 * `session_start` 后台体里的启动判定：开关关着就什么都不做（只给了 box flag 时提示一次）；
		 * 开关开着就按「会话绑定 > flag > config」取 box，缺失 / 不在 `ls` 里则 warning + 不注册
		 * （**不静默换机**）。会话恢复后曾 `on` 过的 box 因此能继续生效。
		 */
		async function syncDevToolsOnStartup(ctx: ExtensionContext): Promise<void> {
			if (!devToolsSwitchOn()) {
				if (devToolsFlagBox() !== "") notifyOnce("devtools-switch-missing", DEVTOOLS_SWITCH_MISSING_MESSAGE);
				return;
			}
			// 本会话已注册（命令开过、或更早一次 session_start）：不重复写盘，也不打扰用户
			if (registeredDevTools !== undefined) return;
			const choice = devToolsBoxChoice(ctx);
			if (choice === undefined) {
				notifyOnce("devtools-no-box", DEVTOOLS_NO_BOX_MESSAGE);
				return;
			}
			const box = choice.box;
			const listed = await boxLister.list();
			if (!listed.ok) {
				notifyOnce(
					"devtools-ls-failed",
					`instabox: 无法校验 devtools box "${box}"（${listed.error ?? "unknown error"}）；DevTools MCP 未注册`,
				);
				return;
			}
			if (!listed.boxes.some((candidate) => candidate.name === box)) {
				const candidates = namesOf(listed.boxes).join(", ") || "(none)";
				notifyOnce(
					`devtools-unknown-box:${box}`,
					`instabox: devtools box "${box}" 不在 instabox ls 里；DevTools MCP 未注册（候选：${candidates}）`,
				);
				return;
			}
			registerDevTools(box, choice.source);
		}

		/**
		 * `/instabox-devtools [status|on [box]|off|reset]`：查看 / 开启（替换）/ 关闭远端 DevTools MCP /
		 * 清除会话绑定的 box。
		 */
		async function handleDevTools(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const [subcommand = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const action = subcommand === "" ? "status" : subcommand.toLowerCase();
			if (action === "status") {
				// 三段分开报：已注册的 server（`reset` 不动它）、会话绑定（`reset` 清的就是它）、
				// 以及下一次 `on` / 启动会用的解析结果 —— 合成一行会让 `reset` 看起来没生效。
				const sessionBox = readDevtoolsTarget(branchOf(ctx));
				const effective = devToolsBoxChoice(ctx);
				ctx.ui.notify(
					[
						`instabox-devtools: ${devToolsSwitchOn() ? "on" : "off"} (--${DEVTOOLS_FLAG})`,
						`registration: ${
							registeredDevTools === undefined
								? "(none)"
								: `${registeredDevTools.box} (via ${registeredDevTools.source})`
						}`,
						`session binding: ${sessionBox ?? "(unset)"}`,
						`effective box: ${effective === undefined ? "(unset)" : `${effective.box} (${effective.source})`}`,
						`candidates: ${await devToolsCandidates()}`,
					].join("\n"),
					"info",
				);
				return;
			}
			if (action === "off") {
				if (registeredDevTools === undefined) {
					ctx.ui.notify("instabox: DevTools MCP 未注册，无操作", "info");
					return;
				}
				const { box, name } = registeredDevTools;
				pi.unregisterMcpServer(name);
				registeredDevTools = undefined;
				logEvent("devtools.disabled", {});
				ctx.ui.notify(`instabox: DevTools MCP 已关闭（原 box "${box}"）`, "info");
				return;
			}
			if (action === "reset") {
				// 只写一条清除标记：开关与已注册的 server 都不动（`off` 才是注销入口）
				pi.appendEntry(DEVTOOLS_TARGET_ENTRY, devtoolsTargetEntryData(""));
				logEvent("devtools.reset", {});
				ctx.ui.notify(DEVTOOLS_RESET_MESSAGE, "info");
				return;
			}
			if (action === "on") {
				const requested = rest.join(" ").trim();
				// 给了 box：解析目标就是它，并写成会话绑定（下次启动优先用它）；
				// 没给：按 会话绑定 → flag → config 解析，三者都没有才报缺失
				const choice = requested !== "" ? { box: requested, source: "command" as const } : devToolsBoxChoice(ctx);
				if (choice === undefined) {
					ctx.ui.notify(DEVTOOLS_NO_BOX_MESSAGE, "warning");
					return;
				}
				const box = choice.box;
				const listed = await boxLister.list();
				if (!listed.ok) {
					ctx.ui.notify(`instabox: cannot list boxes: ${listed.error ?? "unknown error"}`, "warning");
					return;
				}
				if (!listed.boxes.some((candidate) => candidate.name === box)) {
					const candidates = namesOf(listed.boxes).join(", ") || "(none)";
					ctx.ui.notify(
						`instabox: unknown box "${box}"; available boxes: ${candidates}; devtools 状态未变`,
						"warning",
					);
					return;
				}
				if (requested !== "") pi.appendEntry(DEVTOOLS_TARGET_ENTRY, devtoolsTargetEntryData(box));
				if (!registerDevTools(box, "command")) return; // 失败原因已提示
				ctx.ui.notify(`instabox: DevTools MCP registered for box "${box}"`, "info");
				return;
			}
			ctx.ui.notify(`instabox: 未知参数 "${subcommand}"；${DEVTOOLS_USAGE}`, "warning");
		}

		// —— 命令：动态开关（flag 之外的运行期入口；`off` 只关本会话的注册，`reset` 只清会话绑定） ——
		pi.registerCommand("instabox-devtools", {
			description: "Show, enable (on [box]), disable (off) or reset the session box of the remote DevTools MCP server",
			handler: async (args, ctx) => {
				sessionCtx = ctx;
				await safely(ctx, "/instabox-devtools", () => handleDevTools(args, ctx));
			},
		});

		/**
		 * `session_start` 的后台任务：DevTools flag 判定 + 拉模板（连接即唤醒）+ 注册 + codemode 只读判定。
		 * 所有 UI 提示都在这里发，异常只 debug（`safely` 再兜一层 warning）。
		 *
		 * 注意：async 函数体在**第一次 await 之前**是同步执行的，`TemplateStore` / `readCache` 的
		 * 同步磁盘读正好落在那里。所以调用方必须先让出一个宏任务（{@link startBackgroundSessionStart}），
		 * 否则这些读会发生在事件处理器的同步帧里。
		 */
		async function backgroundSessionStart(ctx: ExtensionContext): Promise<void> {
			await safely(ctx, "session_start", async () => {
				await syncDevToolsOnStartup(ctx);
				await refreshTemplateInBackground(ctx);
				notifyCodemodeOnce();
			});
		}

		/**
		 * 把后台任务挪到下一个宏任务：`session_start` 的同步段因此只剩内存赋值与通知 drain。
		 * `unref` 让这个定时器不拖住进程退出（与 pi-todo 的清理定时器同款）。
		 */
		function startBackgroundSessionStart(ctx: ExtensionContext): void {
			const timer = setTimeout(() => {
				void backgroundSessionStart(ctx).catch((error: unknown) => {
					debug(`instabox: session_start background task failed: ${messageOf(error)}`);
					logEvent("error", { where: "session_start background", message: messageOf(error) }, "warn");
				});
			}, 0);
			(timer as unknown as { unref?: () => void }).unref?.();
		}

		// —— 事件：会话开始 ——
		/**
		 * 本会话的启动：同步段只有内存赋值 + 通知 drain，远端与磁盘工作都在宏任务之后。
		 * 正常路径由 `session_start` 调用；「加载期探测超时 → 会话开始后重试成功」的那条路径要在
		 * **当前**会话里补跑一次（那次 `session_start` 已经派发过了），所以这里必须单独成函数。
		 */
		let startedCtx: ExtensionContext | undefined;
		function startSession(ctx: ExtensionContext, source?: SessionStartEvent["reason"]): void {
			// 同一会话只启动一次：重试路径显式补跑时，若 pi 把刚注册的处理器也算进同一轮派发，不会跑两遍
			if (startedCtx === ctx) return;
			startedCtx = ctx;
			sessionCtx = ctx;
			notified.clear();
			flushPendingNotifications(ctx);
			// `source` = `session_start` 的 reason（startup / reload / new / resume / fork）；
			// `target` 是本会话已有的目标 entry（未设则不记），与解析链结果无关。
			logEvent("session.start", { target: readTarget(branchOf(ctx)), source, mode: ctx.mode });
			// 不 await、也不在这里调用 async 体：pi 会 await 事件处理器，等在这里（甚至只是让 async
			// 函数的同步前奏跑起来）就等于把 ssh/握手/读盘算进会话启动（方案 §4.4）
			startBackgroundSessionStart(ctx);
		}

		pi.on("session_start", (event, ctx) => startSession(ctx, event.reason));

		// —— 事件：`/tree` 换分支后换掉 ctx（目标状态不缓存，解析链每次调用实时读分支） ——
		pi.on("session_tree", async (_event, ctx) => {
			sessionCtx = ctx;
			const target = readTarget(branchOf(ctx));
			logEvent("session.tree", { target }, "debug");
			debug(`instabox: session_tree → target=${target ?? "(not set)"}`);
		});

		// —— 事件：会话结束（换会话 / `/reload` / 退出）→ 收掉本实例的远端连接，避免残留 ssh ——
		pi.on("session_shutdown", async () => {
			const open = pool.size();
			pool.disposeAll();
			// 在飞的建连由池自己按代数校验丢弃（`dispose` 会把 clients 与 inflight 两侧都驱逐），
			// 这里只把已失效的 ctx 放掉：之后的 `notifyOnce` 会走排队，等下一个会话 drain。
			sessionCtx = undefined;
			logEvent("session.shutdown", { open });
			// 本实例已收尾：复位日志单例，避免进程内遗留（下一个会话重新装配时再建）
			setLogger(undefined);
			// 只在真的收过连接时记一条（没有连接时 shutdown 不该产生任何日志噪音）
			if (open > 0) debug(`instabox: session_shutdown → disposed ${open} connection(s)`);
		});

		return { startSession };
	}

	/**
	 * 加载期探测超时的会话开始重试：**超时 ≠ 没有 CLI**。
	 *
	 * `instabox version` 在本机实测 803–1178ms，而加载期预算（`cli.ts` 默认 3000ms，早期 1200ms）
	 * 在冷启动慢时会被击杀；直接自禁用会让相当比例（实测 5 次里 2 次）的冷启动误判「无 CLI」。
	 * 因此在**第一次** `session_start` 里用更长预算（{@link RETRY_PROBE_TIMEOUT_MS}）再探一次：
	 * 成功 → 立刻装配并在本会话补跑后台任务；仍失败 → 才按「无 CLI」禁用。只重试一次。
	 */
	async function retryProbe(ctx: ExtensionContext, source?: SessionStartEvent["reason"]): Promise<void> {
		const retried = await probeVersion(exec, { timeout: RETRY_PROBE_TIMEOUT_MS });
		if (!retried.ok) {
			disable(ctx, NO_CLI_MESSAGE, `CLI retry probe failed: ${retried.error}`);
			return;
		}
		// 装配成功之后才算「可用」：`assemble()` 抛错时若已置 `assembled`，后续会话就再也不会
		// 重试，而且会把「初始化失败」误报成「未找到 instabox CLI」
		let session: { startSession: (ctx: ExtensionContext, source?: SessionStartEvent["reason"]) => void };
		try {
			session = assemble();
		} catch (error) {
			disable(
				ctx,
				`instabox 扩展初始化失败：${messageOf(error)}`,
				`assembly after a successful retry probe failed: ${messageOf(error)}`,
			);
			return;
		}
		state = "assembled";
		try {
			// 本次会话已经派发过 session_start（处理器还没注册）→ 手动补跑后台拉取与 codemode 判定
			session.startSession(ctx, source);
		} catch (error) {
			// 装配已完成，只是本次补跑失败：只记日志，不改变状态（下一个会话正常启动）
			debug(`instabox: startSession after retry failed: ${messageOf(error)}`);
		}
	}

	/**
	 * 发一条禁用/失败提示，**绝不抛**。
	 *
	 * 这些调用点都在 fire-and-forget 的异步链里（`session_start` 重试、`retryProbe` 的 catch），
	 * 并且可能在 ctx 失效（换会话 / `/reload` 之后的旧 ctx）以后才执行；`ui.notify` 抛一次就会
	 * 变成进程级 unhandled rejection，所以统一从这里出去，异常只记日志。
	 */
	function notifyQuietly(ctx: ExtensionContext, message: string, type: "info" | "warning" = "warning"): void {
		try {
			ctx.ui.notify(message, type);
		} catch (error) {
			debug(`instabox: ui.notify failed: ${messageOf(error)}`);
			logEvent("error", { where: "ui.notify", message: messageOf(error) }, "warn");
		}
	}

	/** 重试状态机：`pending` 只出现一次（一次性标记），之后不再探测。 */
	let state: "pending" | "probing" | "assembled" | "disabled" = "pending";
	/** 禁用时对用户说的那句话：装配失败要换成准确原因，不能一律说「未找到 CLI」。 */
	let disabledMessage = NO_CLI_MESSAGE;

	/** 一次性关掉这条路：记下原因 / 状态，只记日志，给一条绝不抛的提示。 */
	function disable(ctx: ExtensionContext, message: string, detail: string): void {
		state = "disabled";
		disabledMessage = message;
		debug(`instabox: ${detail}`);
		notifyQuietly(ctx, message);
	}

	// —— 加载期：探测 CLI（默认 3000ms）；没有就零注册、不建运行期目录（日志已接上，只写日志） ——
	const probe = await probeVersion(exec);
	if (probe.ok) {
		assemble();
		return;
	}
	if (!probeTimedOut(probe)) {
		debug(`instabox CLI probe failed: ${probe.error}`);
		pi.on("session_start", (_event, ctx) => {
			notifyQuietly(ctx, NO_CLI_MESSAGE);
		});
		return;
	}
	// 只是被超时击杀：本次零注册，等第一次 session_start 用更长预算重试
	debug(`instabox CLI probe timed out; retrying on session_start with ${RETRY_PROBE_TIMEOUT_MS}ms: ${probe.error}`);
	pi.on("session_start", (event, ctx) => {
		if (state === "assembled") return;
		if (state === "disabled") {
			notifyQuietly(ctx, disabledMessage);
			return;
		}
		if (state === "probing") return;
		state = "probing";
		// 不 await：5000ms 的探测不能算进会话启动（与 `session_start` 其余部分同一口径）
		void retryProbe(ctx, event.reason).catch((error: unknown) => {
			disable(ctx, `instabox 扩展初始化失败：${messageOf(error)}`, `retry probe failed: ${messageOf(error)}`);
		});
	});

}
