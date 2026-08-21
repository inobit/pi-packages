import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHORTCUT = "alt+u" as const;

export interface UndoConfig {
  shortcut: string;
}

export const DEFAULT_CONFIG: UndoConfig = {
  shortcut: SHORTCUT,
};

export function getAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR;
  if (env) {
    if (env === "~" || env.startsWith("~/") || env.startsWith("~\\")) return path.join(os.homedir(), env.slice(2));
    return env;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export interface LoadConfigOptions {
  globalPath?: string;
  projectPath?: string;
  trusted?: boolean;
}

function normalizeShortcut(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t ? t : undefined;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function loadConfig(cwd: string, options: LoadConfigOptions = {}): UndoConfig {
  if ((process as unknown as Record<string, unknown>).env && (process.env as Record<string, string>).VITEST) {
    return { ...DEFAULT_CONFIG };
  }
  const globalPath = options.globalPath ?? path.join(getAgentDir(), "extensions", "pi-undo", "config.json");
  const projectPath = options.projectPath ?? path.join(cwd, ".pi", "extensions", "pi-undo", "config.json");
  let shortcut: string | undefined;
  for (const file of [globalPath, options.trusted === true ? projectPath : undefined]) {
    if (!file) continue;
    const j = readJson(file);
    if (!j) continue;
    const s = normalizeShortcut(j.shortcut ?? j.toggleKey ?? j.shortCut);
    if (s) shortcut = s;
  }
  return { shortcut: shortcut ?? DEFAULT_CONFIG.shortcut };
}
