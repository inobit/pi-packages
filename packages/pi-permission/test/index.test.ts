import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import factory from "../src/index.ts";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

function makeCtx(cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd,
    hasUI: false,
    mode: "print" as const,
    isProjectTrusted: () => false,
    ui: {
      notify: () => {},
      setStatus: () => {},
      confirm: async () => true,
      select: async () => "n: 拒绝",
      input: async () => undefined,
    },
    sessionManager: { getSessionId: () => "test-session" },
    ...overrides,
  };
}

function makePi(cwd: string) {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const shortcuts = new Map<string, { description: string; handler: (ctx: unknown) => Promise<void> }>();
  let activeTools: string[] = [];
  return {
    on: (event: string, handler: EventHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, opts);
    },
    registerShortcut: (shortcut: string, opts: { description: string; handler: (ctx: unknown) => Promise<void> }) => {
      shortcuts.set(shortcut, opts);
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
    getAllTools: () => [
      { name: "read" },
      { name: "grep" },
      { name: "find" },
      { name: "ls" },
      { name: "write" },
      { name: "edit" },
      { name: "bash" },
      { name: "web_search" },
      { name: "agent-browser" },
    ],
    emit: async (event: string, payload: unknown, ctx: unknown) => {
      let result: unknown;
      for (const h of handlers.get(event) ?? []) {
        result = await h(payload, ctx);
        const r = result as { block?: boolean } | undefined;
        if (r?.block) return result;
      }
      return result;
    },
    handlers,
    commands,
    shortcuts,
  };
}

