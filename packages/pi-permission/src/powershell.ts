/**
 * PowerShell 命令解析与效果分类（与 src/bash.ts 同构的自研简化解析器，零依赖）。
 *
 * 设计要点（与 bash 管线对齐）：
 * - 解析产物复用 bash.ts 的 ParsedCommand/BashSegment 形状，决策层零改动即可复用；
 * - 别名归一化：gci/cat/rm 等别名统一映射为规范 cmdlet 名（小写），分类查表只看规范名；
 * - 效果三档 R/W/X 与危险叠加语义与 bash 完全一致，未知形态一律 X（fail-closed）；
 * - 无法静态验证的语法（$(...) 子表达式、裸 (...) 分组、here-string、@splatting）映射到
 *   ParsedCommand 的复杂度标记，由决策层统一走 FR-7 fail-closed；
 * - 原生 exe（git/node/npm 等）回退复用 bash 的注册表与 git 子命令逻辑——同一程序跨 shell 行为一致；
 * - 二义性命令保守处理：pwsh 7 有真 curl.exe 而 PS 5.1 里 curl 是 Invoke-WebRequest 别名，
 *   故 curl/wget 不做精确分类（一律 X），管道到 shell 由 hasPipeToShellPs 兜底。
 */
import os from "node:os";
import path from "node:path";
import type { PermissionConfig } from "./config.ts";
import {
  classifySegment as classifyBashSegment,
  collectReadRefs as collectBashReadRefs,
  extractGit,
  type BashSegment,
  type ParsedCommand,
  type SegmentClassification,
  type SegmentTier,
} from "./bash.ts";
import { expandHome, realpathDeep, resolveCwdTarget } from "./path.ts";

/** 规范化后的程序名集合：视为切换工作目录的命令（供决策层跟踪段间 cwd）。
 * push-location 有参时切目录、无参仅入栈；pop-location 弹栈目标不可静态跟踪。 */
export const PS_CD_PROGRAMS: ReadonlySet<string> = new Set(["cd", "chdir", "sl", "set-location", "push-location", "pop-location"]);

/** 别名 → 规范名映射表（小写）。仅收录无二义性的常见别名。 */
const ALIASES: Record<string, string> = {
  // 目录/位置
  "gci": "get-childitem",
  "ls": "get-childitem",
  "dir": "get-childitem",
  "gi": "get-item",
  "gl": "get-location",
  "pwd": "get-location",
  "cd": "cd",
  "chdir": "cd",
  "sl": "cd",
  "pushd": "push-location",
  "popd": "pop-location",
  // 内容读取
  "gc": "get-content",
  "cat": "get-content",
  "type": "get-content",
  // 对象/信息查询
  "gps": "get-process",
  "ps": "get-process",
  "gsv": "get-service",
  "gcm": "get-command",
  "gm": "get-member",
  "gp": "get-itemproperty",
  "gv": "get-variable",
  "gal": "get-alias",
  "gdr": "get-psdrive",
  "gwmi": "get-wmiobject",
  "gu": "get-unique",
  // 文本过滤/排序/格式化
  "sls": "select-string",
  "select": "select-object",
  "where": "where-object",
  "?": "where-object",
  "foreach": "foreach-object",
  "%": "foreach-object",
  "sort": "sort-object",
  "group": "group-object",
  "measure": "measure-object",
  "compare": "compare-object",
  "diff": "compare-object",
  "ft": "format-table",
  "fl": "format-list",
  "fw": "format-wide",
  "fx": "format-custom",
  // 输出
  "echo": "write-output",
  "write": "write-output",
  "cls": "clear-host",
  "clear": "clear-host",
  "oh": "out-host",
  "tee": "tee-object",
  // 文档
  "man": "get-help",
  "help": "get-help",
  // 时间
  "sleep": "start-sleep",
  // 写操作族
  "ri": "remove-item",
  "rm": "remove-item",
  "del": "remove-item",
  "erase": "remove-item",
  "rd": "remove-item",
  "rmdir": "remove-item",
  "ni": "new-item",
  "mkdir": "new-item",
  "md": "new-item",
  "mi": "move-item",
  "mv": "move-item",
  "move": "move-item",
  "cpi": "copy-item",
  "cp": "copy-item",
  "copy": "copy-item",
  "rni": "rename-item",
  "ren": "rename-item",
  "si": "set-item",
  "spi": "set-itemproperty",
  "sp": "set-itemproperty",
  "ac": "add-content",
  "clc": "clear-content",
  "cli": "clear-item",
  // 进程控制
  "saps": "start-process",
  "start": "start-process",
  "spps": "stop-process",
  "kill": "stop-process",
  // 启动器
  "ii": "invoke-item",
};

