import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type PermissionConfig } from "./config.ts";
import { decideBashRequest, decideToolRequest, type Decision } from "./decision.ts";
import { ModeStore, PLAN_SYSTEM_PROMPT, registerModeCommands, sessionKey, statusText } from "./mode.ts";
import { registerToolsCommand } from "./tools.ts";
import { createConfirmer, type Confirmer } from "./ui.ts";
import { createAuditor, type Auditor } from "./audit.ts";

/** ask 批准的会话级记忆键。 */
function approvalKey(decision: Decision, toolName: string, detail: string | undefined): string {
  const d = detail ?? toolName;
  switch (decision.rule) {
    case "FR-1":
      return `sensitive:${d}`;
    case "FR-3":
      return `external-write:${d}`;
    case "FR-4":
      return `dangerous:${toolName}`;
    case "FR-7":
      return `fail-closed:${toolName}`;
    case "FR-8":
      return `unknown-tool:${toolName}`;
    default:
      return `${decision.rule}:${toolName}:${d}`;
  }
}

/** ask 决策弹窗附带的配置建议（第 5 点：提示明确来源，便于写入配置）。 */
const CONFIG_HINTS: Record<string, string> = {
  "FR-1": "Adjust sensitivePatterns to change behavior, or approve to proceed",
  "FR-3": "Add the command to readonlyBashCommands / the tool to readonlyTools to allow silently",
  "FR-4": "Approve to run, or remove the command from dangerousBashCommands",
  "FR-7": "Simplify the command to avoid fail-closed prompts",
  "FR-8": "Add the tool to readonlyTools, or switch to build mode",
};

/** shellTools 类别名（NFR-4）：`exec_command` 与 bash 同规则判定。 */
function toolIsBashLike(event: ToolCallEvent): boolean {
  const input = event.input as unknown as { command?: unknown };
  return event.toolName === "exec_command" && typeof input.command === "string";
}

/** 从 ask 决策中提取用于批准记忆的详情（首个路径或原始命令）。 */
function approvalDetail(decision: Decision): string | undefined {
  return decision.details?.[0];
}

