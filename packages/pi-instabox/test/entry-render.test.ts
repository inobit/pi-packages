import { describe, it, expect } from "vitest";
import type { CustomEntry, EntryRenderOptions, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { TARGET_ENTRY } from "../src/session-target.ts";
import {
  createTargetRenderer,
  createTargetRendererWithHostText,
  type TextConstructor,
} from "../src/entry-render.ts";

const DIM_OPEN = "\u001b[2m";
const DIM_CLOSE = "\u001b[22m";

const renderOptions = { expanded: false } as unknown as EntryRenderOptions;

/** 假 theme：只实现渲染用到的 `fg`，记录 (color, text) 并包一层可见的 dim 标记 */
function fakeTheme(): { theme: Theme; fgCalls: Array<[ThemeColor, string]> } {
  const fgCalls: Array<[ThemeColor, string]> = [];
  const theme = {
    fg: (color: ThemeColor, text: string) => {
      fgCalls.push([color, text]);
      return `${DIM_OPEN}${text}${DIM_CLOSE}`;
    },
  } as unknown as Theme;
  return { theme, fgCalls };
}

/** 假 `Text` 构造器：只记录构造实参，不真渲染 */
function fakeText(): { TextCtor: TextConstructor; calls: unknown[][] } {
  const calls: unknown[][] = [];
  class RecordingText implements Component {
    constructor(...args: unknown[]) {
      calls.push(args);
    }
    render(_width: number): string[] {
      return ["<fake-text>"];
    }
    invalidate(): void {
      // 只为满足 Component；本测试不缓存渲染结果
    }
  }
  return { TextCtor: RecordingText, calls };
}

function targetEntry(customType: string, data?: unknown): CustomEntry<unknown> {
  return { type: "custom", customType, data } as CustomEntry<unknown>;
}

describe("createTargetRenderer", () => {
  it("returns a Component-shaped value for a target entry", () => {
    const { TextCtor } = fakeText();
    const { theme } = fakeTheme();

    const rendered = createTargetRenderer(TextCtor)(
      targetEntry(TARGET_ENTRY, { box: "agent", at: "2026-01-01T00:00:00.000Z" }),
      renderOptions,
      theme,
    );

    expect(rendered).toBeDefined();
    expect(typeof rendered?.render).toBe("function");
    expect(rendered?.render(80)).toEqual(["<fake-text>"]);
  });

  it("colours with theme.fg before construction and never passes a 4th argument", () => {
    const { TextCtor, calls } = fakeText();
    const { theme, fgCalls } = fakeTheme();

    createTargetRenderer(TextCtor)(
      targetEntry(TARGET_ENTRY, { box: "agent", at: "2026-01-01T00:00:00.000Z" }),
      renderOptions,
      theme,
    );

    expect(fgCalls).toEqual([["dim", "instabox target: agent"]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([`${DIM_OPEN}instabox target: agent${DIM_CLOSE}`, 0, 0]);
  });

  it("returns undefined for entries of another customType", () => {
    const { TextCtor, calls } = fakeText();
    const { theme, fgCalls } = fakeTheme();

    expect(
      createTargetRenderer(TextCtor)(targetEntry("pi-other", { box: "agent" }), renderOptions, theme),
    ).toBeUndefined();
    expect(createTargetRenderer(TextCtor)(targetEntry("instabox-target-typo"), renderOptions, theme)).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(fgCalls).toHaveLength(0);
  });

  it("returns undefined instead of throwing when the box is missing", () => {
    const { TextCtor, calls } = fakeText();
    const { theme } = fakeTheme();
    const renderer = createTargetRenderer(TextCtor);

    expect(renderer(targetEntry(TARGET_ENTRY), renderOptions, theme)).toBeUndefined();
    expect(renderer(targetEntry(TARGET_ENTRY, {}), renderOptions, theme)).toBeUndefined();
    expect(renderer(targetEntry(TARGET_ENTRY, { box: "" }), renderOptions, theme)).toBeUndefined();
    expect(renderer(targetEntry(TARGET_ENTRY, { box: 42 }), renderOptions, theme)).toBeUndefined();
    expect(renderer(targetEntry(TARGET_ENTRY, null), renderOptions, theme)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("createTargetRendererWithHostText", () => {
  it("renders the target line with the real pi-tui Text", () => {
    const { theme } = fakeTheme();

    const rendered = createTargetRendererWithHostText()(
      targetEntry(TARGET_ENTRY, { box: "general", at: "2026-01-01T00:00:00.000Z" }),
      renderOptions,
      theme,
    );

    const lines = rendered?.render(200) ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.includes("instabox target: general")).toBe(true);
  });

  it("stays silent for entries of another customType", () => {
    const { theme } = fakeTheme();

    expect(
      createTargetRendererWithHostText()(targetEntry("pi-other", { box: "general" }), renderOptions, theme),
    ).toBeUndefined();
  });
});
