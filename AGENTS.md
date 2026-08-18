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

## 包列表

| 包 | 说明 |
| -- | ---- |
| `@inobit/pi-permission` | 轻量权限控制：敏感文件保护 / 项目边界读写区分 / 敏感操作确认 / plan-build 只读模式 |