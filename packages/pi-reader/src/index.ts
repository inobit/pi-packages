/**
 * pi-reader — Vim 风格阅读模式扩展（fullscreen）
 *
 * 架构：TUI inputListener + onTerminalInput 双通道：
 *   - alt+o（config.json: toggleKey 可改）进/出 READING，Promise 异步展开工具
 *   - ctrl-u/d 半页上/下   ctrl-f/b 整页上/下   j/k 行级
 *   - g g 顶部（300ms，含同批 gg）  G 底部
 *   - [q/]q 问题  [a/]a 回答  [t/]t 工具  {/} 段落  / n/N 搜索
 *   - esc/i/c 退出 READING   ? 帮助弹窗（英文，Esc 关闭）
 *   - 输入栏 READING 时左显 ◉ Reading 覆盖，原输入保留
 *   - count 前缀 1-9 累积（0 仅已有 buffer 时追加，800ms 清空），5j / 3]q 生效
 * 弹窗让路（plan-dialog-interaction-fix）：外部组件夺焦（扩展弹窗/ui.input 等）期间，
 *   唯一拦截的是 toggle 键（放行会致容器重建 + promise 悬挂），其余全量透传；
 *   探测为每键实时焦点比对 focusedComponent ≠ reader 编辑器（豁免自有帮助/搜索组件）
 * 搜索状态机（满足四目标）：
 *   READING --"/"--> SEARCH_INPUT --enter--> SEARCH_NAV --esc--> READING
 *   READING --"/"--> SEARCH_INPUT --esc--> READING (取消高亮)
 *   SEARCH_NAV --esc--> READING (关闭搜索栏+取消高亮)
 *   READING (无搜索) --esc--> INSERT (退出阅读)
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

// ---------- 纯逻辑（可单测） ----------

/** 视口半页滚动量（与 TuiAltScreen 一致：floor(vh/2)） */
export function halfPage(vh: number): number {
  return Math.max(1, Math.floor(vh / 2));
}
/** 视口整页滚动量（与 TuiAltScreen OVERLAP=1 一致：vh-1） */
export function pageStep(vh: number): number {
  return Math.max(1, vh - 1);
}

export type ReadingKey =
  | "toggle" | "halfUp" | "halfDown" | "pageUp" | "pageDown"
  | "lineUp" | "lineDown" | "top" | "bottom" | "exit" | "help" | "other";

// ---------- 锚定与可见性（可单测） ----------

export type Anchor = "pinTop" | "third" | "center" | number;
export type VisibleBehavior = "keep" | "reanchor";
export interface NavConfig {
  questionAnchor?: Anchor;
  visibleBehavior?: VisibleBehavior;
  wrapNavigation?: boolean;
  /** 切换阅读模式时是否自动展开/收拢工具输出（plan §9.1）；未配置默认 true */
  autoExpandTools?: boolean;
}

/** 计算锚定偏移量 */
export function getAnchorOffset(vh: number, anchor: Anchor): number {
  if (typeof anchor === "number") return Math.max(0, Math.min(Math.floor(anchor), Math.max(0, vh - 1)));
  if (anchor === "pinTop") return 1;
  if (anchor === "third") return Math.max(0, Math.floor(vh / 3));
  if (anchor === "center") return Math.max(0, Math.floor(vh / 2));
  return 1;
}

/** 判断行是否可见（留 2 行边距，避免贴底） */
export function isRowVisible(row: number, scrollTop: number, vh: number): boolean {
  if (vh <= 0) return false;
  const visibleTop = scrollTop;
  const visibleBottom = scrollTop + vh - 1;
  // 贴底 2 行视为不可见，促使用户看清上下文
  return row >= visibleTop && row <= visibleBottom - 2;
}

/**
 * 计算目标滚动位置
 * @returns null 表示可见且 keep 策略时不动视口；否则返回 clamp 后的 scrollTop
 */
export function computeTargetScrollTop(
  targetRow: number,
  scrollTop: number,
  vh: number,
  maxTop: number,
  anchor: Anchor,
  visibleBehavior: VisibleBehavior = "keep",
): number | null {
  if (isRowVisible(targetRow, scrollTop, vh) && visibleBehavior === "keep") return null;
  const offset = getAnchorOffset(vh, anchor);
  const desired = targetRow - offset;
  return Math.max(0, Math.min(desired, Math.max(0, maxTop)));
}

