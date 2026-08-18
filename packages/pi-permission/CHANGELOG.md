# Changelog

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