/**
 * 固定危险命令（不可配置，镜像 bash 的固定哲学）：
 * - iex/Invoke-Expression：任意代码执行；
 * - icm/Invoke-Command：任意脚本块/远程执行；
 * - Set-ExecutionPolicy：破坏安全边界本身（工具已以 -ExecutionPolicy Bypass 启动，改策略只会更糟）；
 * - sc：二义性（PS 5.1 中是 Set-Content 别名，但 sc.exe 是服务控制器）——按更危险的 sc.exe 处理。
 */
const FIXED_DANGEROUS_PS: ReadonlySet<string> = new Set([
  "invoke-expression", "iex", "invoke-command", "icm", "set-executionpolicy", "sc",
]);

/** 嵌套 shell 解释器：任何形态的调用都不可验证（-Command/-File/-EncodedCommand/交互式）。 */
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set(["powershell", "pwsh"]);

/** 内置写命令注册表：末位位置参数为写目标（cp/mv 语义）。 */
const WRITE_LAST_ARG_PS: ReadonlySet<string> = new Set([
  "copy-item", "move-item", "rename-item", "compress-archive", "expand-archive",
]);

/** 内置写命令注册表：首个位置参数为写目标（内容型 cmdlet：路径在前、值在后）。 */
const WRITE_PATH_FIRST_PS: ReadonlySet<string> = new Set([
  "set-content", "add-content", "out-file", "tee-object", "set-itemproperty", "set-item",
]);

/** 内置写命令注册表：全部位置参数为写目标（创建/删除语义）。 */
const WRITE_ALL_ARGS_PS: ReadonlySet<string> = new Set([
  "new-item", "remove-item", "mklink",
]);

/** 导出类 cmdlet：目标文件由命名参数（-Path/-FilePath 等）或首个位置参数给出。 */
const WRITE_EXPORT_PS: ReadonlySet<string> = new Set([
  "export-csv", "export-clixml", "export-formatdata", "export-counter", "export-modulemember",
]);

/** 无路径参数的对象管道 cmdlet：位置参数是属性名/表达式而非路径，不参与读写引用收集。 */
const NO_PATH_ARGS_PS: ReadonlySet<string> = new Set([
  "where-object", "foreach-object", "sort-object", "group-object", "measure-object",
  "compare-object", "select-object", "format-table", "format-list", "format-wide",
  "format-custom", "convertto-json", "convertto-csv", "convertto-html", "convertto-xml",
  "convertfrom-json", "convertfrom-csv", "out-null", "out-host", "out-default",
  "out-string", "write-output", "write-host", "write-warning", "write-error",
  "write-verbose", "write-debug", "write-information", "write-progress", "start-sleep",
  "get-random", "get-date", "get-culture", "get-uiculture", "get-host", "get-verb",
  "get-help", "get-command", "get-process", "get-service", "get-member", "get-variable",
  "get-alias", "measure-command", "clear-host", "push-location", "pop-location", "exit",
]);