// ---------- 搜索状态机（可单测） ----------
export enum SearchMode {
  INACTIVE = 0, // 无搜索
  INPUT = 1,    // / 已按，接收所有输入直到 enter
  NAV = 2,      // 已提交，n/N 导航，仅接受 ? 快捷键
}
export function isEnterKey(d: string): boolean {
  if (d === "\r" || d === "\n" || d === "\x0d" || d === "\x0a") return true;
  if (d.includes("\r") || d.includes("\n")) return true;
  try { if (matchesKey(d, "enter")) return true; } catch {}
  try { if (matchesKey(d, Key.enter)) return true; } catch {}
  if (/^\x1b\[13(;.*)?u$/.test(d)) return true;
  return false;
}
export function isEscKey(d: string): boolean {
  if (d === "\x1b" || d === "\x1b[27u") return true;
  if (d.startsWith("\x1b[27")) return true;
  try { if (matchesKey(d, "escape")) return true; } catch {}
  try { if (matchesKey(d, Key.escape)) return true; } catch {}
  // \x1b 单字节 esc 已在 parseReadingKey 中单独处理，isEscKey 需严格避免 alt+o 误判
  if (d === "\x1b") return true;
  return false;
}

// ---------- 原生搜索 API 兼容层（pi-tui 私有面，跨版本差异的唯一收敛点） ----------
//
// 下列成员均**不在 pi-tui 的公开 `TUI` 接口**里（`openSearch`/`toggleSearch` 是类私有字段），
// 只能按结构探测：一律声明为可选，缺失即视为不支持，读取方负责降级，不做多余假设。
// 版本差异：0.84.2 为 `openSearch()`（幂等开启）；0.86.0 起改名 `toggleSearch()` 且改为开关语义。

/** 原生搜索输入组件（pi-tui AltScreenSearchComponent 中 reader 依赖的部分） */
export interface NativeSearchComponent {
  handleInput?(data: string): void;
  input?: { getValue?(): string } | null;
}

/** 原生 overlay 句柄（pi-tui OverlayHandle 中 reader 依赖的部分） */
export interface NativeSearchOverlay {
  hide?(): void;
  focus?(): void;
  isFocused?(): boolean;
}

/** 原生搜索态（pi-tui activeSearch 中 reader 依赖的部分；0.86.0 起多出内部 index 字段，reader 不使用） */
export interface NativeSearchState {
  component?: NativeSearchComponent | null;
  query?: string;
  matches?: readonly unknown[] | null;
  selectedIndex?: number;
  overlay?: NativeSearchOverlay | null;
}

/** 主滚动视图（pi-tui ScrollView 中 reader 依赖的部分） */
export interface NativeScrollView {
  viewportHeight?: number;
}

/** reader 依赖的 TUI 私有面；新增探测项一律保持可选，保证 `TUI` 仍可赋值给本类型 */
export interface NativeTuiSurface {
  activeSearch?: NativeSearchState | null;
  /** 当前持焦组件（public `TUI` 接口未声明，位于 TuiBase）；dialogOpen 焦点比对用 */
  focusedComponent?: unknown;
  /** 0.86.0+：开关切换（已开时再调用会关闭搜索） */
  toggleSearch?(): void;
  /** 0.84.x：幂等开启（已开时仅重新聚焦 overlay） */
  openSearch?(): void;
  closeSearch?(): void;
  navigateSearch?(direction: number): void;
  getPrimaryScrollView?(): NativeScrollView | null | undefined;
  /** 视口滚动（public `TUI` 接口未声明） */
  scrollBy?(lines: number): void;
  scrollToTop?(): void;
  scrollToBottom?(): void;
  flash?(message: string): void;
  requestRender?(force?: boolean): void;
}

/** 将任意 TUI 句柄收窄到结构面；非对象（含 undefined/null）一律视为空面，探测不抛错 */
export function nativeTuiSurface(tui: unknown): NativeTuiSurface {
  return (typeof tui === "object" && tui !== null ? tui : {}) as NativeTuiSurface;
}

/** 原生搜索开启结果 */
export type NativeSearchOpenOutcome = "opened" | "already-open" | "unavailable";

/**
 * 兼容开启原生搜索栏（跨 pi-tui 版本的唯一分叉点）。
 *
 * 已存在 activeSearch 时必须跳过调用：0.86.0 的 `toggleSearch()` 是开关，重复调用会把搜索关掉；
 * 0.84.2 的 `openSearch()` 虽然幂等（仅重新聚焦 overlay），但 reader 开启后立即隐藏 overlay，
 * 原生 activeSearch 会一直保留到 esc 关闭，两条版本路径下都无需重复开启。
 *
 * @returns opened=本次开启；already-open=沿用既有原生搜索态；unavailable=两代 API 都不存在
 */
export function openNativeSearch(tui: unknown): NativeSearchOpenOutcome {
  const t = nativeTuiSurface(tui);
  const openCompat: (() => void) | undefined =
    typeof t.toggleSearch === "function" ? t.toggleSearch
      : typeof t.openSearch === "function" ? t.openSearch
        : undefined;
  if (!openCompat) return "unavailable";
  if (t.activeSearch) return "already-open";
  openCompat.call(t);
  return "opened";
}

/**
 * 读取原生搜索进度快照：查询串优先取输入组件当前值（0.86.0 下与 activeSearch.query 同步）。
 * 无原生搜索态返回 null；查询为空仍返回快照，由调用方决定是清栏还是显示输入态。
 */
export function readNativeSearchSnapshot(tui: unknown): { query: string; idx: number; total: number } | null {
  const search = nativeTuiSurface(tui).activeSearch;
  if (!search) return null;
  return {
    query: String(search.component?.input?.getValue?.() ?? search.query ?? "").trim(),
    idx: search.selectedIndex ?? -1,
    total: search.matches?.length ?? 0,
  };
}

/** 隐藏原生右上角 overlay（保留原生 refreshSearch 高亮，视觉上只留底部 Search 栏） */
export function hideNativeSearchOverlay(tui: unknown): void {
  try { nativeTuiSurface(tui).activeSearch?.overlay?.hide?.(); } catch {}
}

/** 底部 Search 栏的显示状态（reader 自有镜像，非原生状态） */
export interface SearchBarState {
  /** true=输入态（`Search: <q>`）；false=已提交态（`Search "<q>" (n/m)`） */
  mode: boolean;
  query: string;
  idx: number;
  total: number;
}

/**
 * 按 `/` 打开搜索时底部栏的初始显示状态。
 *
 * 复用既有原生搜索（outcome=already-open，例如 NAV 态再按 `/`）必须先回填原生 query 与进度：
 * reader 开启后立即隐藏 overlay，原生 activeSearch 会一直存活到 esc，后续按键继续追加到
 * 旧查询上；此时若栏内显示空查询，就会出现「显示为空、实际在改旧查询」的错位。
 */
export function searchUiOnOpen(outcome: NativeSearchOpenOutcome, tui: unknown): SearchBarState {
  const existing = outcome === "already-open" ? readNativeSearchSnapshot(tui) : null;
  return {
    mode: true,
    query: existing?.query ?? "",
    idx: existing?.idx ?? -1,
    total: existing?.total ?? 0,
  };
}

// ---------- 按键路由（双渠道共用核心，依赖注入可单测；见 plan-dialog-interaction-fix §4.1.2） ----------

/** 判断 TUI 是否处于原生搜索态（activeSearch 存在即视为有搜索栏） */
export function hasActiveSearch(tui: unknown): boolean {
  try { return !!nativeTuiSurface(tui).activeSearch; } catch { return false; }
}

/** reader 自有组件引用集合（焦点豁免用） */
export interface OwnFocusRefs {
  /** reader 自己创建的最新编辑器实例（ScrollReaderEditor / ReadonlyEditor） */
  editor?: unknown;
  /** 帮助 overlay 组件引用 */
  help?: unknown;
  /** 原生搜索输入组件（activeSearch.component） */
  searchComponent?: unknown;
}

/**
 * 弹窗夺焦判定本体（纯函数，可单测）：焦点被非 reader 组件持有时为真。
 * 三重豁免：reader 编辑器、自有帮助 overlay、原生搜索输入组件——
 * 不依赖「overlay.hide 同步还原 preFocus」的隐式时序。
 */
export function isForeignFocus(focus: unknown, own: OwnFocusRefs): boolean {
  if (!focus) return false;
  if (focus === own.editor) return false;
  if (focus === own.help) return false;
  if (focus === own.searchComponent) return false;
  return true;
}

/** inputListener / onTerminalInput 的返回结果 */
export type RouteResult = { consume: true } | undefined;

/** 双渠道共用按键路由的依赖注入接口：listener 只做薄接线，路由逻辑独立单测 */
export interface ReadingRouterIO {
  /** 是否处于 READING */
  isReading(): boolean;
  /** 搜索状态机当前值 */
  searchMode(): SearchMode;
  /** 帮助弹窗是否打开 */
  helpOpen(): boolean;
  /** 外部组件夺焦探测（扩展弹窗/ui.input 等一切夺焦场景）；为真时除渠道 1 的 toggle 外全量透传 */
  dialogOpen(): boolean;
  /** 当前 TUI 引用（结构探测，调用方各自收窄） */
  getTui(): unknown;
  /** 双通道去重（terminal 对极短时间内重复投递抑制） */
  isDuplicateNav(data: string, source: "input" | "terminal"): boolean;
  /** 搜索输入处理（INPUT 态全量接收直到 enter/esc）；返回 undefined 表示未消费 */
  handleSearchInput(data: string, tui: unknown, source: "input" | "terminal"): boolean | undefined;
  /** esc 二义处理：有搜索栏就关搜索取消高亮，否则退出阅读 */
  handleEsc(tui: unknown): void;
  /** 清搜索栏并取消高亮，重置状态机，留在 READING */
  closeSearch(tui: unknown): void;
  /** 切换阅读模式 */
  toggle(): void;
  /** 打开帮助弹窗 */
  showHelp(): void;
  /** 关闭帮助 overlay（done→hideOverlay；弹窗持焦时不抢焦点） */
  closeHelp(): void;
  /** app.tools.expand 键位匹配 */
  matchesExpand(data: string): boolean;
  /** 工具展开切换（app.tools.expand 命中时调用，含锚点保位） */
  toggleToolsExpanded(): void;
  /** 语义导航（/ n N {} 与 [q/a/t 序列）；返回 true 表示已消费 */
  trySemanticNav(data: string, tui: unknown): boolean;
  /** 视口高度读取（异常时兜底 20） */
  getViewportHeight(tui: unknown): number;
  /** gg 双击判定 */
  ggPress(): boolean;
  ggReset(): void;
  countPeek(): number | undefined;
  countReset(): void;
  /** 重置 count buffer 与 [ ] 序列缓冲（透传前清残留修饰状态） */
  resetModifiers(): void;
  /** 记录上次语义跳目标 */
  updateLastSemantic(row: number): void;
  requestRender(tui: unknown): void;
}

/**
 * 创建双渠道共用的按键路由（TUI inputListener = "input"，onTerminalInput = "terminal"）。
 *
 * 分层语义（plan §5）：
 * - 外部弹窗夺焦期间：唯一拦截的是 toggle——它是唯一直接操作「层」本身的按键，
 *   放行会导致编辑器容器重建、弹窗 promise 永久悬挂（Bug B）；其余按键全部透传；
 * - 渠道 2 的 toggle/help 让渡渠道 1 统一处理，避免双通道重复；
 * - READING 内优先级：SEARCH_INPUT > toggle > help > exit > expand > 语义导航 > 滚动。
 */
export function createReadingKeyRouter(io: ReadingRouterIO, source: "input" | "terminal"): (data: string) => RouteResult {
  return (data: string): RouteResult => {
    const tui = io.getTui();
    const nativeTui = nativeTuiSurface(tui);
    const reading = io.isReading();

    // ─── 外部弹窗/帮助并存期的按键接管（设计约束，勿改语义）─────
    //
    // 分发模型：pi-tui 先逐个执行 TUI 级 inputListeners（本函数即其中之一），
    // 任一 consume 则终止分发；全部放行才轮到 focusedComponent.handleInput。
    // 即本函数位于焦点组件（弹窗）的「上游必经之路」，consume = 键永远消失，
    // 放行 = 继续流向下游焦点窗体。核心在弹窗出现时 setFocus(弹窗)，
    // 帮助 overlay 只是视觉残留在上层、已失焦——「逻辑栈顶」由本路由的判定模拟。
    //
    // 三态决策表：
    //   ① help 开 && 焦点被外部夺走：UI 最上层是帮助 → 逻辑上也置顶——
    //      esc 关帮助（closeHelp 走 overlay hide，仅在自持焦点时才恢复焦点，
    //      故不抢弹窗焦点），其余键一律承接吞掉（与帮助常态「只认 esc」一致，
    //      不下漏到看不见的弹窗，防误 terminate）；关闭后落入态②
    //   ② 仅外部弹窗夺焦：只吞 toggle——它是唯一直接操作「层」本身的键，
    //      放行会触发核心 setCustomEditorComponent 无条件 editorContainer.clear()，
    //      弹窗 promise 永久悬挂（Bug B）；其余全量放行给弹窗正常操作（Bug A 修复）
    //   ③ 都不是：落到下方常规阅读路由
    // 探测为每键实时焦点比对（非快照），链式弹窗 select→input 换组件也能感知。
    if (io.dialogOpen()) {
      if (source === "terminal") {
        if (io.helpOpen()) {
          if (isEscKey(data) || data === "\x1b") {
            io.closeHelp();
            io.requestRender(tui);
          }
          // esc 关帮助；其余键一律承接不透传（UI 与逻辑统一在帮助层）
          return { consume: true };
        }
        if (parseReadingKey(data) === "toggle") {
          return { consume: true };
        }
      }
      return undefined;
    }

    // 帮助 overlay 打开（无外部弹窗）：两渠道均早退（焦点在 overlay 上，自收输入）
    if (io.helpOpen()) return undefined;

    const key = parseReadingKey(data);

    // 渠道 1：toggle 切换阅读模式（置于 SEARCH_INPUT 之前，维持原优先级）
    if (source === "terminal" && key === "toggle") {
      io.toggle();
      io.requestRender(tui);
      return { consume: true };
    }

    // SEARCH_INPUT：接收所有输入直到 enter（优先级最高，?/i/toggle 等亦作文本）
    if (reading && io.searchMode() === SearchMode.INPUT) {
      const r = io.handleSearchInput(data, tui, source);
      if (r !== undefined) {
        io.requestRender(tui);
        return { consume: true };
      }
      return undefined;
    }

    // 渠道 2：toggle/help 仍由渠道 1 统一处理，避免双通道重复
    if (source === "input" && (key === "toggle" || key === "help")) return undefined;

    // 渠道 1：非阅读态只关心上方已处理的 toggle
    if (source === "terminal" && !reading) return undefined;

    // 渠道 1：? 打开帮助
    if (key === "help") {
      io.showHelp();
      io.requestRender(tui);
      return { consume: true };
    }

    // exit (esc/i/ctrl+c)：esc 二义由 handleEsc 统一——有搜索先关搜索，否则退阅读
    if (key === "exit") {
      if (!reading) return undefined;
      if (isEscKey(data) || data === "\x1b") {
        io.handleEsc(tui);
        io.requestRender(tui);
        return { consume: true };
      }
      // i / ctrl+c：有搜索时先清搜索（留在 READING），无搜索才退出
      if (io.searchMode() !== SearchMode.INACTIVE || hasActiveSearch(tui)) {
        io.closeSearch(tui);
        io.requestRender(tui);
        return { consume: true };
      }
      io.toggle();
      io.requestRender(tui);
      return { consume: true };
    }

    if (!reading) return undefined;

    // app.tools.expand（显式绑定键优先于固定白名单的语义导航，plan §9.2）
    try {
      if (io.matchesExpand(data)) {
        if (io.isDuplicateNav(data, source)) return { consume: true };
        io.toggleToolsExpanded();
        io.requestRender(tui);
        return { consume: true };
      }
    } catch { /* 键位表不可用则忽略 */ }

    // 双通道去重：同一按键极短时间内重复到达只处理一次
    if (io.isDuplicateNav(data, source)) return { consume: true };

    // 语义导航：/ n N {} 与 [q/a/t 序列
    if (io.trySemanticNav(data, tui)) {
      io.requestRender(tui);
      return { consume: true };
    }

    // 滚动导航
    const vh = Math.max(1, io.getViewportHeight(tui));
    const half = halfPage(vh);
    const page = pageStep(vh);
    const lineCnt = io.countPeek() ?? 1;
    switch (key) {
      case "halfUp": nativeTui.scrollBy?.(-half * lineCnt); io.countReset(); break;
      case "halfDown": nativeTui.scrollBy?.(half * lineCnt); io.countReset(); break;
      case "pageDown": nativeTui.scrollBy?.(page * lineCnt); io.countReset(); break;
      case "pageUp": nativeTui.scrollBy?.(-page * lineCnt); io.countReset(); break;
      case "lineUp": nativeTui.scrollBy?.(-lineCnt); io.countReset(); break;
      case "lineDown": nativeTui.scrollBy?.(lineCnt); io.countReset(); break;
      case "bottom": nativeTui.scrollToBottom?.(); io.countReset(); break;
      case "top":
        if (data === "gg") {
          io.ggReset();
          nativeTui.scrollToTop?.();
          io.countReset();
          io.updateLastSemantic(0);
        } else if (io.ggPress()) {
          nativeTui.scrollToTop?.();
          io.countReset();
          io.updateLastSemantic(0);
        } else {
          // 首 g：等待窗口内第二次 g
          return { consume: true };
        }
        break;
      case "other":
        if (source === "terminal") {
          // 多字节 CSI/SSU 序列（含 application cursor keys \x1bO…，§3.3）透传给焦点组件。
          // 注：此处不清理修饰缓冲（与 input 渠道不对称）——同一按键随后必达 input 渠道，
          // 由其 CSI/SSU 透传分支统一 countReset+resetModifiers，净效果一致
          if (data.length > 1 && (data.startsWith("\x1b[") || data.startsWith("\x1bO"))) return undefined;
        } else {
          // 单字节（含数字与不可打印控制符）一律消费，避免泄漏进核心编辑器
          if (isPrintable(data) || data.length === 1) return { consume: true };
          // 多字节非 CSI/SSU 序列消费；CSI/SSU 透传
          if (!(data.startsWith("\x1b[") || data.startsWith("\x1bO"))) return { consume: true };
          io.countReset();
          io.resetModifiers();
          return undefined;
        }
        break;
      default:
        return undefined;
    }
    io.requestRender(tui);
    return { consume: true };
  };
}

// ---------- 行扫描（可单测） ----------

const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const TOOL_MARKERS = ["▌", "⎿", "●", "○", "◐", "◑", "◒", "◓", "│", "├", "└"];

function isBlankLine(line: string): boolean {
  return stripTerminalSequences(line ?? "").trim() === "";
}

/** 段落边界：空行或分隔线（─/—/—/━/─）或 OSC133 区域前缀，需视为段落分隔 */
export function isParagraphBoundary(line: string): boolean {
  const raw = line ?? "";
  // OSC133 区域标记本身视为边界（由 paintBox 剥离，但 scrollContentLines 仍保留）
  if (OSC133_ZONE_PREFIX.test(raw)) return true;
  const stripped = stripTerminalSequences(raw).trim();
  if (stripped === "") return true;
  if (/^[-─—═━\s]+$/.test(stripped)) return true;
  return false;
}

function isToolLine(strippedTrim: string): boolean {
  if (!strippedTrim) return false;
  if (TOOL_MARKERS.some((m) => strippedTrim.startsWith(m))) return true;
  if (/^(bash|read|edit|write|grep|find|ls|todo)\b/i.test(strippedTrim)) return true;
  return false;
}

/** 扫描 prompt 行（OSC133;A） */
export function findPromptRows(lines: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (OSC133_PROMPT_START.test(lines[i] ?? "")) out.push(i);
  }
  return out;
}

