import path from "node:path";
import type { PermissionConfig } from "./config.ts";

/** 重定向目标。 */
export interface Redirect {
  /** 重定向操作符，如 `>`、`>>`、`<`、`2>`。 */
  op: string;
  /** 重定向目标（文件路径或 fd，如 `&1`）。 */
  target: string;
}

/** 顶层命令段。 */
export interface BashSegment {
  /** 段原始文本。 */
  raw: string;
  /** 前一个连接操作符：`&&` / `||` / `;` / `|` / `&` / `换行`。 */
  prevOp: string;
  /** 命令名（basename，去除路径前缀）。 */
  program: string;
  /** 参数（不含重定向）。 */
  args: string[];
  /** 重定向列表。 */
  redirects: Redirect[];
  /** git 子命令（`git <subcommand>`）。 */
  gitSubcommand?: string;
  /** git 子命令后的参数。 */
  gitArgs: string[];
  /** 是否为包装命令（bash -c / eval / sudo / xargs / find -exec 等）。 */
  wrapper: boolean;
}

/** bash 解析结果，供决策层判定（FR-4/FR-5/FR-7/FR-8）。 */
export interface ParsedCommand {
  segments: BashSegment[];
  /** 含命令替换 `$(...)` 或反引号。 */
  hasCommandSubstitution: boolean;
  /** 含进程替换 `<(...)` / `>(...)`。 */
  hasProcessSubstitution: boolean;
  /** 含子 shell `(...)`。 */
  hasSubshell: boolean;
  /** 语法解析失败（引号未闭合等）。 */
  parseError: boolean;
}

/**
 * 效果三档（效果可证明性分类）：
 * - R 纯读者：无文件副作用
 * - W 有界写者：写目标可从参数穷举
 * - X 不透明：效果不可从参数推导（解释器、构建工具、未识别程序、解析失败降级）
 */
export type EffectTier = "R" | "W" | "X";

/** 单段分类结果：效果档位 + 危险叠加标记 + 批准记忆标识。 */
export interface SegmentClass {
  /** 效果档位。 */
  tier: EffectTier;
  /** 危险叠加命中（凌驾档位之上的产品契约层，如 rm -rf / sudo / git push / wrapper）。 */
  danger: boolean;
  /** 会话批准记忆标识：程序名或 `git:<子命令>`。 */
  approvalId: string;
}

const GIT_OPTION_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--exec-path",
  "--namespace", "--super-prefix", "--object-format", "--no-optional-locks",
]);

/** `bash -c` 类静态展开的解释器集合（B4 用，decision 侧复用）。 */
export const WRAPPER_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** 可剥离的启动器前缀：效果修饰程序，不改变真实程序身份；sudo/su 不剥离（提权本身即危险，走叠加）。 */
const STRIPPABLE_LAUNCHERS = new Set(["env", "nohup", "setsid", "stdbuf", "command", "builtin", "exec"]);
/** 变量赋值前缀（`FOO=bar`）：启动段环境设置，剥离后取真实程序。 */
const VAR_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** 已知只读 git 子命令：不在其中的子命令视为未识别（X），不再假定为只读。 */
export const GIT_READONLY_SUBS = new Set([
  "status", "log", "diff", "show", "fetch", "remote", "branch", "tag", "stash", "config",
  "ls-files", "rev-parse", "describe", "shortlog", "reflog", "grep", "cat-file",
  "blame", "whatchanged", "ls-remote", "symbolic-ref", "var", "version", "help",
]);

/** shell 嵌套 span：`$(...)`/反引号/`<(...)`/`>(...)`/顶层 `(...)` 的内层文本与位置（B1）。 */
export interface ShellNest {
  /** span 起始（含定界符）。 */
  start: number;
  /** span 结束（不含，为定界符后一位）。 */
  end: number;
  /** 内层文本（不含定界符）。 */
  inner: string;
}

/** 从闭括号（openIdx 为 `(` 位置）向后捕获配对 span：引号/转义感知；失败返回 undefined。 */
function captureBalanced(text: string, openIdx: number): { end: number; close: number } | undefined {
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let j = openIdx + 1; j < text.length; j++) {
    const c = text[j]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { end: j + 1, close: j };
    }
  }
  return undefined;
}