/** 已知以路径为位置参数的只读 cmdlet：位置参数无条件视为读引用。 */
const PATH_READER_PS: ReadonlySet<string> = new Set([
  "get-content", "get-item", "get-childitem", "get-itemproperty", "get-acl",
  "get-filehash", "get-authenticodesignature", "test-path", "resolve-path",
  "join-path", "split-path", "import-csv", "import-clixml", "import-powershelldatafile",
  "get-wmiobject", "format-hex",
]);

/** 值即路径的命名参数（读写两侧通用）。 */
const PATH_VALUE_PARAMS: ReadonlySet<string> = new Set(["-path", "-literalpath", "-pspath"]);
/** 写侧额外收集目标的命名参数。 */
const PATH_VALUE_PARAMS_WRITE: ReadonlySet<string> = new Set([
  ...PATH_VALUE_PARAMS, "-destination", "-destinationpath", "-filepath", "-name", "-newname",
]);
/** 带值的非路径命名参数（消费其值避免污染位置参数判定）。 */
const OTHER_VALUE_PARAMS: ReadonlySet<string> = new Set([
  "-pattern", "-filter", "-include", "-exclude", "-value", "-inputobject", "-name",
  "-query", "-computername", "-credential", "-argumentlist", "-membername",
  "-propertyname", "-typename", "-title", "-subject", "-body", "-encoding", "-separator",
  "-simplematch", "-casesensitive", "-totalcount", "-endindex", "-startindex",
]);

/** 判定是否为 cmdlet 形态的名字（Verb-Noun，名词段可含连字符）；原生 exe 走 bash 回退逻辑。 */
function isCmdletish(program: string): boolean {
  return /^[a-z]+-[a-z][a-z0-9-]*$/.test(program);
}

/** 配置清单匹配（大小写不敏感 + 接受别名写法）：
 * PowerShell 命令名本身不区分大小写，解析器已把程序名归一化为小写规范名；
 * 用户配置条目同样做小写归一化并先过别名表（如配置里写 "Get-Content" 或 "gc" 都能命中）。 */
function listHasNormalized(list: readonly string[], program: string): boolean {
  return list.some((entry) => {
    const lower = entry.toLowerCase();
    return lower === program || ALIASES[lower] === program;
  });
}

/** token 是否形似路径（含分隔符/盘符/~/$env/带扩展名的短词）。用于过滤值类字符串误判。 */
function looksLikePath(token: string): boolean {
  if (/[\\/]/.test(token)) return true;
  if (token === "." || token === ".." || token.startsWith("~")) return true;
  if (/^[A-Za-z]:/.test(token)) return true;
  if (token.toLowerCase().startsWith("$env:") || token.includes("%")) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(token);
}

/** 无副作用的重定向目标：空设备与 fd 复制（2>&1）/自动变量 $null。 */
function isHarmlessRedirectTargetPs(target: string): boolean {
  const lower = target.toLowerCase();
  return lower === "nul" || lower === "$null" || lower === "null" || target.startsWith("&");
}

// ---------------------------------------------------------------------------
// 顶层切分
// ---------------------------------------------------------------------------

interface PsSplitResult {
  segments: string[];
  /** 每段前的连接操作符（segments[i] 的前驱 op 为 ops[i-1]）。 */
  ops: string[];
  hasSubExpression: boolean;
  hasGrouping: boolean;
  hasSplatting: boolean;
  parseError: boolean;
}

