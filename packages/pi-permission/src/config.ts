import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 插件配置，全部字段有内置默认值，支持全局/项目 config.json 逐字段覆盖（数组整体替换，readonlyTools 取并集）。 */
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
   * 固定规则不可配置：rm -r/-f、chmod -R、chown -R、curl/wget 管道到 shell、wrapper 命令（bash -c/eval/sudo/xargs/find -exec）。
   */
  dangerousBashCommands: string[];
  /** trusted 外部路径前缀（FR-9）：落在前缀下的外部读写直接放行（如 `/tmp` 临时文件）；
   * realpath 双形态防软链逃逸；仅作用于目录放行层面，不改变危险/敏感判定的优先级。 */
  trustedExternalPaths: string[];
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
    "diff", "comm", "cmp", "sort", "uniq", "cut", "paste", "join", "tr",
    // 进程/系统信息类
    "ps", "top", "htop", "uptime", "date", "who", "whoami", "id", "uname", "hostname",
    "free", "vmstat", "iostat", "netstat", "ss", "lsof",
    // 会话基础设施类
    "sleep", "tmux", "agent-browser", "clear", "history",
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
  // trusted 外部路径：默认 `/tmp`（运行时并入 os.tmpdir() 系统临时目录），可配置追加
  trustedExternalPaths: ["/tmp"],
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
  "trustedExternalPaths",
  "readonlyTools",
]);
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
  return config;
}