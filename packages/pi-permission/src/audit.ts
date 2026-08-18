import fs from "node:fs";
import path from "node:path";

/** 审查日志条目（FR-6）。 */
export interface AuditEntry {
  timestamp: string;
  mode: string;
  toolName: string;
  rule: string;
  action: "ask" | "deny" | "allow-after-ask";
  reason: string;
  details?: unknown;
}

const SENSITIVE_KEY_RE = /token|secret|password|credential|api[_-]?key|auth|passwd|private[-_]?key/i;

/** 递归脱敏：键名命中敏感词的值替换为掩码（FR-6）。 */
export function redact(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  if (typeof value === "string" && SENSITIVE_KEY_RE.test(key) && value !== "") {
    return "[REDACTED]";
  }
  return value;
}

/** 审查日志写入器：JSONL 追加到 `<cwd>/logs/pi-permission.log`，文件 0600（FR-6/D4）。 */
export interface Auditor {
  log(entry: Omit<AuditEntry, "timestamp">): void;
}

export function createAuditor(cwd: string, logDir: string, enabled: boolean): Auditor {
  const dir = path.resolve(cwd, logDir);
  const file = path.join(dir, "pi-permission.log");
  return {
    log(entry) {
      if (!enabled) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        try {
          fs.chmodSync(dir, 0o700);
        } catch {
          // 目录权限设置失败不影响写入
        }
        fs.appendFileSync(
          file,
          JSON.stringify(redact({ ...entry, timestamp: new Date().toISOString() })) + "\n",
          { mode: 0o600 },
        );
      } catch {
        // 日志写入失败不影响插件主流程
      }
    },
  };
}