/** 顶层切分：感知引号/反引号/here-string，按 `&&`/`||`/`;`/`|`/`&`/换行 分段并标记复杂语法。 */
function splitTopLevelPs(command: string): PsSplitResult {
  const segments: string[] = [];
  const ops: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let parenDepth = 0;
  let hereMarker = ""; // 非空表示正在扫描 here-string，值为闭合标记（"@ 或 '@）
  let hasSubExpression = false;
  let hasGrouping = false;
  let hasSplatting = false;
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

    // here-string 扫描：逐字符找行首闭合标记（"@ / '@）
    if (hereMarker !== "") {
      current += ch;
      i++;
      continue;
    }

    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === "`") {
      // 反引号转义：行继续符直接跳过；其余转义把下一字符并入当前词（i`ex → iex）
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next !== undefined) {
        current += next;
        i += 2;
        continue;
      }
      parseError = true;
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      current += ch;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "$" && next === "(") hasSubExpression = true;
      current += ch;
      i++;
      continue;
    }

    if (ch === "'") {
      // here-string 开头：'@ 后随换行。内容整体吞掉不分析——here-string 内容不可静态
      // 验证，进入后 until EOF 会置 parseError → FR-7 fail-closed（保守方向，见下方扫描分支）
      if (next === "@" && (command[i + 2] === "\n" || (command[i + 2] === "\r" && command[i + 3] === "\n"))) {
        hereMarker = "'@";
        current += ch;
        i++;
        continue;
      }
      inSingle = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      // 同上："@ 开头的 expandable here-string，整体 fail-closed
      if (next === "@" && (command[i + 2] === "\n" || (command[i + 2] === "\r" && command[i + 3] === "\n"))) {
        hereMarker = "\"@";
        current += ch;
        i++;
        continue;
      }
      inDouble = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "@" && next === "{") {
      // 字面哈希表 @{...}：花括号由 wrapper 检测兜底
      current += "{";
      i += 2;
      continue;
    }
    if (ch === "@" && next !== undefined && !/\s/.test(next) && next !== "(") {
      // @splattting：展开内容不可枚举 → 保守标记
      hasSplatting = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "$" && next === "(") {
      hasSubExpression = true;
      parenDepth++;
      current += ch;
      i += 2;
      continue;
    }
    if (ch === "(") {
      if (parenDepth === 0) hasGrouping = true;
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
    if (ch === "<") {
      // '<' 在 PowerShell 中保留未用，出现即语法错误（不会执行任何东西）
      parseError = true;
      i++;
      continue;
    }

    if (ch === "&") {
      const prev = command[i - 1];
      // 流合并重定向（2>&1、*>&1）中的 & 属于重定向目标，不是操作符
      if (prev === ">") {
        current += ch;
        i++;
        continue;
      }
      if (next === "&") {
        flush("&&");
        i += 2;
        continue;
      }
      // 单个 &：语句起始位置（当前段为空）是调用操作符，保留在段内由
      // stripStatementPrefix 识别；已完成语句之后的 & 是后台作业标记，作为段分隔符。
      // 若不切分，「Get-Date & Remove-Item x」会把第二条语句吞进前段参数而漏检（review M2）。
      if (current.trim() !== "") {
        flush("&");
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    if (parenDepth === 0) {
      const twoChar = command.slice(i, i + 2);
      if (twoChar === "&&" || twoChar === "||") {
        flush(twoChar);
        i += 2;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") {
        flush(ch === "\r" ? "\n" : ch);
        i++;
        continue;
      }
    }
    current += ch;
    i++;
  }

  if (inSingle || inDouble || parenDepth !== 0 || hereMarker !== "") parseError = true;
  flush("\n");
  return { segments, ops, hasSubExpression, hasGrouping, hasSplatting, parseError };
}

// ---------------------------------------------------------------------------
// 单段 token 化
// ---------------------------------------------------------------------------

/** PS 重定向操作符（长操作符优先匹配）。 */
const REDIRECT_OPS_PS = ["2>>", "3>>", "4>>", "5>>", "6>>", "*>>", ">>", "2>", "3>", "4>", "5>", "6>", "*>", ">"];

function isRedirectStartPs(raw: string, index: number): boolean {
  return REDIRECT_OPS_PS.some((o) => raw.startsWith(o, index));
}

/** 单段 token 化：引号/反引号感知，抽取重定向目标。 */
function tokenizeSegmentPs(raw: string): { tokens: string[]; redirects: RedirectPs[]; error: boolean; braces: boolean } {
  const tokens: string[] = [];
  const redirects: RedirectPs[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let error = false;
  let braces = false; // 引号外的 {/}（脚本块/哈希表字面量标记，引号内的属普通文本）

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
      j++;
      return { target, end: j };
    }
    let target = "";
    while (j < raw.length && !/\s/.test(raw[j]!) && !isRedirectStartPs(raw, j)) {
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
    if (ch === "`") {
      if (nextIsContinuation(raw, i)) {
        i += 2;
        continue;
      }
      if (i + 1 < raw.length) {
        current += raw[i + 1]!;
        i += 2;
        continue;
      }
      error = true;
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
    if (ch === "<") {
      // 保留操作符，PS 中必然报错
      error = true;
      i++;
      continue;
    }
    const rest = raw.slice(i);
    if (ch === "{" || ch === "}") {
      braces = true;
      current += ch;
      i++;
      continue;
    }
    const op = REDIRECT_OPS_PS.find((o) => rest.startsWith(o));
    if (op) {
      pushToken();
      const { target, end } = readTarget(i + op.length);
      if (target !== "") redirects.push({ op, target });
      i = end;
      continue;
    }
    current += ch;
    i++;
  }

  if (inSingle || inDouble) error = true;
  pushToken();
  return { tokens, redirects, error, braces };
}

/** 反引号后是否紧跟换行（行继续符，容忍 \r\n）。 */
function nextIsContinuation(raw: string, index: number): boolean {
  const next = raw[index + 1];
  if (next === "\n") return true;
  if (next === "\r" && raw[index + 2] === "\n") return true;
  return false;
}

/** PS 重定向（与 bash Redirect 同构；'< ' 在 PS 中不存在）。 */
export interface RedirectPs {
  op: string;
  target: string;
}

// ---------------------------------------------------------------------------
// 段构建
// ---------------------------------------------------------------------------

/** 剥离赋值前缀（$x = ...）、调用操作符（&）、点源（. ./x.ps1），返回真实程序与参数。 */
function stripStatementPrefix(tokens: string[]): { program: string; args: string[]; dynamicCall: boolean } {
  const t = [...tokens];
  let dynamicCall = false;

  // 赋值前缀：$var = ... / $var=...
  while (t.length > 0) {
    if (t.length >= 2 && t[0]!.startsWith("$") && t[1] === "=") {
      t.splice(0, 2);
      continue;
    }
    if (/^\$[A-Za-z_][A-Za-z0-9_]*=./.test(t[0]!)) {
      t.shift();
      continue;
    }
    break;
  }

  // 点源：. ./script.ps1 —— 直接执行脚本文件，效果不可验证
  if (t[0] === "." && t.length > 1) {
    dynamicCall = true;
    t.shift();
  }
  // 调用操作符：& $var / & './x.ps1' —— 目标动态，不可验证
  if (t[0] === "&" && t.length > 1) {
    dynamicCall = true;
    t.shift();
  }

  if (t.length === 0) {
    return { program: "", args: [], dynamicCall };
  }
  const head = t[0]!;
  return { program: normalizeProgram(head), args: t.slice(1), dynamicCall };
}

/** 程序名规范化：剥路径取 basename、去扩展名（.exe/.cmd/.bat/.com/.ps1）、别名归一化、小写。 */
export function normalizeProgram(head: string): string {
  const base = head.replace(/^.*[\\/]/, "");
  const stem = base.replace(/\.(exe|cmd|bat|com|ps1)$/i, "").toLowerCase();
  return ALIASES[stem] ?? stem;
}

/** 参数中的 $env:VAR 展开（无法解析时保留原文，后续按外部路径保守处理）。 */
function expandEnvRef(token: string): string {
  return token.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => process.env[name] ?? `$env:${name}`);
}

/** 解析 PowerShell 命令为顶层命令段结构。产物形状与 parseBashCommand 一致。 */
export function parsePowerShellCommand(command: string): ParsedCommand {
  const top = splitTopLevelPs(command);
  const segments: BashSegment[] = [];

  top.segments.forEach((raw, idx) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const { tokens, redirects, error, braces } = tokenizeSegmentPs(trimmed);
    if (error) top.parseError = true;
    // 先剥语句前缀（段首 & 调用操作符在此识别），再丢弃剩余的独立后台操作符 token
    const stripped = stripStatementPrefix(tokens);
    const args = stripped.args.filter((t) => t !== "&");

    const git = stripped.program === "git" ? extractGit([stripped.program, ...stripped.args]) : undefined;
    const segment: BashSegment = {
      raw: trimmed,
      prevOp: idx === 0 ? "" : (top.ops[idx - 1] ?? ""),
      program: stripped.program,
      args: args.map(expandEnvRef),
      redirects: redirects.map(({ op, target }) => ({ op, target: expandEnvRef(target) })),
      gitSubcommand: git?.subcommand,
      gitArgs: git?.gitArgs ?? [],
      wrapper: stripped.dynamicCall || braces || SHELL_INTERPRETERS.has(stripped.program),
    };
    segments.push(segment);
  });

  return {
    segments,
    // 复杂度标记映射到 ParsedCommand 统一槽位，决策层按既有 FR-7 fail-closed 处理：
    // - $() 子表达式（含双引号字符串内的插值子表达式）→ hasCommandSubstitution
    // - 裸 (...) 分组 → hasSubshell
    // - @splattting → hasProcessSubstitution
    hasCommandSubstitution: top.hasSubExpression,
    hasProcessSubstitution: top.hasSplatting,
    hasSubshell: top.hasGrouping,
    parseError: top.parseError,
  };
}

