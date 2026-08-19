import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAuditor, redact } from "../src/audit.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

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

  it("default.json 与内置默认一致", () => {
    const sample = JSON.parse(
      fs.readFileSync(new URL("../config/default.json", import.meta.url), "utf8"),
    ) as typeof DEFAULT_CONFIG;
    expect(sample).toEqual(DEFAULT_CONFIG);
  });
});

describe("audit 审查日志（FR-6）", () => {
  it("review 日志写入 base/logs/<project>/ 且权限 0600，含上下文", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const auditor = createAuditor({ base: dir, logDir: "logs", project: "/proj/myapp", reviewEnabled: true, debugEnabled: false });
    auditor.review({ mode: "build", toolName: "bash", rule: "FR-4", action: "ask", reason: "危险操作", sessionId: "sess-1" });
    const file = path.join(dir, "logs", "myapp", "pi-permission-review.jsonl");
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
    const a = createAuditor({ base: dir, logDir: "logs", project: "/p/alpha", reviewEnabled: true, debugEnabled: false });
    const b = createAuditor({ base: dir, logDir: "logs", project: "/p/beta", reviewEnabled: true, debugEnabled: false });
    a.review({ mode: "build", toolName: "bash", rule: "FR-1", action: "ask", reason: "x" });
    b.review({ mode: "build", toolName: "bash", rule: "FR-4", action: "deny", reason: "y" });
    expect(fs.existsSync(path.join(dir, "logs", "alpha", "pi-permission-review.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "logs", "beta", "pi-permission-review.jsonl"))).toBe(true);
  });

  it("debug 流独立文件且默认受 debugEnabled 控制", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const on = createAuditor({ base: dir, logDir: "logs", project: "app", reviewEnabled: false, debugEnabled: true });
    const off = createAuditor({ base: dir, logDir: "logs", project: "off", reviewEnabled: false, debugEnabled: false });
    on.debug("decision", { tool: "bash", action: "ask" });
    off.debug("decision", { tool: "bash" });
    expect(fs.existsSync(path.join(dir, "logs", "app", "pi-permission-debug.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "logs", "off", "pi-permission-debug.jsonl"))).toBe(false);
  });

  it("超过阈值时轮转归档", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const auditor = createAuditor({
      base: dir, logDir: "logs", project: "app", reviewEnabled: true, debugEnabled: false,
      maxBytes: 200, maxBackups: 2,
    });
    for (let i = 0; i < 60; i++) {
      auditor.review({ mode: "build", toolName: "bash", rule: "FR-4", action: "ask", reason: "pad-".repeat(20) });
    }
    const file = path.join(dir, "logs", "app", "pi-permission-review.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
  });

  it("字段宽度上限（review 防膨胀）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const auditor = createAuditor({
      base: dir, logDir: "logs", project: "app", reviewEnabled: true, debugEnabled: false, maxFieldWidth: 50,
    });
    auditor.review({ mode: "build", toolName: "bash", rule: "FR-1", action: "ask", reason: "x".repeat(200) });
    const line = JSON.parse(fs.readFileSync(path.join(dir, "logs", "app", "pi-permission-review.jsonl"), "utf8").trim());
    expect((line.reason as string).length).toBeLessThan(100);
  });

  it("禁用时不写日志", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const auditor = createAuditor({ base: dir, logDir: "logs", project: "app", reviewEnabled: false, debugEnabled: false });
    auditor.review({ mode: "build", toolName: "bash", rule: "FR-4", action: "ask", reason: "x" });
    expect(fs.existsSync(path.join(dir, "logs"))).toBe(false);
  });

  it("敏感键脱敏", () => {
    const out = redact({ api_key: "sk-123", token: "abc", password: "p", cmd: "cat .env" });
    expect(out).toEqual({ api_key: "[REDACTED]", token: "[REDACTED]", password: "[REDACTED]", cmd: "cat .env" });
  });
});