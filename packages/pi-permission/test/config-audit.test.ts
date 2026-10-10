import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAuditor, redact } from "../src/audit.ts";
import { classifySegment, parseBashCommand } from "../src/bash.ts";
import { DEFAULT_CONFIG, loadConfig, normalizeChillSensitiveAction } from "../src/config.ts";

describe("config 加载与合并", () => {
  it("无配置文件时使用默认值", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const cfg = loadConfig(dir, { globalPath: path.join(dir, "nope.json") });
    expect(cfg.sensitivePatterns).toContain("*.env");
    expect(cfg.strictPlanMode).toBe(false);
  });

  it("非数组字段高层覆盖，数组字段与默认并集", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const globalPath = path.join(dir, "config.json");
    fs.writeFileSync(globalPath, JSON.stringify({ strictPlanMode: true, readonlyBashCommands: ["foo"] }));
    const cfg = loadConfig(dir, { globalPath });
    expect(cfg.strictPlanMode).toBe(true);
    // 数组字段 = 默认 ∪ 配置，不替换
    expect(cfg.readonlyBashCommands).toContain("foo");
    expect(cfg.readonlyBashCommands).toContain("cat");
    expect(cfg.sensitivePatterns).toContain("*.env");
  });

  it("全局与项目数组跨层并集（default ∪ global ∪ project）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const globalPath = path.join(dir, "g.json");
    const projectPath = path.join(dir, "p.json");
    fs.writeFileSync(globalPath, JSON.stringify({ readonlyTools: ["g_tool"] }));
    fs.writeFileSync(projectPath, JSON.stringify({ readonlyTools: ["p_tool"] }));
    const cfg = loadConfig(dir, { globalPath, projectPath, trusted: true });
    expect(cfg.readonlyTools).toEqual(expect.arrayContaining(["read", "g_tool", "p_tool"]));
    expect(cfg.readonlyTools).not.toContain("g_tool2");
  });

  it("项目配置叠加于全局（受信任时）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const globalPath = path.join(dir, "g.json");
    const projectPath = path.join(dir, "p.json");
    fs.writeFileSync(globalPath, JSON.stringify({ strictPlanMode: true }));
    fs.writeFileSync(projectPath, JSON.stringify({ strictPlanMode: false, reviewLog: false }));
    const cfg = loadConfig(dir, { globalPath, projectPath, trusted: true });
    expect(cfg.strictPlanMode).toBe(false);
    expect(cfg.reviewLog).toBe(false);
  });

  it("项目未受信任时忽略项目配置", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const globalPath = path.join(dir, "g.json");
    const projectPath = path.join(dir, "p.json");
    fs.writeFileSync(globalPath, JSON.stringify({ strictPlanMode: true }));
    fs.writeFileSync(projectPath, JSON.stringify({ strictPlanMode: false }));
    const cfg = loadConfig(dir, { globalPath, projectPath, trusted: false });
    expect(cfg.strictPlanMode).toBe(true);
  });

  it("损坏的配置文件静默忽略", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const globalPath = path.join(dir, "config.json");
    fs.writeFileSync(globalPath, "{broken json");
    const cfg = loadConfig(dir, { globalPath });
    expect(cfg.strictPlanMode).toBe(false);
  });

  it("readonlyTools 与内置默认取并集（FR-8.3）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const globalPath = path.join(dir, "config.json");
    fs.writeFileSync(globalPath, JSON.stringify({ readonlyTools: ["my_reader"] }));
    const cfg = loadConfig(dir, { globalPath });
    expect(cfg.readonlyTools).toContain("my_reader");
    expect(cfg.readonlyTools).toContain("read");
  });

  it("critical 数组跨层并集，默认条目删不掉", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const globalPath = path.join(dir, "config.json");
    fs.writeFileSync(globalPath, JSON.stringify({ criticalBashCommands: ["nvme", "hdparm"], criticalPowerShellCommands: ["clear-recyclebin"] }));
    const cfg = loadConfig(dir, { globalPath });
    expect(cfg.criticalBashCommands).toEqual(expect.arrayContaining(["nvme", "hdparm", "dd", "shutdown"]));
    expect(cfg.criticalPowerShellCommands).toEqual(expect.arrayContaining(["clear-recyclebin", "format-volume"]));
  });

  it("critical 条目进入有效危险并集（classify 命中即 danger+critical）", () => {
    const cfg = { ...DEFAULT_CONFIG, criticalBashCommands: [...DEFAULT_CONFIG.criticalBashCommands, "nvme"] };
    expect(classifySegment(parseBashCommand("nvme format /dev/nvme0").segments[0]!, cfg)).toMatchObject({ danger: true, critical: true });
    // 不在 dangerous 也不在 critical 的程序保持不危险
    expect(classifySegment(parseBashCommand("ls").segments[0]!, cfg)).toMatchObject({ danger: false, critical: false });
  });

  it("defaultMode 非数组替换语义 + 非法值回退 build", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const globalPath = path.join(dir, "g.json");
    const projectPath = path.join(dir, "p.json");
    fs.writeFileSync(globalPath, JSON.stringify({ defaultMode: "chill" }));
    fs.writeFileSync(projectPath, JSON.stringify({ defaultMode: "yolo" }));
    expect(loadConfig(dir, { globalPath }).defaultMode).toBe("chill");
    // 项目层不受信任时忽略；受信任时 yolo 非法 → 回退 build
    expect(loadConfig(dir, { globalPath, projectPath, trusted: false }).defaultMode).toBe("chill");
    expect(loadConfig(dir, { globalPath, projectPath, trusted: true }).defaultMode).toBe("build");
    expect(loadConfig(dir, { globalPath: path.join(dir, "nope.json") }).defaultMode).toBe("build");
  });

  it("normalizeChillSensitiveAction：非法值回退 deny（含注入告警）", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(normalizeChillSensitiveAction("ask", warn)).toBe("ask");
    expect(normalizeChillSensitiveAction("deny", warn)).toBe("deny");
    expect(normalizeChillSensitiveAction("block", warn)).toBe("deny");
    expect(normalizeChillSensitiveAction(undefined, warn)).toBe("deny");
    expect(warnings).toHaveLength(2);
    const loadWarnings: string[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const globalPath = path.join(dir, "config.json");
    fs.writeFileSync(globalPath, JSON.stringify({ chillSensitiveAction: "nope", debugLog: true }));
    const spy = vi.spyOn(console, "warn").mockImplementation((m: unknown) => loadWarnings.push(String(m)));
    try {
      const cfg = loadConfig(dir, { globalPath });
      expect(cfg.chillSensitiveAction).toBe("deny");
      expect(loadWarnings.join(" ")).toContain("chillSensitiveAction");
    } finally {
      spy.mockRestore();
    }
  });

  it("新数组字段给非数组值时守卫不抛且按默认生效", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-cfg-"));
    const globalPath = path.join(dir, "config.json");
    fs.writeFileSync(globalPath, JSON.stringify({ criticalBashCommands: "dd", criticalPowerShellCommands: 42, sensitivePatterns: null }));
    const cfg = loadConfig(dir, { globalPath });
    expect(cfg.criticalBashCommands).toEqual(expect.arrayContaining(["dd", "shutdown"]));
    expect(cfg.criticalPowerShellCommands).toEqual(expect.arrayContaining(["format-volume"]));
    expect(cfg.sensitivePatterns).toContain("*.env");
  });

  it("default.json 与内置默认一致", () => {
    const sample = JSON.parse(
      fs.readFileSync(new URL("../config/default.json", import.meta.url), "utf8"),
    ) as typeof DEFAULT_CONFIG;
    expect(sample).toEqual(DEFAULT_CONFIG);
  });
});