// ---------------------------------------------------------------------------
// 效果分类
// ---------------------------------------------------------------------------

/** Remove-Item 的递归标志（镜像 bash 的 rm 递归危险叠加；裸 `-Force` 走正常链，glob 目标走叠加）。
 * 含 `-r` 短旗标与 `:$true` 绑定形态——保守方向宁可误报。 */
const REMOVE_ITEM_RECURSE_FLAGS = /^-(recurse|r)(:.*)?$/i;

/** 单段效果分类：R/W/X 三档 + 危险叠加。未知 cmdlet 一律 X（fail-closed）；原生 exe 回退 bash 分类。 */
export function classifyPowerShellSegment(
  segment: BashSegment,
  config: PermissionConfig,
): SegmentClassification {
  const { program } = segment;
  const id = program === "git" && segment.gitSubcommand ? `git:${segment.gitSubcommand}` : program;

  // ---- 空段：纯重定向（如 `> foo`）效果可枚举 → W ----
  if (program === "") {
    const writes = collectWriteTargetsPs(segment);
    return { tier: writes.length > 0 ? "W" : "R", danger: false, id: "" };
  }

  // ---- 危险叠加（凌驾档位）----
  // wrapper：嵌套解释器 / 调用操作符 / 点源 / 脚本块（解析期已标记）
  if (segment.wrapper) return { tier: "X", danger: true, id };
  // 固定危险清单（不可配置）
  if (FIXED_DANGEROUS_PS.has(program)) return { tier: "X", danger: true, id };
  // Remove-Item 递归 / glob 目标（镜像 bash rm：裸 -Force 走正常链）
  if (program === "remove-item") {
    const targets = collectWriteTargetsPs(segment);
    const recursive = segment.args.some((a) => REMOVE_ITEM_RECURSE_FLAGS.test(a));
    if (recursive || targets.some((t) => /[*?]/.test(t))) return { tier: "X", danger: true, id };
  }
  // 二义性下载器（curl/wget 在 PS 5.1 是 Invoke-WebRequest 别名、PS 7 是真 exe）→ 不精确分类，X 兜底
  if (program === "curl" || program === "wget") return { tier: "X", danger: false, id };

  // 用户配置的危险清单（PS 命名空间）
  if (listHasNormalized(config.dangerousPowerShellCommands, program)) return { tier: "X", danger: true, id };

  if (isCmdletish(program)) {
    // ---- cmdlet：查内置/配置白名单 ----
    const inWriteRegistry =
      WRITE_LAST_ARG_PS.has(program) ||
      WRITE_PATH_FIRST_PS.has(program) ||
      WRITE_ALL_ARGS_PS.has(program) ||
      WRITE_EXPORT_PS.has(program);
    let tier: SegmentTier;
    if (inWriteRegistry) {
      tier = "W";
    } else if (
      listHasNormalized(config.readonlyPowerShellCommands, program) ||
      NO_PATH_ARGS_PS.has(program) ||
      PATH_READER_PS.has(program)
    ) {
      // 只读种子 + 写动作扫描（输出重定向）→ 升级 W；否则保持 R
      tier = collectWriteTargetsPs(segment).length > 0 ? "W" : "R";
    } else {
      // 未识别 cmdlet：不再假定只读（fail-closed）
      return { tier: "X", danger: false, id };
    }
    // 写目标含通配符 → 无法穷举 → 降级 X（与 bash 一致）
    if (tier === "W" && collectWriteTargetsPs(segment).some((t) => /[*?]/.test(t))) tier = "X";
    return { tier, danger: false, id };
  }

  // ---- 原生 exe（git/node/npm 等）：跨 shell 行为一致，回退 bash 分类 ----
  return classifyBashSegment(segment, config);
}