/** 抽取文本中的 shell 嵌套 span（引号感知；单引号内不抽取）。 */
export function findShellNests(text: string): ShellNest[] {
  const nests: ShellNest[] = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let i = 0;
  const pushParen = (start: number, openIdx: number) => {
    const r = captureBalanced(text, openIdx);
    if (r === undefined) return false;
    nests.push({ start, end: r.end, inner: text.slice(openIdx + 1, r.close) });
    i = r.end;
    return true;
  };
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        i++;
        continue;
      }
      if (ch === "$" && next === "(") {
        if (!pushParen(i, i + 1)) i += 2;
        continue;
      }
      if (ch === "`") {
        const j = text.indexOf("`", i + 1);
        if (j === -1) {
          i++;
          continue;
        }
        nests.push({ start: i, end: j + 1, inner: text.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === "`") {
      const j = text.indexOf("`", i + 1);
      if (j === -1) {
        i++;
        continue;
      }
      nests.push({ start: i, end: j + 1, inner: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (ch === "$" && next === "(") {
      if (!pushParen(i, i + 1)) i += 2;
      continue;
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      if (!pushParen(i, i + 1)) i += 2;
      continue;
    }
    if (ch === "(") {
      if (!pushParen(i, i)) i++;
      continue;
    }
    i++;
  }
  return nests;
}

/** 净化：将 span 倒序替换为 `""`（位置不漂移），供 B3 外层净化。 */
export function scrubShellNests(raw: string, nests: readonly ShellNest[]): string {
  const ordered = [...nests].sort((a, b) => b.start - a.start);
  let out = raw;
  for (const n of ordered) out = out.slice(0, n.start) + '""' + out.slice(n.end);
  return out;
}

/** 顶层连接操作符（引号外、括号外才生效）。 */
const TOP_LEVEL_OPS = ["||", ";;", "|&", "|", ";", "\n"];

/** 顶层切分：感知引号，按 `&&`/`||`/`;`/`|`/`&`/换行 分段，并检测复杂语法标记。 */
function splitTopLevel(command: string): {
  segments: string[];
  ops: string[];
  hasCommandSubstitution: boolean;
  hasProcessSubstitution: boolean;
  hasSubshell: boolean;
  parseError: boolean;
} {
  const segments: string[] = [];
  const ops: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let parenDepth = 0;
  let hasCommandSubstitution = false;
  let hasProcessSubstitution = false;
  let hasSubshell = false;
  let parseError = false;

  const flush = (op: string) => {
    segments.push(current);
    ops.push(op);
    current = "";
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      if (next === "\n") {
        i += 2;
        continue; // 行继续符
      }
      current += ch;
      escaped = true;
      i++;
      continue;
    }
    if (inSingle) {
      // 闭合引号同样保留到 current，保证后续 token 化引号匹配正确
      if (ch === "'") {
        inSingle = false;
        current += ch;
      } else {
        current += ch;
      }
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        current += ch;
      } else if (ch === "$" && next === "(") hasCommandSubstitution = true;
      else if (ch === "`") hasCommandSubstitution = true;
      else current += ch;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      hasCommandSubstitution = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "$" && next === "(") {
      hasCommandSubstitution = true;
      parenDepth++; // 与闭合 ) 配对，深度归零
      current += "$("; // `(` 同步进 current（B1 内层抽取依赖原文；计数仍只加一次）
      i += 2; // 同时跳过 $ 和 (，避免 ( 分支二次计数把平衡的 $(...) 误判为 parseError
      continue;
    }
    if ((ch === "<" && next === "(") || (ch === ">" && next === "(")) {
      hasProcessSubstitution = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "(") {
      if (parenDepth === 0) hasSubshell = true;
      parenDepth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      else parseError = true;
      current += ch;
      i++;
      continue;
    }

    if (ch === "&") {
      const prev = command[i - 1];
      const next = command[i + 1];
      // 重定向 fd 中的 &（2>&1、&>file、>&2）不是后台分隔符
      if (prev === ">" || next === ">") {
        current += ch;
        i++;
        continue;
      }
      // 括号内的 & 为字面（如 $(a && b) 内），不断段——与 TOP_LEVEL_OPS 的 parenDepth 守卫同理
      if (parenDepth !== 0) {
        current += ch;
        i++;
        continue;
      }
      if (next === "&") {
        flush("&&");
        i += 2;
        continue;
      }
      flush("&");
      i++;
      continue;
    }

    if (parenDepth === 0) {
      const op = TOP_LEVEL_OPS.find((o) => command.startsWith(o, i));
      if (op) {
        flush(op.trim() === "" ? "\n" : op);
        i += op.length;
        continue;
      }
    }
    current += ch;
    i++;
  }

  if (inSingle || inDouble || parenDepth !== 0) parseError = true;
  flush("\n");
  return { segments, ops, hasCommandSubstitution, hasProcessSubstitution, hasSubshell, parseError };
}

const REDIRECT_OPS = ["2>>", "&>>", ">>", "2>", "&>", "1>", "<>", "<<", "<", ">"];

function isRedirectStart(raw: string, index: number): boolean {
  return REDIRECT_OPS.some((o) => raw.startsWith(o, index));
}

/** 单段 token 化：切分参数并抽取重定向目标（引号感知）。 */
function tokenizeSegment(raw: string): { tokens: string[]; redirects: Redirect[]; error: boolean } {
  const tokens: string[] = [];
  const redirects: Redirect[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let error = false;

  const pushToken = () => {
    if (current !== "") {
      tokens.push(current);
      current = "";
    }
  };

  const readTarget = (start: number): { target: string; end: number } => {
    let j = start;
    while (j < raw.length && /\s/.test(raw[j]!)) j++;
    if (raw[j] === '"' || raw[j] === "'") {
      const quote = raw[j]!;
      j++;
      let target = "";
      while (j < raw.length && raw[j] !== quote) {
        target += raw[j]!;
        j++;
      }
      j++; // 跳过闭合引号
      return { target, end: j };
    }
    let target = "";
    while (j < raw.length && !/\s/.test(raw[j]!) && !isRedirectStart(raw, j)) {
      target += raw[j]!;
      j++;
    }
    return { target, end: j };
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      i++;
      continue;
    }
    const rest = raw.slice(i);
    const op = REDIRECT_OPS.find((o) => rest.startsWith(o));
    if (op) {
      pushToken();
      const { target, end } = readTarget(i + op.length);
      // << / <<< / <<- 为 heredoc/herestring，目标是内联内容或标记，不视为文件引用
      const heredoc = op === "<<" || op === "<<<" || op === "<<-";
      if (!heredoc && target !== "") redirects.push({ op, target });
      i = end;
      continue;
    }
    current += ch;
    i++;
  }

  if (inSingle || inDouble) error = true;
  pushToken();
  return { tokens, redirects, error };
}

/** 提取 git 子命令（跳过带值的全局选项如 `-C dir`、`-c key=val`）。导出供 powershell.ts 解析原生 git 调用复用。 */
export function extractGit(args: string[]): { subcommand?: string; gitArgs: string[] } {
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (GIT_OPTION_WITH_VALUE.has(a) && i + 1 < rest.length) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return { subcommand: a, gitArgs: rest.slice(i + 1) };
  }
  return { subcommand: undefined, gitArgs: [] };
}

