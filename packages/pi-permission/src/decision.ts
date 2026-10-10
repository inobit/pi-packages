import os from "node:os";
import path from "node:path";
import { BUILTIN_WRITE_TOOLS, normalizeChillSensitiveAction, type PermissionConfig } from "./config.ts";
import {
  classifySegment,
  collectReadRefs,
  collectWriteTargets,
  findShellNests,
  hasPipeToShell,
  parseBashCommand,
  reparseSegment,
  scrubShellNests,
  staticLiteralUnwrap,
  WRAPPER_SHELLS,
  type BashSegment,
  type ParsedCommand,
} from "./bash.ts";
import { POWERSHELL_ADAPTER } from "./powershell.ts";
import { findGitRoot, isSensitivePath, isSensitiveReadException, isTrustedPath, isWithinProject, resolveCwdTarget } from "./path.ts";

export type DecisionAction = "allow" | "ask" | "deny";

export interface Decision {
  action: DecisionAction;
  /** 命中规则标识。 */
  rule: string;
  /** 面向用户的说明（含 `[bash]` / `[tool:<name>]` 来源前缀，便于对照配置）。 */
  reason: string;
  details?: string[];
  /** 会话批准记忆键用的程序标识（危险/不透明段取最严段；git 子命令为 `git:<sub>`）。 */
  approvalId?: string;
}

export type WorkMode = "build" | "plan" | "yolo" | "chill";

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

/**
 * Shell 工具适配器（NFR：bash 与 powershell 共用同一决策核心）。
 * 各解析器产出统一的 ParsedCommand/BashSegment 形状，决策表、确认 UI、审计零改动复用。
 */
export interface ShellAdapter {
  /** 展示用标识（`[bash]` / `[powershell]` 前缀与弹窗详情前缀）。 */
  id: string;
  /** 解析命令为顶层段结构。 */
  parse(command: string): ParsedCommand;
  /** 单段效果分类（R/W/X + 危险叠加）。 */
  classify(segment: BashSegment, config: PermissionConfig): SegmentClassLike;
  /** 段内读取型路径引用。 */
  readRefs(segment: BashSegment): string[];
  /** 段内写入目标。 */
  writeTargets(segment: BashSegment): string[];
  /** 管道到 shell 检测（FR-4 等价叠加）。 */
  pipeToShell(segments: readonly BashSegment[]): boolean;
  /**
   * 静态字面载荷展开（chill 处置层专用）：`bash -c`/`eval`/`$(…)`/反引号/
   * 解释器 `-c`/`-e`/`xargs`/`find -exec` 的静态内层重解为可判定段（递归上限 2 层，sudo/su 剥离线不计）。
   * 脚本文件、编码载荷、变量拼接与动态目标一律不进此层。
   */
  staticUnwrap(segments: readonly BashSegment[]): BashSegment[];
  /**
   * 解析某段执行后的有效工作目录（C1：切目录语义由适配器全权负责）。
   * 返回 current 表示 cwd 不变（非切目录命令，或 push-location 无参仅入栈）；
   * 返回 undefined 表示无法静态跟踪（如 pop-location、cd -），后续相对路径保守按域外处理。
   */
  resolveCwdChange(program: string, args: readonly string[], current: string | undefined): string | undefined;
}
/** 分类结果最小结构（兼容 bash/powershell 两套 SegmentClassification）。 */
interface SegmentClassLike {
  tier: "R" | "W" | "X";
  danger: boolean;
  /** 严重级（critical）命中：`critical ⟹ danger` 由 classify 各返回点构造保证。 */
  critical: boolean;
  /** 收窄的 rm/Remove-Item 严重级谓词（§3.1 规则 1 / §3.2）：递归 + 黑名单前缀命中或裸 glob；
   * chill 分支用此窄口径决定 ask，`critical` 保留宽口径供 build/plan。 */
  criticalChill: boolean;
  id: string;
}

