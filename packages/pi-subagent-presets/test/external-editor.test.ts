import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { spawn } from "node:child_process";
import { editInExternalEditor, runExternalEditorRound } from "../src/external-editor.ts";

/**
 * 外部编辑器：注入 spawn，绝不起真编辑器。
 * 关键约束：必须**异步** spawn（Windows 上 spawnSync 会与 vim/nvim 抢输入缓冲），
 * 且临时目录必须在编辑器**退出之后**才清理（否则读不回内容）。
 */
function fakeSpawn(options: { exitCode?: number; onSpawn?: (file: string) => void; spawnError?: boolean }) {
	return ((_cmd: string, args: string[], _opts: unknown) => {
		const child = new EventEmitter();
		options.onSpawn?.(args[args.length - 1] ?? "");
		setTimeout(() => {
			if (options.spawnError) child.emit("error", new Error("ENOENT"));
			else child.emit("close", options.exitCode ?? 0);
		}, 0);
		return child;
	}) as unknown as typeof spawn;
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	// 上游会往 stdout 打一行提示；测试里静音，避免刷屏
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
	stdoutSpy.mockRestore();
});

describe("editInExternalEditor", () => {
	it("退出码 0 ⇒ 读回内容并 strip BOM / 去尾部换行", async () => {
		let seenFile = "";
		const result = await editInExternalEditor({
			command: "vi",
			content: "before",
			spawnFn: fakeSpawn({
				onSpawn: (file) => {
					seenFile = file;
					fs.writeFileSync(file, "﻿after\n", "utf-8");
				},
			}),
		});
		expect(result.status).toBe("complete");
		expect(result.content).toBe("after");
		expect(seenFile).toContain("pi-editor-");
	});

	it("回归：临时文件默认是 `entry.jsonc`（既给 JSON 高亮又允许 `//` 注释）", async () => {
		// 编辑器靠扩展名选 filetype。写成 `prompt.md`（pi 主输入框 Ctrl+G 的固定名）
		// ⇒ nvim/VSCode 按 Markdown 打开：没 JSON 高亮、没自动缩进，而我们编辑的是 JSON。
		let seenFile = "";
		await editInExternalEditor({
			command: "vi",
			content: "{}",
			spawnFn: fakeSpawn({ onSpawn: (file) => { seenFile = file; } }),
		});
		expect(seenFile.endsWith("entry.jsonc")).toBe(true);
		expect(seenFile).not.toContain("prompt.md");
	});

	it("显式 `fileName` 可覆盖", async () => {
		let seenFile = "";
		await editInExternalEditor({
			command: "vi",
			content: "{}",
			fileName: "custom.json",
			spawnFn: fakeSpawn({ onSpawn: (file) => { seenFile = file; } }),
		});
		expect(seenFile.endsWith("custom.json")).toBe(true);
	});

	it("非零退出 ⇒ failed（调用方保留原草稿）", async () => {
		const result = await editInExternalEditor({ command: "vi", content: "x", spawnFn: fakeSpawn({ exitCode: 1 }) });
		expect(result.status).toBe("failed");
		expect(result.content).toBeUndefined();
	});

	it("spawn 报错 ⇒ failed，不抛", async () => {
		const result = await editInExternalEditor({ command: "nope", content: "x", spawnFn: fakeSpawn({ spawnError: true }) });
		expect(result.status).toBe("failed");
	});

	it("command 为空 ⇒ failed", async () => {
		const result = await editInExternalEditor({ command: "  ", content: "x", spawnFn: fakeSpawn({}) });
		expect(result.status).toBe("failed");
	});

	it("按空格切分 command（上游口径：含空格的路径会坏，此处原样继承）", async () => {
		const spawnSpy = vi.fn(fakeSpawn({})) as unknown as ReturnType<typeof vi.fn> & typeof spawn;
		await editInExternalEditor({ command: "/usr/bin/my editor --wait", content: "x", spawnFn: spawnSpy });
		expect(spawnSpy).toHaveBeenCalledWith(
			"/usr/bin/my",
			["editor", "--wait", expect.stringContaining("pi-editor-")],
			expect.objectContaining({ stdio: "inherit" }),
		);
	});

	it("Windows 上带 shell（与上游一致）", async () => {
		const spawnSpy = vi.fn(fakeSpawn({})) as unknown as ReturnType<typeof vi.fn> & typeof spawn;
		await editInExternalEditor({ command: "notepad", content: "x", spawnFn: spawnSpy, platform: "win32" });
		expect(spawnSpy.mock.calls[0]?.[2]).toMatchObject({ shell: true });
	});

	it("临时目录在编辑器退出后清理", async () => {
		let dir = "";
		await editInExternalEditor({
			command: "vi",
			content: "x",
			spawnFn: fakeSpawn({ onSpawn: (file) => { dir = path.dirname(file); } }),
		});
		expect(fs.existsSync(dir)).toBe(false);
	});
});

describe("runExternalEditorRound（§3.7 的 B 段）", () => {
	function fakeTui() {
		return { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
	}

	it("顺序是 stop → 启动编辑器 → start + requestRender(true)", async () => {
		const tui = fakeTui();
		const order: string[] = [];
		tui.stop.mockImplementation(() => order.push("stop"));
		tui.start.mockImplementation(() => order.push("start"));
		tui.requestRender.mockImplementation(() => order.push("requestRender"));
		await runExternalEditorRound(tui, { command: "vi", content: "x", spawnFn: fakeSpawn({}) });
		expect(order).toEqual(["stop", "start", "requestRender"]);
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});

	it("编辑器失败也必须恢复 TUI（finally）", async () => {
		const tui = fakeTui();
		await runExternalEditorRound(tui, { command: "vi", content: "x", spawnFn: fakeSpawn({ exitCode: 1 }) });
		expect(tui.start).toHaveBeenCalledTimes(1);
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});
});