/** 检测包装命令：bash -c / eval / sudo / xargs / find -exec 等（危险叠加）。 */
function detectWrapper(program: string, args: string[]): boolean {
  if (program === "eval" || program === "sudo" || program === "su" || program === "xargs") {
    return true;
  }
  if (WRAPPER_SHELLS.has(program)) {
    return args.includes("-c");
  }
  if (program === "find") {
    return args.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-exec+");
  }
  return false;
}

/** 剥离启动器前缀（env/nice/timeout/nohup/setsid/stdbuf/command/VAR=x），返回真实程序与参数。
 * sudo 不剥离：提权本身即危险叠加。剥离后 tokens 为空（裸 `env`）时保留原程序名（仅打印环境变量，读者）。 */
function stripLauncherPrefix(tokens: string[]): { program: string; args: string[] } {
  const t = [...tokens];
  while (t.length > 0) {
    const head = t[0]!;
    if (head === "sudo" || head === "su") break;
    if (VAR_ASSIGN.test(head) && head.includes("=")) {
      t.shift();
      continue;
    }
    if (STRIPPABLE_LAUNCHERS.has(head)) {
      t.shift();
      // 消费启动器自身的选项：command/builtin 的任意 -flag（如 -v）、env/stdbuf 的 -i/--x；其余启动器无值选项已含于 token
      while (
        t.length > 0 &&
        (t[0] === "-i" ||
          ((head === "command" || head === "builtin") && t[0]!.startsWith("-")) ||
          (head === "stdbuf" && /^-[io]/.test(t[0]!)))
      ) {
        // stdbuf 的 -o/-i 可能带值（-o 256K 与 -oL 两种形态），带空格分立时多消费一个
        if ((head === "stdbuf" && /^-[io]$/.test(t[0]!)) || (t[0] === "--suffix")) t.splice(0, 2);
        else t.splice(0, 1);
      }
      continue;
    }
    if (head === "nice") {
      t.shift();
      if (t[0] === "-n" && t.length > 1) t.splice(0, 2);
      continue;
    }
    if (head === "time") {
      t.shift();
      if (t[0] === "-p") t.shift();
      continue;
    }
    if (head === "timeout") {
      t.shift();
      // 第一个位置参数是时长（如 30 / 30s / 2m）
      if (t.length > 0 && /^\d/.test(t[0]!)) t.shift();
      continue;
    }
    break;
  }
  if (t.length === 0) {
    // 裸启动器（如 `env`）：还原为自身程序名
    const orig = tokens[0] ?? "";
    return { program: orig === "" ? "" : path.posix.basename(orig), args: [] };
  }
  return { program: path.posix.basename(t[0]!), args: t.slice(1) };
}

/** 由已切分好的单段文本构建 BashSegment（供 parseBashCommand 与 B3 重解析复用）。 */
function buildSegment(trimmed: string, prevOp: string): { segment: BashSegment; error: boolean } {
  const { tokens, redirects, error } = tokenizeSegment(trimmed);
  const stripped = stripLauncherPrefix(tokens);
  const program = stripped.program;
  const args = stripped.args;
  const git = program === "git" ? extractGit([program, ...args]) : undefined;
  const segment: BashSegment = {
    raw: trimmed,
    prevOp,
    program,
    args,
    redirects,
    gitSubcommand: git?.subcommand,
    gitArgs: git?.gitArgs ?? [],
    wrapper: detectWrapper(program, args),
  };
  return { segment, error };
}

/**
 * 重解析单段文本（B3 净化后外层段用）：空串返回 undefined（调用方丢弃该段）；
 * token 化失败返回 error（调用方回退 fail-closed）。
 */
export function reparseSegment(raw: string, prevOp: string): { segment: BashSegment | undefined; error: boolean } {
  const trimmed = raw.trim();
  if (trimmed === "") return { segment: undefined, error: false };
  const { segment, error } = buildSegment(trimmed, prevOp);
  return { segment, error };
}

/** 解析 bash 命令为顶层命令段结构（自研简化解析器，D11）。 */
export function parseBashCommand(command: string): ParsedCommand {
  const top = splitTopLevel(command);
  const segments: BashSegment[] = [];

  top.segments.forEach((raw, idx) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const { segment, error } = buildSegment(trimmed, idx === 0 ? "" : (top.ops[idx - 1] ?? ""));
    if (error) top.parseError = true;
    segments.push(segment);
  });

  return {
    segments,
    hasCommandSubstitution: top.hasCommandSubstitution,
    hasProcessSubstitution: top.hasProcessSubstitution,
    hasSubshell: top.hasSubshell,
    parseError: top.parseError,
  };
}

export type SegmentTier = "R" | "W" | "X";

export interface SegmentClassification {
  /** 效果档位：R 纯读者 / W 有界写者 / X 不透明（效果不可从参数推导）。 */
  tier: SegmentTier;
  /** 危险叠加命中：wrapper、固定规则（rm -r/-f 等）、危险清单。凌驾于档位之上。 */
  danger: boolean;
  /** 会话批准记忆键用的程序标识（git 子命令为 `git:<sub>`）。 */
  id: string;
}

const DANGEROUS_BRANCH_FLAGS = /^-[dDmMcC]$|^--(delete|move|copy|create-reflog)/;

