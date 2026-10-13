# @inobit/pi-nvim

在 Pi 会话里复用你自己的 Neovim：借它的 LSP 做代码检查，借它的 formatter 管道做格式化。

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）等公共约定见仓库根目录 `AGENTS.md`，本文件不重复。

## 目标

- 复用用户自己的 Neovim 配置（LSP clients＋formatter 管道）来检查与格式化代码，**不自建 LSP 协议栈、不调外部 formatter 二进制**。"怎么查、怎么格"永远是用户编辑器的事
- 一个常驻 headless nvim daemon 服务整个 pi session，同项目复用同一份 LSP 状态，把 nvim 启动与 LSP 冷启动的成本摊薄
- 对模型暴露两个工具：`nvim_lsp`（只读诊断）、`nvim_format`（写盘格式化）。一次调用传全部待处理文件，结果按文件结构化返回，不回文件内容
- 结果必须可信、可消费：能区分"干净 / 没工具 / 没变化 / 失败"，模型据此决定下一步

## 核心约束（跑偏即违背本包意图）

- **复用而非重建**：formatter 完全走用户 autocmd 管道（等价于用户亲手按 `:w`）。桥接不选边、不替用户决定用哪个 formatter、不显式调用 format API、不用 `noautocmd`
- **只读就是只读**：诊断路径绝不写盘；写盘只发生在 format，且必须让模型知道哪些文件被改了
- **诚实记账**：没有 formatter、没有变化、失败要分开记；绝不拿"没抛错"推断成功；看不懂的输出原文透传，绝不记成 clean、绝不编造原因
- **诊断必须等落地**：不能把"还没开始（暂时 0 条）"当成"真干净"，否则冷启动必漏检
- **中断必须一致**：用户中断之后，不能出现"模型以为没处理、磁盘却已改"的分裂
- **资源跟着 session 生死**：daemon 不无限驻留；退出即整树回收（含 LSP server 子进程、socket 与临时目录），不留内存与硬盘污染
- **运行时零第三方依赖**（本仓约定）：通信只用 nvim CLI＋结果文件，不引 npm RPC client
- **批量优先**：对外串行（`executionMode: "sequential"`），对内同一 daemon 串行，别把并发做进桥接层

## 验证

真机行为（spawn nvim、LSP 冷启动、format 写盘、退出回收）不进单测，靠冒烟：`pi -ne -e ./packages/pi-nvim` 跑通典型链路。能进单测的只有纯逻辑、源码结构断言与 Lua 加载校验。