/** bash 适配器：直接绑定 src/bash.ts 的解析与分类实现。 */
const BASH_ADAPTER: ShellAdapter = {
  id: "bash",
  parse: parseBashCommand,
  classify: classifySegment,
  readRefs: collectReadRefs,
  writeTargets: collectWriteTargets,
  pipeToShell: hasPipeToShell,
  staticUnwrap: staticLiteralUnwrap,
  resolveCwdChange(program, args, current) {
    if (program !== "cd") return current;
    const positional = args.filter((a) => !a.startsWith("-"))[0];
    if (positional === undefined) return home(); // 无参数 cd → HOME
    if (positional === "-") return undefined; // cd - 无法跟踪
    if (current === undefined) return undefined;
    return resolveCwdTarget(positional, current);
  },
};

const home = () => os.homedir();

/** 弹窗展示用命令：空白归一化单行 + 中段省略。
 * pi-tui Text 组件支持自动折行，上限可放宽；中段省略保留头部（程序名/主要参数）与尾部（最终目标路径）。 */
const COMMAND_DISPLAY_MAX = 400;
const DISPLAY_HEAD = 160;
const DISPLAY_TAIL = 200;
function displayCommand(command: string): string {
  const withTilde = command.replace(/\s+/g, " ").trim().replace(home(), "~");
  if (withTilde.length <= COMMAND_DISPLAY_MAX) return withTilde;
  const omitted = withTilde.length - DISPLAY_HEAD - DISPLAY_TAIL;
  return `${withTilde.slice(0, DISPLAY_HEAD)} …(${omitted} chars omitted)… ${withTilde.slice(-DISPLAY_TAIL)}`;
}

/** 复杂命令按顶层段分行展示（≤8 行），超限回退单行中段省略。 */
function displaySegmented(label: string, parsed: { segments: { raw: string; prevOp: string }[] }, command: string): string {
  const segs = parsed.segments;
  if (segs.length <= 1 || segs.length > 8) return `${label}: ${displayCommand(command)}`;
  const lines = [`${label}:`];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const prefix = i === 0 ? "  " : `  ${s.prevOp} `;
    lines.push(`${prefix}${displayCommand(s.raw)}`);
  }
  return lines.join("\n");
}

/** ask 弹窗触发主体展示行：details 尾部统一加 `<shell>:<command>`（复杂命令分行），与 reason 前缀同源。 */
const shellDetail = (label: string, command: string, parsed?: { segments: { raw: string; prevOp: string }[] }) =>
  parsed === undefined ? `${label}: ${displayCommand(command)}` : displaySegmented(label, parsed, command);

/** trusted 外部路径前缀：配置项 ∪ 系统临时目录（os.tmpdir()），去重。 */
function trustedPrefixes(cfg: PermissionConfig): string[] {
  return [...new Set([...cfg.trustedExternalPaths, os.tmpdir()])];
}

/** 项目域根目录（E）：显式配置 + findGitRoot 自动识别；仅用于域内外判定（非 trusted）。 */
function projectRoots(config: PermissionConfig, cwd: string): string[] {
  const auto = findGitRoot(cwd);
  return [...config.additionalProjectRoots, ...(auto === undefined ? [] : [auto])];
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
    // 1. 内置 write/edit（W 类，目标单一可枚举）：跨域 → 静默 deny；信任域内敏感 → ask；其余 scratch 写 allow（与 bash 的 tee 同权同责）
    if (writeTool) {
      const nonTrusted = paths.filter((p) => !isTrustedPath(p, trustedPrefixes(config), cwd, home()));
      if (nonTrusted.length > 0 || paths.length === 0) {
        return { action: "deny", rule: "FR-8", reason: `[tool:${toolName}] Plan mode forbids writes outside trusted paths. Use /build for writes.`, details: paths.length > 0 ? paths : undefined };
      }
      const sensitive = sensitiveDecision(paths, cwd, config, [], label);
      if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), `tool:${toolName}`] };
      return { action: "allow", rule: "FR-9", reason: `${label} plan mode trusted scratch write allowed`, details: paths };
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

  // chill：敏感文件 deny（`chillSensitiveAction: "ask"` 时改弹窗），其余一律放行
  if (mode === "chill") {
    const sensitive = sensitiveDecision(paths, cwd, config, readTool ? paths : [], label);
    if (sensitive) {
      const details = [...(sensitive.details ?? []), `tool:${toolName}`];
      if (normalizeChillSensitiveAction(config.chillSensitiveAction) === "ask") {
        return { ...sensitive, details };
      }
      return { action: "deny", rule: "FR-1", reason: `${label} sensitive file access blocked in chill mode`, details };
    }
    return { action: "allow", rule: "FR-5", reason: `${label} chill mode, non-sensitive operation allowed` };
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
  const external = paths.filter((p) => !isWithinProject(p, cwd, projectRoots(config, cwd), home()));
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

function failClosed(mode: WorkMode, label: string, kind: string, command?: string, detailLabel?: string): Decision {
  // B+ S5 指令式文案：类别 + 改道（拆步骤、去命令替换）
  const msg = `${label} Unverifiable syntax (${kind}). Split into simple sequential commands without $(...)`;
  return mode === "plan"
    ? { action: "deny", rule: "FR-7", reason: msg }
    : {
        action: "ask",
        rule: "FR-7",
        reason: msg,
        // ask 必须带触发命令，否则弹窗无上下文，用户无法定位问题
        details: command === undefined ? undefined : [shellDetail(detailLabel ?? label, command)],
      };
}

/** 纯变量赋值前缀段（如 `OLD=""`）：B3 净化后仅剩此类内容直接丢弃（视同 R）。 */
const PURE_ASSIGN_SEGMENT = /^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s]*)\s*)+$/;

