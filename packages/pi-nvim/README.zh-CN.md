# @inobit/pi-nvim

Pi coding agent 会话内复用你的 Neovim LSP 配置：`nvim_lsp`（只读诊断）+ `nvim_format`（写盘格式化），背后是 per-session 常驻 headless nvim daemon。

- **编辑器的大脑，随叫随到**：诊断与格式化走你自己的 Neovim 配置（LSP server、none-ls 桥接），不另起语言工具链
- **session 绑定 daemon**：首次调用懒启动，per-call 零 server  churn，整 session 留温；空闲 5min 停 clients，父死亡探测干净退出
- **批量优先**：一次调用传 ALL 文件；format 逐文件五态（`formatted` / `reason`），诊断全量返回，错误文本截断注记 `…(truncated N chars)`

## 环境要求

- **暂时只支持 Linux。** daemon 依赖 POSIX 信号与 Unix domain socket（信号 0 探活、`SIGTERM`/`SIGKILL`），socket 路径也假设有 `XDG_RUNTIME_DIR`。macOS 未验证且有风险（没有 `XDG_RUNTIME_DIR`，回退 `os.tmpdir()` 可能使 socket 路径超过 104 字节上限）；Windows 不支持。
- `PATH` 上有可用的 `nvim`（或在配置里设 `nvimPath`），且你的 LSP 配置可 headless 加载。

## 安装

```bash
pi install npm:@inobit/pi-nvim
```

重启 Pi 会话生效。

## 用法

模型调用两个工具（均为 `executionMode: "sequential"`）：

- `nvim_lsp({ files })` — 对给定绝对路径做只读诊断，绝不写盘。
- `nvim_format({ files })` — 用你的 Neovim formatter 格式化并写回，返回剩余诊断。会修改磁盘文件。

模型侧四条 guideline：nvim_lsp 只读诊断；nvim_format 写盘回写；多文件单次调用；scope 白名单，越界文件返回 per-file skipped。

调用守卫：每次 `execute` 先做 pre-check（存在→是文件→可读文本→本工具白名单），再碰 daemon。缺失／目录／不可读／二进制走 per-file `error`；越界类型（含未知类型，fail-closed 默认跳过）走 per-file `skipped` 不执行。全被拦截则不启动 daemon。`whitelist.enabled: false` 仅关白名单闸（存在/是文件/可读文本三闸仍生效）。

## 配置

可选 `config.json`（全局 `~/.pi/agent/extensions/pi-nvim/config.json`，或 trusted 时项目 `<cwd>/.pi/extensions/pi-nvim/config.json`）：

```json
{
  "nvimPath": "nvim",
  "timeouts": { "spawnMs": 30000, "attachMs": 20000, "diagMs": 10000, "requestMs": 60000, "pollMs": 50 },
  "idleMs": 300000,
  "parentPollMs": 15000,
  "errorCap": 2000,
  "whitelist": {
    "enabled": true,
    "diagnostics": { "extensions": ["ts", "tsx", "js", "lua", "py", "md"], "filenames": ["Dockerfile"] },
    "format": { "extensions": ["ts", "tsx", "js", "lua", "py"], "filenames": [] }
  }
}
```

非法项回退默认。`sockDir` 覆盖 socket 父目录（默认 `XDG_RUNTIME_DIR`，回退 `os.tmpdir()`）。

## 开发

```bash
pnpm --filter @inobit/pi-nvim check   # tsc --noEmit
pnpm --filter @inobit/pi-nvim test    # vitest
pnpm --filter @inobit/pi-nvim pack:check
pi -ne -e ./packages/pi-nvim
```

daemon 真机行为（spawn/探活/轮询）靠冒烟验证，不进单测；纯逻辑（诊断全量、socket 路径、Vim 转义、五态推导、错误截断、启动健康）有单测。

## 许可证

MIT
