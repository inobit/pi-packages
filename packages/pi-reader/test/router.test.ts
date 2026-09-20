import { describe, it, expect, vi } from "vitest";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import {
  createReadingKeyRouter,
  hasActiveSearch,
  hideNativeSearchOverlay,
  isForeignFocus,
  nativeTuiSurface,
  openNativeSearch,
  readNativeSearchSnapshot,
  searchUiOnOpen,
  SearchMode,
  type ReadingRouterIO,
} from "../src/index.ts";

/**
 * 双渠道共用路由单测：依赖注入 fake tui 与可控状态。
 * 注意：不构造带 extensionSelector 的假对象——真实运行时该私有字段恒不可达，
 * 弹窗探测走 focusedComponent 引用比对，fake 只需提供可切换的 dialogOpen()。
 */
function makeHarness(overrides: Partial<ReadingRouterIO> = {}) {
  const state = {
    isReading: true,
    searchMode: SearchMode.INACTIVE,
    helpOpen: false,
    dialogOpen: false,
  };
  const calls = {
    toggle: vi.fn(),
    showHelp: vi.fn(),
    handleEsc: vi.fn(),
    closeSearch: vi.fn(),
    expand: vi.fn(),
    renders: vi.fn(),
    searchInput: vi.fn(),
    semanticNav: vi.fn(),
  };
  const tui: any = {
    scrollBy: vi.fn(),
    scrollToTop: vi.fn(),
    scrollToBottom: vi.fn(),
    requestRender: vi.fn(),
  };
  const io: ReadingRouterIO = {
    isReading: () => state.isReading,
    searchMode: () => state.searchMode,
    helpOpen: () => state.helpOpen,
    dialogOpen: () => state.dialogOpen,
    getTui: () => tui,
    isDuplicateNav: () => false,
    handleSearchInput: (d, tt, src) => { calls.searchInput(d, tt, src); return true; },
    handleEsc: () => { calls.handleEsc(); },
    closeSearch: () => { calls.closeSearch(); },
    toggle: () => { calls.toggle(); state.isReading = !state.isReading; },
    showHelp: () => { calls.showHelp(); },
    closeHelp: () => { state.helpOpen = false; },
    matchesExpand: () => false,
    toggleToolsExpanded: () => { calls.expand(); },
    trySemanticNav: (d, tt) => { calls.semanticNav(d, tt); return false; },
    getViewportHeight: () => 20,
    ggPress: () => false,
    ggReset: () => {},
    countPeek: () => undefined,
    countReset: () => {},
    resetModifiers: () => {},
    updateLastSemantic: () => {},
    requestRender: () => { calls.renders(); },
    ...overrides,
  };
  return {
    state,
    calls,
    tui,
    term: createReadingKeyRouter(io, "terminal"),
    input: createReadingKeyRouter(io, "input"),
  };
}

describe("router: 外部弹窗夺焦期间（dialogOpen=true）", () => {
  it("渠道 1：Enter/j/CSI Down/SSU Down/?/esc 全量透传（返回 undefined）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    for (const d of ["\r", "j", "k", "\x1b[B", "\x1bOB", "?", "\x1b"]) {
      expect(h.term(d)).toBeUndefined();
    }
    // 未产生任何阅读副作用
    expect(h.calls.toggle).not.toHaveBeenCalled();
    expect(h.calls.handleEsc).not.toHaveBeenCalled();
    expect(h.calls.showHelp).not.toHaveBeenCalled();
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
  });

  it("渠道 1：toggle 键被消费屏蔽，但不翻转 isReading、不触发任何 UI 切换（防 Bug B）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    // VITEST 下 toggle 固定 alt+o
    expect(h.term("\x1bo")).toEqual({ consume: true });
    expect(h.calls.toggle).not.toHaveBeenCalled();
    expect(h.state.isReading).toBe(true);
    // Kitty 协议序列同样屏蔽
    expect(h.term("\u001b[111;3u")).toEqual({ consume: true });
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("渠道 2：toggle 键也全量透传（让渡渠道 1，不本地消费）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    expect(h.input("\x1bo")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("渠道 2：SEARCH_INPUT 态下字符同样透传给弹窗（守卫优先于搜索态）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    h.state.searchMode = SearchMode.INPUT;
    for (const d of ["a", "\r", "\x1bOB"]) {
      expect(h.input(d)).toBeUndefined();
    }
    expect(h.calls.searchInput).not.toHaveBeenCalled();
  });
});