// ---------------------------------------------------------------------------
// 读引用 / 写目标收集
// ---------------------------------------------------------------------------

/** 收集命名路径参数的值（如 -Path a -Path b 连续多值形态）。 */
function collectNamedPathValues(args: readonly string[], extraParams?: ReadonlySet<string>): { values: string[]; consumed: Set<number> } {
  const values: string[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const lower = a.toLowerCase();
    const paramKey = lower.split(":")[0]!;
    const isPathParam = PATH_VALUE_PARAMS.has(paramKey) || extraParams?.has(paramKey);
    if (!a.toLowerCase().startsWith("-") || !isPathParam) continue;
    consumed.add(i);
    // 冒号绑定形态：-Path:C:\x
    const colonIdx = a.indexOf(":");
    if (colonIdx > 0 && a.length > colonIdx + 1) {
      values.push(a.slice(colonIdx + 1));
      continue;
    }
    // 分立多值：后续非 - 开头的连续 token 都是值
    for (let j = i + 1; j < args.length && !args[j]!.startsWith("-"); j++) {
      values.push(args[j]!);
      consumed.add(j);
      i = j;
    }
  }
  return { values, consumed };
}

/** 提取写入目标：输出重定向 + 写注册表的位置参数/命名路径参数。 */
export function collectWriteTargetsPs(segment: BashSegment): string[] {
  const targets: string[] = [];
  for (const r of segment.redirects) {
    if (!isHarmlessRedirectTargetPs(r.target)) targets.push(r.target);
  }
  const { program } = segment;
  const isWriteShape =
    WRITE_LAST_ARG_PS.has(program) ||
    WRITE_PATH_FIRST_PS.has(program) ||
    WRITE_ALL_ARGS_PS.has(program) ||
    WRITE_EXPORT_PS.has(program);
  if (!isWriteShape) return targets;

  const positionals = segment.args.filter((a) => !a.startsWith("-"));
  if (WRITE_LAST_ARG_PS.has(program)) {
    if (positionals.length > 0) targets.push(positionals[positionals.length - 1]!);
  } else if (WRITE_PATH_FIRST_PS.has(program) || WRITE_EXPORT_PS.has(program)) {
    // 首个位置参数为目标（值在后的内容型 cmdlet）；导出类同理
    if (positionals.length > 0) targets.push(positionals[0]!);
  } else {
    // 全部位置参数都是目标（创建/删除型）
    targets.push(...positionals);
  }
  // 命名路径参数（-Path/-Destination/-FilePath/-Name 等）
  targets.push(...collectNamedPathValues(segment.args, PATH_VALUE_PARAMS_WRITE).values);
  return targets;
}

