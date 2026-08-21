import os from "node:os";
import path from "node:path";

/** pi-undo 配置：无外部文件，快捷键固定 */
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

export function loadConfig(_cwd: string, _options: LoadConfigOptions = {}): UndoConfig {
  return { ...DEFAULT_CONFIG };
}