/** 启发式扫描工具行 */
export function findToolRows(lines: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripTerminalSequences(lines[i] ?? "").trim();
    if (isToolLine(stripped)) out.push(i);
  }
  return out;
}

/** 回答行：每个 prompt 后的首个非空行 */
export function findAnswerRows(lines: string[]): number[] {
  const promptRows = findPromptRows(lines);
  if (promptRows.length === 0) return [];
  const res: number[] = [];
  for (const pr of promptRows) {
    let r = pr + 1;
    while (r < lines.length && isBlankLine(lines[r] ?? "")) r++;
    // 跳过可能紧跟的 133;B 结束标记行（同样含 OSC133 但非 A）
    while (r < lines.length && /^\x1b\]133;/.test(lines[r] ?? "")) {
      r++;
      while (r < lines.length && isBlankLine(lines[r] ?? "")) r++;
    }
    if (r < lines.length) res.push(r);
  }
  // 去重且保持递增
  return [...new Set(res)].sort((a, b) => a - b);
}

/**
 * 段落边界：空行/分隔线分隔
 * dir 1 找下一个段落首行，-1 找上一个段落首行
 */
export function findParagraphBounds(lines: string[], from: number, dir: -1 | 1): number | null {
  const n = lines.length;
  if (n === 0) return null;
  const isBoundary = (idx: number) => isParagraphBoundary(lines[idx] ?? "");
  const isContent = (idx: number) => !isBoundary(idx);
  if (dir === 1) {
    let i = from + 1;
    // 跳过当前段落剩余内容（若 from+1 仍在同段）
    while (i < n && isContent(i)) i++;
    // 跳过段落间边界
    while (i < n && isBoundary(i)) i++;
    if (i < n && isContent(i)) return i;
    return null;
  } else {
    // 往前找：先找到 from 所在段的段首，再往前找上一段
    let probe = from;
    // 若 from 在边界，先回退到内容
    while (probe >= 0 && isBoundary(probe)) probe--;
    if (probe < 0) return null;
    // 找到当前段首
    let curStart = probe;
    while (curStart >= 0 && isContent(curStart)) curStart--;
    curStart++;
    // 若 from 不在段首，上一段即 curStart 之前的段
    // 若 from 已在段首，需再往前一段
    let i = curStart - 1;
    while (i >= 0 && isBoundary(i)) i--;
    if (i < 0) return null;
    // i 在上一段内容中，找其段首
    let prevStart = i;
    while (prevStart >= 0 && isContent(prevStart)) prevStart--;
    prevStart++;
    while (prevStart < n && isBoundary(prevStart)) prevStart++;
    if (prevStart < n && isContent(prevStart)) return prevStart;
    return null;
  }
}

// ---------- 视口状态（可单测，需 try/catch 降级） ----------

export interface ViewportState {
  scrollView: any | null;
  lines: string[] | null;
  scrollTop: number;
  vh: number;
  maxTop: number;
  contentHeight: number;
}

/** 读取视口状态，需 try/catch 外层保证 regular 下静默 */
export function getViewportState(tui: any): ViewportState {
  try {
    const sv: any = tui?.currentLayout?.primaryScrollView ?? tui?.getPrimaryScrollView?.() ?? null;
    const vh: number = sv?.viewportHeight ?? tui?.getPrimaryScrollView?.()?.viewportHeight ?? 20;
    const scrollTop: number = sv?.scrollTop ?? tui?.viewportTop ?? 0;
    let lines: string[] | null = null;
    let contentHeight = 0;
    try {
      const layout: any = tui?.currentLayout;
      if (layout && sv) {
        // 复用 pi-tui 的 getScrollViewBox 逻辑：遍历 frame.root 树找 scrollView 对应的 box
        const findBox = (box: any): any | null => {
          if (!box) return null;
          if (box.scrollView === sv && box.scrollContentLines) return box;
          const children: any[] = box.children ?? [];
          for (const ch of children) {
            const found = findBox(ch);
            if (found) return found;
          }
          return null;
        };
        // frame.root 是根 box，若直接是 scrollView box 也处理
        let box: any = null;
        try {
          box = findBox(layout.root ?? layout);
          // 兜底：若 root 本身无 children，尝试 layout 本身的 scrollContentLines
          if (!box && layout.scrollContentLines) box = layout;
          // 兜底：遍历 layout 顶层属性找含 scrollContentLines 的对象
          if (!box) {
            for (const k of Object.keys(layout)) {
              const v: any = layout[k];
              if (v?.scrollContentLines && Array.isArray(v.scrollContentLines)) { box = v; break; }
            }
          }
        } catch {}
        if (box?.scrollContentLines) {
          lines = box.scrollContentLines as string[];
          contentHeight = lines.length;
        }
      }
      if (!lines) {
        const alt: any = sv?.scrollContentLines ?? tui?.scrollContentLines ?? null;
        if (Array.isArray(alt)) {
          lines = alt;
          contentHeight = lines.length;
        }
      }
    } catch {}
    if (!lines) {
      // 最后兜底：lines 为空时 contentHeight 用 vh 估算，maxTop 0
      contentHeight = Math.max(scrollTop + vh, vh);
    }
    const maxTop = Math.max(0, contentHeight - vh);
    return { scrollView: sv, lines, scrollTop, vh: Math.max(1, vh), maxTop, contentHeight };
  } catch {
    return { scrollView: null, lines: null, scrollTop: 0, vh: 20, maxTop: 0, contentHeight: 20 };
  }
}

/** 锚定滚动：计算目标并 scrollTo，返回是否滚动 */
export function scrollToAnchor(tui: any, targetRow: number, anchor: Anchor, visibleBehavior: VisibleBehavior = "keep"): boolean {
  const vs = getViewportState(tui);
  if (!vs.scrollView) return false;
  const computed = computeTargetScrollTop(targetRow, vs.scrollTop, vs.vh, vs.maxTop, anchor, visibleBehavior);
  if (computed === null) return false;
  try {
    vs.scrollView.scrollTo(computed, { disableFollow: true });
    tui?.requestRender?.();
    return true;
  } catch { return false; }
}

// ---------- 滚动锚点（模式切换保位，可单测；设计见 plan.md §4/§5） ----------

/** 滚动锚点：prompt 序号坐标系。展开/收起只改段内行数、不增删消息边界，k 跨切换严格稳定 */
export interface ScrollAnchor {
  /** 视口顶行上方最近的 prompt 序号（findPromptRows 下标）；-1 表示位于首个 prompt 之前的头部区域 */
  k: number;
  /** 视口顶行距该锚点的行偏移（同段内偏移；k=-1 时为距文档顶距离） */
  d: number;
  /** 全文 prompt 总数，恢复时 O(1) 校验聊天树是否重建 */
  count: number;
}

/**
 * 捕获滚动锚点：记录视口顶行相对最近 prompt 边界的位置。
 * @param lines 完整拍平内容行（getViewportState().lines）
 * @param scrollTop 视口顶行的绝对行号
 * @returns 行数组为空或全文无 prompt 时返回 null（无法建立锚点）
 */