/** 读取型路径引用收集。 */
export function collectReadRefsPs(segment: BashSegment): string[] {
  const { program } = segment;
  // PS 没有 '<' 输入重定向；纯重定向段无读引用
  if (program === "") return [];

  // 原生 exe：回退 bash 逻辑（含 -o file 这类带值选项启发式）
  if (!isCmdletish(program)) return collectBashReadRefs(segment);

  // 对象管道类：位置参数是属性名/表达式，不收集
  if (NO_PATH_ARGS_PS.has(program)) return [];

  const refs: string[] = [];
  // 命名路径参数（读侧只有 -Path/-LiteralPath/-PSPath）
  refs.push(...collectNamedPathValues(segment.args).values);

  const positionals: string[] = [];
  let skipFirst = false;
  // select-string 首位是 -Pattern；显式给出 -Pattern 时首位即路径
  if (program === "select-string") {
    skipFirst = !segment.args.some((a) => a.toLowerCase() === "-pattern");
  }
  for (let i = 0; i < segment.args.length; i++) {
    const a = segment.args[i]!;
    if (a.startsWith("-")) {
      const lower = a.toLowerCase().split(":")[0]!;
      if (OTHER_VALUE_PARAMS.has(lower) && i + 1 < segment.args.length && !segment.args[i + 1]!.startsWith("-")) {
        i++; // 消费带值选项的值
      }
      continue;
    }
    if (skipFirst) {
      skipFirst = false;
      continue;
    }
    positionals.push(a);
  }
  if (PATH_READER_PS.has(program)) {
    refs.push(...positionals);
  } else {
    // 其余 cmdlet（含未知 X 段）：仅收集形似路径的 token，避免把普通字符串当外部读引用造成弹窗轰炸
    refs.push(...positionals.filter(looksLikePath));
  }
  return refs;
}