/** find 写动作 flag：目标 = 起始路径（可枚举），命中后段升级为 W。 */
const FIND_WRITE_FLAGS = new Set(["-delete", "-fls", "-fprint", "-fprint0", "-fprintf"]);

/** sed -i 变体（含 `-i.bak` 后缀形态）：原位写入，段升级为 W。 */
const SED_IN_PLACE = /^-i(bak.*|\.[A-Za-z0-9_]+)?$/;

/** curl/wget 参数解析结果（F2/F3 单一可信源：classify/collectWriteTargets/collectReadRefs 共用）。 */
interface FetchParse {
  /** 发送信号（curl -d/data/-F/form/-T/upload/非 GET -X/-K-config）：命中即早返 X-danger。 */
  send: boolean;
  /** 写目标（已按各选项豁免规则过滤）。 */
  targets: string[];
  /** 文件型元数据值（curl -E/cert/key/cacert/无=的-b：进 readRefs 参与敏感扫描）。 */
  fileRefs: string[];
  /** 未知选项。 */
  unknown: boolean;
  /** 值选项无值可取。 */
  missing: boolean;
}

/** curl 独立无害短选项（exact 单 token，与捆绑无害表同源）。 */
const CURL_HARMLESS_SHORT = new Set(["s", "S", "v", "L", "k", "I", "q", "f", "N", "G"]);
/** curl 无害长选项（exact；`--remote-name` 不在此表——它是 `-O` 长形，为写目标）。 */
const CURL_HARMLESS_LONG = new Set([
  "silent", "show-error", "verbose", "disable", "location", "fail", "insecure", "no-buffer", "get", "head",
]);
/** curl 纯字符串元数据选项（exact；值 consume 后忽略）：`-b/--cookie` 另行按值内容区分。 */
const CURL_META_STR = new Set([
  "H", "header", "e", "referer", "u", "user", "U", "proxy-user", "x", "proxy",
  "A", "user-agent", "w", "write-out", "m", "max-time", "connect-timeout", "retry",
  "retry-delay", "resolve", "connect-to", "r", "range", "limit-rate",
]);
/** curl 文件型元数据选项（exact；值进 fileRefs）：`-b/--cookie` 按值内容另行区分。 */
const CURL_META_FILE = new Set(["E", "cert", "key", "cacert"]);

/** 取下一 token 作值；缺失则置 missing（F 取值缺失规则）。 */
function takeFetchValue(args: string[], i: { idx: number }, r: FetchParse): string | undefined {
  if (i.idx + 1 < args.length) return args[++i.idx];
  r.missing = true;
  return undefined;
}

/** curl -o/-O 系目标与 --output-dir 状态（解析期上下文，调用方不可见）。 */
interface CurlOutputState {
  o: string[];
  dir: string | undefined;
}

/** 解析 curl 短选项 token（exact/粘连/捆绑）；返回是否消费为“已知”（未知→ unknown）。 */
function parseCurlShort(a: string, args: string[], i: { idx: number }, r: FetchParse, od: CurlOutputState): void {
  // exact 值选项（单字母 + 下一 token 取值）
  const exactValue = (name: string, fn: (v: string | undefined) => void) => {
    if (a !== `-${name}`) return false;
    fn(takeFetchValue(args, i, r));
    return true;
  };
  if (exactValue("d", () => { r.send = true; })) return;
  if (exactValue("F", () => { r.send = true; })) return;
  if (exactValue("T", () => { r.send = true; })) return;
  if (a === "-X") {
    const v = takeFetchValue(args, i, r);
    if (v !== undefined && !/^(get|head)$/i.test(v)) r.send = true;
    return;
  }
  if (exactValue("K", () => { r.send = true; })) return;
  if (a === "-o") {
    const v = takeFetchValue(args, i, r);
    if (v !== undefined && v !== "/dev/null" && v !== "-") od.o.push(v);
    return;
  }
  if (a === "-O") {
    od.o.push(".");
    return;
  }
  if (a === "-D") {
    const v = takeFetchValue(args, i, r);
    if (v !== undefined && v !== "/dev/null" && v !== "-") r.targets.push(v);
    return;
  }
  if (a === "-c") {
    const v = takeFetchValue(args, i, r);
    if (v !== undefined && v !== "/dev/null" && v !== "-") r.targets.push(v);
    return;
  }
  if (exactValue("E", (v) => { if (v !== undefined && v !== "/dev/null") r.fileRefs.push(v); })) return;
  if (a === "-b") {
    const v = takeFetchValue(args, i, r);
    if (v !== undefined && !v.includes("=") && v !== "/dev/null") r.fileRefs.push(v);
    return;
  }
  if (exactValue("H", () => { /* 纯字符串元数据，忽略 */ })) return;
  if (exactValue("e", () => { })) return;
  if (exactValue("u", () => { })) return;
  if (exactValue("U", () => { })) return;
  if (exactValue("x", () => { })) return;
  if (exactValue("A", () => { })) return;
  if (exactValue("w", () => { })) return;
  if (exactValue("m", () => { })) return;
  if (exactValue("r", () => { })) return;
  if (a.length === 2 && CURL_HARMLESS_SHORT.has(a[1]!)) return; // 独立无害短选项
  // 粘连：首字母为带值选项（d/F/T/X/o/D/c/K）
  if (a.length > 2 && "dFTXoDcK".includes(a[1]!)) {
    const flag = a[1]!;
    const rest = a.slice(2);
    if (flag === "d" || flag === "F" || flag === "T" || flag === "K") r.send = true;
    else if (flag === "X") {
      if (!/^(get|head)$/i.test(rest)) r.send = true;
    } else if (flag === "o") {
      if (rest !== "/dev/null" && rest !== "-") od.o.push(rest);
    } else if (flag === "D" || flag === "c") {
      if (rest !== "/dev/null" && rest !== "-") r.targets.push(rest);
    }
    return;
  }
  // 捆绑：逐字符展开（^-[^-][^-]+$ 形态在此；其它未知形态亦按捆绑规则兜底）
  if (/^-[^-]+$/.test(a)) {
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      const rest = a.slice(j + 1);
      if (CURL_HARMLESS_SHORT.has(c)) continue;
      if (c === "d" || c === "F" || c === "T" || c === "K") {
        r.send = true;
        return; // 剩余子串为附着值，忽略
      }
      if (c === "X" || c === "o" || c === "D" || c === "c") {
        const v = rest !== "" ? rest : takeFetchValue(args, i, r);
        if (c === "X") {
          if (v !== undefined && !/^(get|head)$/i.test(v)) r.send = true;
        } else if (c === "o") {
          if (v !== undefined && v !== "/dev/null" && v !== "-") od.o.push(v);
        } else if (v !== undefined && v !== "/dev/null" && v !== "-") {
          r.targets.push(v);
        }
        return;
      }
      if (c === "O") {
        od.o.push(".");
        continue; // 剩余子串继续按捆绑展开（getopt 语义）
      }
      r.unknown = true; // 展开字母表之外 → 未知
      return;
    }
    return;
  }
  r.unknown = true;
}

