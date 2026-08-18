# @inobit/pi-permission

轻量权限控制扩展：敏感文件保护 / 项目边界读写区分 / 敏感操作确认 / plan-build 只读模式。零第三方依赖，决策纯本地、确定性，fail-closed。

## 判定优先级（改 decision.ts 前必读）

```
plan（不分 cwd 内外）：明确的写(重定向/写命令/write/edit) deny → 敏感操作 deny → 敏感文件 ask → read 白名单 allow → 其他 ask（strictPlanMode:true 时 deny）
build：敏感操作 ask → 敏感文件 ask →（cwd 内 allow | cwd 外 read 白名单 allow → 其他 ask）
```

- 敏感文件跨所有通道生效，realpath 双形态匹配防 symlink 绕过，`.env.example` 读取豁免
- 无路径信息的工具（如 MCP）视为 cwd 内
- **cd 跟踪**：链式命令中 cd 后相对路径按新目录判定（防 `cd /outside && cmd` 绕过）；
  `cd -`/无法解析时相对路径保守按外部处理
- fail-closed：解析失败 / `$(...)` / 子 shell / `curl|sh` → build=ask、plan=deny，绝不静默放行
- 插件自身异常降级为不拦截（不拖垮 pi 启动）
- **deny/拒绝反馈**：block 时给模型的 reason 为 `Permission was/by user denied. Do not retry this operation. (FR-x: ...)` +
  `terminate: true`，明确告知模型勿重试（避免把 deny 当"可批准，重试等确认"）

## 配置（config.ts 定义默认清单；全局/项目 config.json 覆盖）

字段：`sensitivePatterns`、`envExampleReadAllowed`、`readonlyBashCommands`、`dangerousBashCommands`（`git <子命令>` + 危险 shell）、`readonlyTools`、`strictPlanMode`（默认 false）、`reviewLog`、`logDir`。

- **数组字段全部跨层并集**（`sensitivePatterns`/`readonlyBashCommands`/`dangerousBashCommands`/`readonlyTools`）：
  default ∪ global ∪ project ∪ session，去重不覆盖（`ARRAY_FIELDS`）；非数组字段高层覆盖
- **无写命令/写工具配置**：内置写工具 `write`/`edit` 固定（plan 下明确 deny，`BUILTIN_WRITE_TOOLS`）；
  内置写命令识别（mv/cp/mkdir/touch 等位置参数为写目标，`WRITE_LAST_ARG`/`WRITE_ALL_ARGS` 硬编码）——
  `mv a /outside/` 提示 "writing outside project" 而非 read 白名单语义；
  read 白名单命令只有通过重定向 `>` 才可能写文件
- 内置 `readonlyTools` 仅 `read`/`grep`/`find`/`ls`（pi 核心只读工具）；
  第三方扩展工具（web_search/agent-browser/skill/mcp_*/ffgrep 等）需用户自行追加（各层并集）
- 固定规则不可配置：`rm -r/-f`、`chmod -R`、`chown -R`、`bash -c`/`eval`/`sudo`/`xargs`/`find -exec` 恒为敏感操作
- 不在 `dangerousBashCommands` 的 git 子命令自动视为只读；`exec_command` 按 bash 规则判定

## /readonly-tools 三级（每层只改自己，其他层锁定）

- 目标层：session（内存）/ project（`.pi/extensions/pi-permission/config.json`，需项目被信任）/ global（`~/.pi/.../config.json`）
- 锁定集：编辑 X 层时，locked = 内置(`UI_LOCKED`) ∪ 其他各层已有工具；保存该层增量 = selected - locked
- session 层存于 `index.ts` 的 `sessionReadonlyTools` Map；生效 = 持久层(loadConfig) ∪ session 层
- project 写入需 `isProjectTrusted()`；写文件后 `invalidateConfig` 清缓存

## 模块（src/）

| 文件 | 职责 |
| -- | ---- |
| `index.ts` | 工厂装配：订阅 tool_call/before_agent_start/session_start，注册 /plan /build，会话级批准 |
| `config.ts` | 默认清单 + 配置加载合并 |
| `decision.ts` | 判定引擎，reason 带 `[bash]`/`[tool:<name>]` 前缀 |
| `bash.ts` | 自研简化解析器：切分/token/重定向/git 子命令/wrapper/分类/写目标（仅重定向） |
| `path.ts` | 归一化 + realpath 双形态 + 敏感匹配 + cwd 边界 |
| `mode.ts` | plan/build 内存状态、命令、状态栏、系统提示注入 |
| `tools.ts` | `/readonly-tools`：空格多选 readonly tools，session（内置+全局锁定）/ global（仅内置锁定） |
| `ui.ts` | y/s/n 选择弹窗、无 UI 降级拒绝 |
| `audit.ts` | JSONL 审查日志 + 敏感键脱敏 |

## 集成

- 模式状态键 `pi-permission-mode`（值 `Plan`/`Build`，主题色：Plan 绿、Build 红；**不带 `[` 前缀**，
  否则 powerline 会归为通知类显示在编辑器上方而非 footer）；无 powerline 时显示于内置 footer 扩展状态行；
  需放主状态栏最左边时在 settings.json 配 `powerline.customItems`（position: left，见 README）
- subagent 继承宿主模式（内存态，会话级，不持久化）

## 测试

```bash
pnpm --filter @inobit/pi-permission test    # vitest（决策/bash/path/config/audit/装配）
pnpm --filter @inobit/pi-permission check   # tsc --noEmit
```

覆盖验收要点：`.env` 弹窗/豁免、软链绕过、外部读写区分、git 只读/写子命令、plan 全量行为、未知 ask/strict deny、日志脱敏。