/** chill 下只看收窄谓词（criticalChill）的程序：宽口径 critical 在这些程序上一律放行（§3.1/§3.2）。 */
const CHILL_NARROWED_PROGRAMS = new Set(["rm", "remove-item", "chmod", "chown", "chgrp"]);

/** 段内嵌套是否非平衡（切分残留的半边 span，如反引号内的 `&&` 切分产物）：是则门直接回退。
 * 单引号 span 与转义先剥离；双引号内的括号为字面（不计），`$(` 与反引号在双引号内仍会执行故计入。 */
function hasUnbalancedNests(raw: string): boolean {
  let tmp = "";
  let inS = false;
  let esc = false;
  for (const ch of raw) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === "'") {
      inS = !inS;
      continue;
    }
    if (!inS) tmp += ch;
  }
  if ((tmp.split("`").length - 1) % 2 !== 0) return true; // 反引号不成对
  let depth = 0;
  let inD = false;
  for (const c of tmp) {
    if (c === '"') {
      inD = !inD;
      continue;
    }
    if (inD) continue;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}

/** 内部门结果：pass（附净化后段）/ fail（回退 fail-closed）/ sensitive（按 FR-1 口径返回）。 */
type InnerGateResult =
  | { outcome: "pass"; segments: BashSegment[] }
  | { outcome: "fail" }
  | { outcome: "sensitive"; decision: Decision };

/** 检查单段内层文本（B2/B4 共用）：全 R + 无 danger + 无 parseError + 无 cd + 无敏感才通过。 */
function checkInnerText(
  inner: string,
  segCwd: string,
  config: PermissionConfig,
  label: string,
): { pass: true } | { pass: false } | { pass: false; sensitive: Decision } {
  const parsed = parseBashCommand(inner);
  // 嵌套直接回退（P0-2）：内层仍含复杂语法标记即整门回退，不逐层展开
  if (parsed.parseError || parsed.hasCommandSubstitution || parsed.hasProcessSubstitution || parsed.hasSubshell) {
    return { pass: false };
  }
  for (const seg of parsed.segments) {
    // 内层含 cd 直接回退（P1-1）：不用外层 cwd 做敏感扫描，避免旁路
    if (seg.program === "cd") return { pass: false };
    const kind = classifySegment(seg, config);
    if (kind.tier !== "R" || kind.danger) return { pass: false };
    const readRefs = collectReadRefs(seg);
    const writeTargets = collectWriteTargets(seg);
    const hit = sensitiveDecision([...readRefs, ...writeTargets], segCwd, config, readRefs, label);
    if (hit) return { pass: false, sensitive: hit };
  }
  return { pass: true };
}

/**
 * L1 内部门（B2/B4，bash-only）：顶层已置 has* 标记时调用。
 * 全 inner 通过 → 返回净化/展开后的段；任一失败 → fail（调用方回退 failClosed）；
 * 内层敏感 → sensitive（调用方按 FR-1 口径返回）。展示一律用原始命令。
 */
