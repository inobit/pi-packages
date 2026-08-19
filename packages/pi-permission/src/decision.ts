import os from "node:os";
import path from "node:path";
import { BUILTIN_WRITE_TOOLS, type PermissionConfig } from "./config.ts";
import {
  classifySegment,
  collectReadRefs,
  collectWriteTargets,
  hasPipeToShell,
  parseBashCommand,
  type BashSegment,
  type SegmentKind,
} from "./bash.ts";
import { expandHome, isSensitivePath, isSensitiveReadException, isWithinCwd, realpathOf } from "./path.ts";

export type DecisionAction = "allow" | "ask" | "deny";

export interface Decision {
  action: DecisionAction;
  /** 命中规则标识：FR-1 / FR-2 / FR-3 / FR-4 / FR-5 / FR-7 / FR-8 / default。 */
  rule: string;
  /** 面向用户的说明（含 `[bash]` / `[tool:<name>]` 来源前缀，便于对照配置）。 */
  reason: string;
  details?: string[];
}

export type WorkMode = "build" | "plan";

export interface ToolDecisionRequest {
  mode: WorkMode;
  config: PermissionConfig;
  cwd: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface BashDecisionRequest {
  mode: WorkMode;
  config: PermissionConfig;
  cwd: string;
  command: string;
}

const home = () => os.homedir();

/** 弹窗展示用命令：空白归一化单行 + 长度截断。
 * FR-3 场景已排除外部写目标（externalTargets>0 先走 write ask），截断丢失的只是命令尾部路径，路径已单独列为 detail，安全。 */
const COMMAND_DISPLAY_MAX = 120;
function displayCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  if (flat.length <= COMMAND_DISPLAY_MAX) return flat;
  return `${flat.slice(0, COMMAND_DISPLAY_MAX)}…`;
}

/** ask 弹窗触发主体展示行：details 尾部统一加 `bash:<command>` / `tool:<tool_name>`，与 reason 前缀同源。 */
const bashDetail = (command: string) => `bash: ${displayCommand(command)}`;

/**
 * FR-1 敏感文件检查：任何模式、任何优先级之前评估，命中即 ask（D9：ask 非 deny）。
 * `readRefs` 中命中的 `.env.example` 读取豁免（FR-1 例外）。
 */
function sensitiveDecision(
  paths: string[],
  cwd: string,
  cfg: PermissionConfig,
  readRefs: string[],
  label: string,
): Decision | undefined {
  for (const p of paths) {
    const sensitive = isSensitivePath(p, cfg.sensitivePatterns, cwd, home());
    if (sensitive) {
      const isRead = readRefs.includes(p);
      if (isRead && cfg.envExampleReadAllowed && isSensitiveReadException(p, cwd, home())) continue;
      return { action: "ask", rule: "FR-1", reason: `${label} sensitive file access requires confirmation`, details: [p] };
    }
  }
  return undefined;
}

/** 内置写工具固定 deny（D6：write/edit 固定，不可配置）。 */
function isWriteTool(toolName: string): boolean {
  return BUILTIN_WRITE_TOOLS.includes(toolName);
}

function isReadTool(toolName: string, config: PermissionConfig): boolean {
  return config.readonlyTools.includes(toolName);
}

/** 从工具输入中提取路径（read/write/edit/grep/find/ls 等带 path 参数的工具）。 */
function extractPaths(toolName: string, input: Record<string, unknown>): string[] {
  const raw = input["path"];
  const paths: string[] = [];
  if (typeof raw === "string" && raw !== "") paths.push(raw);
  return paths;
}

/** 工具级决策。
 * plan：write/edit deny → 敏感文件 ask → read 白名单 allow → other ask/deny(strict)（不分 cwd 内外）
 * build：敏感文件 ask → cwd 外 read 白名单 allow / other ask；cwd 内 allow
 */
