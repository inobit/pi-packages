import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 插件配置，全部字段有内置默认值，支持全局/项目 config.json 逐字段覆盖（数组字段跨层并集，非数组字段高层覆盖）。 */
export interface PermissionConfig {
  /** 敏感文件清单（FR-1 / D2），glob 模式；含 `/` 的匹配绝对路径，否则匹配文件名。 */
  sensitivePatterns: string[];
  /** `.env.example` 读取是否免弹窗（FR-1 例外），写入仍按敏感文件处理。 */
  envExampleReadAllowed: boolean;
  /** 高频只读 bash 命令白名单（FR-5），命令名命中即视为只读。 */
  readonlyBashCommands: string[];
  /**
   * 危险操作统一清单（FR-4，仅作用于 bash 工具），命中即 ask（build）/ deny（plan）。
   * 条目两种格式：纯命令名（如 `sudo`、`dd`）或 `git <子命令>`（如 `git commit`、`git push`）。
   * 不在清单中的 git 子命令视为只读（status/diff/log 等静默放行）；
   * 固定规则不可配置：rm 递归（-r/-R/--recursive）与通配目标、chmod/chown/chgrp -R、
   * curl/wget 管道到 shell、wrapper 命令（bash -c/eval/sudo/xargs/find -exec）、
   * chmod 数字形态 0?777、解释器 -c/-e 字面载荷命中严重级谓词。
   */
  dangerousBashCommands: string[];
  /** PowerShell 只读 cmdlet 白名单（FR-5 等价），规范名命中即视为只读；别名在分类前已归一化。 */
  readonlyPowerShellCommands: string[];
  /**
   * 危险 PowerShell 命令清单（FR-4 等价，仅作用于 powershell 工具），条目为规范 cmdlet 名或原生 exe 名（小写）。
   * 固定规则不可配置：iex/Invoke-Expression、icm/Invoke-Command、Set-ExecutionPolicy、sc（二义性保守）、
   * Remove-Item -Recurse/-Force、嵌套 pwsh/powershell 解释器、调用操作符 & / 点源 / 脚本块、irm|iex 类管道执行。
   */
  dangerousPowerShellCommands: string[];
  /**
   * 严重级（critical）bash 命令清单：主机级不可逆破坏，高 `dangerousBashCommands` 一级。
   * chill 模式拿它做唯一 ask 来源；build 的有效危险数组为 `dangerousBashCommands ∪ criticalBashCommands`（并集匹配）。
   * 条目格式同 `dangerousBashCommands`；并集语义下默认条目删不掉（要删改 `DEFAULT_CONFIG`）。
   */
  criticalBashCommands: string[];
  /** 严重级 PowerShell 命令清单（chill 唯一 ask 来源之一；build 与 `dangerousPowerShellCommands` 取并集匹配）。 */
  criticalPowerShellCommands: string[];
  /** chill 模式命中敏感文件时的动作：默认 `deny`（与 yolo 同严）；置 `ask` 改为弹窗。 */
  chillSensitiveAction: "deny" | "ask";
  /** 新会话默认模式：仅开放 `build` / `chill`（显式 opt-in）；`yolo`/`plan` 与非法值回退 `build` 并告警。 */
  defaultMode: "build" | "chill";
  /** trusted 外部路径前缀（FR-9）：落在前缀下的外部读写直接放行（如 `/tmp` 临时文件）；
   * realpath 双形态防软链逃逸；仅作用于目录放行层面，不改变危险/敏感判定的优先级。 */
  trustedExternalPaths: string[];
  /** 附加项目根目录（E）：与 cwd 同为“域内”（对标 OpenCode 启动目录 ∪ worktree 根）。
   * 注意这是域内不是 trusted——plan 下写此类目录文件照样 deny；数组字段走跨层并集。 */
  additionalProjectRoots: string[];
  /** 内置只读工具（FR-8.3 plan 放行；内置默认 ∪ 用户配置）。 */
  readonlyTools: string[];
  /** strictPlanMode：未知工具在 plan 下由 ask 收紧为 deny（FR-8.3）。 */
  strictPlanMode: boolean;
  /** plan/build 切换快捷键（pi 键位 id，如 `alt+p`）；空字符串或省略禁用快捷键。 */
  toggleModeShortcut: string;
  /** 是否记录审查日志（FR-6 / D4）。 */
  reviewLog: boolean;
  /** 是否记录调试日志（详细事件，默认关；与审查日志分离，参考 pi 生态双流实践）。 */
  debugLog: boolean;
  /** 审查日志目录，相对 `~/.pi/agent`（尊重 `PI_CODING_AGENT_DIR`）；支持绝对路径与 `~/`。扩展目录仅放配置。 */
  logDir: string;
}