function evalBashNestGate(
  segments: readonly BashSegment[],
  segmentCwds: readonly (string | undefined)[],
  cwd: string,
  config: PermissionConfig,
  label: string,
): InnerGateResult {
  const out: BashSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const segCwd = segmentCwds[i] ?? cwd;
    // 非平衡残留（切分半边 span）直接回退，不参与抽取/净化
    if (hasUnbalancedNests(seg.raw)) return { outcome: "fail" };
    // B4：`bash -c "<静态脚本>"` 严格双参才展开
    if (WRAPPER_SHELLS.has(seg.program) && seg.args.length === 2 && seg.args[0] === "-c") {
      const checked = checkInnerText(seg.args[1]!, segCwd, config, label);
      if (!checked.pass) {
        return "sensitive" in checked ? { outcome: "sensitive", decision: checked.sensitive } : { outcome: "fail" };
      }
      const script = parseBashCommand(seg.args[1]!);
      script.segments.forEach((s, idx) => {
        out.push(idx === 0 ? { ...s, prevOp: seg.prevOp } : s);
      });
      continue;
    }
    const nests = findShellNests(seg.raw);
    if (nests.length === 0) {
      out.push(seg);
      continue;
    }
    for (const nest of nests) {
      const checked = checkInnerText(nest.inner, segCwd, config, label);
      if (!checked.pass) {
        return "sensitive" in checked ? { outcome: "sensitive", decision: checked.sensitive } : { outcome: "fail" };
      }
    }
    // B3：净化后重解析；仅剩变量赋值/空直接丢弃（视同 R）
    const scrubbed = scrubShellNests(seg.raw, nests);
    if (scrubbed.trim() === "" || PURE_ASSIGN_SEGMENT.test(scrubbed.trim())) continue;
    const { segment, error } = reparseSegment(scrubbed, seg.prevOp);
    if (error) return { outcome: "fail" };
    if (segment !== undefined) out.push(segment);
  }
  return { outcome: "pass", segments: out };
}

/**
 * 跟踪链式命令中的 cd，返回每段执行时的有效工作目录。
 * 切目录语义由适配器提供（powershell 的 Set-Location/Push-Location/Pop-Location 等）：
 * Pop-Location 弹出栈目标不可静态跟踪 → 返回 undefined，后续相对路径保守按外部处理。
 */
function resolveSegmentCwds(
  segments: readonly BashSegment[],
  initialCwd: string,
  adapter: ShellAdapter,
): (string | undefined)[] {
  const result: (string | undefined)[] = [];
  let current: string | undefined = initialCwd;
  for (const seg of segments) {
    result.push(current); // 本段在切目录之前执行，用切换前的目录
    current = adapter.resolveCwdChange(seg.program, seg.args, current);
  }
  return result;
}

/**
 * chill 分支专用处置（§2.2 判定顺序定稿，插在 yolo 早返回与 parseError fail-closed 之间）：
 * ① 顶层段敏感 → deny（`chillSensitiveAction: "ask"` 时改 ask，FR-1）；
 * ② 静态字面载荷敏感 → 同上（脚本文件/编码/动态载荷不进此层）；
 * ③ critical（含管道到 shell）→ ask（FR-4，approvalId 取首个 critical 段，不走 rankOf）；
 * ④ 其余一律 allow（不可展开/不可解析并入放行，审计落 debug 流）。
 * 非 critical 的 wrapper danger（如 `sudo ls`）在此降级：处置差异，不动解析。
 */
