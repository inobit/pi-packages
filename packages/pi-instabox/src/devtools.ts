/**
 * @inobit/pi-instabox — DevTools MCP：helper 脚本生成/写盘 + `registerMcpServer` 参数（方案 §4.6、§5.1、T13）。
 *
 * 契约：
 * - helper 是**运行期产物**而非配置：落在 `<agentDir>/pi-instabox/bin/devtools-connect.sh`
 *   （`paths.helperScript`，裁决 V3）。每次加载 `mkdir -p` + 幂等覆盖 + `chmod 0o755`；
 *   写盘失败只 `warn`，不 throw 到会话层。
 * - 脚本的 stdout **只承载 JSON-RPC**：pi 把 MCP 的 `command` 直接 exec（不经 shell），
 *   任何写到 stdout 的诊断都会破坏 MCP 握手，所以诊断一律 stderr。
 * - 脚本自己把箱拉起来（`wake`，失败再 `start`）：MCP 客户端不会唤醒箱，pi 也不会重连
 *   失败的 server——箱暂停时若直接把检查/ssh 打过去，结果是 0 个工具且整场会话不再恢复。
 *   两条命令都用 shell 的 `timeout`（有则用）封顶 {@link PREPARE_TIMEOUT_SECONDS} 秒。
 * - PATH 走 `instabox exec --env PATH=…`（CLI 原生能力，方案 C-c「比 `env PATH=… cmd` 包装更干净」）；
 *   最后一段 `instabox ssh` 没有 `--env`，只能用 `env PATH=…` 前缀。
 * - 内容全部来自参数（`remotePath` / `autoInstall`），本模块不读 `DEFAULT_CONFIG`；
 *   也不做 box 存在性预校验：连接失败就是最好的报错（方案 §8.3）。
 * - 零第三方**运行时**依赖：只用 `node:fs` / `node:path`（宿主类型 `McpServerConfig` 仅 `import type`，
 *   编译后擦除），且都经注入面（默认实现见 {@link nodeHelperScriptFileSystem}），单测不落真实文件。
 */

import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { InstaboxConfig, InstaboxPaths } from "./config.ts";
import { logEvent } from "./log.ts";

/**
 * 远端安装检查的 `instabox exec --timeout`（秒）。
 *
 * 真正上界不是 CLI 的 600 秒上限，而是 pi 的 **per-request timeout**
 * （{@link DEVTOOLS_REQUEST_TIMEOUT_SECONDS} 秒，即注册配置的 `timeout`）：MCP 客户端对
 * `initialize` 也计时，而 helper 的唤醒/检查/安装全都发生在 `initialize` 应答之前
 * （`chrome-devtools-mcp` 还没 exec 出来）。所以脚本预算必须小于那个 timeout。
 */
const CHECK_TIMEOUT_SECONDS = 10;

/**
 * 安装本身的 `--timeout`（秒）：`npm i -g` 要拉 tarball，但「检查 + 安装」（10 + 40 = 50 秒）
 * 仍须和前面的唤醒一起留在 per-request timeout（180 秒）以内——唤醒段每条命令由
 * `timeout` 封顶 {@link PREPARE_TIMEOUT_SECONDS} 秒（`wake` + `start` 最坏 2 × 60）。
 */
const INSTALL_TIMEOUT_SECONDS = 40;

/**
 * helper 自己拉起箱时的准备阶段上限（秒）：`timeout` 命令包住每条 `instabox wake`/`start`，
 * 让一条卡住的 CLI 不能把 MCP 握手拖到天荒地老（与 `DEFAULT_CONFIG.timeouts.prepareMs` 的
 * 1 分钟对齐；本模块不读配置，故在这里单点维护）。
 *
 * 它**不是**真正的上界：真正的上界是 pi 的 MCP per-request timeout
 * （{@link DEVTOOLS_REQUEST_TIMEOUT_SECONDS} 秒）——脚本整个前置段（唤醒 ×2 ＋ 检查 ＋ 安装）
 * 都在 `initialize` 应答之前跑完。系统里没有 `timeout` 命令时就不包（退回旧行为）。
 */
const PREPARE_TIMEOUT_SECONDS = 60;

/** helper 权限位：MCP 的 `command` 被直接 exec，可执行位是硬要求。 */
const HELPER_MODE = 0o755;

/** MCP server 名：只允许这一种拼写（`instabox_devtools` 与之撞名，方案 C-e）。 */
const DEVTOOLS_SERVER_NAME = "instabox-devtools";

/**
 * `registerMcpServer` 的每请求超时（秒）：默认 60 偏紧，桌面/浏览器操作给 180（方案 C-d）。
 * 它同时是 helper 脚本前置工作（唤醒 2 × {@link PREPARE_TIMEOUT_SECONDS} + 检查
 * {@link CHECK_TIMEOUT_SECONDS} + 安装 {@link INSTALL_TIMEOUT_SECONDS}，最坏 170 秒）
 * 的总上界——四者之和必须留在它以内，改小这里必须同步压缩脚本预算。
 */