/** 解析 curl 长选项 token；返回是否消费为“已知”。 */
function parseCurlLong(a: string, args: string[], i: { idx: number }, r: FetchParse, od: CurlOutputState): void {
  const eq = a.indexOf("=");
  const name = eq === -1 ? a : a.slice(0, eq);
  const inline = eq === -1 ? undefined : a.slice(eq + 1);
  const valueOf = (): string | undefined => (inline !== undefined ? inline : takeFetchValue(args, i, r));
  if (name.startsWith("--data")) {
    r.send = true;
    valueOf();
    return;
  }
  if (name.startsWith("--form")) {
    r.send = true;
    valueOf();
    return;
  }
  if (name === "--upload-file") {
    r.send = true;
    valueOf();
    return;
  }
  if (name === "--request") {
    const v = valueOf();
    if (v !== undefined && !/^(get|head)$/i.test(v)) r.send = true;
    return;
  }
  if (name === "--config") {
    r.send = true;
    valueOf();
    return;
  }
  if (name === "--output") {
    const v = valueOf();
    if (v !== undefined && v !== "/dev/null" && v !== "-") od.o.push(v);
    return;
  }
  if (name === "--remote-name") {
    od.o.push(".");
    return;
  }
  if (name === "--dump-header") {
    const v = valueOf();
    if (v !== undefined && v !== "/dev/null" && v !== "-") r.targets.push(v);
    return;
  }
  if (name === "--cookie-jar") {
    const v = valueOf();
    if (v !== undefined && v !== "/dev/null" && v !== "-") r.targets.push(v);
    return;
  }
  if (name === "--trace" || name === "--trace-ascii") {
    const v = valueOf();
    if (v !== undefined && v !== "/dev/null" && v !== "-") r.targets.push(v);
    return;
  }
  if (name === "--output-dir") {
    const v = valueOf();
    if (v !== undefined && v !== "/dev/null") od.dir = v; // `-` 不豁免：不是目录选项的 stdout 约定
    return;
  }
  if (CURL_HARMLESS_LONG.has(name.slice(2))) return; // 无害长选项
  if (CURL_META_STR.has(name.slice(2))) {
    valueOf(); // 纯字符串元数据，忽略
    return;
  }
  if (CURL_META_FILE.has(name.slice(2))) {
    const v = valueOf();
    if (v !== undefined && v !== "/dev/null") r.fileRefs.push(v);
    return;
  }
  if (name === "--cookie") {
    const v = valueOf();
    if (v !== undefined && !v.includes("=") && v !== "/dev/null") r.fileRefs.push(v);
    return;
  }
  r.unknown = true;
}

/** 解析 curl 参数（F2）：发送/目标/文件引用/未知/缺值一次扫出。 */
function parseCurlArgs(args: string[]): FetchParse {
  const r: FetchParse = { send: false, targets: [], fileRefs: [], unknown: false, missing: false };
  // -o/-O 系目标与其它写目标分开记：--output-dir 出现时前者整体被 dir 替代（v8 P2-2）
  const od: CurlOutputState = { o: [], dir: undefined };
  const i = { idx: -1 };
  // `--` 之后全为操作数（URL/文件名），不再解析选项
  let operandsOnly = false;
  for (i.idx = 0; i.idx < args.length; i.idx++) {
    const a = args[i.idx]!;
    if (operandsOnly || !a.startsWith("-") || a === "-") continue; // URL 与裸 `-`（stdin 约定）忽略
    if (a === "--") {
      operandsOnly = true;
      continue;
    }
    if (a.startsWith("--")) parseCurlLong(a, args, i, r, od);
    else parseCurlShort(a, args, i, r, od);
    if (r.unknown) return r; // 未知即早返（fail-closed 方向）
  }
  // 合成写目标：--output-dir 出现时 -o/-O 系整体被 dir 替代
  r.targets = od.dir !== undefined ? [od.dir, ...r.targets] : [...od.o, ...r.targets];
  return r;
}

