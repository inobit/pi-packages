# @inobit/pi-permission

轻量权限控制扩展，用于 [Pi coding agent](https://pi.dev)。只做四件事，其余一概不打扰：

1. **敏感文件保护**：`.env`、`.ssh/*`、`*.pem` 等敏感文件，任何通道（工具/bash）的读与写都弹窗确认。
2. **项目边界**：项目外（cwd 外）读取走 read 白名单（命中放行、其余 ask），写入需确认。
3. **敏感操作确认**：`git push`/`git reset --hard`、`rm -rf`、`sudo`、`curl | sh` 等始终确认。
4. **plan/build 模式**：`/plan` 只读（写操作拒绝），`/build` 回到正常模式。

## 特性

- 零第三方依赖（除 pi 核心包），纯本地确定性决策，fail-closed 绝不静默放行
- 只读/写精确区分到路径粒度，符号链接/相对路径不可绕过，cd 后相对路径正确判定
- 敏感文件规则跨所有工具 + bash 统一生效
- 高频必需操作（`cat`/`grep`/`ls`/`git status`/`sleep` 等）零打扰

## 安装

```bash
pi install npm:@inobit/pi-permission
```

## 命令

```
/plan   进入只读规划模式（写操作拒绝，状态栏显示 Plan）
/build  回到正常模式（Build）
/readonly-tools   管理 plan 模式只读工具（空格多选，session/project/global 三级）
```

- 默认 build 模式，会话级、不持久化（重启回到 build）
- **切换快捷键**：`Alt+P` 在 plan/build 之间循环切换（可在 `toggleModeShortcut` 配置中改为其他键位，空字符串禁用，键位格式见 pi [keybindings](https://pi.dev/docs/keybindings)）
- 状态栏：`Plan` 绿 / `Build` 红（主题色），键名 `pi-permission-mode`

## 判定优先级（从高到低）

**plan 模式**（不分 cwd 内外）：明确的写（write/edit、bash 重定向/写命令）→ deny；敏感操作 → deny；敏感文件 → ask；read 白名单 → allow；其他 → ask（`strictPlanMode` 时 deny）

**build 模式**：敏感操作 ask → 敏感文件 ask →（cwd 内 allow；cwd 外 read 白名单 allow → 其他 ask）

## 配置

按层级合并（数组字段跨层**并集**去重，非数组字段高层覆盖）：

| 层级 | 位置 |
| -- | ---- |
| 全局 | `~/.pi/agent/extensions/pi-permission/config.json` |
| 项目 | `.pi/extensions/pi-permission/config.json`（需项目被信任） |
| session | 内存（`/readonly-tools` 选 session，重启失效） |

| 字段 | 含义 | 默认 |
| -- | ---- | ---- |
| `sensitivePatterns` | 敏感文件 glob 清单 | `*.env` `*.env.*` `~/.ssh/*` `*.pem` `*.key` `id_rsa*` `credentials.json` `secrets*.yaml` `~/.aws/*` `.npmrc` |
| `envExampleReadAllowed` | `.env.example` 读取免弹窗 | `true` |
| `readonlyBashCommands` | bash read 白名单 | 高频只读命令（cat/grep/ls/...，约 70 项） |
| `dangerousBashCommands` | 敏感操作统一清单（`sudo` 或 `git commit`） | git 写子命令 + 危险 shell |
| `readonlyTools` | 工具 read 白名单（各层并集） | `read grep find ls` |
| `strictPlanMode` | plan 下非白名单由 ask 收紧为 deny | `false` |
| `toggleModeShortcut` | plan/build 切换快捷键（空字符串禁用） | `alt+p` |
| `reviewLog` | 审查日志开关（FR-6） | `true` |
| `debugLog` | 调试日志开关（与审查日志分离，详细事件） | `false` |
| `logDir` | 日志目录（相对全局扩展目录 `~/.pi/agent/extensions/pi-permission`，0600） | `logs` |

> 固定规则（不可配置）：内置写工具 `write`/`edit`、`rm -r/-f`、`chmod -R`、`chown -R`、
> `curl/wget | sh/bash`、`bash -c`/`eval`/`sudo`/`xargs`/`find -exec` 恒为敏感操作；
> 重定向 `>`/`>>` 写目标固定检测；不在 `dangerousBashCommands` 的 git 子命令自动视为只读。
> 弹窗 reason 带 `[bash]` / `[tool:<name>]` 来源前缀并附配置建议。

## /readonly-tools 交互

空格选中/取消选中、`↑`/`↓`/`j`/`k` 移动、`Enter` 完成、`Esc`/`q` 取消。先选编辑目标（**每层只改自己，其他层锁定**）：

- **session**（内存，会话级）：内置 + 全局 + 项目已配置工具锁定
- **project**（写项目 `.pi/extensions/pi-permission/config.json`）：内置 + 全局已配置锁定，需项目被信任
- **global**（写全局 config.json）：仅内置工具锁定

内置工具（`read`/`grep`/`find`/`ls`）、`bash`、`write`/`edit` 恒锁定。

## 与状态栏插件集成

- **pi 内置 statusline**：`Plan`/`Build` 显示在 footer 扩展状态行，无需配置。
- **pi-powerline-footer**：状态值不带 `[` 前缀，进入 `extension_statuses` 聚合段；放主状态栏最左边时配置：

```json
{
  "powerline": {
    "preset": "default",
    "placement": "below",
    "customItems": [
      { "id": "pi-mode", "statusKey": "pi-permission-mode", "position": "left", "excludeFromExtensionStatuses": true }
    ],
    "layout": { "left": ["custom:pi-mode", "model", "thinking", "shell_mode", "path", "git", "queue", "context_pct", "cache_read", "cost"] }
  }
}
```

## License

MIT