function chillShellDecision(req: BashDecisionRequest, adapter: ShellAdapter, label: string): Decision {
  const { config, cwd, command } = req;
  const parsed = adapter.parse(command);
  const sensitiveAction = normalizeChillSensitiveAction(config.chillSensitiveAction);
  const chillSensitive = (hit: Decision): Decision => {
    const details = [...(hit.details ?? []), shellDetail(adapter.id, command, parsed)];
    if (sensitiveAction === "ask") return { ...hit, details };
    return { action: "deny", rule: "FR-1", reason: `${label} sensitive file access blocked in chill mode`, details };
  };
  const scanSensitive = (segs: readonly BashSegment[], cwds: readonly (string | undefined)[]): Decision | undefined => {
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const readRefs = adapter.readRefs(seg);
      const writeTargets = adapter.writeTargets(seg);
      const hit = sensitiveDecision([...readRefs, ...writeTargets], cwds[i] ?? cwd, config, readRefs, label);
      if (hit) return hit;
    }
    return undefined;
  };
  // ① 顶层段敏感
  const topHit = scanSensitive(parsed.segments, resolveSegmentCwds(parsed.segments, cwd, adapter));
  if (topHit) return chillSensitive(topHit);
  // ② 静态字面载荷层敏感（`staticUnwrap` 仅产静态可证内层）
  const payloads = adapter.staticUnwrap(parsed.segments);
  if (payloads.length > 0) {
    const payloadHit = scanSensitive(payloads, resolveSegmentCwds(payloads, cwd, adapter));
    if (payloadHit) return chillSensitive(payloadHit);
  }
  // ③ critical 唯一 ask 来源（管道到 shell 计入顶层与载荷两处）
  // rm/remove-item 段只看收窄黑名单谓词（criticalChill），其余 critical 固定规则/清单原样生效；
  // chmod/chown/chgrp 亦只看 criticalChill（§3.1 规则 2 终版）：仅数字 0?777 的 chmod 会置位，
  // -R 递归与 chown/chgrp 全部走宽口径 critical（只对 build/plan 生效，chill 一律放行）
  const candidates = [...parsed.segments, ...payloads];
  const kinds = candidates.map((seg) => adapter.classify(seg, config));
  const isChillCritical = (k: SegmentClassLike, program: string): boolean =>
    k.criticalChill || (k.critical && !CHILL_NARROWED_PROGRAMS.has(program));
  const criticalIndex = kinds.findIndex((k, i) => isChillCritical(k, candidates[i]!.program));
  const criticalAny = criticalIndex >= 0 || adapter.pipeToShell(parsed.segments) || adapter.pipeToShell(payloads);
  if (criticalAny) {
    return {
      action: "ask",
      rule: "FR-4",
      reason: `${label} critical operation requires confirmation`,
      details: [shellDetail(adapter.id, command, parsed)],
      approvalId: criticalIndex >= 0 ? kinds[criticalIndex]!.id : undefined,
    };
  }
  // ④ 放行
  return { action: "allow", rule: "FR-5", reason: `${label} chill mode relaxed checks, allowed`, details: [shellDetail(adapter.id, command, parsed)] };
}

/** bash 级决策。
/** 通用 shell 级决策核心：bash 与 powershell 共用（适配器提供解析/分类实现）。
 * plan（不分 cwd 内外）：明确写/敏感操作 deny → 敏感文件 ask → read 白名单 allow → other ask/deny(strict)
 * build：危险操作 ask → 敏感文件 ask → cwd 外（read 白名单 allow / other ask）；cwd 内 allow
 */
