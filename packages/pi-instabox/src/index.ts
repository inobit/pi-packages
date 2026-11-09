/**
 * @inobit/pi-instabox — 扩展入口。
 *
 * 当前为空装配（包骨架）：配置读取、桌面工具注册、`/instabox-*` 命令、
 * entry renderer 与远端 DevTools MCP 注册均在后续任务里填入本文件。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 骨架阶段不使用该参数，按 .oxlintrc.json 的 `argsIgnorePattern: "^_"` 加前导下划线。
export default function (_pi: ExtensionAPI): void {}