export function decideToolRequest(req: ToolDecisionRequest): Decision {
  const { mode, config, cwd, toolName, input } = req;
  const label = `[tool:${toolName}]`;
  const paths = extractPaths(toolName, input);
  const readTool = isReadTool(toolName, config);
  const writeTool = isWriteTool(toolName);

  if (mode === "plan") {
    // 1. 内置 write/edit 明确 deny（固定，不受 strictPlanMode 影响）
    if (writeTool) {
      return { action: "deny", rule: "FR-8", reason: `${label} plan mode forbids write operations (read-only)`, details: paths };
    }
    // 2. 敏感文件 ask
    const sensitive = sensitiveDecision(paths, cwd, config, readTool ? paths : [], label);
    if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), `tool:${toolName}`] };
    // 3. read 白名单放行
    if (readTool) {
      return { action: "allow", rule: "FR-8", reason: `${label} plan mode read-only tool allowed` };
    }
    // 4. 未知工具：strictPlanMode deny，否则 ask（FR-8.3）
    if (config.strictPlanMode) {
      return { action: "deny", rule: "FR-8", reason: `${label} plan mode strict: unknown tool denied`, details: [toolName] };
    }
    return { action: "ask", rule: "FR-8", reason: `${label} plan mode unknown tool requires confirmation`, details: [`tool:${toolName}`] };
  }

  // build 模式
  // 1. 敏感文件 ask（工具层无敏感操作概念，最前）
  const sensitive = sensitiveDecision(paths, cwd, config, readTool ? paths : [], label);
  if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), `tool:${toolName}`] };
  // 2. 无路径信息（MCP 等未知工具）→ 视为 cwd 内，放行
  if (paths.length === 0) {
    return { action: "allow", rule: "FR-5", reason: `${label} no external path, allowed` };
  }
  // 3. cwd 外：read 白名单放行，否则 ask
  const external = paths.filter((p) => !isWithinCwd(p, cwd, home()));
  if (external.length > 0) {
    if (readTool) {
      return { action: "allow", rule: "FR-5", reason: `${label} read-only tool whitelist, external path allowed` };
    }
    return { action: "ask", rule: "FR-3", reason: `${label} external path referenced by a non-whitelisted tool requires confirmation`, details: [...external, `tool:${toolName}`] };
  }
  // 4. cwd 内放行
  return { action: "allow", rule: "FR-2", reason: `${label} inside project, allowed` };
}

function failClosed(mode: WorkMode, label: string, reason: string, command?: string): Decision {
  return mode === "plan"
    ? { action: "deny", rule: "FR-7", reason: `${label} plan mode ${reason} (fail-closed)` }
    : {
        action: "ask",
        rule: "FR-7",
        reason: `${label} ${reason} (fail-closed)`,
        // ask 必须带触发命令，否则弹窗无上下文，用户无法定位问题
        details: command === undefined ? undefined : [bashDetail(command)],
      };
}

const MOST_RESTRICTIVE: Record<SegmentKind, number> = { dangerous: 2, unknown: 1, read: 0 };

/**
 * 跟踪链式命令中的 cd，返回每段执行时的有效工作目录。
 * `cd` 无参数 → HOME；`cd -` 或参数无法解析 → undefined（后续相对路径保守按外部处理）；
 * 其他段返回沿用当前目录。
 */
function resolveSegmentCwds(segments: readonly BashSegment[], initialCwd: string): (string | undefined)[] {
  const result: (string | undefined)[] = [];
  let current: string | undefined = initialCwd;
  for (const seg of segments) {
    result.push(current); // 本段在 cd 之前执行，用切换前的目录
    if (seg.program === "cd") {
      const positional = seg.args.filter((a) => !a.startsWith("-"))[0];
      if (positional === undefined) {
        current = home(); // 无参数 cd → HOME
      } else if (positional === "-") {
        current = undefined; // cd - 无法跟踪 → uncertain
      } else if (current !== undefined) {
        const abs = path.resolve(current, expandHome(positional, home()));
        current = realpathOf(abs) ?? abs;
      }
    }
  }
  return result;
}

/** bash 级决策。
 * plan（不分 cwd 内外）：明确写/敏感操作 deny → 敏感文件 ask → read 白名单 allow → other ask/deny(strict)
 * build：敏感操作 ask → 敏感文件 ask → cwd 外（read 白名单 allow / other ask）；cwd 内 allow
 */