/** 解析 wget 参数（F3）：目标封闭枚举 + 未知/缺值早返 X；不处理短选项捆绑。 */
function parseWgetArgs(args: string[]): FetchParse {
  const r: FetchParse = { send: false, targets: [], fileRefs: [], unknown: false, missing: false };
  let hadOutputOpt = false;
  let queryOnly = false;
  let bare = 0;
  const i = { idx: -1 };
  let operandsOnly = false;
  const pushTarget = (v: string | undefined) => {
    if (v === undefined) return;
    hadOutputOpt = true;
    if (v !== "/dev/null" && v !== "-") r.targets.push(v);
  };
  for (i.idx = 0; i.idx < args.length; i.idx++) {
    const a = args[i.idx]!;
    if (operandsOnly || !a.startsWith("-") || a === "-") {
      if (a !== "-") bare++;
      continue;
    }
    if (a === "--") {
      operandsOnly = true;
      continue;
    }
    if (!a.startsWith("--")) {
      // 短选项：getopt 语义（-O/-o/-P/-a 必带值，exact consume 或粘连附着）
      if (a === "-O") {
        pushTarget(takeFetchValue(args, i, r)); // -O file：- 取 stdout（豁免→R）
        continue;
      }
      if (a.startsWith("-O")) {
        pushTarget(a.slice(2)); // -OVALUE 粘连（含 -O- → 豁免）
        continue;
      }
      let handled = false;
      for (const flag of ["-o", "-P", "-a"]) {
        if (a === flag) {
          pushTarget(takeFetchValue(args, i, r));
          handled = true;
          break;
        }
        if (a.startsWith(flag)) {
          const rest = a.slice(flag.length);
          pushTarget(rest.startsWith("=") ? rest.slice(1) : rest); // -o/-P/-aVALUE 粘连（含 -o=FILE 形态）
          handled = true;
          break;
        }
      }
      if (handled) continue;
      // 其余 `^-[^-][^-]+$`（如 -qO-）一律捆绑整段 X；未知短选项亦 X
      r.unknown = true;
      return r;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    const valueOf = (): string | undefined => (inline !== undefined ? inline : takeFetchValue(args, i, r));
    if (name === "--spider" || name === "--help" || name === "--version") {
      queryOnly = true;
      continue;
    }
    if (name === "--output-document") {
      pushTarget(valueOf());
      continue;
    }
    if (name === "-o" || name === "--output-file") {
      pushTarget(valueOf());
      continue;
    }
    if (name === "-P" || name === "--directory-prefix") {
      pushTarget(valueOf());
      continue;
    }
    if (name === "-a" || name === "--append-output") {
      pushTarget(valueOf());
      continue;
    }
    r.unknown = true;
    return r;
  }
  if (!r.unknown && !r.missing && r.targets.length === 0 && bare > 0 && !queryOnly && !hadOutputOpt) {
    r.targets.push("."); // 默认落盘语义（`wget URL`）
  }
  return r;
}

/** 命令段效果分类：R/W/X 三档 + 危险叠加。
 * 判定轴是「副作用能否从参数完整推导」而非程序名认识与否；未识别程序一律 X（fail-closed）。
 * 前缀已在 parseBashCommand 中剥离，此处看到的是真实程序。 */
export function classifySegment(segment: BashSegment, config: PermissionConfig): SegmentClassification {
  const { program } = segment;
  const id = program === "git" && segment.gitSubcommand ? `git:${segment.gitSubcommand}` : program;

  // ---- 空段：纯重定向（如 `> foo`）效果为截断/创建且可枚举 → W；裸赋值无文件副作用 → R ----
  if (program === "") {
    const writes = collectWriteTargets(segment);
    return { tier: writes.length > 0 ? "W" : "R", danger: false, id: "" };
  }

  // ---- 危险叠加 ----
  let danger = false;
  if (segment.wrapper) {
    return { tier: "X", danger: true, id };
  }
  if (program === "git") {
    const sub = segment.gitSubcommand;
    // 裸 git：交互式，不可证 → X
    if (!sub) return { tier: "X", danger: false, id };
    // 危险清单命中的子命令：只读形态豁免叠加，否则叠加 + X
    if (config.dangerousBashCommands.includes(`git ${sub}`)) {
      const danger = !isGitReadonlyForm(segment, sub);
      return { tier: danger ? "X" : "R", danger, id };
    }
    // 未识别子命令不再假定只读（X）；已知只读子命令 → R
    if (!GIT_READONLY_SUBS.has(sub)) return { tier: "X", danger: false, id };
    return { tier: "R", danger: false, id };
  }
  if (program === "rm") {
    const { before: flags } = splitDashDash(segment.args);
    const recursive = flags.some((a) =>
      a === "--recursive" || a.startsWith("--recursive=") ||
      (/^-[^-]+$/.test(a) && /[rR]/.test(a)),
    ); // 短 flag 束含 r/R；`--force` 等长选项天然排除
    const targets = collectWriteTargets(segment);
    if (recursive || targets.some((t) => /[*?]/.test(t))) return { tier: "X", danger: true, id };
    // 其余落正常 W 链（rm ∈ WRITE_ALL_ARGS）
  } else if (
    (program === "chmod" || program === "chown" || program === "chgrp") &&
    segment.args.some((a) => a.startsWith("-") && (a.includes("R") || a === "--recursive"))
  ) {
    return { tier: "X", danger: true, id };
  }
  if (config.dangerousBashCommands.includes(program)) return { tier: "X", danger: true, id };

  // ---- curl/wget 按方法与目标分（F2/F3）：解析器为单一可信源 ----
  if (program === "curl") {
    const fetched = parseCurlArgs(segment.args);
    if (fetched.unknown || fetched.missing || fetched.send) return { tier: "X", danger: true, id };
    return { tier: fetched.targets.length > 0 ? "W" : "R", danger: false, id };
  }
  if (program === "wget") {
    const fetched = parseWgetArgs(segment.args);
    if (fetched.unknown || fetched.missing) return { tier: "X", danger: true, id };
    return { tier: fetched.targets.length > 0 ? "W" : "R", danger: false, id };
  }

  // ---- 档位判定 ----
  // 有界写者注册表（W 种子）：tar 移出（解压目标不可枚举）；sed 特殊（仅 -i 升 W）
  const writeTargets = collectWriteTargets(segment);
  let tier: SegmentTier;
  if (WRITE_LAST_ARG.has(program) || (WRITE_ALL_ARGS.has(program) && program !== "tar")) {
    tier = "W";
  } else if (program === "sed" && segment.args.some((a) => SED_IN_PLACE.test(a))) {
    tier = "W";
  } else if (config.readonlyBashCommands.includes(program)) {
    // 读种子 + 写动作扫描（重定向/sort -o/find 写 flag）→ 升级 W；否则保持 R
    tier = writeTargets.length > 0 ? "W" : "R";
  } else {
    return { tier: "X", danger: false, id };
  }
  // W 目标含 glob（* ?）→ 无法穷举 → 降级 X（保守：plan 落⑤ ask，build 域内仍③放行）
  if (tier === "W" && writeTargets.some((t) => /[*?]/.test(t))) tier = "X";
  return { tier, danger: false, id };
}

/** 命中危险清单的 git 子命令中，仅列表演示的形态仍视为只读（避免误伤 git branch/stash list/remote -v）。 */
function isGitReadonlyForm(segment: BashSegment, sub: string): boolean {
  if (sub === "branch" || sub === "tag") {
    // 带位置参数 = 创建/删除/移动分支或标签 → 写；仅列表演示 → 只读
    return !segment.gitArgs.some((a) => !a.startsWith("-"));
  }
  if (sub === "stash") {
    const first = segment.gitArgs[0];
    return first === "list" || first === "show";
  }
  if (sub === "config") {
    // 只读形态：--list/--get/--get-all/--show-origin 等；`git config <key> <value>` 为写
    return segment.gitArgs.some((a) =>
      a === "--list" || a === "--get" || a === "--get-all" || a === "--show-origin" ||
      a === "--show-scope" || a === "--name-only" || a.startsWith("--get-"),
    );
  }
  if (sub === "remote") {
    const positional = segment.gitArgs.find((a) => !a.startsWith("-"));
    return positional !== "add" && positional !== "set-url" && positional !== "remove" && positional !== "rename";
  }
  return false;
}

/** 管道到 shell 检测：`curl ... | sh` / `wget ... | bash`（FR-4）。 */
export function hasPipeToShell(segments: readonly BashSegment[]): boolean {
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1]!;
    if ((seg.program === "curl" || seg.program === "wget") && next.prevOp === "|") {
      if (WRAPPER_SHELLS.has(next.program)) return true;
    }
  }
  return false;
}

