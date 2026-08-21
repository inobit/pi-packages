import { describe, it, expect, vi } from "vitest";
import {
  GgSequence,
  BracketSequence,
  CountBuffer,
  halfPage,
  pageStep,
  parseReadingKey,
  getAnchorOffset,
  computeTargetScrollTop,
  isRowVisible,
  findPromptRows,
  findToolRows,
  findAnswerRows,
  findParagraphBounds,
  getViewportState,
} from "../src/index.ts";

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

describe("pi-reader: CountBuffer", () => {
  it("1-9 累积，0 前导忽略", () => {
    vi.useFakeTimers();
    const cb = new CountBuffer(800);
    expect(cb.push("0")).toBe(false);
    expect(cb.hasValue()).toBe(false);
    expect(cb.push("1")).toBe(true);
    expect(cb.push("2")).toBe(true);
    expect(cb.peek()).toBe(12);
    expect(cb.consume()).toBe(12);
    expect(cb.hasValue()).toBe(false);
    vi.useRealTimers();
  });
  it("0 在已有 buffer 时追加", () => {
    const cb = new CountBuffer(800);
    cb.push("1");
    expect(cb.push("0")).toBe(true);
    expect(cb.consume()).toBe(10);
  });
  it("800ms 超时清空", () => {
    vi.useFakeTimers();
    const cb = new CountBuffer(800);
    cb.push("5");
    vi.advanceTimersByTime(900);
    expect(cb.hasValue()).toBe(false);
    expect(cb.consume()).toBe(undefined);
    vi.useRealTimers();
  });
  it("consume 后重置", () => {
    const cb = new CountBuffer(800);
    cb.push("3");
    expect(cb.consume()).toBe(3);
    expect(cb.peek()).toBe(undefined);
  });
});

describe("pi-reader: BracketSequence", () => {
  it("[q ]q 命中", () => {
    vi.useFakeTimers();
    const bs = new BracketSequence(500);
    expect(bs.push("[")).toBe("pending");
    expect(bs.push("q")).toBe("prevQ");
    expect(bs.push("]")).toBe("pending");
    expect(bs.push("q")).toBe("nextQ");
    vi.useRealTimers();
  });
  it("[a ]a [t ]t", () => {
    const bs = new BracketSequence(500);
    expect(bs.push("[")).toBe("pending");
    expect(bs.push("a")).toBe("prevA");
    expect(bs.push("]")).toBe("pending");
    expect(bs.push("t")).toBe("nextT");
  });
  it("超时清空", () => {
    vi.useFakeTimers();
    const bs = new BracketSequence(500);
    expect(bs.push("[")).toBe("pending");
    vi.advanceTimersByTime(600);
    expect(bs.push("q")).toBe(null);
    vi.useRealTimers();
  });
  it("非 q/a/t 清空 pending", () => {
    const bs = new BracketSequence(500);
    expect(bs.push("[")).toBe("pending");
    expect(bs.push("x")).toBe(null);
    expect(bs.push("q")).toBe(null);
  });
});

describe("pi-reader: getAnchorOffset", () => {
  it("pinTop=1", () => { expect(getAnchorOffset(20, "pinTop")).toBe(1); });
  it("third=floor(vh/3)", () => { expect(getAnchorOffset(20, "third")).toBe(6); expect(getAnchorOffset(17, "third")).toBe(5); });
  it("center=floor(vh/2)", () => { expect(getAnchorOffset(20, "center")).toBe(10); });
  it("number clamp", () => {
    expect(getAnchorOffset(20, 5)).toBe(5);
    expect(getAnchorOffset(20, 100)).toBe(19);
    expect(getAnchorOffset(20, -3)).toBe(0);
  });
});

describe("pi-reader: isRowVisible", () => {
  it("可见区间", () => {
    expect(isRowVisible(5, 0, 20)).toBe(true);
    expect(isRowVisible(17, 0, 20)).toBe(true); // 20-1-2 =17 可见
    expect(isRowVisible(18, 0, 20)).toBe(false); // 贴底 2 行不可见
    expect(isRowVisible(0, 0, 20)).toBe(true);
    expect(isRowVisible(25, 10, 20)).toBe(true);
  });
});

