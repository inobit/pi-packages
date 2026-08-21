# @inobit/pi-packages

Pi coding agent 扩展包的 pnpm monorepo。所有包面向 `@earendil-works/pi-coding-agent` 0.84.2+，扩展经 jiti 直载、无需编译。

## 技术栈

- Node >=24 · pnpm 11.22.0（`packageManager` 锁定）
- TypeScript ^6.0.3（仅 `tsc --noEmit` 类型检查，无构建产物）
- vitest ^4.1.8（仅 devDependency）
- 运行时零第三方依赖（仅 peerDependencies 声明 pi 核心包）

## 结构

- `pnpm-workspace.yaml`：`packages/*` 工作区 + catalog 版本中心
- `tsconfig.base.json`：公共 TS 配置，子包 tsconfig extends 此文件
- `packages/<pkg>/`：每个扩展包一个目录，独立发布

## 常用命令

```bash
pnpm install                              # 安装依赖
pnpm check / pnpm test                    # 全仓类型检查 / 测试
pnpm --filter @inobit/<pkg> check/test    # 单包检查/测试
pnpm --filter @inobit/<pkg> pack:check    # 检查发布 tarball
pi -e ./packages/<pkg>/src/index.ts       # 本地冒烟（免编译直载）
```

## 包约定

- 包命名 `@inobit/<pkg>`，`type: module`；`pi.extensions` 指向入口、`keywords` 含 `pi-package`、`publishConfig.access: public`
- 依赖版本走 `pnpm-workspace.yaml` 的 catalog；跨包引用需显式 `workspace:` 协议（`linkWorkspacePackages: false`）
- 每个包自带 README（安装/配置/集成）、CHANGELOG、AGENTS.md（包级上下文）
- **文档分工（公共约定只维护一处）**：环境要求、catalog、常用命令、版本与发布（含 tag 规范）等公共约定一律只维护在本文件与根 README；
  子包 `AGENTS.md` 只写目标（实现的功能）、`src/` 结构、常用命令与本包特有约束，不再重复公共约定；子包 `README.md` 面向快速了解与使用。

## 版本与发布

- **提交/发布前必须同步更新 `packages/<pkg>/package.json` 的 `version`**，否则无法发布（npm 不允许与已发布版本重复）。
- 版本语义：`fix` → patch（`x.y.z` → `x.y.(z+1)`）；`feat` → minor；破坏性 → major。
- 同一次修改中同步更新 `CHANGELOG.md`（用 `## [新版本] - YYYY-MM-DD` 格式在顶部新增条目）。
- tag 格式：`包名/vx.y.z`（semver 版本号，如 `pi-permission/v0.1.2`）。

## 包列表

| 包 | 说明 |
| -- | ---- |
| `@inobit/pi-permission` | 轻量权限控制：敏感文件保护 / 项目边界读写区分 / 敏感操作确认 / plan-build 只读模式 |
| `@inobit/pi-reader` | 阅读模式：`alt+o` 切换、`ctrl-u/d` 半页、`ctrl-f/b` 整页、`gg/G` 顶底、`?` 帮助 |
| `@inobit/pi-todo` | 最小侵入任务清单：`todo` 工具 + `/todos` 命令 + 编辑器上方常驻面板，状态存会话分支可重放 |
| `@inobit/pi-undo` | 撤销扩展：`/undo` + `alt+u`，单次/轮、队列感知、原子 abort 再撤 |
| `@inobit/pi-themes` | 精选主题包：Rosé Pine / TokyoNight 两族亮暗主题，支持 `theme: "亮/暗"` 配对自动切换 |