/** 内置写工具（固定，不可配置）：plan 下明确 deny，与 write/edit 同级（D6）。 */
export const BUILTIN_WRITE_TOOLS: readonly string[] = ["write", "edit"];

/** 内置只读工具（pi 核心 createReadOnlyTools），UI 选择中锁定不可取消。 */
export const BUILTIN_READONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export const DEFAULT_CONFIG: PermissionConfig = {
  sensitivePatterns: [
    "*.env",
    "*.env.*",
    "~/.ssh/*",
    "*.pem",
    "*.key",
    "id_rsa*",
    "credentials.json",
    "secrets*.yaml",
    "~/.aws/*",
    ".npmrc",
    "~/.config/gh/hosts.yml",
  ],
  envExampleReadAllowed: true,
  readonlyBashCommands: [
    // 环境/目录/Shell 内建类
    "cd", "pwd", "env", "which", "echo", "printf", "export", "unset", "alias", "type", "command", "builtin", "hash", "set",
    // 文件查看类
    "cat", "ls", "dir", "vdir", "tree", "find", "locate", "stat", "file", "du", "df",
    "nl", "od", "hexdump", "xxd", "strings", "wc", "less", "more", "head", "tail",
    // 搜索类
    "grep", "rg", "ag", "ack", "fzf",
    // 文本比较/处理（只读形态）
    "diff", "comm", "cmp", "sort", "uniq", "cut", "paste", "join", "tr", "sed", "jq",
    // 进程/系统信息类
    "ps", "top", "htop", "uptime", "date", "who", "whoami", "id", "uname", "hostname",
    "free", "vmstat", "iostat", "netstat", "ss", "lsof",
    // 会话基础设施类
    "sleep", "tmux", "agent-browser", "clear", "history",
    // 路径/条件 introspect 与无文件副作用的信息输出类（F1）
    "[", "test", "true", "false",
    "basename", "dirname", "readlink", "realpath",
    "seq", "nproc", "tty", "logname", "groups", "printenv", "locale", "getconf",
    "tput", "jobs", "yes", "cal",
  ],
  dangerousBashCommands: [
    // git 写操作（`git <子命令>` 条目；不在清单中的 git 子命令视为只读）
    "git add", "git commit", "git push", "git pull", "git merge", "git rebase", "git reset",
    "git checkout", "git restore", "git clean", "git branch", "git remote", "git stash",
    "git tag", "git mv", "git rm", "git switch", "git revert", "git cherry-pick",
    "git gc", "git prune", "git repack", "git am", "git apply", "git submodule", "git worktree",
    "git update-index", "git update-ref", "git lfs", "git init", "git clone", "git config",
    "git notes", "git replace", "git filter-branch", "git bisect",
    // 系统/磁盘操作
    "sudo", "su", "dd", "mkfs", "mkfs.ext2", "mkfs.ext3", "mkfs.ext4", "mkfs.xfs",
    "fdisk", "gdisk", "parted", "wipefs", "mount", "umount", "chroot",
    "shutdown", "reboot", "halt", "poweroff", "init",
    // 进程操作
    "kill", "pkill", "killall",
    // 网络/防火墙
    "iptables", "ip6tables", "ufw", "firewall-cmd",
  ],
  readonlyPowerShellCommands: [
    // 目录/内容读取
    "get-childitem", "get-content", "get-item", "get-itemproperty", "get-location",
    "get-filehash", "get-authenticodesignature", "get-acl",
    "test-path", "resolve-path", "join-path", "split-path", "format-hex",
    "import-csv", "import-clixml", "import-powershelldatafile",
    "test-connection", "test-netconnection",
    // 对象/系统信息查询
    "get-process", "get-service", "get-command", "get-help", "get-member",
    "get-variable", "get-alias", "get-psdrive", "get-psprovider", "get-wmiobject",
    "get-date", "get-random", "get-culture", "get-uiculture", "get-host", "get-verb",
    "get-eventlog", "get-winevent", "get-computerinfo", "get-history", "get-module",
    "get-itempropertyvalue", "get-clipboard",
    // 文本过滤/排序/比较/格式化
    "select-string", "select-object", "select-xml", "where-object", "foreach-object",
    "sort-object", "group-object", "measure-object", "measure-command", "compare-object",
    "format-table", "format-list", "format-wide", "format-custom",
    "convertto-json", "convertto-csv", "convertto-html", "convertto-xml",
    "convertfrom-json", "convertfrom-csv", "convertfrom-stringdata",
    // 输出与会话内建
    "out-string", "out-host", "out-default", "out-null",
    "write-output", "write-host", "write-warning", "write-error",
    "write-verbose", "write-debug", "write-information", "write-progress",
    "clear-host", "start-sleep", "push-location", "pop-location", "exit",
  ],
  dangerousPowerShellCommands: [
    // 远程/任意代码执行
    "start-process", "saps", "new-psdrive",
    // 服务/进程控制
    "stop-process", "kill", "stop-service", "set-service", "new-service", "start-service",
    // 系统/计划任务/注册表/磁盘
    "register-scheduledtask", "schtasks", "reg", "wmic", "diskpart", "format-volume",
    "restart-computer", "stop-computer", "clear-eventlog", "remove-computer",
    // 动态编译与模块加载（模块代码任意执行）
    "add-type", "new-object", "import-module", "invoke-item", "invoke-wmimethod", "invoke-cimmethod",
    // 后台作业（脚本块任意执行，wrapper 已兜底，显式列出便于配置感知）
    "start-job", "receive-job",
  ],
  criticalBashCommands: [
    // 磁盘/分区销毁
    "dd", "mkfs", "mkfs.ext2", "mkfs.ext3", "mkfs.ext4", "mkfs.xfs",
    "fdisk", "gdisk", "parted", "wipefs",
    // 断电/停机
    "shutdown", "reboot", "halt", "poweroff", "init",
  ],
  criticalPowerShellCommands: [
    // 磁盘/机器级破坏
    "format-volume", "diskpart", "remove-computer",
    // 断电/重启/日志清除
    "restart-computer", "stop-computer", "clear-eventlog",
  ],
  // chill 敏感文件动作：默认 deny（与 yolo 一致，严于 build 的 ask）
  chillSensitiveAction: "deny",
  // 默认模式 build：存量行为不变，chill 需显式 opt-in
  defaultMode: "build",
  // trusted 外部路径：默认 `/tmp`（运行时并入 os.tmpdir() 系统临时目录），可配置追加
  trustedExternalPaths: ["/tmp"],
  // 附加项目根：默认空，由用户按需配置；另有 findGitRoot 自动识别（path.ts）
  additionalProjectRoots: [],
  // 仅 pi 核心内置只读工具（createReadOnlyTools：read/grep/find/ls）；
  // 第三方扩展工具（web_search/agent-browser/skill/mcp_*/ffgrep 等）需用户自行追加（取并集）
  readonlyTools: [...BUILTIN_READONLY_TOOLS],
  strictPlanMode: false,
  toggleModeShortcut: "alt+p",
  reviewLog: true,
  debugLog: false,
  logDir: "logs/pi-permission",
};

