/**
 * pi-reader — Vim 风格阅读模式扩展（fullscreen）
 *
 * 架构：TUI inputListener + onTerminalInput 双通道：
 *   - alt+o（config.json: toggleKey 可改）进/出 READING，Promise 异步展开工具
 *   - ctrl-u/d 半页上/下   ctrl-f/b 整页上/下   j/k 行级
 *   - g g 顶部（300ms，含同批 gg）  G 底部
 *   - esc/i/c 退出 READING   ? 帮助弹窗（英文，Esc 关闭）
 *   - 输入栏 READING 时左显 ◉ Reading 覆盖，原输入保留
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

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

// ---------- toggleKey 缓存（避免每次按键同步读盘） ----------
let cachedToggleKeyRaw: string | undefined;
let cachedToggleKeyAt = 0;
let hasToggleKeyCache = false;
const TOGGLE_CACHE_TTL = 2000;

function readToggleKeyRaw(): string | undefined {
  try {
    const fs: any = (globalThis as any).require?.("fs") ?? (globalThis as any).process?.getBuiltinModule?.("fs");
    if (!fs) return undefined;
    try {
      const url = (import.meta as any).url ?? "";
      const curDir = url ? (globalThis as any).require?.("path")?.dirname?.(new URL(url).pathname) ?? "" : "";
      const cfg1 = curDir ? (globalThis as any).require?.("path")?.join?.(curDir, "config.json") : "";
      if (cfg1 && fs?.existsSync?.(cfg1)) {
        const j = JSON.parse(fs.readFileSync(cfg1, "utf8"));
        if (j?.toggleKey) return String(j.toggleKey);
      }
    } catch {}
    const path: any = (globalThis as any).require?.("path") ?? (globalThis as any).process?.getBuiltinModule?.("path");
    const os: any = (globalThis as any).require?.("os") ?? (globalThis as any).process?.getBuiltinModule?.("os");
    const home: string = os?.homedir?.() ?? (process as any).env?.HOME ?? "";
    const extCfg = path?.join?.(home, ".pi", "agent", "extensions", "pi-reader", "config.json");
    if (extCfg && fs?.existsSync?.(extCfg)) {
      const j = JSON.parse(fs.readFileSync(extCfg, "utf8"));
      if (j?.toggleKey) return String(j.toggleKey);
    }
  } catch {}
  return undefined;
}

function getToggleKeyRawCached(): string | undefined {
  const now = Date.now();
  if (hasToggleKeyCache && now - cachedToggleKeyAt < TOGGLE_CACHE_TTL) return cachedToggleKeyRaw;
  cachedToggleKeyRaw = readToggleKeyRaw();
  cachedToggleKeyAt = now;
  hasToggleKeyCache = true;
  return cachedToggleKeyRaw;
}

function getToggleKeyNormalized(): string {
  if ((process as any).env?.VITEST) return "alt+o";
  const raw = getToggleKeyRawCached();
  return raw ? raw.toLowerCase() : "alt+o";
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

/** 只读编辑器：READING 时完全覆盖原 input 位置，居中显示 ◉ Reading，无边框。 */
export class ReadonlyEditor extends CustomEditor {
  private readonly accent: (s: string) => string;
  constructor(tui: TUI, theme: any, keybindings: any, style: { accent: (s: string) => string }) {
    super(tui, theme, keybindings);
    this.accent = style.accent;
  }
  override render(width: number): string[] {
    const styled = this.accent("◉ Reading");
    const w = visibleWidth(styled);
    const line = "  " + styled + " ".repeat(Math.max(0, width - 2 - w));
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

  const themeFg = (theme: any) => (theme?.fg ? theme.fg.bind(theme) : (t: string) => t);

  // READING 指示：状态直接显示在输入栏内（ReadonlyEditor），不再使用上方 widget
  const readingBarWidget = (_tui: any, _theme: any) => ({
    render: () => [] as string[],
    invalidate: () => {},
  });

  // ? 帮助弹窗内容（英文，标题非全大写，切换键显示生效的那个）
  const getHelpLines = () => {
    const toggle = getActiveToggleLabel();
    return [
      "Reading Mode Help",
      "",
      `${toggle}  Toggle reading mode`,
      "Ctrl+U / Ctrl+D             Half page up / down",
      "Ctrl+F / Ctrl+B             Page down / up",
      "j / k  or  Ctrl+N / Ctrl+P  Line down / up",
      "g g  (within 300ms)         Go to top",
      "G  (Shift+G)                Go to bottom",
      "Esc / i / Ctrl+C            Exit reading mode",
      "?                           Show this help",
      "",
      "Press Esc to close",
    ];
  };

  let helpOpen = false;
  const showHelp = () => {
    if (helpOpen) return;
    let ui: any;
    try { ui = currentCtx?.ui; } catch { return; }
    if (!ui?.custom) return;
    helpOpen = true;
    ui.custom((_tui: any, _theme: any, _kb: any, done: (v: any) => void) => {
      return {
        render: (width: number) => {
          const lines = getHelpLines();
          const boxW = Math.min(56, width - 6);
          const padLeft = Math.max(0, Math.floor((width - boxW) / 2));
          const pad = " ".repeat(padLeft);
          const out: string[] = [];
          const hLine = "─".repeat(boxW);
          out.push(pad + hLine);
          for (const l of lines) {
            const content = truncateToWidth(l, boxW);
            const fill = " ".repeat(Math.max(0, boxW - visibleWidth(content)));
            out.push(pad + content + fill);
          }
          out.push(pad + hLine);
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
      // Promise 微任务异步，避免长会话展开时阻塞输入栏切换的首帧渲染
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
      helpOpen = false;
    }
    isReading = !isReading;
    applyReaderUI(isReading);
  };

  // TUI inputListener 高可靠拦截（不依赖 editor focus）
  const factory = (tui: TUI, theme: any, kb: any) => {
    const ed = new ScrollReaderEditor(tui, theme, kb);
    const tt: any = tui;
    try {
      if (listenerInstalled) return ed;
      listenerInstalled = true;
      tt.addInputListener?.((d: string) => {
        if (helpOpen) return undefined;
        const key = parseReadingKey(d);
        // toggle/help/exit 由 onTerminalInput 统一处理，避免与 reload 后的 TUI 实例双重触发
        if (key === "toggle" || key === "help" || key === "exit") return undefined;
        if (!isReading) return undefined; // INSERT：完全透传

        let vh = 20;
        try { vh = tt.getPrimaryScrollView?.().viewportHeight ?? 20; } catch {}
        const half = halfPage(vh);
        const page = pageStep(vh);

        switch (key) {
          case "halfUp": tt.scrollBy?.(-half); break;
          case "halfDown": tt.scrollBy?.(half); break;
          case "pageDown": tt.scrollBy?.(page); break;
          case "pageUp": tt.scrollBy?.(-page); break;
          case "lineUp": tt.scrollBy?.(-1); break;
          case "lineDown": tt.scrollBy?.(1); break;
          case "bottom": tt.scrollToBottom?.(); break;
          case "top":
            if (d === "gg") {
              gg.reset();
              tt.scrollToTop?.();
            } else if (gg.press()) {
              tt.scrollToTop?.();
            }
            break;
          case "other":
            if (isPrintable(d) || d.length === 1) return { consume: true };
            if (d.length > 1 && !d.startsWith("\x1b[")) return { consume: true };
            return undefined;
        }
        tt.requestRender?.();
        return { consume: true };
      });
    } catch {}
    return ed;
  };
  const mainFactory = (tui: TUI, theme: any, kb: any) => factory(tui, theme, kb);
  const readonlyEditorFactory = (ui: any) => {
    const fg = themeFg(ui?.theme);
    return (tui: TUI, theme: any, kb: any) =>
      new ReadonlyEditor(tui, theme, kb, { accent: (s: string) => fg("accent", s) });
  };
  // 读取用户配置的切换快捷键，默认 alt+o，仅生效配置的那个，? 弹窗显示生效的；测试环境固定 Alt+O
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
      // 同步刷新 latestTui：避免 resume/reload 后 TUI 已重建但 latestTui 仍指旧实例
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
        let vh = 20;
        try { vh = tt?.getPrimaryScrollView?.().viewportHeight ?? (latestTui as any)?.getPrimaryScrollView?.().viewportHeight ?? 20; } catch {}
        const half = halfPage(vh);
        const page = pageStep(vh);
        let handled = true;
        switch (key) {
          case "help": showHelp(); break;
          case "halfUp": tt?.scrollBy?.(-half); break;
          case "halfDown": tt?.scrollBy?.(half); break;
          case "pageDown": tt?.scrollBy?.(page); break;
          case "pageUp": tt?.scrollBy?.(-page); break;
          case "lineUp": tt?.scrollBy?.(-1); break;
          case "lineDown": tt?.scrollBy?.(1); break;
          case "bottom": tt?.scrollToBottom?.(); break;
          case "top":
            if (data === "gg") { gg.reset(); tt?.scrollToTop?.(); }
            else if (gg.press()) tt?.scrollToTop?.();
            break;
          case "exit": toggle(); break;
          case "other":
            // 与 inputListener 一致：ESC[ 开头的序列（鼠标滚轮等）透传，其余吞掉
            if (data.length > 1 && data.startsWith("\x1b[")) {
              handled = false;
              break;
            }
            // 可打印/单字节已在 Reading 态消费，避免落入输入栏
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
    savedInput = "";
    try {
      ctx.ui.setEditorComponent((tui, theme, kb) => {
        latestTui = tui;
        return factory(tui, theme, kb);
      });
    } catch {}
    installTerminalListener(ctx);
  };
  pi.on("session_start", handleSession as any);
  // 旧会话的 resume/reload 可能走不同事件，确保都能刷新 ctx
  pi.on("session_info_changed" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_switch" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_fork" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_compact" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_compact" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_tree" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_tree" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_shutdown" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));

  // 命令：/reader 与 /scroll 双别名
  const cmdHandler = async (_args: string, ctx: ExtensionContext) => {
    toggle(ctx);
    const label = getActiveToggleLabel();
    ctx.ui.notify(isReading
      ? `已进入阅读模式（${label} 切换）：ctrl-u/d 半页 f/b 整页 gg/G 顶底 j/k 行 esc/i 退出，? 帮助`
      : "已退出阅读模式，恢复编辑", "info");
  };
  pi.registerCommand("reader", {
    description: "切换阅读模式（vim 翻页：ctrl-u/d f/b gg/G）",
    handler: cmdHandler,
  });
  pi.registerCommand("scroll", {
    description: "切换阅读模式（别名，等同 /reader）",
    handler: cmdHandler,
  });
}