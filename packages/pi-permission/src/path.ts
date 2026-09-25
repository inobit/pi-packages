import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 展开 `~` / `~/...` / `$HOME` / `${HOME}` 为 home 绝对路径（PowerShell 用户常写 `~\`，同样展开）。 */
export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  if (p.startsWith("~\\")) return path.join(home, p.slice(2));
  if (p === "$HOME" || p === "${HOME}") return home;
  if (p.startsWith("$HOME/")) return path.join(home, p.slice(6));
  if (p.startsWith("${HOME}/")) return path.join(home, p.slice(8));
  return p;
}

/** 将路径归一化为绝对路径（相对路径按 cwd 解析，`~` 按 home 展开）。 */
export function normalizePath(p: string, cwd: string, home: string): string {
  return path.resolve(cwd, expandHome(p, home));
}

/** 解析「切目录命令的位置参数」为新的有效工作目录（review C1 配套）。
 * Windows 盘符/UNC 形式原样保留——POSIX resolve 会把 `D:\x` 误拼进当前目录字符串，
 * 导致跨平台运行时 cd 跟踪结果错误；此类路径本身已由 isWithinCwd 恒判域外。 */
export function resolveCwdTarget(positional: string, current: string): string {
  const expanded = expandHome(positional, os.homedir());
  if (/^[A-Za-z]:[\\\/]/.test(expanded) || expanded.startsWith("\\\\")) return expanded;
  const abs = path.resolve(current, expanded);
  return realpathDeep(abs) ?? abs;
}

/** 解析真实路径（符号链接已解析）；不存在时返回 undefined。 */
export function realpathOf(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * 解析最深已存在祖先的真实路径：对尚不存在的文件，逐级解析其已存在的父目录后拼接自身。
 * 修复「父目录为软链 + 目标文件尚未创建」时的逃逸判定（issue #1 缺陷 6）：
 * `link/newfile`（link → 项目外）解析为 `<项目外>/newfile`，而非回退到未解析路径。
 */
export function realpathDeep(p: string): string | undefined {
  const real = realpathOf(p);
  if (real !== undefined) return real;
  const parent = path.dirname(p);
  if (parent === p) return undefined;
  const realParent = realpathDeep(parent);
  return realParent === undefined ? undefined : path.join(realParent, path.basename(p));
}

/** 将 glob 模式转为正则：`*` 匹配任意字符（含 `/`），`?` 匹配单个字符。 */
export function patternToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += "[^]*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * 判断路径是否命中敏感文件清单（FR-1 / D2）。
 *
 * 双形态匹配：引用路径 + realpath 解析后路径都参与匹配（防 symlink 绕过）；
 * 含 `/` 的模式匹配绝对路径，不含 `/` 的模式匹配文件名。
 */
export function isSensitivePath(
  target: string,
  patterns: readonly string[],
  cwd: string,
  home: string,
): boolean {
  const abs = normalizePath(target, cwd, home);
  const real = realpathOf(abs);
  const deep = realpathDeep(abs);
  // 反斜杠归一化变体（review P2-1）：PS 命令里的 `~\.ssh\id_rsa` 在 POSIX 决策宿主上
  // `\` 不参与路径切分，补一个替换后的候选让 basename/目录模式仍能命中
  const winNormalized = abs.includes("\\") ? abs.replace(/\\/g, "/") : undefined;
  const candidates = [...new Set([abs, real, deep, winNormalized].filter((p): p is string => Boolean(p)))];

  for (const pattern of patterns) {
    const expanded = expandHome(pattern, home);
    const hasSeparator = expanded.includes("/") || expanded.includes(path.sep);
    const rx = patternToRegExp(expanded);
    if (hasSeparator) {
      // 目录路径额外匹配 `<path>/*`，覆盖对敏感目录本身的引用（如 grep -r ~/.ssh）
      for (const c of candidates) {
        if (rx.test(c) || rx.test(`${c}/x`)) return true;
      }
    } else {
      const basenames = candidates.map((c) => path.basename(c));
      for (const b of basenames) if (rx.test(b)) return true;
    }
  }
  return false;
}


/**
 * 判断路径是否落在 trusted 外部路径前缀下（FR-9，如 `/tmp` 临时目录）。
 * 双形态匹配（原始 + realpath，防 symlink 逃逸）+ 相对路径按 cwd 解析 + `~` 展开；
 * 前缀匹配用 `p === prefix || p.startsWith(prefix + "/")`（避免 /tmp 误匹配 /tmpxxx）。
 */
export function isTrustedPath(
  target: string,
  prefixes: readonly string[],
  cwd: string,
  home: string,
): boolean {
  const abs = normalizePath(target, cwd, home);
  const real = realpathOf(abs);
  // 候选与前缀都补反斜杠归一化变体（review P2-1 / 用户反馈：PS 侧常写正斜杠、
  // 配置里可能写反斜杠，跨形态前缀比较需归一化后进行）
  const candidates = [...new Set([abs, real].filter((p): p is string => Boolean(p)))];
  const candForms = candidates.flatMap((p) => (p.includes("\\") ? [p, p.replace(/\\/g, "/")] : [p]));
  for (const prefix of prefixes) {
    const expanded = expandHome(prefix, home);
    const forms = expanded.includes("\\") ? [expanded, expanded.replace(/\\/g, "/")] : [expanded];
    for (const f of forms) {
      const sep = f.includes("/") ? "/" : path.sep;
      for (const p of candForms) {
        if (p === f || p.startsWith(f + sep)) return true;
      }
    }
  }
  return false;
}

