/**
 * @inobit/pi-subagent-presets — 外部编辑器（§3.7）。
 *
 * pi 的 `editInExternalEditor` **未**从主入口导出，所以 A 段自己实现（取自
 * `dist/modes/interactive/external-editor.js`，该文件内没有任何 tui 调用）。
 * B 段（`tui.stop()` → A → `tui.start()` + `tui.requestRender(true)`）取自
 * `components/extension-editor.js:87-99`。
 *
 * ⚠️ **必须异步 `spawn`，不能用 `spawnSync`**：pi 源码注释写明，Windows 上同步子进程
 * 会在父进程暂停 stdin 后继续占用控制台，与 vim/nvim 抢输入缓冲直到 Ctrl+C。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type EditStatus = "complete" | "failed";

export interface EditResult {
	status: EditStatus;
	/** `status === "complete"` 时的回填内容（已 strip BOM、去掉尾部换行）。 */
	content?: string;
}

export interface EditInExternalEditorOptions {
	command: string;
	content: string;
	/**
	 * 临时文件名（含扩展名）。
	 *
	 * ⚠️ **必须带对扩展名**：编辑器靠它选 filetype。
	 * - `prompt.md`（pi 主输入框 `Ctrl+G` 的固定名）：按 Markdown 打开，没 JSON 高亮 / 自动缩进。
	 * - `entry.json`：高亮对了，但**严格 JSON 不允许注释** ⇒ 头部那 15 行 `//` 注释
	 *   会被 JSON 语言服务逐行报 `Comments are not permitted in JSON`。
	 * - `entry.jsonc`（JSON with Comments，VSCode / nvim 都认）：高亮与注释兼得。
	 */
	fileName?: string;
	/** 可注入的 spawn（测试用，避免真起编辑器）。 */
	spawnFn?: typeof spawn;
	platform?: NodeJS.Platform;
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 上游用 `command.split(" ")` 切分（`external-editor.js:11`），**含空格的路径会坏**。
 * 原样继承该限制：这是 pi 主输入框 `Ctrl+G` 的同一套行为，改成引号解析反而会与
 * 官方在同一条命令上产生分歧。
 */
export function editInExternalEditor(options: EditInExternalEditorOptions): Promise<EditResult> {
	const spawnFn = options.spawnFn ?? spawn;
	const platform = options.platform ?? process.platform;
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, options.fileName ?? "entry.jsonc");
	try {
		writeFileSync(filePath, options.content, "utf-8");
	} catch {
		rmQuietly(directory);
		return Promise.resolve({ status: "failed" });
	}
	const [editor, ...editorArgs] = options.command.split(" ");
	if (!editor) {
		rmQuietly(directory);
		return Promise.resolve({ status: "failed" });
	}
	process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);
	// 临时目录的清理必须发生在**编辑器退出之后**（读回内容要用到那个文件）。
	return new Promise<EditResult>((resolve) => {
		const finish = (result: EditResult): void => {
			rmQuietly(directory);
			resolve(result);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnFn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: platform === "win32",
			});
		} catch {
			finish({ status: "failed" });
			return;
		}
		child.on("error", () => finish({ status: "failed" }));
		child.on("close", (code) => {
			if (code !== 0) {
				finish({ status: "failed" });
				return;
			}
			try {
				finish({ status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") });
			} catch {
				finish({ status: "failed" });
			}
		});
	});
}

function rmQuietly(directory: string): void {
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch {
		// 清理 best-effort
	}
}

/** pi-tui 的 TUI 上 `stop` / `start` / `requestRender` 是公开 API。 */
export interface TuiForEditor {
	stop: (options?: { preserveScreen?: boolean }) => void;
	start: () => void;
	requestRender: (force?: boolean) => void;
}

/** B 段：`tui.stop()` → A → `tui.start()` + `requestRender(true)`（失败也必须恢复）。 */
export async function runExternalEditorRound(
	tui: TuiForEditor,
	options: Omit<EditInExternalEditorOptions, "command"> & { command: string },
): Promise<EditResult> {
	tui.stop();
	try {
		return await editInExternalEditor(options);
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}