/** 浅合并：仅允许覆盖 PermissionConfig 顶层字段。 */
export type PartialConfig = { [K in keyof PermissionConfig]?: PermissionConfig[K] };

/** 数组字段（default ∪ global ∪ project 跨层并集，去重，不替换）；非数组字段按高层覆盖。 */
const ARRAY_FIELDS = new Set<keyof PermissionConfig>([
  "sensitivePatterns",
  "readonlyBashCommands",
  "dangerousBashCommands",
  "criticalBashCommands",
  "readonlyPowerShellCommands",
  "dangerousPowerShellCommands",
  "criticalPowerShellCommands",
  "trustedExternalPaths",
  "additionalProjectRoots",
  "readonlyTools",
]);
/** chill 敏感文件动作归一：非法值回退 `deny`（唯一安全默认），并在 debugLog 开启时告警。 */
export function normalizeChillSensitiveAction(
  value: unknown,
  warn: (message: string) => void = () => {},
): "deny" | "ask" {
  if (value === "deny" || value === "ask") return value;
  warn(`[pi-permission] invalid chillSensitiveAction ${JSON.stringify(value)}, falling back to "deny"`);
  return "deny";
}

/** 默认模式归一：仅开放 build/chill；`yolo`/`plan` 与非法值回退 `build`（避免旁路 /yolo 的 UI 确认门与 plan 工具集接线）。 */
export function normalizeDefaultMode(value: unknown, warn: (message: string) => void = () => {}): "build" | "chill" {
  if (value === "build" || value === "chill") return value;
  warn(`[pi-permission] invalid defaultMode ${JSON.stringify(value)}, falling back to "build"`);
  return "build";
}