const DEVTOOLS_REQUEST_TIMEOUT_SECONDS = 180;

/** 脚本内的 PATH 变量名：`--env`/`env` 两处都引用它，改字面量只改这里。 */
const REMOTE_PATH_VAR = "remote_path";

export interface BuildHelperScriptOptions {
	/** 远端 PATH（来自 `cfg.remotePath`，不硬编码） */
	remotePath: string;
	/** 远端缺 `chrome-devtools-mcp` 时是否尝试自动安装（来自 `cfg.autoInstallDevTools`） */
	autoInstall: boolean;
}

/**
 * POSIX 单引号字面量：值内的 `'` 写成 `'\''`。
 * 脚本里所有配置值插值都走这个函数，避免任何配置值能破出引号。
 */
function shSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * 安装命令（远端执行）：`sudo -n env "PATH=<remotePath>"` 把 `--env` 给的 PATH 再显式交给 sudo。
 *
 * 理由：sudo 默认按 `secure_path` 重写 PATH，`--env PATH=…` 传进去的 npm 目录可能在 sudo 下丢失，
 * `sudo -n npm` 就会 "command not found"。**待真机复核**：sandbox 镜像的 sudoers/`secure_path`
 * 还没在实际 box 上验证过（未复核，属于经验性保险）。
 */
function buildInstallCommand(remotePath: string): string {
	return `sudo -n env "PATH=${remotePath}" npm i -g chrome-devtools-mcp`;
}

/**
 * 生成 helper 脚本（纯函数，便于单测断言内容）。
 *
 * 脚本职责：`devtools-connect.sh <box> [chrome-devtools-mcp args...]` → 先 `wake`（失败再 `start`）
 * 拉起箱 → 远端缺包时检查/可选安装 →
 * `exec instabox ssh <box> -- env PATH=… chrome-devtools-mcp "$@"`，stdout 只留 JSON-RPC。
 */
export function buildHelperScript(options: BuildHelperScriptOptions): string {
	const remotePath = shSingleQuote(options.remotePath);
	const installBlock = options.autoInstall
		? `  printf 'instabox-devtools: installing chrome-devtools-mcp on %s\\n' "$box" >&2
  # sudo 按 secure_path 重写 PATH，故显式再传一次（待真机复核）。
  instabox exec "$box" --env "PATH=$${REMOTE_PATH_VAR}" --timeout ${INSTALL_TIMEOUT_SECONDS} -- \\
      sh -c ${shSingleQuote(buildInstallCommand(options.remotePath))} >&2 2>&1 || true`
		: `  printf 'instabox-devtools: auto-install disabled (autoInstallDevTools=false)\\n' >&2`;

	return `#!/bin/sh
# devtools-connect.sh —— 由 @inobit/pi-instabox 生成，勿手改（每次加载幂等覆盖）。
# 用法: devtools-connect.sh <box> [chrome-devtools-mcp args...]
#
# stdout 只承载 MCP 的 JSON-RPC 帧，诊断一律写 stderr（否则握手立刻崩）。
set -eu

if [ "$#" -lt 1 ]; then
  printf 'usage: devtools-connect.sh <box> [chrome-devtools-mcp args...]\\n' >&2
  exit 2
fi

box="$1"
shift
${REMOTE_PATH_VAR}=${remotePath}

# 0) 先确保箱在运行：MCP 客户端不会自己唤醒，pi 也不会重连失败的 server。
#    失败不阻断，让后面的检查/ssh 自然报错。每条唤醒命令包一层 \`timeout\`
#    （有就用，没有就不加）：准备阶段上限 ${PREPARE_TIMEOUT_SECONDS}s，
#    真实上界仍是 pi 的 MCP per-request timeout。
if command -v timeout >/dev/null 2>&1; then TO="timeout ${PREPARE_TIMEOUT_SECONDS}"; else TO=""; fi
$TO instabox wake "$box" >/dev/null 2>&1 || $TO instabox start "$box" >/dev/null 2>&1 || true

# 远端缺 chrome-devtools-mcp 时最多处理一次；检查与安装失败都不阻断连接，
# 让真正的 "command not found" 原样冒给 MCP 客户端。
if ! instabox exec "$box" --env "PATH=$${REMOTE_PATH_VAR}" --timeout ${CHECK_TIMEOUT_SECONDS} -- \\
    sh -c 'command -v chrome-devtools-mcp >/dev/null 2>&1' >/dev/null 2>&1; then
  printf 'instabox-devtools: chrome-devtools-mcp missing on %s\\n' "$box" >&2
${installBlock}
fi

exec instabox ssh "$box" -- env "PATH=$${REMOTE_PATH_VAR}" chrome-devtools-mcp "$@"
`;
}

