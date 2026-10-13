/**
 * @inobit/pi-nvim — 扩展入口：事件接线＋双工具注册（方案 §三/§四）。
 *
 * - `session_start`：不 spawn（懒启动），只备好本 session 的 socket 路径＋刷新配置。
 * - `agent_settled`：无操作（该事件为最终仅通知边界；session 绑定下无需清理）。
 * - `session_shutdown`：按 reason 分流——`reload` 直接跳过（同 session 同 daemon，
 *   保 warmth）；其余 fire-and-forget 发 `:lua PiNvim.begin_shutdown()`，不等落子。
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, packageRootOf, resolveResource } from "./config.ts";
import { DaemonManager } from "./daemon.ts";
import { registerNvimTools } from "./tools.ts";

function currentDirname(): string {
	try {
		return typeof __dirname !== "undefined" && __dirname ? __dirname : "";
	} catch {
		return "";
	}
}

function refreshConfigTarget(ctx: ExtensionContext): { cwd: string; trusted: boolean } {
	const cwd = typeof ctx.cwd === "string" && ctx.cwd !== "" ? ctx.cwd : process.cwd();
	let trusted = false;
	try {
		trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
	} catch {
		trusted = false;
	}
	return { cwd, trusted };
}

export default function (pi: ExtensionAPI): void {
	// 资源定位：jiti 直载下 import.meta.url 不可用，用 CJS __dirname 手法
	// （照 pi-reader 实测：从 src/ 加载时取父级即包目录）
	const baseDir = currentDirname();
	const packageRoot = baseDir ? packageRootOf(baseDir) : process.cwd();
	const bridgePath = resolveResource(packageRoot, path.join("lua", "bridge.lua"));

	// daemon 常驻单例（工具经闭包共享同一实例）；配置随 session_start 刷新
	const daemon = new DaemonManager(loadConfig(process.cwd(), { packageRoot }), packageRoot, bridgePath);
	const deps = {
		get cfg() {
			return daemon.getConfig();
		},
		daemon,
	};

	pi.on("session_start", async (_event, ctx) => {
		const { cwd, trusted } = refreshConfigTarget(ctx);
		daemon.setConfig(loadConfig(cwd, { packageRoot, trusted }));
		try {
			const sessionId = ctx.sessionManager.getSessionId() ?? "";
			daemon.prepare(sessionId);
		} catch {
			// 路径备忘失败不阻塞会话；首次工具调用时 ensure 重试
		}
	});

	// agent_settled 无操作：server 留温给下一轮（约束：该事件内不续跑模型）
	pi.on("agent_settled", async () => {});

	pi.on("session_shutdown", async (event, ctx) => {
		// reload 跳过：同 session 同 daemon，不惊动保 warmth
		if (event.reason === "reload") return;
		let sessionId = "";
		try {
			sessionId = ctx.sessionManager.getSessionId() ?? "";
		} catch {
			return;
		}
		const handles = daemon.prepare(sessionId);
		// fire-and-forget：不等落子（daemon 侧立 flag→停 clients→:qa! 自排序）
		// socket 已断则 no-op（含 beginShutdown 内部探活）
		void daemon.beginShutdown(handles).catch(() => undefined);
	});

	registerNvimTools(pi, deps);
}