/** 与 pi 核心 getAgentDir() 对齐的 agent 根（尊重 PI_CODING_AGENT_DIR）。 */
export function getAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR;
  if (env) {
    if (env === "~" || env.startsWith("~/") || env.startsWith("~\\")) return path.join(os.homedir(), env.slice(2));
    return env;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export interface LoadConfigOptions {
  /** 全局配置路径，默认 `<agentDir>/extensions/pi-permission/config.json`（`~/.pi/agent/...`，尊重 PI_CODING_AGENT_DIR）。 */
  globalPath?: string;
  /** 项目配置路径，默认 `<cwd>/.pi/extensions/pi-permission/config.json`。 */
  projectPath?: string;
  /** 项目是否被信任；未信任时忽略项目配置。 */
  trusted?: boolean;
}

/** 加载并合并配置：default < global < project；数组字段逐层并集，其余字段高层覆盖。 */
export function loadConfig(cwd: string, options: LoadConfigOptions = {}): PermissionConfig {
  const globalPath =
    options.globalPath ?? path.join(getAgentDir(), "extensions", "pi-permission", "config.json");
  const projectPath = options.projectPath ?? path.join(cwd, ".pi", "extensions", "pi-permission", "config.json");

  const merged: PartialConfig = {};
  const arrayGuardWarnings: string[] = [];
  for (const file of [globalPath, options.trusted === true ? projectPath : undefined]) {
    if (!file) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PartialConfig;
      for (const key of Object.keys(parsed) as (keyof PermissionConfig)[]) {
        const value = parsed[key];
        if (value === undefined) continue;
        if (ARRAY_FIELDS.has(key) && Array.isArray(value)) {
          // 数组字段：与既有值（已含 default/更低层）并集去重
          const base = merged[key] as string[] | undefined;
          (merged as Record<string, unknown>)[key] = [...new Set([...(base ?? []), ...(value as string[])])];
        } else if (ARRAY_FIELDS.has(key)) {
          // 数组字段给非数组值：跳过该层 + 告警，按默认生效（不抛，不污染后续展开）
          arrayGuardWarnings.push(`[pi-permission] config field "${key}" must be an array, ignoring value from ${path.basename(file)}`);
        } else {
          (merged as Record<string, unknown>)[key] = value;
        }
      }
    } catch {
      // 配置文件不存在或损坏时静默忽略，使用默认值
    }
  }

  const config: PermissionConfig = { ...DEFAULT_CONFIG, ...merged };
  // 数组字段与内置默认并集（default ∪ 全局 ∪ 项目）
  for (const key of ARRAY_FIELDS) {
    const extra = merged[key] as string[] | undefined;
    if (extra) {
      (config as unknown as Record<string, unknown>)[key] = [
        ...new Set([...(DEFAULT_CONFIG[key] as string[]), ...extra]),
      ];
    }
  }
  // 非数组标量字段归一（非法值回退安全默认，debugLog 开启时才告警）
  const warnIfDebug = (message: string) => {
    if (config.debugLog === true) console.warn(message);
  };
  config.chillSensitiveAction = normalizeChillSensitiveAction(config.chillSensitiveAction, warnIfDebug);
  config.defaultMode = normalizeDefaultMode(config.defaultMode, warnIfDebug);
  for (const message of arrayGuardWarnings) warnIfDebug(message);
  return config;
}