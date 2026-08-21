import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, DEFAULT_CONFIG, getAgentDir } from "../src/config.ts";

describe("loadConfig", () => {
  let tmpDir: string;
  let cwd: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-undo-test-"));
    cwd = path.join(tmpDir, "proj");
    fs.mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults when no files", () => {
    const cfg = loadConfig(cwd, { globalPath: path.join(tmpDir, "none.json"), projectPath: path.join(tmpDir, "none2.json") });
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("ignores config files, always returns default", () => {
    const g = path.join(tmpDir, "g.json");
    fs.writeFileSync(g, JSON.stringify({ shortcut: "alt+z" }));
    const cfg = loadConfig(cwd, { globalPath: g });
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.shortcut).toBe("alt+u");
  });

  it("getAgentDir respects PI_CODING_AGENT_DIR", () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent";
    expect(getAgentDir()).toBe("/tmp/custom-agent");
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  });
});
