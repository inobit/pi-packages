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
  it("日志写入 logs/ 且权限 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const auditor = createAuditor(dir, "logs", true);
    auditor.log({ mode: "build", toolName: "bash", rule: "FR-4", action: "ask", reason: "危险操作" });
    const logDir = path.join(dir, "logs");
    const file = path.join(logDir, "pi-permission.log");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
    expect(line.rule).toBe("FR-4");
  });

  it("禁用时不写日志", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-audit-"));
    const auditor = createAuditor(dir, "logs", false);
    auditor.log({ mode: "build", toolName: "bash", rule: "FR-4", action: "ask", reason: "x" });
    expect(fs.existsSync(path.join(dir, "logs"))).toBe(false);
  });

  it("敏感键脱敏", () => {
    const out = redact({ api_key: "sk-123", token: "abc", password: "p", cmd: "cat .env" });
    expect(out).toEqual({ api_key: "[REDACTED]", token: "[REDACTED]", password: "[REDACTED]", cmd: "cat .env" });
  });
});