describe("index.ts 工厂装配", () => {
  it("注册 /plan 与 /build 命令", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    expect(pi.commands.has("plan")).toBe(true);
    expect(pi.commands.has("build")).toBe(true);
  });

  it("注册 Alt+P 快捷键在 plan/build 间切换", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    expect(pi.shortcuts.has("alt+p")).toBe(true);

    const ctx = makeCtx(dir);
    const toggle = pi.shortcuts.get("alt+p")!;
    const writeCall = {
      type: "tool_call",
      toolCallId: "1",
      toolName: "write",
      input: { filePath: "x" },
    };

    // 默认 build：Alt+P 进入只读 plan，写工具被拒绝
    await toggle.handler(ctx as never);
    const denied = await pi.emit("tool_call", writeCall as never, makeCtx(dir));
    expect(denied).toMatchObject({ block: true });

    // 再按 Alt+P 回到 build，写工具恢复放行
    await toggle.handler(ctx as never);
    const allowed = await pi.emit("tool_call", writeCall as never, makeCtx(dir));
    expect(allowed).toBeUndefined();
  });

  it("订阅 tool_call 与 before_agent_start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    expect(pi.handlers.has("tool_call")).toBe(true);
    expect(pi.handlers.has("before_agent_start")).toBe(true);
  });

  it("bash 危险命令被拦截（build 模式）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    const event = {
      type: "tool_call",
      toolCallId: "1",
      toolName: "bash",
      input: { command: "rm -rf /tmp/evil" },
    };
    const result = await pi.emit("tool_call", event, makeCtx(dir));
    expect(result).toMatchObject({ block: true });
    expect(String((result as { reason?: string }).reason)).toContain("pi-permission");
  });

  it("高频只读命令放行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    const event = {
      type: "tool_call",
      toolCallId: "1",
      toolName: "bash",
      input: { command: "git status" },
    };
    const result = await pi.emit("tool_call", event, makeCtx(dir));
    expect(result).toBeUndefined();
  });

  it("写工具在 plan 模式下被拒绝", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir);
    // 先切换到 plan
    const planCmd = pi.commands.get("plan")!;
    await planCmd.handler("", ctx as never);
    const event = {
      type: "tool_call",
      toolCallId: "2",
      toolName: "write",
      input: { path: path.join(dir, "x.txt"), content: "x" },
    };
    const result = await pi.emit("tool_call", event, ctx) as { block: boolean; reason: string; terminate?: boolean };
    expect(result).toMatchObject({ block: true });
    expect(result.terminate).toBe(false);
    expect(result.reason).toMatch(/Plan is read-only/);
  });

  it("plan 模式注入只读系统提示", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir);
    await pi.commands.get("plan")!.handler("", ctx as never);
    const result = await pi.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE", systemPromptOptions: {} },
      ctx,
    );
    expect(result).toMatchObject({ systemPrompt: expect.stringContaining("PLAN mode — read-only") });
  });

  it("plan→build 切换后首个 turn 注入 build 公告，随后 build 常态不注入", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir);
    const event = { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE", systemPromptOptions: {} };

    // 从未 plan：build 常态首个 turn 不注入
    expect(await pi.emit("before_agent_start", event, ctx)).toBeUndefined();

    // 进入 plan：注入只读提示
    await pi.commands.get("plan")!.handler("", ctx as never);
    const planTurn = await pi.emit("before_agent_start", event, ctx);
    expect(planTurn).toMatchObject({ systemPrompt: expect.stringContaining("PLAN mode — read-only") });

    // 切回 build：首个 turn 注入 build 公告（显式撤销只读约束）
    await pi.commands.get("build")!.handler("", ctx as never);
    const firstBuild = await pi.emit("before_agent_start", event, ctx);
    expect(firstBuild).toMatchObject({
      systemPrompt: expect.stringContaining("Plan mode off. Normal permission checks restored."),
    });

    // build 常态：再次 turn 不注入（单次公告，无累积）
    expect(await pi.emit("before_agent_start", event, ctx)).toBeUndefined();
  });

  it("isToolCallEventType 类型收窄可用", () => {
    const event = { type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: "ls" } };
    expect(isToolCallEventType("bash", event as never)).toBe(true);
  });

  it("exec_command 别名按 bash 规则判定（NFR-4）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    const blocked = await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: "4",
      toolName: "exec_command",
      input: { command: "git push" },
    }, makeCtx(dir));
    expect(blocked).toMatchObject({ block: true });
    const allowed = await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: "5",
      toolName: "exec_command",
      input: { command: "git status" },
    }, makeCtx(dir));
    expect(allowed).toBeUndefined();
  });

  it("会话启动时初始化状态栏显示当前模式（默认 build）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const statuses = new Map<string, string>();
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir, {
      ui: { notify: () => {}, setStatus: (k: string, v: string | undefined) => statuses.set(k, v ?? "") },
    });
    await pi.emit("session_start", { type: "session_start" }, ctx);
    expect(statuses.get("pi-permission-mode")).toBe("Build");
    // /plan 后更新为 Plan
    await pi.commands.get("plan")!.handler("", ctx as never);
    expect(statuses.get("pi-permission-mode")).toBe("Plan");
  });

  it("注册 /readonly-tools 命令", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    expect(pi.commands.has("readonly-tools")).toBe(true);
  });

  it("/readonly-tools 保存到 session（内存生效）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir, {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async () => "session: current session only (memory)",
        custom: async () => ({ selected: ["read", "grep", "find", "ls", "web_search"], done: true }),
      },
    });
    await pi.commands.get("readonly-tools")!.handler("", ctx as never);
    // session 生效：web_search 加入 readonlyTools 后 plan 下放行
    const result = await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: "10",
      toolName: "web_search",
      input: { q: "x" },
    }, makeCtx(dir, { hasUI: false }));
    expect(result).toBeUndefined();
  });

  it("/readonly-tools 保存到全局 config.json（只写本层增量，内置/其他层锁定）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const globalPath = path.join(dir, "extensions", "pi-permission", "config.json");
    const { registerToolsCommand } = await import("../src/tools.ts");
    const { BUILTIN_READONLY_TOOLS } = await import("../src/config.ts");
    const pi = makePi(dir);
    registerToolsCommand(pi as never, {
      getConfig: () => ({ readonlyTools: [...BUILTIN_READONLY_TOOLS, "web_search"] } as never),
      setSessionTools: () => {},
      getSessionTools: () => [],
      globalConfigPath: () => globalPath,
      readGlobalConfig: () => ({}),
      projectConfigPath: (cwd) => path.join(cwd, ".pi", "extensions", "pi-permission", "config.json"),
      readProjectConfig: () => ({}),
      isTrusted: () => true,
      invalidateConfig: () => {},
    });
    const ctx = makeCtx(dir, {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async () => "global: user-wide config.json",
        custom: async () => ({ selected: [...BUILTIN_READONLY_TOOLS, "web_search", "agent-browser"], done: true }),
      },
    });
    await pi.commands.get("readonly-tools")!.handler("", ctx as never);
    // 全局配置只写非锁定部分（web_search 是已生效但仍属可编辑增量）
    const written = JSON.parse(fs.readFileSync(globalPath, "utf8")) as { readonlyTools?: string[] };
    expect(written.readonlyTools).toEqual(["web_search", "agent-browser"]);
  });

  it("/readonly-tools project 级保存到项目 .pi/extensions（需 trusted）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const projectPath = path.join(dir, ".pi", "extensions", "pi-permission", "config.json");
    const { registerToolsCommand } = await import("../src/tools.ts");
    const { BUILTIN_READONLY_TOOLS } = await import("../src/config.ts");
    const pi = makePi(dir);
    registerToolsCommand(pi as never, {
      getConfig: () => ({ readonlyTools: [...BUILTIN_READONLY_TOOLS] } as never),
      setSessionTools: () => {},
      getSessionTools: () => [],
      globalConfigPath: () => path.join(dir, "g.json"),
      readGlobalConfig: () => ({}),
      projectConfigPath: (cwd) => projectPath,
      readProjectConfig: () => ({}),
      isTrusted: () => true,
      invalidateConfig: () => {},
    });
    const ctx = makeCtx(dir, {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async () => "project: this project (.pi/extensions/pi-permission/config.json)",
        custom: async () => ({ selected: [...BUILTIN_READONLY_TOOLS, "p_tool"], done: true }),
      },
    });
    await pi.commands.get("readonly-tools")!.handler("", ctx as never);
    const written = JSON.parse(fs.readFileSync(projectPath, "utf8")) as { readonlyTools?: string[] };
    expect(written.readonlyTools).toEqual(["p_tool"]);
  });

  it("/readonly-tools project 级未信任拒绝写入", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const projectPath = path.join(dir, ".pi", "extensions", "pi-permission", "config.json");
    const { registerToolsCommand } = await import("../src/tools.ts");
    const { BUILTIN_READONLY_TOOLS } = await import("../src/config.ts");
    const pi = makePi(dir);
    registerToolsCommand(pi as never, {
      getConfig: () => ({ readonlyTools: [...BUILTIN_READONLY_TOOLS] } as never),
      setSessionTools: () => {},
      getSessionTools: () => [],
      globalConfigPath: () => path.join(dir, "g.json"),
      readGlobalConfig: () => ({}),
      projectConfigPath: (cwd) => projectPath,
      readProjectConfig: () => ({}),
      isTrusted: () => false,
      invalidateConfig: () => {},
    });
    const ctx = makeCtx(dir, {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async () => "project: this project (.pi/extensions/pi-permission/config.json)",
        custom: async () => ({ selected: ["read", "grep", "find", "ls", "p_tool"], done: true }),
      },
    });
    await pi.commands.get("readonly-tools")!.handler("", ctx as never);
    expect(fs.existsSync(projectPath)).toBe(false);
  });

  it("/readonly-tools 取消不写文件", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const globalPath = path.join(dir, "extensions", "pi-permission", "config.json");
    const { registerToolsCommand } = await import("../src/tools.ts");
    const { BUILTIN_READONLY_TOOLS } = await import("../src/config.ts");
    const pi = makePi(dir);
    registerToolsCommand(pi as never, {
      getConfig: () => ({ readonlyTools: [...BUILTIN_READONLY_TOOLS] } as never),
      setSessionTools: () => {},
      getSessionTools: () => [],
      globalConfigPath: () => globalPath,
      readGlobalConfig: () => ({}),
      projectConfigPath: (cwd) => path.join(cwd, ".pi", "extensions", "pi-permission", "config.json"),
      readProjectConfig: () => ({}),
      isTrusted: () => true,
      invalidateConfig: () => {},
    });
    const ctx = makeCtx(dir, {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async () => "cancel",
        custom: async () => ({ selected: [], done: false }),
      },
    });
    await pi.commands.get("readonly-tools")!.handler("", ctx as never);
    expect(fs.existsSync(globalPath)).toBe(false);
  });

  it("ask 弹窗被拒后给模型明确「已拒绝、勿重试」反馈（terminate:false 让模型继续）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir, { hasUI: true, ui: { notify: () => {}, select: async () => "n: deny" } });
    const result = await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: "6",
      toolName: "bash",
      input: { command: "git push" },
    }, ctx) as { block: boolean; reason: string; terminate?: boolean };
    expect(result.block).toBe(true);
    expect(result.terminate).toBe(false);
    expect(result.reason).toMatch(/Permission denied/);
    expect(result.reason).toMatch(/try a simpler approach/);
  });

  it("直接 deny 同样带勿重试反馈", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir, { hasUI: true, ui: { notify: () => {}, select: async () => "y: allow once" } });
    // plan 模式下 git commit → 直接 deny（敏感操作）
    await pi.commands.get("plan")!.handler("", ctx as never);
    const result = await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: "7",
      toolName: "bash",
      input: { command: "git commit" },
    }, ctx) as { block: boolean; reason: string; terminate?: boolean };
    expect(result.block).toBe(true);
    expect(result.terminate).toBe(false);
    expect(result.reason).toMatch(/Plan is read-only/);
  });

  it("注册 /yolo 命令且需二次确认", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    expect(pi.commands.has("yolo")).toBe(true);
    // 取消
    const ctxCancel = makeCtx(dir, { hasUI: true, ui: { notify: () => {}, select: async () => "n: cancel", setStatus: () => {} } });
    await pi.commands.get("yolo")!.handler("", ctxCancel as never);
    const statuses = new Map<string, string>();
    const ctx = makeCtx(dir, { ui: { notify: () => {}, select: async () => "n: cancel", setStatus: (k: string, v: string) => statuses.set(k, v) } });
    // 仍为 build（未切入 yolo）
    await pi.emit("session_start", { type: "session_start" }, ctx);
    expect(statuses.get("pi-permission-mode")).toBe("Build");
    // 确认进入 yolo
    const ctxYolo = makeCtx(dir, { hasUI: true, ui: { notify: () => {}, select: async () => "y: confirm yolo", setStatus: (k: string, v: string) => statuses.set(k, v) } });
    await pi.commands.get("yolo")!.handler("", ctxYolo as never);
    expect(statuses.get("pi-permission-mode")).toBe("Yolo");
  });

  it("yolo 首轮注入 Yolo on，驻留零注入，yolo->build 注入 build 公告", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const pi = makePi(dir);
    factory(pi as never);
    const event = { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE", systemPromptOptions: {} };
    // build 首轮不注入
    expect(await pi.emit("before_agent_start", event, makeCtx(dir))).toBeUndefined();
    // 切 yolo
    const ctxYolo = makeCtx(dir, { hasUI: true, ui: { notify: () => {}, select: async () => "y: confirm yolo", setStatus: () => {} } });
    await pi.commands.get("yolo")!.handler("", ctxYolo as never);
    const firstYolo = await pi.emit("before_agent_start", event, ctxYolo);
    expect(firstYolo).toMatchObject({ systemPrompt: expect.stringContaining("Yolo on: prompts bypassed") });
    // 驻留 yolo 第二轮不注入
    expect(await pi.emit("before_agent_start", event, ctxYolo)).toBeUndefined();
    // 切回 build 首轮注入 build 公告
    await pi.commands.get("build")!.handler("", ctxYolo as never);
    const firstBuild = await pi.emit("before_agent_start", event, ctxYolo);
    expect(firstBuild).toMatchObject({ systemPrompt: expect.stringContaining("Plan mode off. Normal permission checks restored.") });
    // build 常态不注入
    expect(await pi.emit("before_agent_start", event, ctxYolo)).toBeUndefined();
  });

  it("yolo 下敏感文件 deny 且 terminate:false（可继续）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    const pi = makePi(dir);
    factory(pi as never);
    const ctxYolo = makeCtx(dir, { hasUI: true, ui: { notify: () => {}, select: async () => "y: confirm yolo", setStatus: () => {} } });
    await pi.commands.get("yolo")!.handler("", ctxYolo as never);
    const result = await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: "y1",
      toolName: "read",
      input: { path: ".env" },
    }, ctxYolo) as { block: boolean; reason: string; terminate?: boolean };
    expect(result.block).toBe(true);
    expect(result.terminate).toBe(false);
    expect(result.reason).toMatch(/Sensitive file blocked/);
    // yolo 下非敏感写放行
    const ok = await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: "y2",
      toolName: "bash",
      input: { command: "rm -rf /tmp/x" },
    }, ctxYolo);
    expect(ok).toBeUndefined();
  });

  it("yolo 模式状态栏显示 Yolo（warning 色）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-factory-"));
    const statuses = new Map<string, string>();
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir, { hasUI: true, ui: { notify: () => {}, select: async () => "y: confirm yolo", setStatus: (k: string, v: string) => statuses.set(k, v) } });
    await pi.commands.get("yolo")!.handler("", ctx as never);
    expect(statuses.get("pi-permission-mode")).toBe("Yolo");
    // yolo->plan 切换恢复只读工具集语义可在 decision 层验证，此处仅验状态
    await pi.commands.get("plan")!.handler("", ctx as never);
    expect(statuses.get("pi-permission-mode")).toBe("Plan");
  });
});

