import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir, loadConfig, normalizeDefaultMode, type PermissionConfig } from "./config.ts";
import { decideBashRequest, decidePowerShellRequest, decideToolRequest, type Decision, type WorkMode } from "./decision.ts";
import { BUILD_SWITCH_NOTICE, ModeStore, PLAN_SYSTEM_PROMPT, registerModeCommands, sessionKey, statusText, YOLO_SWITCH_NOTICE } from "./mode.ts";
import { registerToolsCommand } from "./tools.ts";
import { createConfirmer, type Confirmer } from "./ui.ts";
import { createAuditor, type Auditor } from "./audit.ts";

/** 跨域写目标的会话批准记忆粒度：target 所在父目录（避免同目录反复首问）。 */
function crossDomainParentKey(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const expanded = detail.startsWith("~") ? path.join(os.homedir(), detail.slice(1)) : detail;
  return path.dirname(expanded);
}

/** ask 批准的会话级记忆键（细粒度化：危险按 program、敏感按路径、跨域写按父目录；
 * FR-4/FR-1 与 FR-10 同样按模式隔离 —— chill 批准不得免问 build 同程序，反之亦然）。 */
function approvalKey(decision: Decision, toolName: string, detail: string | undefined, mode: string): string {
  const d = detail ?? toolName;
  switch (decision.rule) {
    case "FR-1":
      return `sensitive:${mode}:${d}`;
    case "FR-3":
      return `external-write:${crossDomainParentKey(d) ?? d}`;
    case "FR-4":
      return `dangerous:${mode}:${toolName}:${decision.approvalId ?? d}`;
    case "FR-10":
      // 键含工具名（review P2-2）：powershell 下批准的执行器不得免问 bash 同名 X 程序，反之亦然
      return `unverified:${toolName}:${mode}:${decision.approvalId ?? toolName}`;
    case "FR-7":
      return `fail-closed:${toolName}`;
    case "FR-8":
      return `unknown-tool:${toolName}`;
    default:
      return `${decision.rule}:${toolName}:${d}`;
  }
}

/** ask 弹窗附带的配置建议（每 rule 会话内只展示一次；FR-7 已移入 deny 反馈不设弹窗 hint）。 */
const CONFIG_HINTS: Record<string, string> = {
  "FR-1": "Adjust sensitivePatterns, or approve to proceed",
  "FR-3": "Approve once, or keep write targets inside the project/trusted paths",
  "FR-4": "'s' approves this program for the whole session",
  "FR-10": "'s' approves this program for the session; restructuring into simpler verifiable commands is also welcome",
  "FR-8": "Use /build for write operations",
};
/** shellTools 类别名（NFR-4）：`exec_command` 与 bash 同规则判定。 */
function toolIsBashLike(event: ToolCallEvent): boolean {
  const input = event.input as unknown as { command?: unknown };
  return event.toolName === "exec_command" && typeof input.command === "string";
}

/** pi 0.84.3+ Windows 可选 powershell 工具（input schema 与 bash 相同：{ command, timeout?}）。 */
function toolIsPowerShell(event: ToolCallEvent): boolean {
  return event.toolName === "powershell";
}

/** 从 ask 决策中提取用于批准记忆的详情（首个路径或原始命令）。 */
function approvalDetail(decision: Decision): string | undefined {
  return decision.details?.[0];
}