/** 带值选项（后一 token 为其值，不视为路径）。 */
const OPTIONS_WITH_VALUE = new Set([
  "-e", "-f", "-E", "-F", "-I", "-L", "-P", "-o", "-w", "-c", "-C",
  "--include", "--exclude", "--glob", "--max-depth", "--jobs", "--timeout", "--color", "--regexp", "--file",
]);

/** 读取型路径引用：命令参数中会被当作文件访问的 token（含重定向输入目标）。 */
export function collectReadRefs(segment: BashSegment): string[] {
  const refs: string[] = [];
  for (const r of segment.redirects) {
    // 仅 `<` 输入重定向是读取；其余重定向是写入
    // `< /dev/null` 为惯用写法（丢弃 stdin），无副作用，不视为外部读引用
    if (r.op === "<" && r.target !== "/dev/null") refs.push(r.target);
  }
  if (segment.program === "echo" || segment.program === "printf" || segment.program === "git") {
    return refs;
  }
  // curl/wget：仅文件型元数据值参与读引用（敏感扫描用）；URL/纯字符串元数据不视为文件
  if (segment.program === "curl") {
    refs.push(...parseCurlArgs(segment.args).fileRefs);
    return refs;
  }
  const isGrepLike = segment.program === "grep" || segment.program === "rg" || segment.program === "sed";
  // 模式已通过 -e/-E/-f/-F 显式给出时，首个位置参数即为路径而非 pattern
  const patternViaOption = isGrepLike && segment.args.some((a) => a === "-e" || a === "-E" || a === "-f" || a === "-F");
  let skipFirst = isGrepLike && !patternViaOption;
  for (let i = 0; i < segment.args.length; i++) {
    const a = segment.args[i]!;
    if (a.startsWith("-")) {
      if (OPTIONS_WITH_VALUE.has(a) && i + 1 < segment.args.length) i++;
      continue;
    }
    if (skipFirst) {
      skipFirst = false;
      continue;
    }
    // 读取 /dev/null 无副作用（如 `tee /dev/null` 的写位置、`cat /dev/null`），豁免外部读判定
    if (a === "/dev/null") continue;
    refs.push(a);
  }
  return refs;
}

/** 重定向目标是否为无副作用目标（不作为写入目标）：
 * - `/dev/null`：空设备，写入无副作用（`> /dev/null`、`2>/dev/null` 均为惯用写法）
 * - `&N`（如 `&1`、`&2`）：fd 复制（`2>&1`、`>&2`），非文件路径
 */
function isHarmlessRedirectTarget(target: string): boolean {
  return target === "/dev/null" || target.startsWith("&");
}

/** 内置写命令（硬编码，不可配置）：位置参数视为写入目标，用于区分读写语义与外部写判定。
 * tar 已移出（解压目标由包内容决定不可枚举，归 X）；sed 特殊处理（仅 -i 原位写入，含 -i.bak 后缀变体）。 */
