import fs from "node:fs";
import path from "node:path";

/** 展开 `~` / `~/...` 为 home 绝对路径。 */
export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** 将路径归一化为绝对路径（相对路径按 cwd 解析，`~` 按 home 展开）。 */
export function normalizePath(p: string, cwd: string, home: string): string {
  return path.resolve(cwd, expandHome(p, home));
}

/** 解析真实路径（符号链接已解析）；不存在时返回 undefined。 */
export function realpathOf(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
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
  const candidates = [abs, real].filter((p): p is string => Boolean(p));

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
  const candidates = [abs, real].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    for (const prefix of prefixes) {
      const expanded = expandHome(prefix, home);
      if (p === expanded || p.startsWith(expanded + path.sep)) return true;
    }
  }
  return false;
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
 */
export function isWithinCwd(target: string, cwd: string, home: string): boolean {
  const abs = normalizePath(target, cwd, home);
  const real = realpathOf(abs) ?? abs;
  const realCwd = realpathOf(cwd) ?? cwd;
  return real === realCwd || real.startsWith(realCwd + path.sep);
}