export function decideShellRequest(req: BashDecisionRequest, adapter: ShellAdapter): Decision {
  const { mode, config, cwd, command } = req;
  const label = `[${adapter.id}]`;
  const parsed = adapter.parse(command);

  // yolo：彻底放行但敏感文件仍 deny（跳过 fail-closed / 管道等检查）
  if (mode === "yolo") {
    // 复用段 cwd 缓存，避免每轮重算
    const yoloSegmentCwds = resolveSegmentCwds(parsed.segments, cwd, adapter);
    const yoloSensitive = (() => {
      for (let i = 0; i < parsed.segments.length; i++) {
        const seg = parsed.segments[i]!;
        const segCwd = yoloSegmentCwds[i] ?? cwd;
        const readRefs = adapter.readRefs(seg);
        const writeTargets = adapter.writeTargets(seg);
        const hit = sensitiveDecision([...readRefs, ...writeTargets], segCwd, config, readRefs, label);
        if (hit) return hit;
      }
      return undefined;
    })();
    if (yoloSensitive) {
      return { action: "deny", rule: "FR-1", reason: yoloSensitive.reason, details: [...(yoloSensitive.details ?? []), shellDetail(adapter.id, command)] };
    }
    // 即使含复杂语法/管道也放行（yolo bypass）
    return { action: "allow", rule: "yolo", reason: `[yolo] yolo mode, all operations allowed` };
  }

  // chill：只拦敏感文件（默认 deny）与 critical 清单（唯一 ask 来源），其余一律放行（含解析失败）
  if (mode === "chill") return chillShellDecision(req, adapter, label);

  // FR-7 fail-closed：语法无法解析 / 含复杂语法 → build=ask、plan=deny
  if (parsed.parseError) return failClosed(mode, label, "unparseable", command, adapter.id);

  // 跟踪 cd：每段的有效工作目录（cd 后相对路径按新目录解析，防 cd 到外部绕过）
  // cd 无法解析（如 `cd -`）时置 undefined，后续相对路径保守按外部处理
  const segmentCwds = resolveSegmentCwds(parsed.segments, cwd, adapter);

  // L1 内部门（B2/B4，bash-only）：顶层含嵌套时试探递归判定，通过则用净化后段走正常链
  // （展示用的 parsed 保持原始命令；判定用的 segments/activeCwds 为净化后）
  // B4 的 `bash -c "..."` 本身不置 has* 标记，需独立触发
  let segments: readonly BashSegment[] = parsed.segments;
  let activeCwds = segmentCwds;
  const hasStaticBashC =
    adapter.id === "bash" &&
    parsed.segments.some((s) => WRAPPER_SHELLS.has(s.program) && s.args.length === 2 && s.args[0] === "-c");
  if (parsed.hasCommandSubstitution || parsed.hasProcessSubstitution || parsed.hasSubshell || hasStaticBashC) {
    if (adapter.id !== "bash") {
      return failClosed(mode, label, "command substitution/subshell", command, adapter.id);
    }
    const gate = evalBashNestGate(parsed.segments, segmentCwds, cwd, config, label);
    if (gate.outcome === "fail") {
      return failClosed(mode, label, "command substitution/subshell", command, adapter.id);
    }
    if (gate.outcome === "sensitive") {
      return { ...gate.decision, details: [...(gate.decision.details ?? []), shellDetail(adapter.id, command, parsed)] };
    }
    segments = gate.segments;
    activeCwds = resolveSegmentCwds(segments, cwd, adapter);
  }

  if (segments.length === 0) {
    return { action: "allow", rule: "default", reason: `${label} empty command` };
  }
  const uncertainRelative = activeCwds.includes(undefined);

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
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const segCwd = activeCwds[i] ?? cwd;
    const readRefs = adapter.readRefs(seg);
    const writeTargets = adapter.writeTargets(seg);
    for (const r of readRefs) {
      const external = uncertainRelative && !path.isAbsolute(r) ? true : !isWithinProject(r, segCwd, projectRoots(config, segCwd), home());
      if (external) {
        externalRefs.push(r);
        if (!isTrustedForSegment(r, segCwd)) nonTrustedExternalRefs.push(r);
      }
    }
    for (const w of writeTargets) {
      const external = uncertainRelative && !path.isAbsolute(w) ? true : !isWithinProject(w, segCwd, projectRoots(config, segCwd), home());
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
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const segCwd = activeCwds[i] ?? cwd;
      const readRefs = adapter.readRefs(seg);
      const writeTargets = adapter.writeTargets(seg);
      const hit = sensitiveDecision([...readRefs, ...writeTargets], segCwd, config, readRefs, label);
      if (hit) return hit;
    }
    return undefined;
  };

  const kinds = segments.map((seg) => adapter.classify(seg, config));
  const dangerAny = kinds.some((k) => k.danger) || adapter.pipeToShell(segments);
  const hasX = kinds.some((k) => k.tier === "X");
  const allPureR = kinds.every((k) => k.tier === "R");
  // 会话批准记忆 id：危险 > 不透明 > 有界写 > 纯读，取最严段的标识
  const rankOf = (k: SegmentClassLike) => (k.danger ? 3 : k.tier === "X" ? 2 : k.tier === "W" ? 1 : 0);
  let approvalId: string | undefined;
  let bestRank = -1;
  for (let i = 0; i < segments.length; i++) {
    const r = rankOf(kinds[i]!);
    if (r > bestRank) {
      bestRank = r;
      approvalId = kinds[i]!.id;
    }
  }

  if (mode === "plan") {
    // ① 危险叠加命中 → 静默 deny（本操作停死含变体；显式授权任务其余只读部分继续）
    if (dangerAny) {
      return {
        action: "deny",
        rule: "FR-8",
        reason: `${label} Dangerous op blocked in plan mode. No workarounds — switch to /build or continue read-only work.`,
        details: [displaySegmented(adapter.id, parsed, command)],
        approvalId,
      };
    }
    // ② 可枚举写目标 ∉ T_plan（含写 cwd 项目文件）→ 静默 deny；X 段普通参数只是引用不算
    if (nonTrustedWriteTargets.length > 0) {
      return {
        action: "deny",
        rule: "FR-8",
        reason: `${label} Plan mode forbids writes outside trusted paths. Continue read-only work or use /build for writes.`,
        details: [...nonTrustedWriteTargets],
        approvalId,
      };
    }
    // ③ 涉及敏感文件（不分读写；能走到此处的写必然在 trusted 内）→ ask
    const sensitive = sensitiveBySegment();
    if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), displaySegmented(adapter.id, parsed, command)], approvalId };
    // ④ 可证安全：所有段为 R 或 W（W 写目标已由②证明全 ∈ T_plan）→ allow
    if (!hasX) {
      return { action: "allow", rule: "FR-8", reason: `${label} provable read/trusted-write operations allowed`, approvalId };
    }
    // ⑤ 真兜底：含 X 段（效果不可证明）→ strict 静默 deny / ask
    if (config.strictPlanMode) {
      return {
        action: "deny",
        rule: "FR-10",
        reason: `${label} Strict plan mode: unverifiable execution blocked. Use commands with provable effects, or switch to /build.`,
        details: [displaySegmented(adapter.id, parsed, command)],
        approvalId,
      };
    }
    return {
      action: "ask",
      rule: "FR-10",
      reason: `${label} opaque execution cannot be verified in plan mode — the command may write anywhere`,
      details: [displaySegmented(adapter.id, parsed, command)],
      approvalId,
    };
  }

  // build 模式
  // ① 危险叠加命中 → ask
  if (dangerAny) {
    return { action: "ask", rule: "FR-4", reason: `${label} dangerous operation requires confirmation`, details: [shellDetail(adapter.id, command, parsed)], approvalId };
  }
  // ② 涉及敏感文件（不分读写）→ ask
  const sensitive = sensitiveBySegment();
  if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), shellDetail(adapter.id, command, parsed)], approvalId };
  // ③ 所有段的引用与写目标全部 ∈ T_build（cwd ∪ trusted）→ allow（R/W/X 同权）
  if (nonTrustedExternalRefs.length === 0 && nonTrustedExternalTargets.length === 0) {
    return { action: "allow", rule: "FR-5", reason: `${label} inside trust domain, allowed`, approvalId };
  }
  // ④ 纯 R（引用任意位置）→ allow
  if (allPureR) {
    return { action: "allow", rule: "FR-5", reason: `${label} read-only command whitelist, external path allowed`, approvalId };
  }
  // ⑤ 兜底：存在跨域写目标 → FR-3（按父目录记忆）；否则 X 跨域引用 → FR-10（按 program 记忆）
  if (nonTrustedExternalTargets.length > 0) {
    return {
      action: "ask",
      rule: "FR-3",
      reason: `${label} writing outside project requires confirmation`,
      details: [...nonTrustedExternalTargets, shellDetail(adapter.id, command, parsed)],
      approvalId,
    };
  }
  return {
    action: "ask",
    rule: "FR-10",
    reason: `${label} external path referenced by an unverifiable command requires confirmation`,
    details: [...nonTrustedExternalRefs, shellDetail(adapter.id, command, parsed)],
    approvalId,
  };
}

/** bash 工具决策入口。 */
export function decideBashRequest(req: BashDecisionRequest): Decision {
  return decideShellRequest(req, BASH_ADAPTER);
}

/** powershell 工具决策入口（pi 0.84.3+ Windows 可选工具）。 */
export function decidePowerShellRequest(req: BashDecisionRequest): Decision {
  return decideShellRequest(req, POWERSHELL_ADAPTER);
}
