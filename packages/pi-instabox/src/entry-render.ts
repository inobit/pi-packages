/**
 * @inobit/pi-instabox — 目标 entry 的转录渲染（R5）。
 *
 * 宿主的 `EntryRenderer` 必须返回一个 `Component`（`render(width)` + `invalidate()`）：
 * 返回字符串会被当真组件用而崩。`Text` 的第 4 参是背景色函数、不是 `Theme`，
 * 所以着色在构造之前用 `theme.fg("dim", line)` 完成，第 4 参永不传。
 * 工厂注入 `Text` 构造器，单测据此断言构造实参而不真渲染。
 */

import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Text as HostText, type Component } from "@earendil-works/pi-tui";
import { TARGET_ENTRY, type TargetEntryData } from "./session-target.ts";

/** `Text` 构造器的最小形状；第 4 参是背景色函数，本模块永不使用 */
export type TextConstructor = new (
  text?: string,
  paddingX?: number,
  paddingY?: number,
  customBgFn?: (text: string) => string,
) => Component;

/**
 * 目标 entry 的渲染器工厂。
 * 只认 `customType === TARGET_ENTRY`，其余条目返回 undefined，交回宿主默认渲染；
 * `CustomEntry.data` 可缺省，取不到非空箱名时同样返回 undefined（不抛）。
 */
export function createTargetRenderer(TextCtor: TextConstructor): EntryRenderer<unknown> {
  return (entry, _options, theme) => {
    if (entry.customType !== TARGET_ENTRY) return undefined;
    const box = (entry.data as Partial<TargetEntryData> | undefined)?.box;
    if (typeof box !== "string" || box === "") return undefined;
    return new TextCtor(theme.fg("dim", `instabox target: ${box}`), 0, 0);
  };
}

/**
 * 宿主默认版本：接 pi-tui 的真 `Text`，T15 一行接线：
 * `pi.registerEntryRenderer(TARGET_ENTRY, createTargetRendererWithHostText())`。
 */
export function createTargetRendererWithHostText(): EntryRenderer<unknown> {
  return createTargetRenderer(HostText);
}
