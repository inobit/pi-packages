# Changelog

## [0.2.1] - 2026-08-19

### 修复

- 修正 FR-3/FR-5 外部路径提示文案歧义：原「not in read whitelist」易被误解为存在路径白名单（实际只有命令/工具级白名单）；改为「\`external path referenced by a non-whitelisted command/tool\`」，FR-5 明确为「\`read-only command/tool whitelist, external path allowed\`」
- ask 弹窗统一带触发主体展示行：bash 层所有 ask（FR-1 敏感文件 / FR-3 外部读写 / FR-4 危险 / FR-7 fail-closed / FR-8.3 plan 未知）details 尾部追加 \`bash:<command>\` 行，tool 层所有 ask 追加 \`tool:<tool_name>\` 行（空白归一化单行 + 120 字符截断，替换原 \`command: …\` 格式）；路径类详情保持首位，`s` 会话批准仍按路径记忆的粒度

## [0.2.0] - 2026-08-19

### 新增

- plan/build 切换快捷键：默认 `Alt+P`，在只读规划模式与正常模式之间循环切换（`registerShortcut` 实现，不占用 TUI 输入键位）
- 新增配置项 `toggleModeShortcut`（全局 `config.json`）：可自定义快捷键或空字符串禁用，键位格式与 pi 内置键位一致

## [0.1.2] - 2026-08-19

### 修复

- 无副作用重定向不再误判为外部写入：`2>/dev/null`、`&>/dev/null`、`2>&1`、`>&2`、`> /dev/null` 及 `tee /dev/null` 等不再触发「writing outside project」确认（纯读命令 `ls ... 2>/dev/null` 曾错误弹窗并列出 `/dev/null`）
- 位置参数/输入重定向的 `/dev/null` 不再视为外部读引用（`cat < /dev/null`、`tee /dev/null`）
- 真实外部写入（如 `> /tmp/x`、`2>~/err.log`）仍按 FR-3 拦截，行为不变
- 补充重定向豁免单元测试与 bash 决策集成回归用例（117 个用例全部通过）

## [0.1.1] - 2026-08-19

### 修复

- 审查日志不再写入项目目录，改到全局扩展目录 `~/.pi/agent/extensions/pi-permission/logs/<project>/`，按项目分目录隔离
- 对齐 pi 生态日志实践：debug/review 双流分离、字段宽度上限、大小轮转、`extension`/`stream`/`sessionId` 上下文
- 新增 `debugLog` 配置（默认关），审查日志开关仍为 `reviewLog`

## [0.1.0] - 2026-08-18

### 新增

- 轻量权限控制扩展（`@inobit/pi-permission`），pi 0.84.2+，jiti 直载免编译
- 敏感文件保护（FR-1）：`.env`/`.ssh/*`/`*.pem` 等任何通道读写 ask，realpath 双形态防 symlink 绕过，`.env.example` 读取豁免
- 项目边界（FR-3）：cwd 外读取走 read 白名单（命中放行、其余 ask），写操作外部 ask
- 敏感操作确认（FR-4）：`dangerousBashCommands` 统一清单（`git <子命令>` + 危险 shell），wrapper/管道恒敏感
- plan/build 模式（FR-8）：`/plan` `/build` 命令、状态栏（`Plan` 绿/`Build` 红主题色）、系统提示注入、写工具隐藏
- `/readonly-tools` 命令：空格多选 readonly tools，session/global 两级，锁定内置工具与 bash/write/edit
- 自研简化 bash 解析器（引号感知、重定向、git 子命令、wrapper、cd 跟踪、fail-closed）
- 审查日志（FR-6）：JSONL 0600，敏感键脱敏
- 106 个 vitest 用例

### 配置

- `sensitivePatterns` / `envExampleReadAllowed` / `readonlyBashCommands` / `dangerousBashCommands` / `readonlyTools` / `strictPlanMode` / `reviewLog` / `logDir`
- 全局 `~/.pi/agent/extensions/pi-permission/config.json` 与项目 `.pi/extensions/pi-permission/config.json` 合并
