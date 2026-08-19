# Changelog

## [0.2.4] - 2026-08-19

### 修复

- 修复 `$(` 命令替换的括号深度 off-by-one：`splitTopLevel` 中 `$` 分支先 `parenDepth++`，随后 `(` 分支又 `parenDepth++`，而匹配的 `)` 只 `-1`，导致任何合法闭合的 `$(...)` 结束后深度残留 1 → 误报 `parseError` → fail-closed 提示始终为「unparseable command syntax」。现改为 `$(` 一次性跳过两个字符（深度只 +1），平衡的 `$(...)` 深度归零，命中「command substitution / subshell / complex syntax」分支（决策不变，仍 fail-closed：build=ask、plan=deny）
- 补充回归测试：`$(...)` 及嵌套 `$(...)` 不再误报 parseError；决策层 reason 断言命中的是复杂语法分支

## [0.2.3] - 2026-08-19

### 新增

- trusted 外部路径赎免（FR-9）：新增配置项 `trustedExternalPaths`（默认 `["/tmp"]`，运行时并入 `os.tmpdir()`）；落在前缀下的外部读写直接放行（临时验证计算场景，普通用户不能删除整个 /tmp：sticky 1777），并入 ARRAY_FIELDS 走 default ∪ global ∪ project 并集。
  - plan 模式：sensitive 操作 deny → 非赎免写 deny（含敏感文件名写，如 /tmp/.env / .env）→ 敏感文件读 ask → trusted 读写 allow（FR-9）→ read 白名单 → other ask/deny
  - build 模式：sensitive ask → trusted 赎免（过滤后 externalRefs/externalTargets 为空则放行）→ 剩余外部写 ask → 剩余外部读 read 白名单/ask
  - realpath 双形态 + 段 cwd 解析防软链逃逸；敏感/危险判定始终优先于 trusted 赎免

## [0.2.2] - 2026-08-19

### 新增

- plan→build 切换后模型感知修复：`before_agent_start` 记录上次 agent 启动时的模式，从 plan 切到 build 后的首个 turn 注入一次 build 公告（`Plan mode is now disabled. Full tool access is restored; you may modify files and run state-changing commands.`），显式撤销 plan 只读约束，避免模型延续只读行为；build 常态零注入、无上下文累积（参考 @narumiruna/pi-plan-mode 的 handoff 通知模式）

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