describe("router: 无弹窗正常路径（回归）", () => {
  it("渠道 1：toggle 正常切换且消费", () => {
    const h = makeHarness();
    expect(h.term("\x1bo")).toEqual({ consume: true });
    expect(h.calls.toggle).toHaveBeenCalledTimes(1);
    expect(h.state.isReading).toBe(false);
  });

  it("渠道 2：toggle 让渡渠道 1（返回 undefined，不重复切换）", () => {
    const h = makeHarness();
    expect(h.input("\x1bo")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("READING 下 j/k 行级滚动 + count 前缀生效", () => {
    const h = makeHarness({ countPeek: () => 5 });
    expect(h.term("j")).toEqual({ consume: true });
    expect(h.tui.scrollBy).toHaveBeenLastCalledWith(5);
    expect(h.input("k")).toEqual({ consume: true });
    expect(h.tui.scrollBy).toHaveBeenLastCalledWith(-5);
  });

  it("§3.3：application cursor keys 的 SSU 方向键序列透传（\\x1bO 前缀）", () => {
    const h = makeHarness();
    // Down/Up 在 application cursor keys 模式为 \x1bOB/\x1bOA，应透传给焦点组件而非被吞
    expect(h.term("\x1bOB")).toBeUndefined();
    expect(h.term("\x1bOA")).toBeUndefined();
    // CSI 序列照旧透传
    expect(h.term("\x1b[B")).toBeUndefined();
    // 多字节非 CSI/SSU 序列仍消费，避免泄漏进核心
    expect(h.term("\x1bz")).toEqual({ consume: true });
  });

  it("编辑态（isReading=false）：导航键不消费、不滚动", () => {
    const h = makeHarness();
    h.state.isReading = false;
    expect(h.term("j")).toBeUndefined(); // 渠道 1 非阅读态只关心 toggle
    expect(h.input("j")).toBeUndefined(); // 渠道 2 非阅读态透传
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
  });

  it("?：渠道 2 让渡，渠道 1 打开帮助并消费；helpOpen 时两渠道早退", () => {
    const h = makeHarness();
    expect(h.input("?")).toBeUndefined();
    expect(h.calls.showHelp).not.toHaveBeenCalled();
    expect(h.term("?")).toEqual({ consume: true });
    expect(h.calls.showHelp).toHaveBeenCalledTimes(1);
    h.state.helpOpen = true;
    expect(h.term("?")).toBeUndefined();
    expect(h.input("?")).toBeUndefined();
  });

  it("esc 二义：无搜索时经 handleEsc 走退出；i 在 NAV 态先清搜索留在 READING", () => {
    const h = makeHarness();
    expect(h.term("\x1b")).toEqual({ consume: true });
    expect(h.calls.handleEsc).toHaveBeenCalledTimes(1);
    expect(h.calls.toggle).not.toHaveBeenCalled();

    h.state.searchMode = SearchMode.NAV;
    expect(h.term("i")).toEqual({ consume: true });
    expect(h.calls.closeSearch).toHaveBeenCalledTimes(1);
    expect(h.calls.toggle).not.toHaveBeenCalled();

    // 无搜索时 i 直接退阅读
    h.state.searchMode = SearchMode.INACTIVE;
    expect(h.term("i")).toEqual({ consume: true });
    expect(h.calls.toggle).toHaveBeenCalledTimes(1);
  });

  it("SEARCH_INPUT：两渠道全量交给 handleSearchInput；未消费则透传", () => {
    const h = makeHarness();
    h.state.searchMode = SearchMode.INPUT;
    expect(h.term("a")).toEqual({ consume: true });
    expect(h.input("b")).toEqual({ consume: true });
    expect(h.calls.searchInput).toHaveBeenCalledWith("a", h.tui, "terminal");
    expect(h.calls.searchInput).toHaveBeenCalledWith("b", h.tui, "input");
    // handler 返回 undefined（如非 INPUT 兜底）→ 不消费
    const h2 = makeHarness({ handleSearchInput: () => undefined });
    h2.state.searchMode = SearchMode.INPUT;
    expect(h2.term("a")).toBeUndefined();
  });

  it("gg 同批连发直达顶部；单个 g 等待双击仅消费不滚动", () => {
    const h = makeHarness();
    expect(h.term("gg")).toEqual({ consume: true });
    expect(h.tui.scrollToTop).toHaveBeenCalledTimes(1);
    expect(h.term("g")).toEqual({ consume: true });
    expect(h.tui.scrollToTop).toHaveBeenCalledTimes(1);
  });

  it("G 底部 / ctrl-u 半页", () => {
    const h = makeHarness();
    expect(h.term("G")).toEqual({ consume: true });
    expect(h.tui.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(h.term("\x15")).toEqual({ consume: true }); // ctrl+u，vh=20 → half=10
    expect(h.tui.scrollBy).toHaveBeenLastCalledWith(-10);
  });

  it("去重命中：直接消费且不再触发滚动/语义导航", () => {
    const h = makeHarness({ isDuplicateNav: () => true });
    expect(h.term("j")).toEqual({ consume: true });
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
    expect(h.calls.semanticNav).not.toHaveBeenCalled();
  });

  it("app.tools.expand 命中：触发工具展开并消费", () => {
    const h = makeHarness({ matchesExpand: (d) => d === "\x0f" });
    expect(h.term("\x0f")).toEqual({ consume: true });
    expect(h.calls.expand).toHaveBeenCalledTimes(1);
  });

  it("语义导航命中即消费", () => {
    const semNav = vi.fn((d: string) => d === "/");
    const h = makeHarness({ trySemanticNav: semNav });
    expect(h.term("/")).toEqual({ consume: true });
    expect(semNav).toHaveBeenCalledWith("/", h.tui);
    expect(h.term("x")).toEqual({ consume: true }); // 未命中落入 other 分支仍消费
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
  });

  it("非 INPUT 态不进入搜索处理分支（NAV/INACTIVE 均不调 handleSearchInput）", () => {
    const h = makeHarness();
    for (const mode of [SearchMode.NAV, SearchMode.INACTIVE]) {
      h.state.searchMode = mode;
      h.term("a");
      h.input("b");
    }
    expect(h.calls.searchInput).not.toHaveBeenCalled();
  });

  it("多字符粘贴块：渠道 2 单字节逐个消费，非 CSI 多字节消费", () => {
    const h = makeHarness();
    expect(h.input("abc")).toEqual({ consume: true });
    expect(h.input("\x02\x05")).toEqual({ consume: true });
  });

  it("帮助+弹窗并存：帮助逻辑上也在最上——esc 关帮助，其余键全部承接不透传", () => {
    const h = makeHarness();
    h.state.helpOpen = true;
    h.state.dialogOpen = true;
    // esc → 关帮助（消费），不触碰弹窗、不退阅读
    expect(h.term("\x1b")).toEqual({ consume: true });
    expect(h.state.helpOpen).toBe(false);
    expect(h.calls.handleEsc).not.toHaveBeenCalled();
    expect(h.calls.toggle).not.toHaveBeenCalled();
    // 帮助已关、弹窗仍在：再按 esc 透传给弹窗（不退阅读）
    expect(h.term("\x1b")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
    // 并存期间：j/enter 等被帮助层承接（不下漏到看不见的弹窗），toggle 同样被吞
    h.state.helpOpen = true;
    expect(h.term("j")).toEqual({ consume: true });
    expect(h.term("\r")).toEqual({ consume: true });
    expect(h.term("\x1bo")).toEqual({ consume: true });
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("帮助+弹窗并存仅限渠道 1 承接按键；渠道 2 全量透传（由渠道 1 消费兜底）", () => {
    const h = makeHarness();
    h.state.helpOpen = true;
    h.state.dialogOpen = true;
    expect(h.input("\x1b")).toBeUndefined();
  });
});

describe("hasActiveSearch", () => {
  it("activeSearch 存在判定，异常降级 false", () => {
    expect(hasActiveSearch({ activeSearch: { query: "x" } })).toBe(true);
    expect(hasActiveSearch({})).toBe(false);
    expect(hasActiveSearch(null)).toBe(false);
  });
});

describe("isForeignFocus（dialogOpen 判定本体，fake tui 注入 focusedComponent）", () => {
  const editor = { id: "reader-editor" };
  const help = { id: "help-overlay" };
  const searchComp = { id: "search-input" };
  const own = { editor, help, searchComponent: searchComp };

  it("焦点为空（undefined/null）→ false（无法判定时不拦截任何键）", () => {
    expect(isForeignFocus(undefined, own)).toBe(false);
    expect(isForeignFocus(null, own)).toBe(false);
  });

  it("焦点是 reader 编辑器 → false（基层正常态）", () => {
    expect(isForeignFocus(editor, own)).toBe(false);
  });

  it("三重豁免：帮助 overlay / 搜索输入组件 → false", () => {
    expect(isForeignFocus(help, own)).toBe(false);
    expect(isForeignFocus(searchComp, own)).toBe(false);
  });

  it("焦点是外部组件（扩展弹窗/输入框等夺焦场景）→ true", () => {
    expect(isForeignFocus({ id: "extension-selector" }, own)).toBe(true);
    // 链式弹窗换组件后仍是外部组件（select → input 同层切换）
    expect(isForeignFocus({ id: "extension-input" }, own)).toBe(true);
  });

  it("引用比对而非结构比对：同形对象不相等；豁免字段缺省时同样生效", () => {
    expect(isForeignFocus({ id: "reader-editor" }, own)).toBe(true); // 结构相同但引用不同
    expect(isForeignFocus(help, {})).toBe(true); // 未登记豁免则视为外部
    expect(isForeignFocus(searchComp, { editor })).toBe(true);
  });
});

describe("openNativeSearch（开启原生搜索：跨 pi-tui 版本的唯一分叉点）", () => {
  it("0.86.0 形态（只有 toggleSearch）：调用一次即开启，且 this 绑定到 TUI 本体", () => {
    const seen: unknown[] = [];
    const tui = { toggleSearch(this: unknown) { seen.push(this); } };
    expect(openNativeSearch(tui)).toBe("opened");
    // 类方法内部读 this.activeSearch，丢 this 会直接抛错
    expect(seen).toEqual([tui]);
  });

  it("0.84.x 形态（只有 openSearch）：回落旧名", () => {
    const openSearch = vi.fn();
    expect(openNativeSearch({ openSearch })).toBe("opened");
    expect(openSearch).toHaveBeenCalledTimes(1);
  });

  it("两代 API 都不存在 → unavailable（调用方据此提示 Search unavailable）", () => {
    expect(openNativeSearch({})).toBe("unavailable");
    expect(openNativeSearch(null)).toBe("unavailable");
    expect(openNativeSearch(undefined)).toBe("unavailable");
  });

  it("已存在 activeSearch 时不再调用：0.86.0 的 toggleSearch 是开关，重复调用会把搜索关掉", () => {
    const toggleSearch = vi.fn();
    expect(openNativeSearch({ toggleSearch, activeSearch: { query: "x" } })).toBe("already-open");
    expect(toggleSearch).not.toHaveBeenCalled();
    // 0.84.2 路径同样跳过：reader 开启后立即隐藏 overlay，无需重新聚焦
    const openSearch = vi.fn();
    expect(openNativeSearch({ openSearch, activeSearch: { query: "x" } })).toBe("already-open");
    expect(openSearch).not.toHaveBeenCalled();
  });

  it("两代 API 并存时优先新名", () => {
    const toggleSearch = vi.fn();
    const openSearch = vi.fn();
    expect(openNativeSearch({ toggleSearch, openSearch })).toBe("opened");
    expect(toggleSearch).toHaveBeenCalledTimes(1);
    expect(openSearch).not.toHaveBeenCalled();
  });

  it("核心抛错时向上冒泡，由调用方统一降级，不静默吞掉", () => {
    expect(() => openNativeSearch({ toggleSearch() { throw new Error("boom"); } })).toThrow("boom");
  });
});

describe("nativeTuiSurface / 原生搜索快照读取", () => {
  it("非对象句柄一律降级为空面且不抛错", () => {
    for (const v of [null, undefined, 0, "", "tui", true]) {
      expect(nativeTuiSurface(v)).toEqual({});
      expect(hasActiveSearch(v)).toBe(false);
      expect(readNativeSearchSnapshot(v)).toBeNull();
      expect(() => hideNativeSearchOverlay(v)).not.toThrow();
    }
  });

  it("快照优先取输入组件当前值（去空白），并带上匹配进度", () => {
    const tui = {
      activeSearch: {
        query: "stale",
        selectedIndex: 1,
        matches: [{}, {}, {}],
        component: { input: { getValue: () => "  fresh  " } },
      },
    };
    expect(readNativeSearchSnapshot(tui)).toEqual({ query: "fresh", idx: 1, total: 3 });
  });

  it("查询为空时仍返回快照（由调用方决定清栏还是显示输入态）", () => {
    expect(readNativeSearchSnapshot({ activeSearch: {} })).toEqual({ query: "", idx: -1, total: 0 });
  });

  it("hideNativeSearchOverlay 调 overlay.hide；缺失或抛错均不冒泡", () => {
    const hide = vi.fn();
    hideNativeSearchOverlay({ activeSearch: { overlay: { hide } } });
    expect(hide).toHaveBeenCalledTimes(1);
    expect(() => hideNativeSearchOverlay({ activeSearch: { overlay: {} } })).not.toThrow();
    expect(() => hideNativeSearchOverlay({ activeSearch: { overlay: { hide() { throw new Error("x"); } } } })).not.toThrow();
  });
});

describe("searchUiOnOpen（按 / 时底部栏的初始显示）", () => {
  const nativeState = {
    activeSearch: {
      query: "tokyo",
      selectedIndex: 1,
      matches: [{}, {}, {}],
      component: { input: { getValue: () => "tokyo" } },
    },
  };

  it("首次开启：输入态、查询为空", () => {
    expect(searchUiOnOpen("opened", {})).toEqual({ mode: true, query: "", idx: -1, total: 0 });
  });

  it("复用既有原生搜索：回填 query 与进度（否则显示为空、实际在改旧查询）", () => {
    expect(searchUiOnOpen("already-open", nativeState)).toEqual({ mode: true, query: "tokyo", idx: 1, total: 3 });
  });

  it("already-open 但原生暂无查询：仍是空输入栏", () => {
    expect(searchUiOnOpen("already-open", { activeSearch: {} })).toEqual({ mode: true, query: "", idx: -1, total: 0 });
  });

  it("unavailable 不回填（调用方直接返回 false，不进输入态）", () => {
    expect(searchUiOnOpen("unavailable", nativeState)).toEqual({ mode: true, query: "", idx: -1, total: 0 });
  });
});

describe("核心私有面契约（对真实 @earendil-works/pi-tui 原型方法探测）", () => {
  // reader 依赖的搜索/滚动成员是类私有成员，tsc 看不见；此处按运行时原型链断言：
  // 核心一旦再次改名/删除，本用例失败，而不是让功能在升级后静默失效
  // （0.86.0 把 openSearch 改成 toggleSearch 即此类变更，当时无任何测试拦得住）。
  //
  // 覆盖边界（勿高估）：只能覆盖 **TuiAltScreen 原型链上的方法**（含 TuiBase 继承项）。
  // 看不见的：实例字段 activeSearch / focusedComponent，以及 activeSearch 下的
  // component / overlay 成员（属 AltScreenSearchComponent / OverlayHandle）——
  // 这些每次升级核心必须人工核对，清单见包 AGENTS.md「核心私有面」。
  //
  // 已知假阳性：核心若把某方法改成实例箭头函数字段（合法重构），`in` 会失败而 reader
  // 仍可工作——请人工确认 reader 侧探测可用后同步更新本名单。
  const proto = TuiAltScreen.prototype as unknown as Record<string, unknown>;

  it("搜索/滚动/提示相关私有方法仍存在，且仍是函数", () => {
    for (const name of [
      "toggleSearch", "closeSearch", "navigateSearch",
      "getPrimaryScrollView", "scrollBy", "scrollToTop", "scrollToBottom",
      "flash", "requestRender",
    ]) {
      expect(name in proto, `@earendil-works/pi-tui 不再提供 ${name}`).toBe(true);
      // 只断言存在不够：成员降级成非函数会让 reader 静默走降级分支
      expect(typeof proto[name], `${name} 不再是函数`).toBe("function");
    }
  });

  it("开启搜索至少有一代可用名（0.84.x openSearch / 0.86.0+ toggleSearch）", () => {
    const names = ["toggleSearch", "openSearch"];
    expect(names.some((n) => typeof proto[n] === "function"), `两代开启 API 都缺失：${names.join(" / ")}`).toBe(true);
  });
});