describe("deny with reason 交互（ask 扩展）", () => {
  it("r: deny with reason 正常提交（FR-3 外部写，terminate:false 让模型继续）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-reason-"));
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir, {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async () => "r: deny with reason",
        input: async () => "use placeholder",
        setStatus: () => {},
      },
    });
    // FR-3 外部写 ask
    const result = (await pi.emit(
      "tool_call",
      { type: "tool_call", toolCallId: "r1", toolName: "write", input: { path: "/outside/a.txt", content: "x" } },
      ctx,
    )) as { block: boolean; reason: string; terminate: boolean };
    expect(result.block).toBe(true);
    expect(result.reason).toBe("[pi-permission] User denied: use placeholder");
    expect(result.terminate).toBe(false);
  });

  it("r: deny with reason 完全替换但 terminate 按 FR-1 保持 false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-reason-"));
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir, {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async () => "r: deny with reason",
        input: async () => "do not use this file",
        setStatus: () => {},
      },
    });
    const result = (await pi.emit(
      "tool_call",
      { type: "tool_call", toolCallId: "r2", toolName: "read", input: { path: ".env" } },
      ctx,
    )) as { block: boolean; reason: string; terminate: boolean };
    expect(result.reason).toBe("[pi-permission] User denied: do not use this file");
    expect(result.terminate).toBe(false);
  });

  it("空输入不提交循环并提示，最终提交有效", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-reason-"));
    const pi = makePi(dir);
    factory(pi as never);
    const notifies: string[] = [];
    let inputCalls = 0;
    const ctx = makeCtx(dir, {
      hasUI: true,
      ui: {
        notify: (msg: string) => notifies.push(msg),
        select: async () => "r: deny with reason",
        input: async () => {
          inputCalls++;
          return inputCalls === 1 ? "" : "valid reason";
        },
        setStatus: () => {},
      },
    });
    const result = (await pi.emit(
      "tool_call",
      { type: "tool_call", toolCallId: "r3", toolName: "bash", input: { command: "git push" } },
      ctx,
    )) as { block: boolean; reason: string };
    expect(notifies.some((m) => m.includes("reason cannot be empty"))).toBe(true);
    expect(result.reason).toBe("[pi-permission] User denied: valid reason");
    expect(inputCalls).toBe(2);
  });

  it("input Esc 回到 select：r → Esc → n，最终 deny with default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-reason-"));
    const pi = makePi(dir);
    factory(pi as never);
    let selectCalls = 0;
    const ctx = makeCtx(dir, {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async () => {
          selectCalls++;
          return selectCalls === 1 ? "r: deny with reason" : "n: deny";
        },
        input: async () => undefined,
        setStatus: () => {},
      },
    });
    const result = (await pi.emit(
      "tool_call",
      { type: "tool_call", toolCallId: "r4", toolName: "bash", input: { command: "git push" } },
      ctx,
    )) as { block: boolean; reason: string; terminate: boolean };
    expect(selectCalls).toBe(2);
    expect(result.reason).toMatch(/Permission denied/);
    expect(result.terminate).toBe(false);
  });

  it("select Esc 硬终止：返回 Denied by user — stopping 且 terminate:true", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-reason-"));
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    const pi = makePi(dir);
    factory(pi as never);
    const ctx = makeCtx(dir, {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async () => undefined,
        input: async () => "should not be called",
        setStatus: () => {},
      },
    });
    // FR-1 默认 terminate:false，但 Esc 硬终止应强制 true
    const result = (await pi.emit(
      "tool_call",
      { type: "tool_call", toolCallId: "r5", toolName: "read", input: { path: ".env" } },
      ctx,
    )) as { block: boolean; reason: string; terminate: boolean };
    expect(result.reason).toBe("[pi-permission] Denied by user — stopping.");
    expect(result.terminate).toBe(true);
  });

  it("hasUI=false 降级：直接 deny with default，不弹 input", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-reason-"));
    const pi = makePi(dir);
    factory(pi as never);
    let inputCalled = false;
    const ctx = makeCtx(dir, {
      hasUI: false,
      ui: {
        notify: () => {},
        select: async () => {
          throw new Error("select should not be called without UI");
        },
        input: async () => {
          inputCalled = true;
          return "ignored";
        },
        setStatus: () => {},
      },
    });
    const result = (await pi.emit(
      "tool_call",
      { type: "tool_call", toolCallId: "r6", toolName: "bash", input: { command: "git push" } },
      ctx,
    )) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(inputCalled).toBe(false);
    expect(result.reason).toMatch(/Permission denied/);
  });

  it("审计截断：超长 customReason 被 capFieldWidths 截断", async () => {
    const { createAuditor } = await import("../src/audit.ts");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-cwd-"));
    const auditor = createAuditor({
      base,
      logDir: "logs/pi-permission",
      project: cwd,
      reviewEnabled: true,
      debugEnabled: false,
      maxFieldWidth: 20,
    });
    const long = "a".repeat(100);
    auditor.review({
      mode: "build",
      toolName: "bash",
      rule: "FR-4",
      action: "deny",
      reason: "test",
      sessionId: "s",
      customReason: long,
    });
    const files = fs.readdirSync(path.join(base, "logs/pi-permission", path.basename(cwd)));
    const content = fs.readFileSync(path.join(base, "logs/pi-permission", path.basename(cwd), files[0]!), "utf8");
    const entry = JSON.parse(content.trim().split("\n").at(-1)!);
    expect(entry.customReason.length).toBeLessThan(long.length);
    expect(entry.customReason).toMatch(/\[truncated\]/);
  });
});