export function captureAnchor(lines: string[] | null, scrollTop: number): ScrollAnchor | null {
  if (!lines || lines.length === 0) return null;
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return null;
  const promptRows = findPromptRows(lines);
  if (promptRows.length === 0) return null;
  // 二分找 ≤ scrollTop 的最后一个 prompt
  let lo = 0;
  let hi = promptRows.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((promptRows[mid] ?? 0) <= scrollTop) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (idx < 0) return { k: -1, d: Math.trunc(scrollTop), count: promptRows.length };
  return { k: idx, d: scrollTop - (promptRows[idx] ?? 0), count: promptRows.length };
}

/**
 * 计算恢复目标行（统一 clamp 模型：scrollTop' = clamp(base + d', 0, maxTop)，见 plan §5）。
 *
 * 先做 O(1) 结构校验：prompt 总数与捕获时不一致说明聊天树已重建，放弃恢复。
 * d 截断顺序：先夹进所在段（不超过下个 prompt），再整体夹进 [0, maxTop]——
 * 保证目标要么精确还原、要么落在同一问答边界内、要么贴底且仍在屏内。
 *
 * @param newLines 变更后的完整内容行
 * @param anchor 之前 captureAnchor 的产物
 * @param vh 视口高度（计算 maxTop 用）
 * @returns null 表示放弃恢复（结构变化或输入无效）；否则为绝对目标行号
 */
export function computeRestoreRow(newLines: string[] | null, anchor: ScrollAnchor, vh: number): number | null {
  if (!newLines || newLines.length === 0 || !anchor) return null;
  if (!Number.isFinite(vh) || vh < 1) return null;
  const promptRows = findPromptRows(newLines);
  if (promptRows.length !== anchor.count) return null;
  const maxTop = Math.max(0, newLines.length - Math.floor(vh));
  let base: number;
  let segEnd: number; // 所在段的结束界（不含）
  if (anchor.k < 0) {
    base = 0;
    segEnd = promptRows[0] ?? newLines.length;
  } else {
    const row = promptRows[anchor.k];
    if (row === undefined) return null;
    base = row;
    const next = promptRows[anchor.k + 1];
    segEnd = next === undefined ? newLines.length : next;
  }
  const dClamped = Math.min(Math.max(0, anchor.d), Math.max(0, segEnd - 1 - base));
  return Math.max(0, Math.min(base + dClamped, maxTop));
}

export interface ScrollRestoreMonitorOptions {
  /** 发起时的代际号；轮询期间不一致说明有新的高度变更动作，立即放弃 */
  generation: number;
  /** 当前代际号读取器 */
  getGeneration: () => number;
  /** 当前帧对象读取器（currentLayout 引用，换代即证明发生重排） */
  getFrame: () => unknown;
  /** 当前内容高度读取器 */
  getContentHeight: () => number;
  /** 布局稳定后的恢复回调（至多触发一次） */
  onRestore: () => void;
  /** 每次 tick 前主动请求一次渲染：pi-tui 按需渲染，空闲时零帧，
   *  不主动推进则“两个新帧”判据可能永远不满足（冒烟实测缺陷） */
  requestRender?: () => void;
  /** 轮询间隔 ms，默认 16 */
  intervalMs?: number;
  /** 最大轮询次数，默认 20，超限放弃 */
  maxTicks?: number;
}

/**
 * 恢复监视器：等布局稳定后执行一次恢复回调（plan §6 步骤③）。
 * 三重条件：generation 未变、currentLayout 帧代际变化、contentHeight 连续两个新帧相同。
 * 轮询默认 16ms/tick、上限 20 次，超限静默放弃（与包内降级策略一致）。
 */
export class ScrollRestoreMonitor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticks = 0;
  private prevFrame: unknown;
  private seenNewFrame = false;
  private lastHeight: number | null = null;
  private finished = false;

  constructor(private readonly o: ScrollRestoreMonitorOptions) {}

  /** 启动轮询；已启动/已完成时无效果 */
  start(): void {
    if (this.finished || this.timer !== undefined) return;
    this.prevFrame = this.safe(this.o.getFrame);
    this.schedule();
  }

  /** 中止轮询（含未决 timer） */
  stop(): void {
    this.finished = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (this.finished) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, this.o.intervalMs ?? 16);
  }

  private tick(): void {
    if (this.finished) return;
    try {
      if (this.o.getGeneration() !== this.o.generation) {
        this.stop();
        return;
      }
      try { this.o.requestRender?.(); } catch {}
      const frame = this.safe(this.o.getFrame);
      if (frame !== this.prevFrame) {
        const h = this.safe(this.o.getContentHeight);
        // 需要两个“不同帧”采样到相同高度才算稳定；采样失败（null）视为不稳定
        if (this.seenNewFrame && h !== null && h === this.lastHeight) {
          this.finished = true;
          this.stop();
          this.o.onRestore();
          return;
        }
        this.seenNewFrame = true;
        this.lastHeight = h;
      }
      this.prevFrame = frame;
    } catch { /* 防御：单次轮询异常不中断 */ }
    this.ticks += 1;
    if (this.ticks >= (this.o.maxTicks ?? 20)) {
      this.stop();
      return;
    }
    this.schedule();
  }

  private safe<T>(fn: () => T): T | null {
    try { return fn(); } catch { return null; }
  }
}

// ---------- toggleKey / NavConfig 缓存（启动时加载，修改后需 reload / 重启 pi 生效，无 TTL） ----------
let cachedToggleKeyRaw: string | undefined;
let hasToggleKeyCache = false;

let cachedNavConfig: NavConfig | undefined;
let hasNavCache = false;

function readConfigJson(): any {
  try {
    const fs: any = (globalThis as any).require?.("fs") ?? (globalThis as any).process?.getBuiltinModule?.("fs");
    if (!fs) return undefined;
    try {
      // jiti 会把模块编译为 base64 data:URL（import.meta.url 拿不到文件路径），
      // 但 CJS 包装作用域注入了 __dirname（实测可用）；从 src/ 加载时取父级即包目录
      let baseDir = "";
      try {
        baseDir = (typeof __dirname !== "undefined" && __dirname) ? __dirname : "";
      } catch {}
      const path: any = (globalThis as any).require?.("path") ?? (globalThis as any).process?.getBuiltinModule?.("path");
      const candidates = [
        baseDir ? path?.join?.(baseDir, "..", "config.json") : "",
        baseDir ? path?.join?.(baseDir, "config.json") : "",
      ];
      for (const cfg of candidates) {
        if (cfg && fs?.existsSync?.(cfg)) {
          return JSON.parse(fs.readFileSync(cfg, "utf8"));
        }
      }
    } catch {}
    const path: any = (globalThis as any).require?.("path") ?? (globalThis as any).process?.getBuiltinModule?.("path");
    const os: any = (globalThis as any).require?.("os") ?? (globalThis as any).process?.getBuiltinModule?.("os");
    const home: string = os?.homedir?.() ?? (process as any).env?.HOME ?? "";
    const extCfg = path?.join?.(home, ".pi", "agent", "extensions", "pi-reader", "config.json");
    if (extCfg && fs?.existsSync?.(extCfg)) {
      return JSON.parse(fs.readFileSync(extCfg, "utf8"));
    }
  } catch {}
  return undefined;
}

function readToggleKeyRaw(): string | undefined {
  const j = readConfigJson();
  if (j?.toggleKey) return String(j.toggleKey);
  return undefined;
}

function getToggleKeyRawCached(): string | undefined {
  if (hasToggleKeyCache) return cachedToggleKeyRaw;
  cachedToggleKeyRaw = readToggleKeyRaw();
  hasToggleKeyCache = true;
  return cachedToggleKeyRaw;
}

function getToggleKeyNormalized(): string {
  if ((process as any).env?.VITEST) return "alt+o";
  const raw = getToggleKeyRawCached();
  return raw ? raw.toLowerCase() : "alt+o";
}

function readNavConfigRaw(): NavConfig {
  if ((process as any).env?.VITEST) return {};
  const j = readConfigJson();
  if (!j) return {};
  const out: NavConfig = {};
  if (j.questionAnchor !== undefined) out.questionAnchor = j.questionAnchor as Anchor;
  if (j.visibleBehavior !== undefined) out.visibleBehavior = j.visibleBehavior as VisibleBehavior;
  if (j.wrapNavigation !== undefined) out.wrapNavigation = Boolean(j.wrapNavigation);
  if (j.autoExpandTools !== undefined) out.autoExpandTools = Boolean(j.autoExpandTools);
  return out;
}

export function getNavConfigCached(): NavConfig {
  if (hasNavCache) return cachedNavConfig ?? {};
  cachedNavConfig = readNavConfigRaw();
  hasNavCache = true;
  return cachedNavConfig ?? {};
}

/**
 * 需求 A：模式切换时是否自动展开/收拢工具输出（plan §9.1）。
 * 默认 false：保持工具状态不动，进出阅读位置天然无损；true 为显式选择，
 * 展开动作走锚点包装补偿位置。VITEST 空配置同样走此兑底，防测试基线漂移。
 */
export function isAutoExpandToolsEnabled(): boolean {
  const v = getNavConfigCached().autoExpandTools;
  return v === undefined ? false : v;
}

export function __resetNavConfigCacheForTest(): void {
  hasNavCache = false;
  cachedNavConfig = undefined;
  hasToggleKeyCache = false;
  cachedToggleKeyRaw = undefined;
}

/**
 * 归并终端原始键序列到阅读语义。兼容传统控制符（\x0f 等）与 Kitty 协议序列
 * （\x1b[<char>;5u）。"top" 由 g/g 及同批连发的 "gg" 触发，双击时序由
 * 调用方用 GgSequence 判定（"gg" 同块到达即视为双击命中）。
 */
