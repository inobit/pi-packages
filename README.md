# @inobit/pi-packages

Pi coding agent 扩展包的 monorepo（pnpm workspace）。面向 `@earendil-works/pi-coding-agent` 0.84.2+，扩展经 jiti 直载、无需编译。

## 包列表

| 包 | 说明 |
| -- | ---- |
| [`@inobit/pi-permission`](packages/pi-permission) | 轻量权限控制扩展：敏感文件保护 / 项目边界读写区分 / 敏感操作确认 / plan-build 只读模式 |
| [`@inobit/pi-todo`](packages/pi-todo) | 最小侵入任务清单扩展：`todo` 工具 + `/todos` 命令 + 编辑器上方常驻面板，状态存会话分支可重放 |

各包安装、配置、使用详见其 README（上表链接）。

## 环境要求

| 项 | 版本 |
| -- | ---- |
| Node.js | >=24 |
| pnpm | 11.22.0（`packageManager` 锁定） |
| Pi coding agent | 0.84.2+ |

## 开发

```bash
pnpm install                # 安装依赖
pnpm check                  # 全仓类型检查（= pnpm -r run check）
pnpm test                   # 全仓测试（= pnpm -r run test）
pnpm --filter <pkg> test    # 单包测试（如 --filter @inobit/pi-permission）
pnpm --filter <pkg> pack:check   # 检查发布 tarball
```

## License

MIT