const WRITE_LAST_ARG = new Set(["cp", "mv", "ln", "install", "scp", "rsync"]);
const WRITE_ALL_ARGS = new Set([
  "mkdir", "rmdir", "touch", "rm", "tee", "truncate", "unlink", "shred",
  "chmod", "chown", "chgrp", "chattr", "dd",
  "gzip", "gunzip", "bzip2", "xz", "zstd", "zip", "unzip",
]);

/** `--` 切分：之后全部视为位置参数（含 `-` 开头的文件名），`--` 自身丢弃（P0-3 全程序通用）。 */
function splitDashDash(args: string[]): { before: string[]; after: string[] } {
  const idx = args.indexOf("--");
  return idx === -1 ? { before: args, after: [] } : { before: args.slice(0, idx), after: args.slice(idx + 1) };
}

/** 提取段内的写入目标：
 * 1. 重定向输出目标（`>`/`>>`/`2>` 等）；
 * 2. 内置写命令的位置参数——cp/mv/ln/install/scp/rsync 取末位（源文件是读取），其余取全部位置参数。
 * 这样 `mv a /outside/` 按「写外部」判定（而非误入 read 白名单语义）。
 */
export function collectWriteTargets(segment: BashSegment): string[] {
  const targets: string[] = [];
  for (const r of segment.redirects) {
    // 输出重定向（> >> 2> &> 等）→ 写入目标；纯输入 < 除外
    // `2>/dev/null` 等 fd 重定向到空设备/&N 不产生文件副作用，豁免
    if (r.op !== "<" && !isHarmlessRedirectTarget(r.target)) targets.push(r.target);
  }
  // curl/wget 选项目标（F2/F3，解析器已按豁免过滤）
  if (segment.program === "curl") {
    targets.push(...parseCurlArgs(segment.args).targets);
    return targets;
  }
  if (segment.program === "wget") {
    targets.push(...parseWgetArgs(segment.args).targets);
    return targets;
  }
  // find 写动作（-delete/-fls/-fprint*）：目标 = 起始路径；省略时 GNU find 默认从 . 递归删除。
  // 起始路径识别需跳过带值选项的值（如 -name '*.tmp' 的模式不是起始路径）
  if (segment.program === "find" && segment.args.some((a) => FIND_WRITE_FLAGS.has(a))) {
    const FIND_OPTION_WITH_VALUE = new Set([
      "-name", "-iname", "-lname", "-ilname", "-path", "-wholename", "-regex", "-iregex",
      "-newer", "-anewer", "-cnewer", "-size", "-user", "-group", "-uid", "-gid",
      "-mtime", "-atime", "-ctime", "-mmin", "-amin", "-cmin", "-maxdepth", "-mindepth",
      "-type", "-perm", "-context", "-fstype", "-used", "-samefile", "-inum", "-links",
    ]);
    let start: string | undefined;
    let seenDD = false;
    for (let i = 0; i < segment.args.length; i++) {
      const a = segment.args[i]!;
      if (a === "--") {
        seenDD = true;
        continue;
      }
      if (FIND_WRITE_FLAGS.has(a)) break; // 起始路径只会出现在写 flag 之前
      if (!seenDD && a.startsWith("-")) {
        if (FIND_OPTION_WITH_VALUE.has(a) && i + 1 < segment.args.length) i++;
        continue;
      }
      start = a;
      break;
    }
    targets.push(start ?? ".");
    return targets;
  }
  // sort -o <file>：输出目标可枚举（短选项分立/连写、长选项 =赋值与分立两种形态）
  if (segment.program === "sort") {
    for (let i = 0; i < segment.args.length; i++) {
      const a = segment.args[i]!;
      if (a === "-o" && i + 1 < segment.args.length) targets.push(segment.args[i + 1]!);
      else if (a.startsWith("-o") && a.length > 2) targets.push(a.slice(2));
      else if (a === "--output" && i + 1 < segment.args.length) targets.push(segment.args[i + 1]!);
      else if (a.startsWith("--output=" )) targets.push(a.slice("--output=".length));
    }
  }
  // sed 仅在 -i（含 -i.bak 变体）时原位写入；chmod/chown/chgrp 首位是 mode/owner
  const sedInPlace = segment.program === "sed" && segment.args.some((a) => SED_IN_PLACE.test(a));
  if (WRITE_LAST_ARG.has(segment.program)) {
    const { before, after } = splitDashDash(segment.args);
    const positionals = [...before.filter((a) => !a.startsWith("-")), ...after];
    if (positionals.length > 0) targets.push(positionals[positionals.length - 1]!);
    return targets;
  }
  if (sedInPlace) {
    // sed 原位写：跳过脚本表达式（首个非 flag 位置参数），其余为被编辑文件
    const { before, after } = splitDashDash(segment.args);
    const files = [...before.filter((a) => !a.startsWith("-")).slice(1), ...after];
    targets.push(...files);
    return targets;
  }
  if (WRITE_ALL_ARGS.has(segment.program)) {
    const { before, after } = splitDashDash(segment.args);
    let skipFirst = segment.program === "chmod" || segment.program === "chown" || segment.program === "chgrp";
    for (const a of before) {
      if (a.startsWith("-")) continue;
      if (skipFirst) {
        skipFirst = false;
        continue;
      }
      // /dev/null 无副作用（如 `tee /dev/null` 丢弃输出），豁免
      if (a === "/dev/null") continue;
      targets.push(a);
    }
    targets.push(...after);
    return targets;
  }
  return targets;
}