/** git worktree 根缓存：key 为 realpath 归一化后的 cwd，进程内常驻无失效（cwd 不变则根不变）。 */
const gitRootCache = new Map<string, string | undefined>();

/**
 * 从 cwd 向上找首个含 `.git`（文件或目录）的祖先，realpath 后即 worktree 根（E 自动识别）。
 * 纯 fs、无 git 子进程；到 fs root 自停；找不到返回 undefined。
 */
export function findGitRoot(cwd: string): string | undefined {
  const key = realpathOf(cwd) ?? cwd;
  const cached = gitRootCache.get(key);
  if (cached !== undefined || gitRootCache.has(key)) return cached;
  let dir = key;
  for (;;) {
    try {
      const st = fs.statSync(path.join(dir, ".git"));
      if (st.isDirectory() || st.isFile()) {
        const root = realpathOf(dir) ?? dir;
        gitRootCache.set(key, root);
        return root;
      }
    } catch {
      // 无 .git，继续上溯
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      gitRootCache.set(key, undefined);
      return undefined;
    }
    dir = parent;
  }
}

/**
 * 判断路径是否落在项目域内（E）：cwd 或任一 root 内即域内（对标 OpenCode 双轴）。
 * 相对路径（含 `~/`、`$HOME/`）只按 cwd 解析一次为绝对路径，再与各 root 比较
 * （避免按 root 重复解析导致基址错误）；绝对路径（POSIX/Windows）直通 isWithinCwd
 * （保留盘符/UNC 语义）；前缀比较带 path separator（防 `/proj2` 误判）；roots 是域内不是 trusted。
 */
export function isWithinProject(
  target: string,
  cwd: string,
  roots: readonly string[],
  home: string,
): boolean {
  if (isWithinCwd(target, cwd, home)) return true;
  const hasRoot = roots.some((r) => r !== "");
  if (!hasRoot) return false;
  if (!path.isAbsolute(target) && !isWindowsAbsolute(target)) {
    const abs = normalizePath(target, cwd, home);
    return roots.some((r) => r !== "" && isWithinCwd(abs, r, home));
  }
  return roots.some((r) => r !== "" && isWithinCwd(target, r, home));
}

/** 是否为 `.env.example`（读取豁免，FR-1 例外）。 */
export function isSensitiveReadException(target: string, cwd: string, home: string): boolean {
  const abs = normalizePath(target, cwd, home);
  const base = path.basename(abs);
  return base === ".env.example" || /\.env\.example$/.test(base);
}

/**
 * 判断路径是否落在 cwd 内（FR-3 项目边界判定基准）。
 * 比较基于 realpath（符号链接已解析）；目标不存在时回退到归一化路径。
 * Windows 盘符/UNC 处理分两种情况：
 * - 宿主本身是 Windows 风格 cwd（生产常态）：双方都归一化分隔符/大小写后做前缀比较；
 * - POSIX 宿主（WSL/CI）收到 Windows 绝对路径目标：POSIX resolve 会把 `C:\x` 误当相对
 *   路径拼进 cwd 造成错误的域内放行，故恒判域外。
 */
export function isWithinCwd(target: string, cwd: string, home: string): boolean {
  // 双方均为 Windows 绝对路径（Windows 宿主常态）：先折叠 ./.. 点段（纯词法、跨平台可用，
  // 纯前缀比较可被 `a/../..` 穿越逃逸——review P1），再归一化分隔符/大小写做前缀比较。
  // 仅此分支走词法判定；混合对（如 Windows 宿主上相对路径目标 + 盘符 cwd，生产常态）
  // 必须落到下方原生流程：path.win32.resolve 在真实 Windows 上才能正确判域内域外（review P1-B）。
  if (isWindowsAbsolute(target) && isWindowsAbsolute(cwd)) {
    const t = normWinPath(path.win32.normalize(target));
    const c = normWinPath(path.win32.normalize(cwd));
    return t === c || t.startsWith((c.endsWith("/") ? c : c + "/"));
  }
  if (isWindowsAbsolute(target)) return false;
  const abs = normalizePath(target, cwd, home);
  // 深解析：目标不存在时也解析其父目录软链，防止 `link/newfile`（link→域外）被误判为域内
  const resolved = realpathDeep(abs) ?? abs;
  const realCwd = realpathOf(cwd) ?? cwd;
  return resolved === realCwd || resolved.startsWith(realCwd + path.sep);
}

/** Windows 风格绝对路径：盘符路径（`C:\...` / `C:/...`）或 UNC 路径（`\\server\share`）。 */
export function isWindowsAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\\/]/.test(p) || p.startsWith("\\\\");
}

/** Windows 路径归一化：反斜杠→正斜杠、小写（NTFS 大小写不敏感；
 * 已知限制：\\wsl$ 挂载的大小写敏感 ext4 上，大小写变体兄弟目录会被误判同目录，方向为放行）。 */
function normWinPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}