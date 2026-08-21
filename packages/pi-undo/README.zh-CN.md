# @inobit/pi-undo

[English](./README.md) | **中文**

Pi 撤销扩展：把最近一次发送的输入撤回到输入框并从对话中移除，单次/轮，队列感知，原子 abort 再撤。

- **撤销**：移除最近一次 `user` 轮并回填到输入框，`/tree` 可找回；文件副作用**不回滚**
- **队列感知、单次/轮**：`a已发 + b,c队列` 时 `undo` 撤 `c` 到输入框一次；下一次 `undo` 转历史。发一次可撤一次，`before_agent_start` 重置，草稿原子检查
- **执行中原子 abort**：`!isIdle` 时 `abort() → waitForIdle` 后再判草稿再移除

## 安装

```bash
pi install npm:@inobit/pi-undo
```

重启或 `/reload` 生效。本地调试（隔离，--no-extensions 屏蔽已安装旧版）：

```bash
pi -ne -e ./packages/pi-undo
# 发一句后 /undo 或 alt+u
```

## 使用

- `/undo` — 撤回最近一次输入到编辑框，仅出错时英文提示
- `alt+u` — 同 `/undo`

行为：

- 编辑器有草稿时提示 `Editor has draft, clear it first` 且不覆盖
- `a已发 + b,c队列` 时 `undo` 撤 `c` 单次；镜像剩余 `b` 仍保留（真队列可能仍含 `c`，需要可用 `Esc` 清理，见限制）
- 执行中直接 `abort` 后撤（terminate+undo），无确认
- 无 redo：从输入框重发或 `/tree` 找回；仅出错时英文提示

## 配置

快捷键可配，配置文件 `~/.pi/agent/extensions/pi-undo/config.json`（改后需 `/reload`）：

```json
{
  "shortcut": "alt+u"
}
```

默认 `alt+u`，受信任项目下 `.pi/extensions/pi-undo/config.json` 可覆盖全局。

## 兼容与限制

- 撤销立刷页并跨 `--session` 持久化，首条经 `resetLeaf` 回到空分支
- 若 `parentId` 已被压缩截断，提示 `Hard undo failed`（`details` 含原文本已回填）
- 文件副作用不回滚（edit/write/bash），仅回退对话分支
- 队列撤销基于镜像（`input` 的 `steer|followUp`，限 20，`trim` 后判空并过滤 `/undo`）；真队列 pop 需内核透出，队列 `c` 可能仍 pending，需 `Esc` 清理时请手动

## 开发

```bash
pnpm --filter @inobit/pi-undo check
pnpm --filter @inobit/pi-undo test
pnpm --filter @inobit/pi-undo pack:check
pi -ne -e ./packages/pi-undo
```

## License

MIT
