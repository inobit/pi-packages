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
import { expandHome, isSensitivePath, isSensitiveReadException, isTrustedPath, isWithinCwd, realpathOf } from "./path.ts";

export type DecisionAction = "allow" | "ask" | "deny";

export interface Decision {
  action: DecisionAction;
  /** 命中规则标识：FR-1 / FR-2 / FR-3 / FR-4 / FR-5 / FR-7 / FR-8 / FR-9 / default。 */
  rule: string;
  /** 面向用户的说明（含 `[bash]` / `[tool:<name>]` 来源前缀，便于对照配置）。 */
  reason: string;
  details?: string[];
}

export type WorkMode = "build" | "plan" | "yolo";

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

/** trusted 外部路径前缀：配置项 ∪ 系统临时目录（os.tmpdir()），去重。 */
function trustedPrefixes(cfg: PermissionConfig): string[] {
  return [...new Set([...cfg.trustedExternalPaths, os.tmpdir()])];
}

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

  // yolo：彻底放行但敏感文件仍 deny（FR-1）
  if (mode === "yolo") {
    const sensitive = sensitiveDecision(paths, cwd, config, readTool ? paths : [], label);
    if (sensitive) {
      return { action: "deny", rule: "FR-1", reason: `${label} sensitive file access requires confirmation`, details: [...(sensitive.details ?? []), `tool:${toolName}`] };
    }
    return { action: "allow", rule: "yolo", reason: `[yolo] yolo mode, all operations allowed` };
  }

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
  // 3. cwd 外：trusted 赎免放行；read 白名单放行；否则 ask
  const external = paths.filter((p) => !isWithinCwd(p, cwd, home()));
  if (external.length > 0) {
    if (readTool) {
      return { action: "allow", rule: "FR-5", reason: `${label} read-only tool whitelist, external path allowed` };
    }
    // FR-9：外部路径全部落在 trusted 前缀（如 /tmp）→ 放行
    const nonTrusted = external.filter((p) => !isTrustedPath(p, trustedPrefixes(config), cwd, home()));
    if (nonTrusted.length === 0) {
      return { action: "allow", rule: "FR-9", reason: `${label} trusted external path allowed` };
    }
    return { action: "ask", rule: "FR-3", reason: `${label} external path referenced by a non-whitelisted tool requires confirmation`, details: [...nonTrusted, `tool:${toolName}`] };
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

  // yolo：彻底放行但敏感文件仍 deny（跳过 fail-closed / 管道等检查）
  if (mode === "yolo") {
    // 敏感文件检查仍需解析后的段信息
    const yoloSensitive = (() => {
      for (let i = 0; i < parsed.segments.length; i++) {
        const seg = parsed.segments[i]!;
        const segCwd = resolveSegmentCwds(parsed.segments, cwd)[i] ?? cwd;
        const readRefs = collectReadRefs(seg);
        const writeTargets = collectWriteTargets(seg);
        const hit = sensitiveDecision([...readRefs, ...writeTargets], segCwd, config, readRefs, label);
        if (hit) return hit;
      }
      return undefined;
    })();
    if (yoloSensitive) {
      return { action: "deny", rule: "FR-1", reason: yoloSensitive.reason, details: [...(yoloSensitive.details ?? []), bashDetail(command)] };
    }
    // 即使含复杂语法/管道也放行（yolo bypass）
    return { action: "allow", rule: "yolo", reason: `[yolo] yolo mode, all operations allowed` };
  }

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
  // trusted 判定按段 cwd 解析（相对路径写 /tmp 也算 trusted）；cd 无法跟踪时相对路径保守视为非 trusted
  const prefixes = trustedPrefixes(config);
  const externalRefs: string[] = [];
  const externalTargets: string[] = [];
  const nonTrustedWriteTargets: string[] = []; // plan：所有写目标中不在 trusted 下
  const sensitiveWriteTargets: string[] = []; // trusted 内但命中敏感文件的写（plan 下也：deny；如 /tmp/.env）
  const nonTrustedExternalRefs: string[] = []; // 外部读中不在 trusted 下
  const nonTrustedExternalTargets: string[] = []; // 外部写中不在 trusted 下
  const isTrustedForSegment = (p: string, segCwd: string): boolean => {
    if (uncertainRelative && !path.isAbsolute(p)) return false;
    return isTrustedPath(p, prefixes, segCwd, home());
  };
  for (let i = 0; i < parsed.segments.length; i++) {
    const seg = parsed.segments[i]!;
    const segCwd = segmentCwds[i] ?? cwd;
    const readRefs = collectReadRefs(seg);
    const writeTargets = collectWriteTargets(seg);
    for (const r of readRefs) {
      const external = uncertainRelative && !path.isAbsolute(r) ? true : !isWithinCwd(r, segCwd, home());
      if (external) {
        externalRefs.push(r);
        if (!isTrustedForSegment(r, segCwd)) nonTrustedExternalRefs.push(r);
      }
    }
    for (const w of writeTargets) {
      const external = uncertainRelative && !path.isAbsolute(w) ? true : !isWithinCwd(w, segCwd, home());
      if (!isTrustedForSegment(w, segCwd)) {
        nonTrustedWriteTargets.push(w);
      } else if (isSensitivePath(w, config.sensitivePatterns, segCwd, home())) {
        // trusted 内但命中敏感文件名/realpath（如 /tmp/.env）：plan 下写仍 deny，不弹 ask
        sensitiveWriteTargets.push(w);
      }
      if (external) {
        externalTargets.push(w);
        if (!isTrustedForSegment(w, segCwd)) nonTrustedExternalTargets.push(w);
      }
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
    // 1. 敏感操作（操作级、路径无关）→ deny
    if (dangerous) {
      return { action: "deny", rule: "FR-8", reason: `${label} plan mode forbids sensitive operations`, details: [command] };
    }
    // 2. 非赎免的写 deny：写目标不在 trusted（如 /tmp）下 → deny
    //    （含项目内写、~ 写、敏感文件写、外部非 /tmp 写，全部拒绝于此，不弹 ask）
    if (nonTrustedWriteTargets.length > 0 || sensitiveWriteTargets.length > 0) {
      return { action: "deny", rule: "FR-8", reason: `${label} plan mode forbids writes outside trusted temp paths`, details: [...nonTrustedWriteTargets, ...sensitiveWriteTargets] };
    }
    // 3. 敏感文件 ask（此时只剩读引用 + trusted 写目标；realpath 软链仍捕获）
    const sensitive = sensitiveBySegment();
    if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), bashDetail(command)] };
    // 4. trusted 外部赎免（FR-9）：存在外部引用且全部落在 trusted 前缀 → 放行（未知命令读写 /tmp 验证计算）
    if (
      (externalRefs.length > 0 || externalTargets.length > 0) &&
      nonTrustedExternalRefs.length === 0 &&
      nonTrustedExternalTargets.length === 0
    ) {
      return { action: "allow", rule: "FR-9", reason: `${label} plan mode trusted external path allowed`, details: [...externalRefs, ...externalTargets] };
    }
    // 5. read 白名单放行
    if (mostRestrictive === "read") {
      return { action: "allow", rule: "FR-8", reason: `${label} plan mode read-only command allowed` };
    }
    // 6. 未知命令：strictPlanMode deny，否则 ask（FR-8.3，与未知工具语义统一）
    if (config.strictPlanMode) {
      return { action: "deny", rule: "FR-8", reason: `${label} plan mode strict: non-read-only command denied`, details: [bashDetail(command)] };
    }
    return { action: "ask", rule: "FR-8", reason: `${label} plan mode non-read-only command requires confirmation`, details: [bashDetail(command)] };
  }

  // build 模式
  // 1. 敏感操作 ask（项目内外同权，与路径无关）
  if (dangerous) {
    return { action: "ask", rule: "FR-4", reason: `${label} dangerous operation requires confirmation`, details: [bashDetail(command)] };
  }
  // 2. 敏感文件 ask（按段 cwd；build 下写敏感文件也 ask，可确认后写）
  const sensitive = sensitiveBySegment();
  if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), bashDetail(command)] };
  // 3. cwd 内，或外部引用全部落在 trusted 前缀（如 /tmp）→ 默认放行
  if (nonTrustedExternalRefs.length === 0 && nonTrustedExternalTargets.length === 0) {
    return { action: "allow", rule: "FR-5", reason: `${label} inside project, allowed` };
  }
  // 4. cwd 外（非 trusted）：写目标 → ask；read 白名单 → allow；other → ask
  if (nonTrustedExternalTargets.length > 0) {
    return { action: "ask", rule: "FR-3", reason: `${label} writing outside project requires confirmation`, details: [...nonTrustedExternalTargets, bashDetail(command)] };
  }
  if (mostRestrictive === "read") {
    return { action: "allow", rule: "FR-5", reason: `${label} read-only command whitelist, external path allowed` };
  }
  // 外部路径 ask：details 首位仍是路径（approvalKey 按路径记忆，保 s 会话批准粒度），尾部追加命令展示行
  return {
    action: "ask",
    rule: "FR-3",
    reason: `${label} external path referenced by a non-whitelisted command requires confirmation`,
    details: [...nonTrustedExternalRefs, bashDetail(command)],
  };
}