export default function (pi: ExtensionAPI) {
  const configCache = new Map<string, PermissionConfig>();
  const modeStore = new ModeStore();
  // 上次 agent_start 时的模式（FR-8.4b）：plan→build 切换后首个 turn 注入一次 build 公告，常态 build 零注入
  // （plan→chill 同样复用该公告做只读纠正）
  const lastAgentStartMode = new Map<string, WorkMode>();
  const confirmer: Confirmer = createConfirmer();
  // 会话级批准集合：`<sessionKey>:<approvalKey>`（FR-3/FR-8.3/NFR-5 的 s 语义）
  const sessionApprovals = new Set<string>();
  // hint 已展示标记：`<sessionKey>:<rule>`（每 rule 会话内只提示一次）
  const sessionHintShown = new Set<string>();
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
    // 审查日志写入 agentDir/logs/pi-permission（扩展目录仅放配置），按项目分目录隔离；与 pi-debug.log 同级，规避同步工具误同步
    const base = getAgentDir();
    const cacheKey = `${cwd}::${cfg.logDir}::${cfg.reviewLog}::${cfg.debugLog}`;
    let auditor = auditorCache.get(cacheKey);
    if (!auditor) {
      auditor = createAuditor({
        base,
        logDir: cfg.logDir,
        project: cwd,
        reviewEnabled: cfg.reviewLog,
        debugEnabled: cfg.debugLog,
      });
      auditorCache.set(cacheKey, auditor);
    }
    return auditor;
  };

  const globalConfigPath = () =>
    path.join(getAgentDir(), "extensions", "pi-permission", "config.json");
  const readConfigFile = (p: string): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  // plan/build 命令 + 切换快捷键；快捷键配置读取全局层（trusted=false 跳过项目配置，避免未信任项目影响全局键位）
  registerModeCommands(pi, modeStore, {
    toggleModeShortcut: getConfig(process.cwd(), false).toggleModeShortcut,
    defaultMode: normalizeDefaultMode(getConfig(process.cwd(), false).defaultMode),
  });

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
      const mode = modeStore.getMode(key, normalizeDefaultMode(cfg.defaultMode));
      const auditor = getAuditor(ctx.cwd, cfg);

      let decision: Decision;
      let toolName: string;
      let commandDetail: string | undefined;
      if (isToolCallEventType("bash", event) || toolIsBashLike(event)) {
        const bashInput = event.input as unknown as { command: string };
        toolName = "bash";
        commandDetail = bashInput.command;
        decision = decideBashRequest({ mode, config: cfg, cwd: ctx.cwd, command: bashInput.command });
      } else if (toolIsPowerShell(event)) {
        // powershell 工具：细粒度管线与 bash 对齐（别名归一化 + cmdlet 注册表 + 同一决策核心）。
        // 注意：此前该工具落入 decideToolRequest 且因无 path 字段命中 FR-5 被静默放行（安全缺口）。
        const psInput = event.input as unknown as { command?: unknown };
        toolName = "powershell";
        if (typeof psInput.command === "string") {
          commandDetail = psInput.command;
          decision = decidePowerShellRequest({ mode, config: cfg, cwd: ctx.cwd, command: psInput.command });
        } else {
          // schema 外的畸形入参 fail-closed（review P2-6）：不落入无 path 的 FR-5 静默放行
          decision = { action: "ask", rule: "FR-10", reason: "[powershell] opaque tool input requires confirmation" };
        }
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

      if (decision.action === "allow") {
        // chill 放行审计（§6 定稿方案 b）：只落 debug 流（debugLog 门控，默认不可见），不扩 review 日志
        if (mode === "chill") {
          auditor.debug("chill-allow", {
            mode,
            toolName,
            rule: decision.rule,
            reason: decision.reason,
            details: decision.details,
            sessionId: key,
          });
        }
        return undefined;
      }

      // 拒绝反馈（给模型）：决策层 reason 自包含（类别+原因+改道）；用户拒绝（n 键）需携带「User declined」强停信号防变体重试
      const denyFeedback = (decision: Decision, opts: { userDeclined?: boolean } = {}): { block: true; reason: string; terminate: boolean } => {
        if (decision.rule === "FR-1") {
          const p = decision.details?.[0] ?? "sensitive file";
          return {
            block: true,
            reason: `[pi-permission] Sensitive file "${p}" blocked. Use a .example placeholder or ask the user; do not retry.`,
            terminate: false,
          };
        }
        const suffix = opts.userDeclined
          ? " User declined; do not retry this operation or variants."
          : " Do not retry as-is.";
        return { block: true, reason: `${decision.reason}${suffix}`, terminate: false };
      };

      if (decision.action === "deny") {
        auditor.review({ mode, toolName, rule: decision.rule, action: "deny", reason: decision.reason, details: decision.details, sessionId: key });
        if (ctx.hasUI) ctx.ui.notify(`[pi-permission] denied: ${decision.reason}`, "warning");
        return denyFeedback(decision);
      }

      // ask：检查会话级批准，未批准则弹窗（hint 每 rule 会话内只展示一次）
      const approveKey = approvalKey(decision, toolName, approvalDetail(decision), mode);
      if (sessionApprovals.has(`${key}:${approveKey}`)) return undefined;

      const hintKeyId = `${key}:${decision.rule}`;
      const hintShown = sessionHintShown.has(hintKeyId);
      sessionHintShown.add(hintKeyId);
      const choice = await confirmer.confirm(ctx, {
        title: decision.reason,
        details: [...(decision.details ?? []), ...(hintShown ? [] : [`hint: ${CONFIG_HINTS[decision.rule] ?? "approve or deny"}`])],
        dangerLevel: decision.rule === "FR-4" || decision.rule === "FR-10" ? "danger" : "warning",
      });
      if (choice === "yes" || choice === "session") {
        if (choice === "session") sessionApprovals.add(`${key}:${approveKey}`);
        auditor.review({ mode, toolName, rule: decision.rule, action: "allow-after-ask", reason: decision.reason, details: decision.details, sessionId: key });
        return undefined;
      }
      // 硬终止：第一层 Esc（deny + terminate:true，无视 rule）
      if (choice === "terminate") {
        auditor.review({
          mode,
          toolName,
          rule: decision.rule,
          action: "deny",
          reason: decision.reason,
          details: decision.details,
          sessionId: key,
          terminatedByEsc: true,
        });
        return { block: true, reason: "[pi-permission] Denied by user — stopping.", terminate: true };
      }
      // deny with reason：完全替换 reason 文本，始终 terminate:false 让模型立即消化 customReason 并继续（仅 Esc 硬终止为 true）
      if (typeof choice === "object" && choice !== null && (choice as { kind: string }).kind === "reason") {
        const customReason = (choice as { kind: "reason"; customReason: string }).customReason;
        auditor.review({
          mode,
          toolName,
          rule: decision.rule,
          action: "deny",
          reason: decision.reason,
          details: decision.details,
          sessionId: key,
          customReason,
        });
        return { block: true, reason: `[pi-permission] User denied: ${customReason}`, terminate: false };
      }
      auditor.review({ mode, toolName, rule: decision.rule, action: "deny", reason: decision.reason, details: decision.details, sessionId: key });
      return denyFeedback(decision, { userDeclined: true });
    } catch {
      // FR-7：插件自身异常不拦截，降级为放行
      return undefined;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    try {
      const key = sessionKey(ctx);
      const defaultMode = normalizeDefaultMode(getConfig(ctx.cwd, ctx.isProjectTrusted()).defaultMode);
      const mode = modeStore.getMode(key, defaultMode);
      // prev 只用于「本轮是否切出上一模式」的公告判定，恒回退 build（不能读 defaultMode，
      // 否则默认 chill 的会话会永远注入 build 公告）
      const prev = lastAgentStartMode.get(key) ?? "build";
      lastAgentStartMode.set(key, mode);
      if (mode === "plan") {
        return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_SYSTEM_PROMPT}` };
      }
      // yolo 仅切入首轮注入一次（首轮即 yolo 也算 build->yolo 的切入），驻留期零注入
      if (mode === "yolo" && prev !== "yolo") {
        return { systemPrompt: `${event.systemPrompt}\n\n${YOLO_SWITCH_NOTICE}` };
      }
      // chill 仅 plan→chill 切出只读时复用只读纠正公告；build/yolo→chill 零注入（不闲聊 chill 语义）
      if (mode === "chill" && prev === "plan") {
        return { systemPrompt: `${event.systemPrompt}\n\n${BUILD_SWITCH_NOTICE}` };
      }
      // 切回 build：plan->build 与 yolo->build 统一用同一句精简公告
      if (mode === "build" && prev !== "build") {
        return { systemPrompt: `${event.systemPrompt}\n\n${BUILD_SWITCH_NOTICE}` };
      }
      return undefined;
    } catch {
      return undefined;
    }
  });

  // 会话启动时初始化状态栏显示当前模式（默认取配置 defaultMode，无需等 /plan 切换）
  pi.on("session_start", (event, ctx) => {
    try {
      const key = sessionKey(ctx);
      const defaultMode = normalizeDefaultMode(getConfig(ctx.cwd, ctx.isProjectTrusted()).defaultMode);
      const mode = modeStore.getMode(key, defaultMode);
      ctx.ui.setStatus("pi-permission-mode", statusText(mode));
    } catch {
      // 状态栏初始化失败不影响主流程
    }
  });
}