/** 管道到 shell 检测（PS 版）：irm/iwr/curl/wget 管道给 iex/powershell/pwsh（FR-4 等价）。 */
export function hasPipeToShellPs(segments: readonly BashSegment[]): boolean {
  const SOURCES = new Set(["curl", "wget", "irm", "invoke-restmethod", "iwr", "invoke-webrequest"]);
  const TARGETS = new Set(["iex", "invoke-expression", "powershell", "pwsh"]);
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1]!;
    if (SOURCES.has(seg.program) && next.prevOp === "|" && TARGETS.has(next.program)) return true;
  }
  return false;
}

/** PowerShell 适配器：接入决策层的通用 shell 核心。 */
export const POWERSHELL_ADAPTER = {
  id: "powershell",
  parse: parsePowerShellCommand,
  classify: classifyPowerShellSegment,
  readRefs: collectReadRefsPs,
  writeTargets: collectWriteTargetsPs,
  pipeToShell: hasPipeToShellPs,
  /** 切目录跟踪（review C1）：push-location 无参仅入栈 cwd 不变；pop-location 弹栈目标
   * 不可静态跟踪 → 返回 undefined（后续相对路径保守按域外处理）。 */
  resolveCwdChange(program: string, args: readonly string[], current: string | undefined): string | undefined {
    if (program === "pop-location") return undefined;
    if (!PS_CD_PROGRAMS.has(program)) return current;
    const positional = args.filter((a: string) => !a.startsWith("-"))[0];
    if (positional === undefined) return program === "push-location" ? current : os.homedir();
    if (positional === "-") return undefined;
    if (current === undefined) return undefined;
    return resolveCwdTarget(positional, current);
  },
} as const;
