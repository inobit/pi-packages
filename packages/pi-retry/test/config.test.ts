import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, DEFAULT_CONFIG, getAgentDir } from "../src/config.ts";

describe("loadConfig", () => {
  let tmpDir: string;
  let cwd: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retry-test-"));
    cwd = path.join(tmpDir, "proj");
    fs.mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults when no files", () => {
    const cfg = loadConfig(cwd, { globalPath: path.join(tmpDir, "none.json"), projectPath: path.join(tmpDir, "none2.json") });
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.shortcut).toBe("alt+r");
  });

  it("reads global shortcut", () => {
    // loadConfig 在 VITEST 下短路返回默认值，读取逻辑用例需临时摘除该标记
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const g = path.join(tmpDir, "g.json");
      fs.writeFileSync(g, JSON.stringify({ shortcut: "alt+t" }));
      const cfg = loadConfig(cwd, { globalPath: g });
      expect(cfg.shortcut).toBe("alt+t");
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  });

  it("ignores untrusted project config, applies trusted override", () => {
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const projDir = path.join(cwd, ".pi", "extensions", "pi-retry");
      fs.mkdirSync(projDir, { recursive: true });
      const p = path.join(projDir, "config.json");
      fs.writeFileSync(p, JSON.stringify({ shortcut: "ctrl+g" }));

      expect(loadConfig(cwd, { globalPath: path.join(tmpDir, "none.json") }).shortcut).toBe("alt+r");
      expect(loadConfig(cwd, { globalPath: path.join(tmpDir, "none.json"), trusted: true }).shortcut).toBe("ctrl+g");
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  });

  it("project overrides global when trusted; blank values skipped", () => {
    const g = path.join(tmpDir, "g.json");
    fs.writeFileSync(g, JSON.stringify({ shortcut: " " }));
    const cfg = loadConfig(cwd, { globalPath: g });
    expect(cfg.shortcut).toBe("alt+r");
  });

  it("getAgentDir honors env override", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/agent-x";
    try {
      expect(getAgentDir()).toBe("/tmp/agent-x");
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  it("returns defaults under VITEST even with config files", () => {
    const g = path.join(tmpDir, "g.json");
    fs.writeFileSync(g, JSON.stringify({ shortcut: "alt+z" }));
    expect(loadConfig(cwd, { globalPath: g })).toEqual(DEFAULT_CONFIG);
  });
});
