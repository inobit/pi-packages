/**
 * @inobit/pi-instabox — 远端 DevTools MCP：注册前的准备（复用 `pool.ensureReady` + 确保远端
 * 可执行）与 `registerMcpServer` 参数（方案 §4.6、§5.1、T13）。
 *
 * 契约：
 * - **普通注册，没有中间层**：注册的就是一条 stdio 配置，效果等价于在 `mcp.json` 里手写
 *
 *       "instabox-devtools": { "command": "instabox",
 *                              "args": ["ssh", "<box>", "--", "env", "PATH=…", "chrome-devtools-mcp", …] }
 *
 *   不生成脚本、不落盘、不多包一层进程——唯一的区别是由扩展在需要时注册/注销。
 * - 前置工作因此在注册**之前**由普通函数（{@link prepareDevTools}）做完：MCP 客户端自己不会
 *   唤醒箱，pi 也不会重连失败的 server——箱暂停时若直接注册，结果是 0 个工具且整场会话不再
 *   恢复。顺序：`ensureReady(box)` → 检查远端有没有 `chrome-devtools-mcp`（缺了且
 *   `autoInstallDevTools` 就装一次）。
 * - **唤醒链不在这里**：`ensureReady` 由装配层注入（就是 `pool.ensureReady`），「准备一个可用
 *   的 box」全仓库只有那一套实现；本模块只负责它之后的那半步（远端二进制）。
 * - 箱准备不好＝准备失败（调用方不注册）；检查/安装失败只 warn：远端可能早就装好，让
 *   `command not found` 在真正连接时原样冒给 MCP 客户端更好排查。
 * - PATH 走 `instabox exec --env PATH=…`（CLI 原生能力，方案 C-c「比 `env PATH=… cmd` 包装
 *   更干净」）；最后一段 `instabox ssh` 没有 `--env`，只能用 `env PATH=…` 前缀。
 * - 内容全部来自参数（`cfg` / `box`），本模块不读 `DEFAULT_CONFIG`；box 存在性与状态一律由
 *   注入的 `ensureReady` 判定（它带候选清单），本模块不自己跑 `ls`。
 * - 零第三方**运行时**依赖：远端命令一律经 `cli.ts` 的薄封装（宿主类型 `McpServerConfig` 仅
 *   `import type`，编译后擦除），单测不 spawn 真进程。
 */

import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { type ExecFn, execRemote } from "./cli.ts";
import type { InstaboxConfig } from "./config.ts";
import { logEvent } from "./log.ts";
import type { EnsureReadyResult, Pool } from "./pool.ts";

/** CLI 可执行文件名（argv[0]，不经 shell；与 `cli.ts` 一致）。 */
const INSTABOX_BIN = "instabox";

/** 远端 DevTools MCP 的可执行文件名（注册配置里最后一段命令）。 */
const DEVTOOLS_BIN = "chrome-devtools-mcp";

/** 远端安装检查的 `instabox exec --timeout`：`command -v` 立刻返回，20 秒只兜 CLI 冷启动。 */
const CHECK_TIMEOUT_MS = 20_000;

/** 安装本身的预算：`npm i -g` 要拉 tarball，60 秒比检查宽一档。 */
const INSTALL_TIMEOUT_MS = 60_000;

/**
 * `registerMcpServer` 的每请求超时（秒）：默认 60 偏紧，桌面/浏览器操作给 180（方案 C-d）。
 *
 * 唤醒/检查/安装在**注册之前**由 {@link prepareDevTools} 做完，不再落在这个 timeout 里，
 * 所以这里只需覆盖 MCP 请求本身。
 */
const DEVTOOLS_REQUEST_TIMEOUT_SECONDS = 180;

/**
 * `pi.registerMcpServer(name, config)` 的 stdio 参数；`exposure` 钉死 `codemode`（方案 §4.3）。
 *
 * 本地细化类型，构造点用 `satisfies McpServerConfig` 绑到宿主并集上（见
 * {@link buildMcpServerConfig}），宿主改字段时这里先报错。
 */
export interface DevToolsMcpServerConfig {
	/** `instabox`（就是 `mcp.json` 里能手写的那条命令） */
	command: string;
	/** `["ssh", box, "--", "env", "PATH=…", "chrome-devtools-mcp", ...devToolsArgs]` */
	args: string[];
	/** 远端工具既不声明给模型、也不进 codemode 描述，codemode 脚本用 `searchTools()` 发现（方案 R3） */
	exposure: "codemode";
	/** 每请求秒数 */
	timeout: number;
	/** 出现在系统提示 `mcp_servers` 段，必须自解释（方案 §4.3 备注） */
	description: string;
}

export interface DevToolsMcpServerRegistration {
	/** server 名（命名空间由此派生为 `mcp__instabox_devtools`） */
	name: string;
	config: DevToolsMcpServerConfig;
}

/**
 * 构造远端 `chrome-devtools-mcp` 的注册参数（纯函数，便于单测逐字断言 argv）。
 *
 * `box` 是唯一对应的箱名（flag / 命令解析后传入），缺省沿用 `cfg.devToolsBox`；为空时调用方
 * 不该调用本函数（该能力整体不存在，方案 §4.3 验收③）。
 * `args` 每次新建数组，不与 `cfg.devToolsArgs` 共享引用。
 */