describe("audit 审查日志（FR-6）", () => {
  it("review 日志写入 base/logDir/<project>/ 且权限 0600，含上下文", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const auditor = createAuditor({ base: dir, logDir: "logs/pi-permission", project: "/proj/myapp", reviewEnabled: true, debugEnabled: false });
    auditor.review({ mode: "build", toolName: "bash", rule: "FR-4", action: "ask", reason: "危险操作", sessionId: "sess-1" });
    const file = path.join(dir, "logs", "pi-permission", "myapp", "pi-permission-review.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
    expect(line.rule).toBe("FR-4");
    expect(line.project).toBe("/proj/myapp");
    expect(line.sessionId).toBe("sess-1");
    expect(line.stream).toBe("review");
    expect(line.extension).toBe("pi-permission");
  });

  it("不同项目写入不同目录（隔离）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const a = createAuditor({ base: dir, logDir: "logs/pi-permission", project: "/p/alpha", reviewEnabled: true, debugEnabled: false });
    const b = createAuditor({ base: dir, logDir: "logs/pi-permission", project: "/p/beta", reviewEnabled: true, debugEnabled: false });
    a.review({ mode: "build", toolName: "bash", rule: "FR-1", action: "ask", reason: "x" });
    b.review({ mode: "build", toolName: "bash", rule: "FR-4", action: "deny", reason: "y" });
    expect(fs.existsSync(path.join(dir, "logs", "pi-permission", "alpha", "pi-permission-review.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "logs", "pi-permission", "beta", "pi-permission-review.jsonl"))).toBe(true);
  });

  it("debug 流独立文件且默认受 debugEnabled 控制", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const on = createAuditor({ base: dir, logDir: "logs/pi-permission", project: "app", reviewEnabled: false, debugEnabled: true });
    const off = createAuditor({ base: dir, logDir: "logs/pi-permission", project: "off", reviewEnabled: false, debugEnabled: false });
    on.debug("decision", { tool: "bash", action: "ask" });
    off.debug("decision", { tool: "bash" });
    expect(fs.existsSync(path.join(dir, "logs", "pi-permission", "app", "pi-permission-debug.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "logs", "pi-permission", "off", "pi-permission-debug.jsonl"))).toBe(false);
  });

  it("超过阈值时轮转归档", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const auditor = createAuditor({
      base: dir, logDir: "logs/pi-permission", project: "app", reviewEnabled: true, debugEnabled: false,
      maxBytes: 200, maxBackups: 2,
    });
    for (let i = 0; i < 60; i++) {
      auditor.review({ mode: "build", toolName: "bash", rule: "FR-4", action: "ask", reason: "pad-".repeat(20) });
    }
    const file = path.join(dir, "logs", "pi-permission", "app", "pi-permission-review.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
  });

  it("字段宽度上限（review 防膨胀）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const auditor = createAuditor({
      base: dir, logDir: "logs/pi-permission", project: "app", reviewEnabled: true, debugEnabled: false, maxFieldWidth: 50,
    });
    auditor.review({ mode: "build", toolName: "bash", rule: "FR-1", action: "ask", reason: "x".repeat(200) });
    const line = JSON.parse(fs.readFileSync(path.join(dir, "logs", "pi-permission", "app", "pi-permission-review.jsonl"), "utf8").trim());
    expect((line.reason as string).length).toBeLessThan(100);
  });

  it("禁用时不写日志", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const auditor = createAuditor({ base: dir, logDir: "logs/pi-permission", project: "app", reviewEnabled: false, debugEnabled: false });
    auditor.review({ mode: "build", toolName: "bash", rule: "FR-4", action: "ask", reason: "x" });
    expect(fs.existsSync(path.join(dir, "logs", "pi-permission"))).toBe(false);
  });

  it("敏感键脱敏", () => {
    const out = redact({ api_key: "sk-123", token: "abc", password: "p", cmd: "cat .env" });
    expect(out).toEqual({ api_key: "[REDACTED]", token: "[REDACTED]", password: "[REDACTED]", cmd: "cat .env" });
  });

  it("新默认 logDir=logs/pi-permission 写入 agentDir/logs/pi-permission/<project>/", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    expect(DEFAULT_CONFIG.logDir).toBe("logs/pi-permission");
    const auditor = createAuditor({ base: dir, logDir: DEFAULT_CONFIG.logDir, project: "/proj/myapp", reviewEnabled: true, debugEnabled: false });
    auditor.review({ mode: "build", toolName: "bash", rule: "FR-1", action: "ask", reason: "x" });
    const file = path.join(dir, "logs", "pi-permission", "myapp", "pi-permission-review.jsonl");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("绝对路径 logDir 覆盖 base（支持自定义日志位置）", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-base-"));
    const absDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-abs-"));
    const auditor = createAuditor({ base, logDir: absDir, project: "/proj/myapp", reviewEnabled: true, debugEnabled: false });
    auditor.review({ mode: "build", toolName: "bash", rule: "FR-1", action: "ask", reason: "x" });
    const file = path.join(absDir, "myapp", "pi-permission-review.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(base, "myapp", "pi-permission-review.jsonl"))).toBe(false);
  });

  it("~/ 前缀 logDir 展开为 homedir", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-base-"));
    const home = os.homedir();
    const unique = `pi-permission-test-tilde-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const logDir = `~/${unique}`;
    // 写入真实 home，断言失败也不能残留，清理放进 finally
    try {
      const auditor = createAuditor({ base, logDir, project: "/proj/myapp", reviewEnabled: true, debugEnabled: false });
      auditor.review({ mode: "build", toolName: "bash", rule: "FR-1", action: "ask", reason: "x" });
      const file = path.join(home, unique, "myapp", "pi-permission-review.jsonl");
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(path.join(home, unique), { recursive: true, force: true });
    }
  });
});