import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 审查日志条目（FR-6）。timestamp/extension/stream/project 由 Auditor 自动填充。 */
export interface ReviewEntry {
  timestamp: string;
  extension: string;
  stream: "review";
  /** 触发事件的项目（cwd），用于追溯与隔离。 */
  project: string;
  /** 会话标识（如 sessionId），便于跨日志追溯。 */
  sessionId?: string;
  mode: string;
  toolName: string;
  rule: string;
  action: "ask" | "deny" | "allow-after-ask";
  reason: string;
  details?: unknown;
  /** 用户自定义拒绝理由（deny with reason，完全替换）。 */
  customReason?: string;
  /** 硬终止标记（第一层 Esc）。 */
  terminatedByEsc?: boolean;
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

/** 递归限制字符串字段宽度（review 流防日志膨胀，参考 pi 生态实践）。 */
function capFieldWidths(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => capFieldWidths(v, max));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = capFieldWidths(v, max);
    }
    return out;
  }
  return value;
}

/** Auditor 选项。 */
export interface AuditorOptions {
  /** 日志根目录（生产：`~/.pi/agent`，尊重 `PI_CODING_AGENT_DIR`）。 */
  base: string;
  /** 日志目录（相对 base，默认 `logs/pi-permission`；支持绝对路径与 `~/` 前缀）。 */
  logDir: string;
  /** 当前项目 cwd：按项目分目录写入，并记录在每条日志中。 */
  project: string;
  /** 是否启用审查日志。 */
  reviewEnabled: boolean;
  /** 是否启用调试日志。 */
  debugEnabled: boolean;
  /** 单文件轮转阈值（字节，默认 512KB）。 */
  maxBytes?: number;
  /** 保留的轮转备份数（默认 3）。 */
  maxBackups?: number;
  /** 审查字段宽度上限（默认 2000 字符）。 */
  maxFieldWidth?: number;
  /** IO 失败时通知（去重后调用一次）。 */
  notify?: (message: string) => void;
}

/** 项目目录名：取 cwd 的 basename 并清理非法字符，用于按项目隔离日志。 */
function sanitizeProject(cwd: string): string {
  const base = path.basename(cwd) || "root";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** 大小轮转：当前文件超过阈值时滚动为 `.1/.2/...`，删除超出保留份数的旧档。 */
function rotateIfNeeded(file: string, maxBytes: number, maxBackups: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return; // 文件尚不存在
  }
  if (stat.size < maxBytes) return;
  try {
    for (let i = maxBackups - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // 轮转失败不影响主流程
  }
}

/**
 * 审查/调试日志写入器（双流，参考 pi 生态实践）：
 * - review：JSONL 追加到 `<base>/<logDir>/<project>/pi-permission-review.jsonl`
 * - debug：JSONL 追加到 `<base>/<logDir>/<project>/pi-permission-debug.jsonl`
 * 文件 0600、目录 0700、按项目分目录隔离、支持大小轮转、字段宽度上限；
 * 写入 `~/.pi/agent/logs/pi-permission`（扩展目录仅放配置），不污染被审查的工作区。
 */
export interface Auditor {
  /** 审查日志（ask/deny/allow 事件）。 */
  review(entry: Omit<ReviewEntry, "timestamp" | "extension" | "stream" | "project">): void;
  /** 调试日志（详细事件，默认关）。 */
  debug(event: string, details?: Record<string, unknown>): void;
}

/** 展开 `~/` 前缀为 homedir（与 pi 的 expandTildePath 对齐）。 */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function createAuditor(options: AuditorOptions): Auditor {
  const dir = path.resolve(expandTilde(options.base), expandTilde(options.logDir), sanitizeProject(options.project));
  const reviewFile = path.join(dir, "pi-permission-review.jsonl");
  const debugFile = path.join(dir, "pi-permission-debug.jsonl");
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const maxBackups = options.maxBackups ?? 3;
  const maxFieldWidth = options.maxFieldWidth ?? 2000;
  const reported = new Set<string>();

  const writeLine = (stream: "review" | "debug", file: string, line: Record<string, unknown>): void => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // 目录权限设置失败不影响写入
      }
      rotateIfNeeded(file, maxBytes, maxBackups);
      const json = JSON.stringify(
        redact({ ...line, timestamp: new Date().toISOString() }),
      );
      if (json === undefined) return;
      fs.appendFileSync(file, `${json}\n`, { mode: 0o600 });
    } catch (err) {
      // IO 失败：去重后通知一次
      const message = err instanceof Error ? err.message : String(err);
      const key = `${file}:${message}`;
      if (!reported.has(key)) {
        reported.add(key);
        options.notify?.(`[pi-permission] failed to write ${stream} log: ${message}`);
      }
    }
  };

  return {
    review(entry) {
      if (!options.reviewEnabled) return;
      writeLine("review", reviewFile, {
        ...entry,
        extension: "pi-permission",
        stream: "review",
        project: options.project,
        details: entry.details === undefined ? undefined : capFieldWidths(entry.details, maxFieldWidth),
        reason: capFieldWidths(entry.reason, maxFieldWidth),
        customReason: entry.customReason === undefined ? undefined : capFieldWidths(entry.customReason, maxFieldWidth),
      });
    },
    debug(event, details = {}) {
      if (!options.debugEnabled) return;
      writeLine("debug", debugFile, {
        extension: "pi-permission",
        stream: "debug",
        project: options.project,
        event,
        details,
      });
    },
  };
}