export function buildMcpServerConfig(
	cfg: InstaboxConfig,
	box: string = cfg.devToolsBox,
): DevToolsMcpServerRegistration {
	// 双重 satisfies：本地细化类型 + 宿主 `McpServerConfig`（stdio 并集）。宿主增删字段或收窄
	// `exposure` 时在编译期就炸，而不是留到 `registerMcpServer()` 或运行期。
	const config = {
		command: INSTABOX_BIN,
		args: ["ssh", box, "--", "env", `PATH=${cfg.remotePath}`, DEVTOOLS_BIN, ...cfg.devToolsArgs],
		exposure: "codemode",
		timeout: DEVTOOLS_REQUEST_TIMEOUT_SECONDS,
		description: `Remote Chromium on instabox '${box}' (fixed box): DOM/accessibility snapshots, clicks, element screenshots, CSS cascade, network, console, performance traces. Tools are not declared directly — discover them with describeNamespace("mcp__instabox_devtools") or searchTools("devtools").`,
	} satisfies DevToolsMcpServerConfig satisfies McpServerConfig;

	return { name: "instabox-devtools", config };
}

export interface PrepareDevToolsOptions {
	/** 注入的 CLI 执行函数（与装配层共用同一个 `pi.exec` 薄封装） */
	exec: ExecFn;
	/** 公共的「准备一个可用 box」（装配层传 `pool.ensureReady`）：唤醒链只有那一份实现 */
	ensureReady: Pool["ensureReady"];
	/** 承载 DevTools MCP 的箱（调用方已校验非空） */
	box: string;
	/** 远端 PATH（`remotePath`）与 `autoInstallDevTools` 都从这里来 */
	cfg: InstaboxConfig;
	/** 取消信号：透传给 `ensureReady` 与远端命令 */
	signal?: AbortSignal;
	/** 检查/安装失败的唯一出口（只 warn，不影响结果）；不给就只记日志 */
	warn?: (message: string) => void;
}

export interface PrepareDevToolsResult {
	/** `true` = 箱已可用（`ensureReady` 成功）且远端检查跑过（检查/安装失败不影响该值） */
	ok: boolean;
	/** 失败原因（`ok: false` 时必有） */
	error?: string;
}

/** `unknown` → message 文本（错误文本里不出现 `[object Object]`）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 确保远端有 `chrome-devtools-mcp`：`instabox exec … sh -c 'command -v chrome-devtools-mcp'`
 * → 缺失且 `autoInstallDevTools` 时 `sudo -n env "PATH=…" npm i -g chrome-devtools-mcp`。
 *
 * 检查与安装的失败都只 warn：装不上不是注册的否决项（远端可能早就装好，或用户自己会处理），
 * 而这里放弃注册会把「一个工具都没有」变成一个更难排查的静默降级。
 */
async function prepareRemoteBinary(options: PrepareDevToolsOptions): Promise<PrepareDevToolsResult> {
	const { exec, box, cfg, signal } = options;
	const check = await execRemote(exec, box, ["sh", "-c", `command -v ${DEVTOOLS_BIN}`], {
		timeoutMs: CHECK_TIMEOUT_MS,
		envPath: cfg.remotePath,
		signal,
	});
	// 检查/安装的任何结果都不否决注册（见上方契约）：往前推进一定返回 `{ ok: true }`
	if (check.ok) return { ok: true };
	if (!cfg.autoInstallDevTools) {
		logEvent("devtools.install", { box, ok: false, skipped: true });
		options.warn?.(
			`instabox: 远端箱 "${box}" 上没有 ${DEVTOOLS_BIN}（autoInstallDevTools=false，未安装）；DevTools 工具连接时会报 command not found。`,
		);
		return { ok: true };
	}
	// sudo 按 `secure_path` 重写 PATH，所以显式再传一次（与 `--env` 的 PATH 同一个值）
	const install = await execRemote(
		exec,
		box,
		["sudo", "-n", "env", `PATH=${cfg.remotePath}`, "npm", "i", "-g", DEVTOOLS_BIN],
		{ timeoutMs: INSTALL_TIMEOUT_MS, envPath: cfg.remotePath, signal },
	);
	logEvent("devtools.install", { box, ok: install.ok }, install.ok ? "info" : "warn");
	// 安装成功也静默：真正的可用性由第一次 MCP 调用验证（模板的 npm prefix 与 remotePath 不一致时
	// `command -v` 依旧会失败），多报一句只是噪音
	if (!install.ok) {
		options.warn?.(
			`instabox: 在 "${box}" 上安装 ${DEVTOOLS_BIN} 失败（${install.error}）；DevTools 工具可能不可用。`,
		);
	}
	return { ok: true };
}

/**
 * 注册前的准备（**必须**在 `registerMcpServer` 之前 await）：箱可用 + 远端有可执行文件。
 *
 * 前半步整段委托给注入的 {@link PrepareDevToolsOptions.ensureReady}（`pool.ensureReady`：查状态 →
 * 唤醒链 → 确认 `running`），本模块**不**再写一遍唤醒逻辑；后半步只做远端二进制检查/安装。
 * 只有 `ensureReady` 失败才返回 `ok: false`（调用方据此不注册）；检查/安装失败只经 `warn` 报到
 * stderr。整个函数不 throw：任何意外异常都收成 `{ ok: false, error }`。
 */
export async function prepareDevTools(options: PrepareDevToolsOptions): Promise<PrepareDevToolsResult> {
	const startedAt = Date.now();
	let result: PrepareDevToolsResult;
	try {
		const ready: EnsureReadyResult = await options.ensureReady(options.box, {
			allowWake: true,
			signal: options.signal,
		});
		// 箱都准备不好就不必再花 20 秒查远端：调用方本来就不会注册
		result = ready.ok ? await prepareRemoteBinary(options) : { ok: false, error: ready.error };
	} catch (error) {
		result = { ok: false, error: messageOf(error) };
	}
	logEvent(
		"devtools.prepare",
		{ box: options.box, ok: result.ok, ms: Date.now() - startedAt, error: result.ok ? undefined : result.error },
		result.ok ? "info" : "warn",
	);
	return result;
}
