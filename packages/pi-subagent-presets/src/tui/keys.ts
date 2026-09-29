/**
 * @inobit/pi-subagent-presets — 键盘输入的共享常量与判定。
 *
 * pi-tui 的 `handleInput` 收到的是**原始字节串**（不是解析后的 key id），所以
 * escape / backspace / ctrl+c 都是单字节控制码。集中在这里，避免各组件各写一份
 * 字面量（而控制码字面量在源码里是不可见的）。
 */

/** ESC。 */
export const KEY_ESC = "\u001b";
/** DEL（终端的 Backspace）。 */
export const KEY_BACKSPACE = "\u007f";
/** Ctrl+C。 */
export const KEY_CTRL_C = "\u0003";
export const KEY_ENTER = "\r";
export const KEY_NEWLINE = "\n";
export const KEY_UP = "\u001b[A";
export const KEY_DOWN = "\u001b[B";
export const KEY_PAGE_UP = "\u001b[5~";
export const KEY_PAGE_DOWN = "\u001b[6~";
export const KEY_TAB = "\t";
/** Shift+Tab（pi 默认的 `app.thinking.cycle` 键位）。 */
export const KEY_SHIFT_TAB = "\u001b[Z";

/** 可打印字符（单字节、ASCII 可见范围、不含控制码）。 */
export function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data.charCodeAt(0) < 0x7f;
}