export function parseReadingKey(d: string): ReadingKey {
  // 默认 alt+o，仅生效用户配置的那个；测试环境固定 alt+o
  const isToggle = (() => {
    try {
      if ((process as any).env?.VITEST) return d === "\x1bo" || d === "\u001b[111;3u";
      const active = getToggleKeyNormalized();
      const ctrlO = d === "\x0f" || d === "\u001b[111;5u" || d === "\x1b\x0f";
      const altO = d === "\x1bo" || d === "\u001b[111;3u";
      if (active === "ctrl+o" || active === "ctrl-o") return ctrlO;
      if (active === "alt+o" || active === "alt-o") return altO;
      // 无配置或未知：默认仅 alt+o 生效
      return altO;
    } catch { return d === "\x1bo" || d === "\u001b[111;3u"; }
  })();
  if (isToggle) return "toggle";
  if (d === "\x15" || d === "\u001b[117;5u") return "halfUp"; // ctrl+u
  if (d === "\x04" || d === "\u001b[100;5u") return "halfDown"; // ctrl+d
  if (d === "\x06" || d === "\u001b[102;5u") return "pageDown"; // ctrl+f
  if (d === "\x02" || d === "\u001b[98;5u") return "pageUp"; // ctrl+b
  if (d === "\x10" || d === "\u001b[112;5u") return "lineUp"; // ctrl+p
  if (d === "\x0e" || d === "\u001b[110;5u") return "lineDown"; // ctrl+n
  if (d === "k") return "lineUp";
  if (d === "j") return "lineDown";
  if (d === "G") return "bottom"; // shift+g
  if (d === "g" || d === "gg") return "top"; // gg 双击 / 同批连发
  if (d === "?") return "help";
  if (matchesKey(d, "escape") || d === "i" || matchesKey(d, Key.ctrl("c"))) return "exit";
  return "other";
}

/** gg 双击判定（纯时序，可测）。窗口过短（如 100ms）或浏览器/终端把两个 g
 *  合并为同一块输入时都会让 gg 失效，默认 500ms 较稳，实例化常用 300ms。 */
