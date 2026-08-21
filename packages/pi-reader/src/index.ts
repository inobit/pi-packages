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
      const url = (import.meta as any).url ?? "";
      const curDir = url ? (globalThis as any).require?.("path")?.dirname?.(new URL(url).pathname) ?? "" : "";
      const cfg1 = curDir ? (globalThis as any).require?.("path")?.join?.(curDir, "config.json") : "";
      if (cfg1 && fs?.existsSync?.(cfg1)) {
        return JSON.parse(fs.readFileSync(cfg1, "utf8"));
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
  return out;
}

export function getNavConfigCached(): NavConfig {
  if (hasNavCache) return cachedNavConfig ?? {};
  cachedNavConfig = readNavConfigRaw();
  hasNavCache = true;
  return cachedNavConfig ?? {};
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
  private readonly searchUiRef?: { mode: boolean; query: string; idx: number; total: number };
  constructor(tui: TUI, theme: any, keybindings: any, style: { accent: (s: string) => string }, searchUiRef?: any) {
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
  let offTerminalInput: (() => void) | undefined;
  // inputListener 只安装一次：mainFactory 退出阅读恢复时会再次被调用，防止重复拦截。
  let listenerInstalled = false;
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

  const hasActiveSearch = (tui: any): boolean => {
    try { return !!(tui as any)?.activeSearch; } catch { return false; }
  };

  const patchSearchTitle = (tui: any): void => {
    try {
      const comp: any = (tui as any)?.activeSearch?.component;
      if (comp && typeof comp.render === "function" && !(comp as any).__patchedSearchLabel) {
        const orig = comp.render.bind(comp);
        (comp as any).__patchedSearchLabel = true;
        comp.render = (width: number) => {
          const lines: string[] = orig(width);
          if (lines[0]?.includes("Find transcript")) lines[0] = lines[0].replace("Find transcript", "Search");
          else if (lines[0]?.includes("Find")) lines[0] = lines[0].replace(/Find[^\x1b]*/, "Search");
          return lines;
        };
        try { (tui as any)?.requestRender?.(); } catch {}
      }
    } catch {}
  };

  const flash = (tui: any, msg: string): void => {
    try { (tui as any)?.flash?.(msg); return; } catch {}
    try { currentCtx?.ui?.notify?.(msg, "info"); } catch {}
  };

  // 搜索进度显示在底部输入栏（ReadonlyEditor）固定位置替换，不用 flash。
  // 搜索阶段常驻显示 Search，直到 esc 取消，不做节流切回 Reading。
  const searchUi = { mode: false, query: "", idx: -1, total: 0 };

  const clearSearchUi = (): void => {
    searchUi.mode = false;
    searchUi.query = "";
    searchUi.idx = -1;
    searchUi.total = 0;
  };

  /** 关闭搜索栏并取消高亮，重置状态机，留在 READING */
  const closeSearchAndReset = (tui: any): void => {
    try { (tui as any)?.closeSearch?.(); } catch {}
    searchMode = SearchMode.INACTIVE;
    clearSearchUi();
    try { (tui as any)?.requestRender?.(); } catch {}
  };

  const proxySearchOpen = (tui: any): boolean => {
    clearSearchUi();
    try {
      const fn: any = (tui as any)?.openSearch;
      if (typeof fn === "function") {
        fn.call(tui);
        // 隐藏原生右上角 overlay，仅保留底部 ReadonlyEditor 的 Search 栏（单入口，避免双重 Search）
        try { (tui as any)?.activeSearch?.overlay?.hide?.(); } catch {}
        // 仍保留原生匹配逻辑（refreshSearch）用于高亮，仅隐藏视觉
        searchMode = SearchMode.INPUT;
        // 初始化底部栏为输入态
        searchUi.mode = true;
        searchUi.query = "";
        searchUi.idx = -1;
        searchUi.total = 0;
        tui?.requestRender?.();
        return true;
      }
    } catch {}
    flash(tui, "Search unavailable");
    return false;
  };

  /**
   * 搜索输入阶段（/ 到 enter）：接收所有输入直到 enter
   * - enter: 提交 -> NAV (高亮保留，n/N 接管) 或空查询则直接 INACTIVE
   * - esc: 取消 -> closeSearch 取消高亮，回到 READING
   * - 其他: 全部喂给官方 Input（含 j/k、退格、粘贴等）
   * 返回 true 表示已消费
   */
  const handleSearchInput = (d: string, tui: any, source: "input" | "terminal"): boolean | undefined => {
    if (searchMode !== SearchMode.INPUT) return undefined;
    if (isDuplicateNav(d, source)) return true;
    if (isEnterKey(d)) {
      // enter 切状态：有查询则进入 NAV，高亮保留；空查询则关闭
      try {
        const q = String((tui as any)?.activeSearch?.component?.input?.getValue?.() ?? (tui as any)?.activeSearch?.query ?? "").trim();
        if (!q) {
          closeSearchAndReset(tui);
          return true;
        }
        try { (tui as any)?.navigateSearch?.(1); } catch {}
        try {
          const ov: any = (tui as any)?.activeSearch?.overlay;
          if (ov && typeof ov.hide === "function") ov.hide();
        } catch {}
        searchMode = SearchMode.NAV;
        // 同步底部栏显示
        setTimeout(() => {
          try {
            const a2: any = (tui as any)?.activeSearch;
            if (!a2) { clearSearchUi(); return; }
            const q2 = String(a2?.query ?? "").trim();
            if (!q2) { clearSearchUi(); return; }
            // hide 后可能因 render 重现 overlay，再次隐藏保留高亮
            try { const ov2: any = a2?.overlay; if (ov2 && typeof ov2.hide === "function") ov2.hide(); } catch {}
            searchUi.mode = false;
            searchUi.query = q2;
            searchUi.idx = a2?.selectedIndex ?? -1;
            searchUi.total = a2?.matches?.length ?? 0;
            (tui as any)?.requestRender?.();
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
    const comp: any = (tui as any)?.activeSearch?.component;
    if (comp && typeof comp.handleInput === "function") {
      try { comp.handleInput(d); } catch {}
      // 同步底部栏：实时反映 query 与匹配数（单入口，避免右上角重复）
      try {
        const curQ = String(comp.input?.getValue?.() ?? (tui as any)?.activeSearch?.query ?? "").trim();
        // 下一帧 refreshSearch 才会更新 matches，先用当前 activeSearch 的值
        setTimeout(() => {
          try {
            const a: any = (tui as any)?.activeSearch;
            if (!a) return;
            // 确保原生 overlay 保持隐藏（仅底部栏）
            try { a.overlay?.hide?.(); } catch {}
            searchUi.mode = true;
            searchUi.query = curQ;
            searchUi.idx = a.selectedIndex ?? -1;
            searchUi.total = a.matches?.length ?? 0;
            try { (tui as any)?.requestRender?.(); } catch {}
          } catch {}
        }, 15);
        if (curQ) {
          searchUi.mode = true;
          searchUi.query = curQ;
          try { (tui as any)?.requestRender?.(); } catch {}
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

  const proxySearchNavigate = (tui: any, dir: number): boolean => {
    try {
      const as: any = (tui as any)?.activeSearch;
      const fn: any = (tui as any)?.navigateSearch;
      if (as && typeof fn === "function") {
        fn.call(tui, dir);
        setTimeout(() => {
          try {
            const a2: any = (tui as any)?.activeSearch;
            try {
              const ov2: any = a2?.overlay;
              if (ov2 && typeof ov2.hide === "function") ov2.hide();
            } catch {}
            const q = String(a2?.query ?? "").trim();
            if (!q) { clearSearchUi(); return; }
            searchUi.mode = false;
            searchUi.query = q;
            searchUi.idx = a2?.selectedIndex ?? -1;
            searchUi.total = a2?.matches?.length ?? 0;
            (tui as any)?.requestRender?.();
          } catch {}
        }, 30);
        return true;
      }
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
    return [
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
  };

  let helpOpen = false;
  const showHelp = () => {
    if (helpOpen) return;
    let ui: any;
    try { ui = currentCtx?.ui; } catch { return; }
    if (!ui?.custom) return;
    helpOpen = true;
    ui.custom((tui: any, _theme: any, _kb: any, done: (v: any) => void) => {
      return {
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
          if (matchesKey(data, "escape")) {
            helpOpen = false;
            done(undefined);
          }
        },
        invalidate: () => {},
        focused: true,
      } as any;
    }, { overlay: true, overlayOptions: { anchor: "center" as any } } as any)?.then(() => { helpOpen = false; }).catch(() => { helpOpen = false; });
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
    if (reading) {
      try { savedInput = ui.getEditorText?.() ?? ""; } catch { savedInput = ""; }
      safe(() => ui.setEditorComponent?.(readonlyEditorFactory(ui)));
      safe(() => ui.setEditorText?.(""));
      Promise.resolve().then(() => { try { ui.setToolsExpanded?.(true); } catch {} });
    } else {
      safe(() => ui.setEditorComponent?.(mainFactory));
      Promise.resolve().then(() => { try { ui.setToolsExpanded?.(false); } catch {} });
      const toRestore = savedInput;
      savedInput = "";
      if (toRestore) safe(() => ui.setEditorText?.(toRestore));
    }
  };

  // toggle：只翻转状态 + 尽力应用 UI
  const toggle = (ctx?: ExtensionContext) => {
    if (ctx) {
      currentCtx = ctx;
      ctxBroken = false;
    }
    if (isReading) {
      gg.reset();
      countBuf.reset();
      bracketSeq.reset();
      helpOpen = false;
      // 退出 reading 时若搜索还开着，一并关闭恢复视图
      try { (latestTui as any)?.closeSearch?.(); } catch {}
      searchMode = SearchMode.INACTIVE;
      clearSearchUi();
    } else {
      // 进入 reading 时确保搜索状态干净
      searchMode = SearchMode.INACTIVE;
      clearSearchUi();
    }
    isReading = !isReading;
    applyReaderUI(isReading);
  };

  /** esc 统一处理：有搜索栏就关闭取消高亮，留在 READING；无搜索才退出 READING */
  const handleEsc = (tui: any): boolean => {
    if (searchMode === SearchMode.INPUT || searchMode === SearchMode.NAV || hasActiveSearch(tui)) {
      closeSearchAndReset(tui);
      return true;
    }
    toggle();
    try { (latestTui as any)?.requestRender?.(); } catch {}
    return true;
  };

  // TUI inputListener 高可靠拦截（不依赖 editor focus）
  const factory = (tui: TUI, theme: any, kb: any) => {
    const tt: any = tui;
    let ed: ScrollReaderEditor;
    try {
      ed = new ScrollReaderEditor(tui, theme, kb);
    } catch {
      ed = new ScrollReaderEditor(tui, theme ?? {}, kb ?? {});
    }
    try { latestTui = tui as any; } catch {}
    try {
      if (listenerInstalled) return ed;
      listenerInstalled = true;
      tt.addInputListener?.((d: string) => {
        if (helpOpen) return undefined;
        const curTui: any = (latestTui as any) ?? tt;
        // 1. SEARCH_INPUT：接收所有输入直到 enter（优先级最高，?/alt+o/i 等亦作文本）
        if (isReading && searchMode === SearchMode.INPUT) {
          const r = handleSearchInput(d, curTui, "input");
          if (r !== undefined) {
            curTui.requestRender?.();
            return { consume: true };
          }
          return undefined;
        }
        const key = parseReadingKey(d);
        // toggle/help 仍由 onTerminalInput 统一处理，避免双通道重复
        if (key === "toggle" || key === "help") return undefined;
        // exit (esc/i/ctrl+c)：esc 二义由 handleEsc 统一，有搜索就关搜索否则退阅读
        if (key === "exit") {
          if (!isReading) return undefined;
          // esc 二义：有搜索就关搜索，否则退阅读
          if (isEscKey(d) || d === "\x1b") {
            handleEsc(curTui);
            curTui.requestRender?.();
            return { consume: true };
          }
          // i / ctrl+c：有搜索时先清搜索（留在 READING），无搜索才退出
          if (searchMode !== SearchMode.INACTIVE || hasActiveSearch(curTui)) {
            closeSearchAndReset(curTui);
            curTui.requestRender?.();
            return { consume: true };
          }
          toggle();
          curTui.requestRender?.();
          return { consume: true };
        }
        if (!isReading) return undefined;
        // 2. SEARCH_NAV：仅接受 ? 绑定的快捷键（reading 导航集），esc 已在上方处理
        // 此处 n/N 已在 tryHandleReadingNav 中白名单，其余 ? 列表外可打印字符直接消费不透传
        // 去重：仅 terminal 侧抑制
        if (isDuplicateNav(d, "input")) return { consume: true };
        if (tryHandleReadingNav(d, curTui)) {
          curTui.requestRender?.();
          return { consume: true };
        }

        let vh = 20;
        try { vh = curTui.getPrimaryScrollView?.().viewportHeight ?? tt.getPrimaryScrollView?.().viewportHeight ?? 20; } catch {}
        const half = halfPage(vh);
        const page = pageStep(vh);
        const cnt = countBuf.peek();
        const lineCnt = cnt ?? 1;
        switch (key) {
          case "halfUp": curTui.scrollBy?.(-half * lineCnt); countBuf.reset(); break;
          case "halfDown": curTui.scrollBy?.(half * lineCnt); countBuf.reset(); break;
          case "pageDown": curTui.scrollBy?.(page * lineCnt); countBuf.reset(); break;
          case "pageUp": curTui.scrollBy?.(-page * lineCnt); countBuf.reset(); break;
          case "lineUp": curTui.scrollBy?.(-lineCnt); countBuf.reset(); break;
          case "lineDown": curTui.scrollBy?.(lineCnt); countBuf.reset(); break;
          case "bottom": curTui.scrollToBottom?.(); countBuf.reset(); break;
          case "top":
            if (d === "gg") {
              gg.reset();
              curTui.scrollToTop?.();
              countBuf.reset();
              updateLastSemantic(0);
            } else if (gg.press()) {
              curTui.scrollToTop?.();
              countBuf.reset();
              updateLastSemantic(0);
            } else {
              return { consume: true };
            }
            break;
          case "other":
            if (d.length === 1 && /[0-9]/.test(d)) {
            } else {
              if (isPrintable(d) || d.length === 1) {
                if (/^[0-9]$/.test(d)) { /* 已处理 */ } else {}
                return { consume: true };
              }
              if (d.length > 1 && !d.startsWith("\x1b[")) return { consume: true };
              countBuf.reset();
              bracketSeq.reset();
              return undefined;
            }
            break;
          default:
            return undefined;
        }
        curTui.requestRender?.();
        return { consume: true };
      });
    } catch {}
    return ed;
  };
  const mainFactory = (tui: TUI, theme: any, kb: any) => factory(tui, theme, kb);
  const readonlyEditorFactory = (ui: any) => {
    const fg = themeFg(ui?.theme);
    return (tui: TUI, theme: any, kb: any) =>
      new ReadonlyEditor(tui, theme, kb, { accent: (s: string) => fg("accent", s) }, searchUi);
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
      offTerminalInput = ctx.ui.onTerminalInput?.((data: string) => {
        if (helpOpen) return undefined;
        const key = parseReadingKey(data);
        if (key === "toggle") {
          toggle();
          try { (latestTui as any)?.requestRender?.(); } catch {}
          return { consume: true };
        }
        if (!isReading) return undefined;
        const tt: any = latestTui ?? (currentCtx as any)?.ui?.tui ?? (currentCtx as any)?.tui;
        // SEARCH_INPUT：全量接收直到 enter
        if (searchMode === SearchMode.INPUT) {
          const r = handleSearchInput(data, tt, "terminal");
          if (r !== undefined) {
            try { (latestTui as any)?.requestRender?.(); } catch {}
            return { consume: true };
          }
          return undefined;
        }
        if (key === "help") { showHelp(); try { (latestTui as any)?.requestRender?.(); } catch {} return { consume: true }; }
        if (key === "exit") {
          // esc 二义：有搜索栏就关闭取消高亮，否则退出阅读
          if (isEscKey(data) || data === "\x1b") {
            handleEsc(tt);
            return { consume: true };
          }
          // i / ctrl+c 在有搜索时先清搜索
          if (searchMode !== SearchMode.INACTIVE || hasActiveSearch(tt)) {
            closeSearchAndReset(tt);
            return { consume: true };
          }
          toggle(); try { (latestTui as any)?.requestRender?.(); } catch {} return { consume: true }; }
        if (isDuplicateNav(data, "terminal")) return { consume: true };
        if (tryHandleReadingNav(data, tt)) {
          try { (latestTui as any)?.requestRender?.(); } catch {}
          return { consume: true };
        }
        let vh = 20;
        try { vh = tt?.getPrimaryScrollView?.().viewportHeight ?? (latestTui as any)?.getPrimaryScrollView?.().viewportHeight ?? 20; } catch {}
        const half = halfPage(vh);
        const page = pageStep(vh);
        let handled = true;
        const cnt = countBuf.peek();
        const lineCnt = cnt ?? 1;
        switch (key) {
          case "halfUp": tt?.scrollBy?.(-half * lineCnt); countBuf.reset(); break;
          case "halfDown": tt?.scrollBy?.(half * lineCnt); countBuf.reset(); break;
          case "pageDown": tt?.scrollBy?.(page * lineCnt); countBuf.reset(); break;
          case "pageUp": tt?.scrollBy?.(-page * lineCnt); countBuf.reset(); break;
          case "lineUp": tt?.scrollBy?.(-lineCnt); countBuf.reset(); break;
          case "lineDown": tt?.scrollBy?.(lineCnt); countBuf.reset(); break;
          case "bottom": tt?.scrollToBottom?.(); countBuf.reset(); break;
          case "top":
            if (data === "gg") { gg.reset(); tt?.scrollToTop?.(); countBuf.reset(); updateLastSemantic(0); }
            else if (gg.press()) { tt?.scrollToTop?.(); countBuf.reset(); updateLastSemantic(0); }
            else { return { consume: true }; }
            break;
          case "other":
            if (data.length > 1 && data.startsWith("\x1b[")) {
              handled = false;
              break;
            }
            break;
          default: handled = false; break;
        }
        try { (latestTui as any)?.requestRender?.(); } catch {}
        return handled ? { consume: true } : undefined;
      }) as any;
    } catch {}
  };
  const handleSession = async (_event: any, ctx: ExtensionContext) => {
    refreshCtx(ctx);
    isReading = false;
    helpOpen = false;
    listenerInstalled = false;
    gg.reset();
    countBuf.reset();
    bracketSeq.reset();
    searchMode = SearchMode.INACTIVE;
    clearSearchUi();
    lastSemanticRow = null;
    savedInput = "";
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
  pi.on("session_start", handleSession as any);
  pi.on("session_info_changed" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_switch" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_fork" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_compact" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_compact" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_tree" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_tree" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_shutdown" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));

  const cmdHandler = async (_args: string, ctx: ExtensionContext) => {
    toggle(ctx);
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
