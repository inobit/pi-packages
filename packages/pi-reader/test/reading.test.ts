import { describe, it, expect, vi } from "vitest";
import { GgSequence, halfPage, pageStep, parseReadingKey } from "../src/index.ts";

describe("pi-reader: 视口步长", () => {
  it("half = floor(vh/2)（与 TuiAltScreen 一致）", () => {
    expect(halfPage(20)).toBe(10);
    expect(halfPage(17)).toBe(8);
    expect(halfPage(1)).toBe(1);
    expect(halfPage(0)).toBe(1);
  });
  it("page = vh-1（OVERLAP=1，与 TuiAltScreen 一致）", () => {
    expect(pageStep(20)).toBe(19);
    expect(pageStep(17)).toBe(16);
    expect(pageStep(1)).toBe(1);
  });
});

describe("pi-reader: parseReadingKey 键分类", () => {
  it("toggle=alt+o（默认，传统/Kitty）", () => {
    expect(parseReadingKey("\x1bo")).toBe("toggle");
    expect(parseReadingKey("\u001b[111;3u")).toBe("toggle");
  });
  it("半页 ctrl-u/d", () => {
    expect(parseReadingKey("\x15")).toBe("halfUp");
    expect(parseReadingKey("\u001b[117;5u")).toBe("halfUp");
    expect(parseReadingKey("\x04")).toBe("halfDown");
    expect(parseReadingKey("\u001b[100;5u")).toBe("halfDown");
  });
  it("整页 ctrl-f/b", () => {
    expect(parseReadingKey("\x06")).toBe("pageDown");
    expect(parseReadingKey("\u001b[102;5u")).toBe("pageDown");
    expect(parseReadingKey("\x02")).toBe("pageUp");
    expect(parseReadingKey("\u001b[98;5u")).toBe("pageUp");
  });
  it("行级 ctrl-p/n, j/k", () => {
    expect(parseReadingKey("\x10")).toBe("lineUp");
    expect(parseReadingKey("\u001b[112;5u")).toBe("lineUp");
    expect(parseReadingKey("k")).toBe("lineUp");
    expect(parseReadingKey("\x0e")).toBe("lineDown");
    expect(parseReadingKey("j")).toBe("lineDown");
  });
  it("顶/底 G 与 g（含同批连发 gg）", () => {
    expect(parseReadingKey("G")).toBe("bottom");
    expect(parseReadingKey("g")).toBe("top");
    expect(parseReadingKey("gg")).toBe("top"); // 终端同块到达的 gg 也视为双击
  });
  it("退出 esc/i/ctrl+c", () => {
    expect(parseReadingKey("\u001b")).toBe("exit");
    expect(parseReadingKey("i")).toBe("exit");
    expect(parseReadingKey("\x03")).toBe("exit");
  });
  it("? 帮助", () => {
    expect(parseReadingKey("?")).toBe("help");
  });
  it("其他可打印/控制为 other", () => {
    expect(parseReadingKey("a")).toBe("other");
    expect(parseReadingKey(" ")).toBe("other");
    expect(parseReadingKey("\x7f")).toBe("other");
  });
});

describe("pi-reader: gg 500ms 双击", () => {
  it("单 g 不触发，500ms 内双 g 触发", () => {
    vi.useFakeTimers();
    const gg = new GgSequence(500);
    const t = 1000;
    expect(gg.press(t)).toBe(false);      // 第一次 g
    expect(gg.press(t + 300)).toBe(true); // 500ms 内第二次 → gg
    vi.useRealTimers();
  });
  it("超过 500ms 重置，需重新双击", () => {
    vi.useFakeTimers();
    const gg = new GgSequence(500);
    const t = 1000;
    expect(gg.press(t)).toBe(false);
    expect(gg.press(t + 600)).toBe(false); // 超窗，仅当新首按
    expect(gg.press(t + 700)).toBe(true);  // 立即再按 → 双击
    vi.useRealTimers();
  });
  it("reset 清理", () => {
    vi.useFakeTimers();
    const gg = new GgSequence(500);
    expect(gg.press(1000)).toBe(false);
    gg.reset();
    expect(gg.press(1200)).toBe(false); // reset 后不再续命中
    vi.useRealTimers();
  });
});