export class GgSequence {
  private lastAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private winMs = 500) {}
  /** 记录一次 g；返回 true 表示 winMs 内双击命中（顶部） */
  press(now = Date.now()): boolean {
    const hit = now - this.lastAt < this.winMs;
    this.clearTimer();
    if (hit) {
      this.lastAt = 0;
      return true;
    }
    this.lastAt = now;
    this.timer = setTimeout(() => { this.lastAt = 0; }, this.winMs);
    return false;
  }
  reset(): void {
    this.lastAt = 0;
    this.clearTimer();
  }
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** count 前缀：1-9 累积，0 仅已有 buffer 时追加，800ms 清空 */
export class CountBuffer {
  private buf = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private winMs = 800) {}
  push(d: string): boolean {
    if (!/^[0-9]$/.test(d)) return false;
    if (d === "0" && this.buf === "") return false; // 前导 0 忽略（vim 0 行首）
    if (this.buf.length >= 4) return false; // 避免超大 count
    this.buf += d;
    this.clearTimer();
    this.timer = setTimeout(() => { this.buf = ""; }, this.winMs);
    if (this.timer && typeof (this.timer as any).unref === "function") (this.timer as any).unref();
    return true;
  }
  consume(): number | undefined {
    if (this.buf === "") return undefined;
    const n = parseInt(this.buf, 10);
    this.reset();
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  peek(): number | undefined {
    if (this.buf === "") return undefined;
    const n = parseInt(this.buf, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  hasValue(): boolean { return this.buf !== ""; }
  reset(): void {
    this.buf = "";
    this.clearTimer();
  }
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** [ / ] + q/a/t 序列，500ms 窗口 */
export class BracketSequence {
  private pending: "[" | "]" | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private winMs = 500) {}
  /**
   * @returns "prevQ"|"nextQ"|"prevA"|"nextA"|"prevT"|"nextT" 命中；"pending" 表示已收 leader 等待；null 无命中
   */
  push(data: string, now = Date.now()): string | null {
    void now;
    if (data === "[" || data === "]") {
      this.pending = data as "[" | "]";
      this.clearTimer();
      this.timer = setTimeout(() => { this.pending = null; }, this.winMs);
      if (this.timer && typeof (this.timer as any).unref === "function") (this.timer as any).unref();
      return "pending";
    }
    if (this.pending && (data === "q" || data === "a" || data === "t")) {
      const dir = this.pending === "[" ? "prev" : "next";
      const kind = data.toUpperCase(); // Q/A/T
      this.pending = null;
      this.clearTimer();
      return `${dir}${kind}`;
    }
    // 非预期字符，清空 pending
    if (this.pending) {
      this.pending = null;
      this.clearTimer();
    }
    return null;
  }
  reset(): void {
    this.pending = null;
    this.clearTimer();
  }
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function isPrintable(data: string): boolean {
  const cc = data.charCodeAt(0) || 0;
  return data.length === 1 && cc >= 32;
}

// ---------- 编辑器组件 ----------

/** 占位编辑器：输入/渲染实际由 listener 接管（INSERT 时透传）。
 *  必须带真实 theme/keybindings 构造（空对象会让 Editor.render borderColor() 崩）。 */
export class ScrollReaderEditor extends CustomEditor {
  public onReadingChange?: (reading: boolean) => void;
  public tuiRef: TUI;

  constructor(tui: TUI, theme: any, keybindings: any) {
    super(tui, theme, keybindings);
    this.tuiRef = tui;
  }
}

/** 只读编辑器：READING 时完全覆盖原 input 位置，居中显示 ◉ Reading，无边框。
 *  搜索输入态时同位置显示 Search: <query> (n/m)，替换式常驻、不堆叠。 */
export class ReadonlyEditor extends CustomEditor {
  private readonly accent: (s: string) => string;
  private readonly searchUiRef?: SearchBarState;
  constructor(tui: TUI, theme: any, keybindings: any, style: { accent: (s: string) => string }, searchUiRef?: SearchBarState) {
    super(tui, theme, keybindings);
    this.accent = style.accent;
    this.searchUiRef = searchUiRef;
  }
  override render(width: number): string[] {
    const su = this.searchUiRef;
    const q = (su?.query ?? "").trim();
    const inSearchInput = !!(su && su.mode);
    let line: string;
    if (su && (q || inSearchInput)) {
      const count = su.total > 0 ? ` (${Math.max(1, su.idx + 1)}/${su.total})` : (q ? " (no matches)" : "");
      const label = inSearchInput ? `Search: ${q}${count}` : `Search "${q}"${count}`;
      line = "  " + this.accent(label);
    } else if (su && q) {
      const count = su.total > 0 ? ` (${Math.max(1, su.idx + 1)}/${su.total})` : " (no matches)";
      const label = `Search "${q}"${count}`;
      line = "  " + this.accent(label);
    } else {
      line = "  " + this.accent("◉ Reading");
    }
    const w = visibleWidth(line);
    line += " ".repeat(Math.max(0, width - 2 - w));
    const empty = " ".repeat(width);
    return [empty, line, empty];
  }
  override handleInput(_data: string): void {}
  override getText(): string { return ""; }
  override getExpandedText(): string { return ""; }
  override setText(_text: string): void {}
  override setPaddingX(_padding: number): void {}
  override setAutocompleteMaxVisible(_maxVisible: number): void {}
}

// ---------- 工厂与扩展装配 ----------
export default function (pi: ExtensionAPI) {
  let isReading = false;
  let currentCtx: ExtensionContext | undefined;
  let ctxBroken = false;
  let savedInput = "";
  let latestTui: TUI | undefined;
  // 需求 B：最近一次 factory 收到的应用级 keybindings（terminal 通道回调无 kb 入参，需在外层记账）
  let latestKb: any;
  // 工具展开状态本地镜像：核心 ui context 无读取 getter，扩展发起的每次变更在此记账；
  // null 表示尚未得知（首次推导规则见 applyReaderUI）。已知限制：编辑态由核心路径
  // （actionHandler 等）切换工具输出时镜像不感知会漂移，进入 READING 后即重新对齐。
  let toolsExpandedMirror: boolean | null = null;
  // 滚动恢复代际号：每次新的高度变更动作递增，作废在途监视器（防快速连按竞态）
  let scrollGen = 0;
  let offTerminalInput: (() => void) | undefined;
  // inputListener 只安装一次：mainFactory 退出阅读恢复时会再次被调用，防止重复拦截。
  let listenerInstalled = false;
  // reader 自己创建的最新编辑器实例（两个工厂都要登记）；不能用 instanceof——
  // jiti 模块边界下会失效，核心自己也用 duck typing
  let currentReaderEditor: object | undefined;
  // reader 自有的帮助 overlay 组件引用（dialogOpen 豁免用）
  let currentHelpComponent: object | undefined;
  const gg = new GgSequence(300); // gg 300ms 双击（100ms 过短易失效）
  const countBuf = new CountBuffer(800);
  const bracketSeq = new BracketSequence(500);
  // 上次语义跳目标（5s 有效，用于 [q/]q 连续步进）
  let lastSemanticRow: number | null = null;
  let lastSemanticAt = 0;
  // 搜索状态机：INACTIVE(无) -> INPUT(/后全量接收) -> NAV(enter后仅?快捷键)
  let searchMode: SearchMode = SearchMode.INACTIVE;
  // 双通道去重：同一 data 在极短时间重复到达只处理一次
  let lastNavData = "";
  let lastNavAt = 0;
  let lastNavSource: "input" | "terminal" | null = null;

  const themeFg = (theme: any) => (theme?.fg ? theme.fg.bind(theme) : (t: string) => t);

  // READING 指示：状态直接显示在输入栏内（ReadonlyEditor），不再使用上方 widget
  const readingBarWidget = (_tui: any, _theme: any) => ({
    render: () => [] as string[],
    invalidate: () => {},
  });
  void readingBarWidget;

  const updateLastSemantic = (row: number): void => {
    lastSemanticRow = row;
    lastSemanticAt = Date.now();
  };

  const isDuplicateNav = (data: string, source: "input" | "terminal"): boolean => {
    const now = Date.now();
    // 仅抑制 terminal 对 input 的极短时间内重复投递（pi 双通道同一按键会走两条路径）
    // 窗口收敛到 20ms，降低人工连击 "aa" 被误判概率
    if (source === "terminal" && data === lastNavData && lastNavSource === "input" && now - lastNavAt < 20) {
      return true;
    }
    lastNavData = data;
    lastNavAt = now;
    lastNavSource = source;
    return false;
  };

  /**
   * 原生 flash（pi-tui `TuiBase.flash`）提示。
   * 降级语义与改前逐字一致：可选调用后立即 return，因此只有「flash 存在但调用抛错」
   * 才会回落到 `ui.notify`，核心无 flash 时保持静默（不改变现有可观测行为）。
   */
  const flash = (tui: unknown, msg: string): void => {
    const native = nativeTuiSurface(tui);
    if (typeof native.flash !== "function") return;
    try { native.flash.call(native, msg); return; } catch {}
    try { currentCtx?.ui?.notify?.(msg, "info"); } catch {}
  };

  /**
   * 焦点被非 reader 组件持有时为真（扩展弹窗/ui.input/ui.custom 等一切夺焦场景），
   * 此时 reader 必须让路。探测为每键实时焦点比对（非快照）：链式弹窗
   * （select → input 换组件）也能正确感知。豁免 reader 自有的编辑器、帮助组件
   * 与搜索输入组件，不依赖「overlay.hide 同步还原 preFocus」的隐式时序。
   */
  const dialogOpen = (): boolean => {
    try {
      const native = nativeTuiSurface(latestTui);
      return isForeignFocus(native.focusedComponent, {
        editor: currentReaderEditor,
        help: currentHelpComponent,
        searchComponent: native.activeSearch?.component,
      });
    } catch { return false; }
  };

  // 搜索进度显示在底部输入栏（ReadonlyEditor）固定位置替换，不用 flash。
  // 搜索阶段常驻显示 Search，直到 esc 取消，不做节流切回 Reading。
  const searchUi: SearchBarState = { mode: false, query: "", idx: -1, total: 0 };

  const clearSearchUi = (): void => {
    searchUi.mode = false;
    searchUi.query = "";
    searchUi.idx = -1;
    searchUi.total = 0;
  };

  /** 关闭搜索栏并取消高亮，重置状态机，留在 READING */
  const closeSearchAndReset = (tui: unknown): void => {
    try { nativeTuiSurface(tui).closeSearch?.(); } catch {}
    searchMode = SearchMode.INACTIVE;
    clearSearchUi();
    try { nativeTuiSurface(tui).requestRender?.(); } catch {}
  };

  const proxySearchOpen = (tui: unknown): boolean => {
    clearSearchUi();
    // 私有面结构探测：跨版本差异或核心内部异常统一降级为「不可用」，不让异常冒泡到按键路由
    let outcome: NativeSearchOpenOutcome = "unavailable";
    try { outcome = openNativeSearch(tui); } catch { outcome = "unavailable"; }
    if (outcome === "unavailable") {
      flash(tui, "Search unavailable");
      return false;
    }
    // 隐藏原生右上角 overlay，仅保留底部 ReadonlyEditor 的 Search 栏（单入口，避免双重 Search）
    // 仍保留原生匹配逻辑（refreshSearch）用于高亮，仅隐藏视觉
    hideNativeSearchOverlay(tui);
    searchMode = SearchMode.INPUT;
    // 初始化底部栏为输入态；already-open 时回填既有原生查询与进度，避免显示与实际错位
    Object.assign(searchUi, searchUiOnOpen(outcome, tui));
    try { nativeTuiSurface(tui).requestRender?.(); } catch {}
    return true;
  };

  /**
   * 搜索输入阶段（/ 到 enter）：接收所有输入直到 enter
   * - enter: 提交 -> NAV (高亮保留，n/N 接管) 或空查询则直接 INACTIVE
   * - esc: 取消 -> closeSearch 取消高亮，回到 READING
   * - 其他: 全部喂给官方 Input（含 j/k、退格、粘贴等）
   * 返回 true 表示已消费
   */
  const handleSearchInput = (d: string, tui: unknown, source: "input" | "terminal"): boolean | undefined => {
    if (searchMode !== SearchMode.INPUT) return undefined;
    if (isDuplicateNav(d, source)) return true;
    if (isEnterKey(d)) {
      // enter 切状态：有查询则进入 NAV，高亮保留；空查询则关闭
      try {
        const snapshot = readNativeSearchSnapshot(tui);
        if (!snapshot || !snapshot.query) {
          closeSearchAndReset(tui);
          return true;
        }
        try { nativeTuiSurface(tui).navigateSearch?.(1); } catch {}
        hideNativeSearchOverlay(tui);
        searchMode = SearchMode.NAV;
        // 同步底部栏显示（原生 matches 由 refreshSearch 在下一帧才更新，故延后取快照）
        setTimeout(() => {
          try {
            const p = readNativeSearchSnapshot(tui);
            if (!p || !p.query) { clearSearchUi(); return; }
            // hide 后可能因 render 重现 overlay，再次隐藏保留高亮
            hideNativeSearchOverlay(tui);
            searchUi.mode = false;
            searchUi.query = p.query;
            searchUi.idx = p.idx;
            searchUi.total = p.total;
            nativeTuiSurface(tui).requestRender?.();
          } catch {}
        }, 30);
      } catch {}
      return true;
    }
    if (isEscKey(d)) {
      // esc 有搜索栏就关闭取消高亮，留在 READING
      closeSearchAndReset(tui);
      return true;
    }
    const comp = nativeTuiSurface(tui).activeSearch?.component;
    if (comp && typeof comp.handleInput === "function") {
      try { comp.handleInput(d); } catch {}
      // 同步底部栏：实时反映 query 与匹配数（单入口，避免右上角重复）
      try {
        const curQ = readNativeSearchSnapshot(tui)?.query ?? "";
        // 下一帧 refreshSearch 才会更新 matches，先用当前 activeSearch 的值
        setTimeout(() => {
          try {
            const p = readNativeSearchSnapshot(tui);
            if (!p) return;
            // 确保原生 overlay 保持隐藏（仅底部栏）
            hideNativeSearchOverlay(tui);
            searchUi.mode = true;
            searchUi.query = curQ;
            searchUi.idx = p.idx;
            searchUi.total = p.total;
            nativeTuiSurface(tui).requestRender?.();
          } catch {}
        }, 15);
        if (curQ) {
          searchUi.mode = true;
          searchUi.query = curQ;
          try { nativeTuiSurface(tui).requestRender?.(); } catch {}
        } else {
          searchUi.query = "";
          searchUi.idx = -1;
          searchUi.total = 0;
        }
      } catch {}
      return true;
    }
    // 组件尚未就绪：仍消费避免落入 reading 导航
    return true;
  };

  const proxySearchNavigate = (tui: unknown, dir: number): boolean => {
    try {
      const native = nativeTuiSurface(tui);
      const navigate = native.navigateSearch;
      if (!native.activeSearch || typeof navigate !== "function") return false;
      navigate.call(native, dir);
      setTimeout(() => {
        try {
          const p = readNativeSearchSnapshot(tui);
          // 确保原生 overlay 保持隐藏（仅底部栏）
          hideNativeSearchOverlay(tui);
          if (!p || !p.query) { clearSearchUi(); return; }
          searchUi.mode = false;
          searchUi.query = p.query;
          searchUi.idx = p.idx;
          searchUi.total = p.total;
          nativeTuiSurface(tui).requestRender?.();
        } catch {}
      }, 30);
      return true;
    } catch {}
    return false;
  };

  const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi));

  const findNextRow = (rows: number[], from: number, dir: number, wrap: boolean): number | null => {
    if (dir > 0) {
      for (const r of rows) if (r > from) return r;
      if (wrap && rows.length > 0) return rows[0] ?? null;
      return null;
    } else {
      for (let i = rows.length - 1; i >= 0; i--) if ((rows[i] ?? 0) < from) return rows[i] ?? null;
      if (wrap && rows.length > 0) return rows[rows.length - 1] ?? null;
      return null;
    }
  };

  const navigateByKind = (kind: string, count: number, tui: any): boolean => {
    const vs = getViewportState(tui);
    if (!vs.lines) { flash(tui, "No content"); return true; }
    if (!vs.scrollView) return false;
    let rows: number[] = [];
    let label = "";
    switch (kind) {
      case "prevQ":
      case "nextQ":
        rows = findPromptRows(vs.lines);
        label = "Question";
        break;
      case "prevA":
      case "nextA":
        rows = findAnswerRows(vs.lines);
        label = "Answer";
        break;
      case "prevT":
      case "nextT":
        rows = findToolRows(vs.lines);
        label = "Tool";
        break;
      default: return false;
    }
    if (rows.length === 0) { flash(tui, `No ${label.toLowerCase()}s`); return true; }
    const dir = kind.startsWith("prev") ? -1 : 1;
    const cfg = getNavConfigCached();
    const anchor = (cfg.questionAnchor ?? "pinTop") as Anchor;
    const visibleBehavior = (cfg.visibleBehavior ?? "keep") as VisibleBehavior;
    const wrap = Boolean(cfg.wrapNavigation);
    let searchFrom: number;
    if (lastSemanticRow !== null && Date.now() - lastSemanticAt < 5000 && isRowVisible(lastSemanticRow, vs.scrollTop, vs.vh)) {
      searchFrom = dir > 0 ? lastSemanticRow + 1 : lastSemanticRow - 1;
    } else {
      searchFrom = vs.scrollTop;
      if (dir < 0 && vs.scrollTop === vs.maxTop) searchFrom = vs.scrollTop + vs.vh;
      else if (dir > 0) searchFrom = vs.scrollTop + 1;
    }
    let target: number | null = null;
    for (let i = 0; i < count; i++) {
      const nxt = findNextRow(rows, searchFrom, dir, wrap);
      if (nxt === null) break;
      target = nxt;
      searchFrom = dir > 0 ? nxt + 1 : nxt - 1;
    }
    if (target === null) {
      flash(tui, dir > 0 ? `No more ${label.toLowerCase()}s` : `No previous ${label.toLowerCase()}`);
      return true;
    }
    const isVis = isRowVisible(target, vs.scrollTop, vs.vh);
    if (isVis && visibleBehavior === "keep") {
      updateLastSemantic(target);
      const idx = rows.indexOf(target) + 1;
      flash(tui, `${label} ${idx}/${rows.length}`);
      return true;
    }
    const offset = getAnchorOffset(vs.vh, anchor);
    const desired = target - offset;
    const newTop = clamp(desired, 0, vs.maxTop);
    try {
      vs.scrollView.scrollTo(newTop, { disableFollow: true });
      updateLastSemantic(target);
      const idx = rows.indexOf(target) + 1;
      flash(tui, `${label} ${idx}/${rows.length}`);
      tui?.requestRender?.();
    } catch {}
    return true;
  };

  const navigateParagraph = (dir: -1 | 1, count: number, tui: any): boolean => {
    const vs = getViewportState(tui);
    if (!vs.lines) { flash(tui, "No content"); return true; }
    if (!vs.scrollView) return false;
    const cfg = getNavConfigCached();
    const anchor = (cfg.questionAnchor ?? "pinTop") as Anchor;
    let cur = vs.scrollTop;
    if (lastSemanticRow !== null && Date.now() - lastSemanticAt < 5000 && isRowVisible(lastSemanticRow, vs.scrollTop, vs.vh)) {
      cur = lastSemanticRow;
    }
    let target: number | null = null;
    for (let i = 0; i < count; i++) {
      const nxt = findParagraphBounds(vs.lines, cur, dir);
      if (nxt === null) break;
      target = nxt;
      cur = nxt;
    }
    if (target === null) {
      flash(tui, dir > 0 ? "No next paragraph" : "No previous paragraph");
      return true;
    }
    const offset = getAnchorOffset(vs.vh, anchor);
    const newTop = clamp(target - offset, 0, vs.maxTop);
    try {
      vs.scrollView.scrollTo(newTop, { disableFollow: true });
      updateLastSemantic(target);
      tui?.requestRender?.();
    } catch {}
    return true;
  };

  /**
   * 统一阅读态按键处理（供双通道复用）
   * @returns true 表示已消费
   */
  const tryHandleReadingNav = (data: string, tui: any): boolean => {
    if (data.length > 1 && !data.startsWith("\x1b") && data !== "gg") {
      let handledAny = false;
      let allHandled = true;
      for (const ch of data) {
        const r = tryHandleReadingNav(ch, tui);
        if (r) handledAny = true;
        else allHandled = false;
      }
      if (handledAny && allHandled) return true;
      if (!allHandled) return false;
      if (handledAny) return true;
      return false;
    }
    if (/^[0-9]$/.test(data) && data.length === 1) {
      const ok = countBuf.push(data);
      return true && (ok || true);
    }
    // 搜索：/ 进入 INPUT（全量接收），n/N 在 NAV/有搜索时导航
    if (data === "/") {
      const opened = proxySearchOpen(tui);
      if (opened) {
        countBuf.reset();
        bracketSeq.reset();
        tui?.requestRender?.();
        return true;
      }
      return false;
    }
    if (data === "n") {
      // 仅 NAV 或存在 activeSearch 时有效，避免无搜索时误触发
      if (searchMode === SearchMode.NAV || hasActiveSearch(tui)) {
        proxySearchNavigate(tui, 1);
        countBuf.reset();
        tui?.requestRender?.();
        return true;
      }
      return false;
    }
    if (data === "N") {
      if (searchMode === SearchMode.NAV || hasActiveSearch(tui)) {
        proxySearchNavigate(tui, -1);
        countBuf.reset();
        tui?.requestRender?.();
        return true;
      }
      return false;
    }
    if (data === "{" || data === "}") {
      const cnt = countBuf.consume() ?? 1;
      bracketSeq.reset();
      navigateParagraph(data === "{" ? -1 : 1, cnt, tui);
      return true;
    }
    const bracketRes = bracketSeq.push(data);
    if (bracketRes === "pending") {
      countBuf.peek();
      return true;
    }
    if (bracketRes) {
      const cnt = countBuf.consume() ?? 1;
      navigateByKind(bracketRes, cnt, tui);
      return true;
    }
    return false;
  };

  // ? 帮助弹窗内容：key 列 + 描述列，统一固定宽度对齐，保证盒子整齐可读
  const getHelpEntries = (): Array<[string, string]> => {
    const toggle = getActiveToggleLabel();
    const entries: Array<[string, string]> = [
      [toggle, "Toggle reading mode"],
      ["Ctrl+U / Ctrl+D", "Half page up / down"],
      ["Ctrl+F / Ctrl+B", "Page down / up"],
      ["j / k  /  Ctrl+N / Ctrl+P", "Line down / up (count, e.g. 5j)"],
      ["g g (within 300ms)", "Go to top"],
      ["G (Shift+G)", "Go to bottom"],
      ["[q / ]q", "Prev/next question"],
      ["[a / ]a", "Prev/next answer"],
      ["[t / ]t", "Prev/next tool"],
      ["{ / }", "Prev/next paragraph"],
      ["/ (Search)", "n / N  next/prev match"],
      ["Esc / i / Ctrl+C", "Exit reading mode"],
      ["?", "Show this help"],
    ];
    // 需求 B：动态插入 app.tools.expand 键位行（拿不到键位则隐藏该行，plan §9.2）
    try {
      const keys: string[] = latestKb?.getKeys?.("app.tools.expand") ?? [];
      if (keys.length > 0) {
        entries.splice(1, 0, [keys.join("/"), "Toggle tool output (edit & reading)"]);
      }
    } catch { /* 拿不到则隐藏 */ }
    return entries;
  };

  let helpOpen = false;
  // 帮助 overlay 的关闭入口（done 回调包装）：供 esc 路径与弹窗期守卫共用
  let helpClose: (() => void) | undefined;
  const showHelp = () => {
    if (helpOpen) return;
    let ui: any;
    try { ui = currentCtx?.ui; } catch { return; }
    if (!ui?.custom) return;
    helpOpen = true;
    currentHelpComponent = undefined;
    ui.custom((tui: any, _theme: any, _kb: any, done: (v: any) => void) => {
      const comp = {
        render: (width: number) => {
          const entries = getHelpEntries();
          const padL = 2;
          const keyW = 28;
          const descW = 42;
          const innerNeed = padL + keyW + 2 + descW;
          const usable = Math.min(innerNeed, Math.max(44, width - 2));
          const t = truncateToWidth;
          const center = (s: string): string => {
            const w = visibleWidth(s);
            const left = Math.max(0, Math.floor((usable - w) / 2));
            return " ".repeat(left) + s + " ".repeat(Math.max(0, usable - left - w));
          };
          const body = (row: string): string => {
            const w = visibleWidth(row);
            return "│" + " ".repeat(padL) + row + " ".repeat(Math.max(0, usable - padL - w)) + "│";
          };
          const out: string[] = [];
          out.push("╭" + "─".repeat(usable) + "╮");
          const titleRow = center("Reading Mode Help").trimEnd();
          out.push("│" + titleRow + " ".repeat(Math.max(0, usable - visibleWidth(titleRow))) + "│");
          out.push("│" + " ".repeat(usable) + "│");
          for (const [k, d] of entries) {
            const key = t(k, keyW);
            const descW2 = Math.max(0, usable - padL - keyW - 2);
            const desc = t(d, descW2);
            const row = key + " ".repeat(Math.max(0, keyW - visibleWidth(key))) + "  " + desc;
            out.push(body(row));
          }
          out.push("│" + " ".repeat(usable) + "│");
          const closeRow = center("Press Esc to close").trimEnd();
          out.push("│" + closeRow + " ".repeat(Math.max(0, usable - visibleWidth(closeRow))) + "│");
          out.push("╰" + "─".repeat(usable) + "╯");
          return out;
        },
        handleInput: (data: string) => {
          if (matchesKey(data, "escape")) helpClose?.();
        },
        invalidate: () => {},
        focused: true,
      } as any;
      // 登记 reader 自有 overlay 组件引用与关闭入口（dialogOpen 焦点比对豁免 / 弹窗期 esc 先关帮助）
      currentHelpComponent = comp;
      helpClose = () => {
        if (!helpOpen) return;
        helpOpen = false;
        currentHelpComponent = undefined;
        helpClose = undefined;
        done(undefined);
      };
      return comp;
    }, { overlay: true, overlayOptions: { anchor: "center" as any } } as any)?.then(() => {
      helpOpen = false;
      currentHelpComponent = undefined;
      helpClose = undefined;
    }).catch(() => {
      helpOpen = false;
      currentHelpComponent = undefined;
      helpClose = undefined;
    });
  };

  // 滚动恢复代际号递增：作废在途监视器，返回新号
  const advanceScrollGen = (): number => {
    scrollGen += 1;
    return scrollGen;
  };

  /** 守卫链捕获（plan §6）：scrollView 存在？lines 存在？非贴底跟随态？任一失败返回 null */
  const tryCaptureAnchor = (): ScrollAnchor | null => {
    try {
      const tui: any = latestTui;
      if (!tui) return null;
      const sv: any = tui.currentLayout?.primaryScrollView ?? tui.getPrimaryScrollView?.() ?? null;
      if (!sv) return null;
      try { if (sv.isFollowingEnd === true) return null; } catch {}
      const vs = getViewportState(tui);
      return captureAnchor(vs.lines, vs.scrollTop);
    } catch { return null; }
  };

  /**
   * 挂布局稳定监视器；稳定后按锚点 scrollTo(target, { disableFollow: true })。
   * disableFollow 必带：否则目标落底时会重新武装 follow-end，前功尽弃（plan §6 约束 3）。
   */
  const scheduleScrollRestore = (anchor: ScrollAnchor | null): void => {
    if (!anchor) return;
    const gen = scrollGen;
    try {
      const tui: any = latestTui;
      if (!tui) return;
      new ScrollRestoreMonitor({
        generation: gen,
        getGeneration: () => scrollGen,
        getFrame: () => (tui as any).currentLayout,
        getContentHeight: () => getViewportState(tui).contentHeight,
        requestRender: () => (tui as any).requestRender?.(),
        onRestore: () => {
          try {
            const cur: any = latestTui;
            if (!cur || scrollGen !== gen) return;
            const vs = getViewportState(cur);
            const target = computeRestoreRow(vs.lines, anchor, vs.vh);
            if (target === null || !vs.scrollView) return;
            vs.scrollView.scrollTo(target, { disableFollow: true });
            cur.requestRender?.();
          } catch { /* 静默降级 */ }
        },
      }).start();
    } catch { /* 静默降级 */ }
  };

  /**
   * 扩展侧统一的工具展开变更入口：镜像记账 + 锚点保位（先捕获再变更）。
   * applyReaderUI 的自动展开/收拢与 §9.2 阅读态手动分支都必须走这里。
   */
  const toggleToolsExpandedWithAnchor = (notify?: (msg: string) => void): void => {
    const next = !(toolsExpandedMirror ?? false);
    advanceScrollGen();
    // 必须在高度生效前同步捕获（setExpanded 在下一次 render 才改变行数）
    const anchor = tryCaptureAnchor();
    try { currentCtx?.ui?.setToolsExpanded?.(next); } catch {}
    toolsExpandedMirror = next;
    scheduleScrollRestore(anchor);
    if (notify) notify(`Tool output: ${next ? "expanded" : "collapsed"}`);
  };

  // 统一应用 READING UI；输入栏用 ReadonlyEditor 覆盖，保留原输入内容，工具展开/收起 Promise 异步不阻塞首帧
  const applyReaderUI = (reading: boolean) => {
    let ui: any;
    try {
      ui = currentCtx?.ui;
    } catch {
      ctxBroken = true;
      return;
    }
    if (!ui) return;
    const safe = (fn: () => void) => { try { fn(); } catch { /* 忽略 */ } };
    advanceScrollGen(); // 作废在途恢复监视器
    const autoExpand = isAutoExpandToolsEnabled();
    // 镜像推导：首次未知时按“刚进入且 autoExpandTools=true → true，否则 false”（plan §9.4）
    toolsExpandedMirror = autoExpand ? reading : (toolsExpandedMirror ?? false);
    // 捕获必须在任何高度变化之前同步完成（plan §6 约束 1）
    const anchor = tryCaptureAnchor();
    if (reading) {
      try { savedInput = ui.getEditorText?.() ?? ""; } catch { savedInput = ""; }
      safe(() => ui.setEditorComponent?.(readonlyEditorFactory(ui)));
      safe(() => ui.setEditorText?.(""));
      Promise.resolve().then(() => {
        try { if (autoExpand) ui.setToolsExpanded?.(true); } catch {}
        scheduleScrollRestore(anchor);
      });
    } else {
      safe(() => ui.setEditorComponent?.(mainFactory));
      Promise.resolve().then(() => {
        try { if (autoExpand) ui.setToolsExpanded?.(false); } catch {}
        scheduleScrollRestore(anchor);
      });
      const toRestore = savedInput;
      savedInput = "";
      if (toRestore) safe(() => ui.setEditorText?.(toRestore));
    }
  };

  // toggle：只翻转状态 + 尽力应用 UI
  /** @returns 是否实际翻转（外部弹窗持有焦点时被守卫拦截则返回 false） */
  const toggle = (ctx?: ExtensionContext): boolean => {
    if (ctx) {
      currentCtx = ctx;
      ctxBroken = false;
    }
    // 纵深防御：外部弹窗持有焦点时禁止切换——容器重建会让弹窗 promise 悬挂（Bug B）
    if (dialogOpen()) return false;
    if (isReading) {
      gg.reset();
      countBuf.reset();
      bracketSeq.reset();
      helpOpen = false;
      // 退出 reading 时若搜索还开着，一并关闭恢复视图
      try { nativeTuiSurface(latestTui).closeSearch?.(); } catch {}
      searchMode = SearchMode.INACTIVE;
      clearSearchUi();
    } else {
      // 进入 reading 时确保搜索状态干净
      searchMode = SearchMode.INACTIVE;
      clearSearchUi();
    }
    isReading = !isReading;
    applyReaderUI(isReading);
    return true;
  };

  /** esc 统一处理：有搜索栏就关闭取消高亮，留在 READING；无搜索才退出 READING */
  const handleEsc = (tui: unknown): boolean => {
    if (searchMode === SearchMode.INPUT || searchMode === SearchMode.NAV || hasActiveSearch(tui)) {
      closeSearchAndReset(tui);
      return true;
    }
    toggle();
    try { nativeTuiSurface(latestTui).requestRender?.(); } catch {}
    return true;
  };

  // ---------- 可测性接缝：双渠道共用路由的薄接线（单测见 test/router.test.ts） ----------
  const routerIO: ReadingRouterIO = {
    isReading: () => isReading,
    searchMode: () => searchMode,
    helpOpen: () => helpOpen,
    dialogOpen,
    getTui: () => latestTui ?? (currentCtx as any)?.ui?.tui ?? (currentCtx as any)?.tui,
    isDuplicateNav,
    handleSearchInput: (d, tui, src) => handleSearchInput(d, tui, src),
    handleEsc: (tui) => { handleEsc(tui); },
    closeSearch: (tui) => { closeSearchAndReset(tui); },
    toggle: () => toggle(),
    showHelp,
    closeHelp: () => { try { helpClose?.(); } catch {} },
    matchesExpand: (d) => {
      try { return latestKb?.matches?.(d, "app.tools.expand") === true; } catch { return false; }
    },
    toggleToolsExpanded: () => {
      const tt: any = latestTui ?? (currentCtx as any)?.ui?.tui ?? (currentCtx as any)?.tui;
      toggleToolsExpandedWithAnchor((m) => flash(tt, m));
    },
    trySemanticNav: (d, tui) => tryHandleReadingNav(d, tui),
    getViewportHeight: (tui) => {
      try {
        // 保留原有优先级：主通道缺失时才回落到最近一次 factory 收到的 TUI
        return nativeTuiSurface(tui).getPrimaryScrollView?.()?.viewportHeight
          ?? nativeTuiSurface(latestTui).getPrimaryScrollView?.()?.viewportHeight
          ?? 20;
      } catch { return 20; }
    },
    ggPress: () => gg.press(),
    ggReset: () => gg.reset(),
    countPeek: () => countBuf.peek(),
    countReset: () => countBuf.reset(),
    resetModifiers: () => { countBuf.reset(); bracketSeq.reset(); },
    updateLastSemantic,
    requestRender: (tui) => { try { nativeTuiSurface(tui).requestRender?.(); } catch {} },
  };
  const inputRoute = createReadingKeyRouter(routerIO, "input");
  const terminalRoute = createReadingKeyRouter(routerIO, "terminal");

  // TUI inputListener 高可靠拦截（不依赖 editor focus）
  const factory = (tui: TUI, theme: any, kb: any) => {
    let ed: ScrollReaderEditor;
    try {
      ed = new ScrollReaderEditor(tui, theme, kb);
    } catch {
      ed = new ScrollReaderEditor(tui, theme ?? {}, kb ?? {});
    }
    try { latestTui = tui; } catch {}
    // dialogOpen 焦点比对基准：登记 reader 自己创建的最新编辑器实例
    currentReaderEditor = ed;
    // 需求 B：terminal 通道无 kb 入参，在此记账（仿 latestTui 先例，plan §9.2）
    try { latestKb = (kb as any) ?? undefined; } catch {}
    try {
      if (listenerInstalled) return ed;
      listenerInstalled = true;
      tui.addInputListener?.((d: string) => inputRoute(d));
    } catch {}
    return ed;
  };
  const mainFactory = (tui: TUI, theme: any, kb: any) => factory(tui, theme, kb);
  const readonlyEditorFactory = (ui: any) => {
    const fg = themeFg(ui?.theme);
    return (tui: TUI, theme: any, kb: any) => {
      const ro = new ReadonlyEditor(tui, theme, kb, { accent: (s: string) => fg("accent", s) }, searchUi);
      // dialogOpen 焦点比对基准：READing 态下登记最新编辑器实例
      currentReaderEditor = ro;
      return ro;
    };
  };
  const getActiveToggleLabel = (): string => {
    try {
      if ((process as any).env?.VITEST) return "Alt+O";
      const raw = getToggleKeyRawCached();
      if (raw) return String(raw);
    } catch {}
    return "Alt+O";
  };
  const refreshCtx = (ctx: ExtensionContext | undefined) => {
    if (ctx) {
      currentCtx = ctx;
      ctxBroken = false;
      try {
        const maybeTui: any = (ctx as any)?.ui?.tui ?? (ctx as any)?.tui;
        if (maybeTui?.scrollBy) latestTui = maybeTui;
      } catch {}
    }
  };
  const installTerminalListener = (ctx: ExtensionContext) => {
    try { offTerminalInput?.(); } catch {}
    try {
      offTerminalInput = ctx.ui.onTerminalInput?.((data: string) => terminalRoute(data));
    } catch {}
  };
  const handleSession = async (_event: unknown, ctx: ExtensionContext) => {
    refreshCtx(ctx);
    isReading = false;
    helpOpen = false;
    listenerInstalled = false;
    // 弹窗探测基准重置：不依赖「resetExtensionUI 清 listener → 工厂先行重登」的间接时序
    currentReaderEditor = undefined;
    currentHelpComponent = undefined;
    helpClose = undefined;
    gg.reset();
    countBuf.reset();
    bracketSeq.reset();
    searchMode = SearchMode.INACTIVE;
    clearSearchUi();
    lastSemanticRow = null;
    savedInput = "";
    // 新会话聊天树重建，工具展开回到核心默认（收拢）；作废在途恢复监视器
    toolsExpandedMirror = false;
    advanceScrollGen();
    // 配置常驻缓存，reload / 新会话时重新读取
    __resetNavConfigCacheForTest();
    try {
      ctx.ui.setEditorComponent((tui, theme, kb) => {
        latestTui = tui;
        return factory(tui, theme, kb);
      });
    } catch {}
    installTerminalListener(ctx);
  };
  // 事件名与处理器签名一律交给 ExtensionAPI 的 overload 校验：
  // 旧写法用 `as any` 掩盖类型，核心一旦改名/改签名会静默失效（与 openSearch 同一类隐患）
  pi.on("session_start", handleSession);
  pi.on("session_info_changed", async (_e, ctx) => refreshCtx(ctx));
  pi.on("session_before_switch", async (_e, ctx) => refreshCtx(ctx));
  pi.on("session_before_fork", async (_e, ctx) => refreshCtx(ctx));
  pi.on("session_before_compact", async (_e, ctx) => refreshCtx(ctx));
  pi.on("session_compact", async (_e, ctx) => refreshCtx(ctx));
  pi.on("session_before_tree", async (_e, ctx) => refreshCtx(ctx));
  pi.on("session_tree", async (_e, ctx) => refreshCtx(ctx));
  pi.on("session_shutdown", async (_e, ctx) => refreshCtx(ctx));

  const cmdHandler = async (_args: string, ctx: ExtensionContext) => {
    const applied = toggle(ctx);
    if (!applied) {
      // 纵深防御路径（弹窗持焦时命令输入天然不可达）：不宣称未发生的状态翻转
      const label = getActiveToggleLabel();
      ctx.ui.notify(`外部弹窗持有焦点，已忽略 ${label} 阅读模式切换`, "info");
      return;
    }
    const label = getActiveToggleLabel();
    ctx.ui.notify(isReading
      ? `已进入阅读模式（${label} 切换）：ctrl-u/d 半页 f/b 整页 gg/G 顶底 j/k 行 esc/i 退出，? 帮助`
      : "已退出阅读模式，恢复编辑", "info");
  };
  pi.registerCommand("reader", {
    description: "切换阅读模式（vim 翻页：ctrl-u/d f/b gg/G + [q/a/t { } / n N）",
    handler: cmdHandler,
  });
  pi.registerCommand("scroll", {
    description: "切换阅读模式（别名，等同 /reader）",
    handler: cmdHandler,
  });
}
