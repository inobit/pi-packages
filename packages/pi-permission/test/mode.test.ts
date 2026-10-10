import { afterEach, describe, expect, it } from "vitest";
import type { WorkMode } from "../src/decision.ts";
import { statusText } from "../src/mode.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** 假主题：fg 把颜色名包进文案，便于断言颜色映射。 */
function fakeTheme(): { fg: (color: string, text: string) => string } {
  return { fg: (color, text) => `<${color}>${text}</${color}>` };
}

describe("statusText", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[THEME_KEY];
  });

  it("无主题时降级为纯文本标签", () => {
    for (const mode of ["plan", "build", "chill", "yolo"] as WorkMode[]) {
      expect(statusText(mode)).toBe(mode === "plan" ? "Plan" : mode === "build" ? "Build" : mode === "chill" ? "Chill" : "Yolo");
    }
  });

  it("按风险单调上色：plan success / build accent / chill warning / yolo error", () => {
    (globalThis as Record<symbol, unknown>)[THEME_KEY] = fakeTheme();
    expect(statusText("plan")).toBe("<success>Plan</success>");
    expect(statusText("build")).toBe("<accent>Build</accent>");
    expect(statusText("chill")).toBe("<warning>Chill</warning>");
    expect(statusText("yolo")).toBe("<error>Yolo</error>");
  });
});