export function decideBashRequest(req: BashDecisionRequest): Decision {
  const { mode, config, cwd, command } = req;
  const label = "[bash]";
  const parsed = parseBashCommand(command);

  // FR-7 fail-closed：语法无法解析 / 含复杂语法 → build=ask、plan=deny
  if (parsed.parseError) return failClosed(mode, label, "unparseable command syntax", command);
  if (parsed.hasCommandSubstitution || parsed.hasProcessSubstitution || parsed.hasSubshell) {
    return failClosed(mode, label, "command substitution / subshell / complex syntax", command);
  }

  if (parsed.segments.length === 0) {
    return { action: "allow", rule: "default", reason: `${label} empty command` };
  }

  // 管道到 shell（curl | sh）fail-closed
  if (hasPipeToShell(parsed.segments)) return failClosed(mode, label, "curl/wget piped to shell detected", command);

  // 跟踪 cd：每段的有效工作目录（cd 后相对路径按新目录解析，防 cd 到外部绕过）
  // cd 无法解析（如 `cd -`）时置 undefined，后续相对路径引用保守按外部处理
  const segmentCwds = resolveSegmentCwds(parsed.segments, cwd);
  const uncertainRelative = segmentCwds.includes(undefined);

  // 收集段信息（相对路径按各段有效 cwd 判定内外）
  const allReadRefs: string[] = [];
  const allWriteTargets: string[] = [];
  const externalRefs: string[] = [];
  const externalTargets: string[] = [];
  for (let i = 0; i < parsed.segments.length; i++) {
    const seg = parsed.segments[i]!;
    const segCwd = segmentCwds[i] ?? cwd;
    const readRefs = collectReadRefs(seg);
    const writeTargets = collectWriteTargets(seg);
    allReadRefs.push(...readRefs);
    allWriteTargets.push(...writeTargets);
    for (const r of readRefs) {
      const external = uncertainRelative && !path.isAbsolute(r) ? true : !isWithinCwd(r, segCwd, home());
      if (external) externalRefs.push(r);
    }
    for (const w of writeTargets) {
      const external = uncertainRelative && !path.isAbsolute(w) ? true : !isWithinCwd(w, segCwd, home());
      if (external) externalTargets.push(w);
    }
  }

  // 敏感文件检查按段执行（相对路径用段的有效 cwd）
  const sensitiveBySegment = (): Decision | undefined => {
    for (let i = 0; i < parsed.segments.length; i++) {
      const seg = parsed.segments[i]!;
      const segCwd = segmentCwds[i] ?? cwd;
      const readRefs = collectReadRefs(seg);
      const writeTargets = collectWriteTargets(seg);
      const hit = sensitiveDecision([...readRefs, ...writeTargets], segCwd, config, readRefs, label);
      if (hit) return hit;
    }
    return undefined;
  };

  const kinds = parsed.segments.map((seg) => classifySegment(seg, config));
  const mostRestrictive = kinds.reduce(
    (acc, k) => (MOST_RESTRICTIVE[k] > MOST_RESTRICTIVE[acc] ? k : acc),
    "read" as SegmentKind,
  );
  const dangerous = mostRestrictive === "dangerous";

  if (mode === "plan") {
    // 1. 明确的写（重定向/写命令，等价 write/edit deny）+ 敏感操作 → deny
    if (allWriteTargets.length > 0) {
      return { action: "deny", rule: "FR-8", reason: `${label} plan mode forbids writes (redirect/write command)`, details: allWriteTargets };
    }
    if (dangerous) {
      return { action: "deny", rule: "FR-8", reason: `${label} plan mode forbids sensitive operations`, details: [command] };
    }
    // 2. 敏感文件 ask（按段 cwd）
    const sensitive = sensitiveBySegment();
    if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), bashDetail(command)] };
    // 3. read 白名单放行
    if (mostRestrictive === "read") {
      return { action: "allow", rule: "FR-8", reason: `${label} plan mode read-only command allowed` };
    }
    // 4. 未知命令：strictPlanMode deny，否则 ask（FR-8.3，与未知工具语义统一）
    if (config.strictPlanMode) {
      return { action: "deny", rule: "FR-8", reason: `${label} plan mode strict: non-read-only command denied`, details: [command] };
    }
    return { action: "ask", rule: "FR-8", reason: `${label} plan mode non-read-only command requires confirmation`, details: [bashDetail(command)] };
  }

  // build 模式
  // 1. 敏感操作 ask（项目内外同权）
  if (dangerous) {
    return { action: "ask", rule: "FR-4", reason: `${label} dangerous operation requires confirmation`, details: [bashDetail(command)] };
  }
  // 2. 敏感文件 ask（按段 cwd）
  const sensitive = sensitiveBySegment();
  if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), bashDetail(command)] };
  // 3. cwd 内 → 默认放行
  if (externalTargets.length === 0 && externalRefs.length === 0) {
    return { action: "allow", rule: "FR-5", reason: `${label} inside project, allowed` };
  }
  // 4. cwd 外：写目标 → ask；read 白名单 → allow；other → ask
  if (externalTargets.length > 0) {
    return { action: "ask", rule: "FR-3", reason: `${label} writing outside project requires confirmation`, details: [...externalTargets, bashDetail(command)] };
  }
  if (mostRestrictive === "read") {
    return { action: "allow", rule: "FR-5", reason: `${label} read-only command whitelist, external path allowed` };
  }
  // 外部路径 ask：details 首位仍是路径（approvalKey 按路径记忆，保 s 会话批准粒度），尾部追加命令展示行
  return {
    action: "ask",
    rule: "FR-3",
    reason: `${label} external path referenced by a non-whitelisted command requires confirmation`,
    details: [...externalRefs, bashDetail(command)],
  };
}