/**
 * `pi.registerMcpServer(name, config)` 的 stdio 参数；`exposure` 钉死 `codemode`（方案 §4.3）。
 *
 * 本地细化类型，构造点用 `satisfies McpServerConfig` 绑到宿主并集上（见
 * {@link buildMcpServerConfig}），宿主改字段时这里先报错。
 */
export interface DevToolsMcpServerConfig {
	/** helper 脚本绝对路径 */
	command: string;
	/** `[devToolsBox, ...devToolsArgs]` */
	args: string[];
	/** 远端工具既不声明给模型、也不进 codemode 描述，脚本用 `searchTools()` 发现（方案 R3） */
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
 * 构造远端 `chrome-devtools-mcp` 的注册参数。
 *
 * `box` 是唯一对应的箱名（flag / 命令解析后传入），缺省沿用 `cfg.devToolsBox`；为空时调用方
 * 不该调用本函数（该能力整体不存在，方案 §4.3 验收③）。
 * `args` 每次新建数组，不与 `cfg.devToolsArgs` 共享引用。
 */
export function buildMcpServerConfig(
	cfg: InstaboxConfig,
	paths: InstaboxPaths,
	box: string = cfg.devToolsBox,
): DevToolsMcpServerRegistration {
	// 双重 satisfies：本地细化类型 + 宿主 `McpServerConfig`（stdio 并集）。宿主增删字段或收窄
	// `exposure` 时在编译期就炸，而不是留到 `registerMcpServer()` 或运行期。
	const config = {
		command: paths.helperScript,
		args: [box, ...cfg.devToolsArgs],
		exposure: "codemode",
		timeout: DEVTOOLS_REQUEST_TIMEOUT_SECONDS,
		description: `Remote Chromium on instabox '${box}' (fixed box): DOM/accessibility snapshots, clicks, element screenshots, CSS cascade, network, console, performance traces. Tools are not declared directly — discover them with describeNamespace("mcp__instabox_devtools") or searchTools("devtools").`,
	} satisfies DevToolsMcpServerConfig satisfies McpServerConfig;

	return { name: DEVTOOLS_SERVER_NAME, config };
}

/** 注入的文件系统：本模块只用这三个动作（不读回内容，覆盖写即是幂等）。 */
export interface HelperScriptFileSystem {
	/** `mkdir -p` */
	ensureDir: (dir: string) => void;
	/** 覆盖写文本（编码 UTF-8） */
	writeText: (file: string, text: string) => void;
	/** 设置权限位 */
	setMode: (file: string, mode: number) => void;
}

/** 默认文件系统：`node:fs`（运行期唯一的外部依赖面）。 */
export const nodeHelperScriptFileSystem: HelperScriptFileSystem = {
	ensureDir: (dir) => {
		fs.mkdirSync(dir, { recursive: true });
	},
	writeText: (file, text) => {
		fs.writeFileSync(file, text, "utf8");
	},
	setMode: (file, mode) => {
		fs.chmodSync(file, mode);
	},
};

export interface EnsureHelperScriptOptions extends BuildHelperScriptOptions {
	/** `resolvePaths()` 的返回值；本模块只消费 `helperScript` */
	paths: Pick<InstaboxPaths, "helperScript">;
	/** 注入的文件系统，默认 {@link nodeHelperScriptFileSystem} */
	fs?: HelperScriptFileSystem;
	/** 失败出口（目录/写盘/权限任何一步失败都只在这里报一次，不 throw） */
	warn?: (message: string) => void;
}

export interface EnsureHelperScriptResult {
	ok: boolean;
	/** 失败原因（`ok: false` 时必有） */
	error?: string;
}

/**
 * 把 helper 写到 `paths.helperScript`：`mkdir -p` 父目录 → 覆盖写 → `chmod 0o755`。
 * 三步共用一个 try：任一步失败都只 `warn` 一次并返回 `{ ok: false, error }`。
 */
export function ensureHelperScript(options: EnsureHelperScriptOptions): EnsureHelperScriptResult {
	const file = options.paths.helperScript;
	const io = options.fs ?? nodeHelperScriptFileSystem;
	const script = buildHelperScript({ remotePath: options.remotePath, autoInstall: options.autoInstall });
	try {
		io.ensureDir(path.dirname(file));
		io.writeText(file, script);
		io.setMode(file, HELPER_MODE);
		logEvent("devtools.helper", { ok: true, path: file });
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logEvent("devtools.helper", { ok: false, path: file, error: message });
		options.warn?.(`无法写入 DevTools helper ${file}: ${message}`);
		return { ok: false, error: message };
	}
}