export default function (pi: ExtensionAPI) {
  const configCache = new Map<string, PermissionConfig>();
  const modeStore = new ModeStore();
  const confirmer: Confirmer = createConfirmer();
  // 会话级批准集合：`<sessionKey>:<approvalKey>`（FR-3/FR-8.3/NFR-5 的 s 语义）
  const sessionApprovals = new Set<string>();
  // session 层 readonly tools（`<sessionKey> -> string[]`，只存本层增量，不持久化）
  const sessionReadonlyTools = new Map<string, string[]>();

  /** 持久层配置（default ∪ global ∪ project），带缓存。 */
  const getConfig = (cwd: string, trusted: boolean): PermissionConfig => {
    const key = `${cwd}:${trusted}`;
    let cfg = configCache.get(key);
    if (!cfg) {
      cfg = loadConfig(cwd, { trusted });
      configCache.set(key, cfg);
    }
    return cfg;
  };

  /** 生效配置 = 持久层 ∪ session 层（readonlyTools 并集）。 */
  const getEffectiveConfig = (cwd: string, trusted: boolean, skey: string): PermissionConfig => {
    const cfg = getConfig(cwd, trusted);
    const s = sessionReadonlyTools.get(skey);
    if (!s || s.length === 0) return cfg;
    return { ...cfg, readonlyTools: [...new Set([...cfg.readonlyTools, ...s])] };
  };

  const invalidateConfig = (cwd: string, trusted: boolean): void => {
    configCache.delete(`${cwd}:${trusted}`);
  };

  const auditorCache = new Map<string, Auditor>();
  const getAuditor = (cwd: string, cfg: PermissionConfig): Auditor => {
    // 审查日志写入全局扩展目录（与全局配置同位置），按项目分目录隔离，不污染工作区
    const base = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-permission");
    let auditor = auditorCache.get(cwd);
    if (!auditor) {
      auditor = createAuditor({
        base,
        logDir: cfg.logDir,
        project: cwd,
        reviewEnabled: cfg.reviewLog,
        debugEnabled: cfg.debugLog,
      });
      auditorCache.set(cwd, auditor);
    }
    return auditor;
  };

  const globalConfigPath = () =>
    path.join(os.homedir(), ".pi", "agent", "extensions", "pi-permission", "config.json");
  const readConfigFile = (p: string): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  registerModeCommands(pi, modeStore);

  // /readonly-tools：UI 空格多选 readonly tools，session/project/global 三级，每层只改自己
  registerToolsCommand(pi, {
    getConfig: (ctx) => getEffectiveConfig(ctx.cwd, ctx.isProjectTrusted(), sessionKey(ctx)),
    setSessionTools: (skey, tools) => sessionReadonlyTools.set(skey, tools),
    getSessionTools: (skey) => sessionReadonlyTools.get(skey) ?? [],
    globalConfigPath,
    readGlobalConfig: () => readConfigFile(globalConfigPath()),
    projectConfigPath: (cwd) => path.join(cwd, ".pi", "extensions", "pi-permission", "config.json"),
    readProjectConfig: (cwd) => readConfigFile(path.join(cwd, ".pi", "extensions", "pi-permission", "config.json")),
    isTrusted: (ctx) => ctx.isProjectTrusted(),
    invalidateConfig,
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      const key = sessionKey(ctx);
      const cfg = getEffectiveConfig(ctx.cwd, ctx.isProjectTrusted(), key);
      const mode = modeStore.getMode(key);
      const auditor = getAuditor(ctx.cwd, cfg);

      let decision: Decision;
      let toolName: string;
      let commandDetail: string | undefined;
      if (isToolCallEventType("bash", event) || toolIsBashLike(event)) {
        const bashInput = event.input as unknown as { command: string };
        toolName = "bash";
        commandDetail = bashInput.command;
        decision = decideBashRequest({ mode, config: cfg, cwd: ctx.cwd, command: bashInput.command });
      } else {
        toolName = event.toolName;
        decision = decideToolRequest({
          mode,
          config: cfg,
          cwd: ctx.cwd,
          toolName: event.toolName,
          input: event.input as Record<string, unknown>,
        });
      }

      if (decision.action === "allow") return undefined;

      // 拒绝反馈（给模型）：明确"已拒绝、勿重试"，避免模型把 deny 当成"可批准，重试等确认"。
      // 保持极简，不含原因描述/规则编号（原因仅供人/日志）
      const denyFeedback = (origin: string): { block: true; reason: string; terminate: true } => ({
        block: true,
        reason: `[pi-permission] Permission ${origin} denied. Do not retry this operation.`,
        terminate: true,
      });

      if (decision.action === "deny") {
        auditor.review({ mode, toolName, rule: decision.rule, action: "deny", reason: decision.reason, details: decision.details, sessionId: key });
        if (ctx.hasUI) ctx.ui.notify(`[pi-permission] denied: ${decision.reason}`, "warning");
        return denyFeedback("was");
      }

      // ask：检查会话级批准，未批准则弹窗
      const approveKey = approvalKey(decision, toolName, approvalDetail(decision));
      if (sessionApprovals.has(`${key}:${approveKey}`)) return undefined;

      const choice = await confirmer.confirm(ctx, {
        title: decision.reason,
        details: [...(decision.details ?? []), `hint: ${CONFIG_HINTS[decision.rule] ?? "approve or deny"}`],
        dangerLevel: decision.rule === "FR-4" || decision.rule === "FR-7" ? "danger" : "warning",
      });
      if (choice === "yes" || choice === "session") {
        if (choice === "session") sessionApprovals.add(`${key}:${approveKey}`);
        auditor.review({ mode, toolName, rule: decision.rule, action: "allow-after-ask", reason: decision.reason, details: decision.details, sessionId: key });
        return undefined;
      }
      auditor.review({ mode, toolName, rule: decision.rule, action: "deny", reason: decision.reason, details: decision.details, sessionId: key });
      return denyFeedback("by user");
    } catch {
      // FR-7：插件自身异常不拦截，降级为放行
      return undefined;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    try {
      const key = sessionKey(ctx);
      if (modeStore.getMode(key) === "plan") {
        return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_SYSTEM_PROMPT}` };
      }
      return undefined;
    } catch {
      return undefined;
    }
  });

  // 会话启动时初始化状态栏显示当前模式（默认 build，无需等 /plan 切换）
  pi.on("session_start", (event, ctx) => {
    try {
      const key = sessionKey(ctx);
      const mode = modeStore.getMode(key);
      ctx.ui.setStatus("pi-permission-mode", statusText(mode));
    } catch {
      // 状态栏初始化失败不影响主流程
    }
  });
}