describe("pi-reader: computeTargetScrollTop", () => {
  it("visible + keep => null", () => {
    expect(computeTargetScrollTop(5, 0, 20, 100, "pinTop", "keep")).toBe(null);
  });
  it("visible + reanchor => 滚动", () => {
    expect(computeTargetScrollTop(5, 0, 20, 100, "pinTop", "reanchor")).toBe(4);
  });
  it("不可见 => 计算 offset", () => {
    // target 30, scrollTop 0, vh20, pinTop1 => 29
    expect(computeTargetScrollTop(30, 0, 20, 100, "pinTop", "keep")).toBe(29);
    expect(computeTargetScrollTop(30, 0, 20, 100, "third", "keep")).toBe(24);
  });
  it("clamp 到 maxTop", () => {
    expect(computeTargetScrollTop(200, 0, 20, 50, "pinTop", "keep")).toBe(50);
    expect(computeTargetScrollTop(5, 0, 20, 50, 100, "reanchor")).toBe(0);
    expect(computeTargetScrollTop(5, 0, 20, 100, 100, "keep")).toBe(null);
  });
});

describe("pi-reader: findPromptRows", () => {
  it("扫描 OSC133;A", () => {
    const lines = ["a", "\x1b]133;A\x07prompt", "b", "\x1b]133;A\x1b\\prompt2", "c"];
    expect(findPromptRows(lines)).toEqual([1, 3]);
  });
  it("空数组", () => { expect(findPromptRows([])).toEqual([]); });
});

describe("pi-reader: findToolRows", () => {
  it("启发式工具头", () => {
    const lines = ["\x1b[31m▌ bash · ls\x1b[0m", "normal", "⎿ result", "  read file", "● tool"];
    const rows = findToolRows(lines);
    expect(rows).toContain(0);
    expect(rows).toContain(2);
    expect(rows).toContain(4);
  });
});

describe("pi-reader: findAnswerRows", () => {
  it("prompt 后首个非空", () => {
    const lines = ["\x1b]133;A\x07", "", "  answer line", "other", "\x1b]133;A\x07", "next answer"];
    expect(findAnswerRows(lines)).toEqual([2, 5]);
  });
});

describe("pi-reader: findParagraphBounds", () => {
  it("} 找下一个段落首", () => {
    const lines = ["para1 line1", "para1 line2", "", "para2 line1", "para2 line2", "", "para3 line1"];
    expect(findParagraphBounds(lines, 0, 1)).toBe(3);
    expect(findParagraphBounds(lines, 3, 1)).toBe(6);
    expect(findParagraphBounds(lines, 6, 1)).toBe(null);
  });
  it("{ 找上一个段落首", () => {
    const lines = ["para1 line1", "para1 line2", "", "para2 line1", "para2 line2", "", "para3 line1"];
    expect(findParagraphBounds(lines, 6, -1)).toBe(3);
    expect(findParagraphBounds(lines, 3, -1)).toBe(0);
    expect(findParagraphBounds(lines, 0, -1)).toBe(null);
  });
  it("连续空行合并", () => {
    const lines = ["a", "", "", "b", "", "c"];
    expect(findParagraphBounds(lines, 0, 1)).toBe(3);
    expect(findParagraphBounds(lines, 3, 1)).toBe(5);
  });
  it("分隔线 ─ 视为边界", () => {
    const lines = ["para1", "───", "para2", "", "para3"];
    expect(findParagraphBounds(lines, 0, 1)).toBe(2);
    expect(findParagraphBounds(lines, 2, 1)).toBe(4);
    expect(findParagraphBounds(lines, 4, -1)).toBe(2);
  });
});

describe("pi-reader: getViewportState", () => {
  it("降级返回 20", () => {
    const vs = getViewportState(null);
    expect(vs.vh).toBe(20);
    expect(vs.scrollTop).toBe(0);
  });
  it("从 tui 读取", () => {
    const tui: any = {
      currentLayout: { primaryScrollView: { viewportHeight: 30, scrollTop: 10 } },
      getPrimaryScrollView: () => ({ viewportHeight: 30, scrollTop: 10 }),
    };
    const vs = getViewportState(tui);
    expect(vs.vh).toBe(30);
    expect(vs.scrollTop).toBe(10);
  });
});
