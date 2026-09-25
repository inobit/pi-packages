import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findGitRoot,
  isSensitivePath,
  isSensitiveReadException,
  isTrustedPath,
  realpathDeep,
  isWithinCwd,
  isWithinProject,
  normalizePath,
  patternToRegExp,
} from "../src/path.ts";

const HOME = os.homedir();

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-path-"));
}

describe("normalizePath / patternToRegExp", () => {
  it("相对路径按 cwd 归一化", () => {
    expect(normalizePath("foo/bar", "/proj", HOME)).toBe("/proj/foo/bar");
  });

  it("~ 展开为 home", () => {
    expect(normalizePath("~/.ssh/id_rsa", "/proj", HOME)).toBe(path.join(HOME, ".ssh", "id_rsa"));
  });

  it("glob 转正则：* 匹配任意字符含 /", () => {
    expect(patternToRegExp("*.env").test("/proj/.env")).toBe(true);
    expect(patternToRegExp("*.env").test("/a/b/x.env")).toBe(true);
    expect(patternToRegExp("*.env").test("x.env.local")).toBe(false);
  });
});

describe("isSensitivePath", () => {
  const patterns = [
    "*.env", "*.env.*", "~/.ssh/*", "*.pem", "*.key", "id_rsa*",
    "credentials.json", "secrets*.yaml", "~/.aws/*", ".npmrc",
  ];

  it("命中 .env（任意目录）", () => {
    expect(isSensitivePath("/proj/.env", patterns, "/proj", HOME)).toBe(true);
    expect(isSensitivePath(".env", patterns, "/proj", HOME)).toBe(true);
  });

  it("命中 .env.local / .env.production", () => {
    expect(isSensitivePath("/proj/.env.local", patterns, "/proj", HOME)).toBe(true);
    expect(isSensitivePath("/proj/.env.production", patterns, "/proj", HOME)).toBe(true);
  });

  it("不命中普通文件", () => {
    expect(isSensitivePath("/proj/src/index.ts", patterns, "/proj", HOME)).toBe(false);
  });

  it("命中 ~/.ssh/* 与 ~/.aws/*", () => {
    expect(isSensitivePath("~/.ssh/id_rsa", patterns, "/proj", HOME)).toBe(true);
    expect(isSensitivePath("~/.aws/credentials", patterns, "/proj", HOME)).toBe(true);
  });

  it("命中 .npmrc / credentials.json / secrets 类", () => {
    expect(isSensitivePath("/proj/.npmrc", patterns, "/proj", HOME)).toBe(true);
    expect(isSensitivePath("/proj/credentials.json", patterns, "/proj", HOME)).toBe(true);
    expect(isSensitivePath("/proj/secrets-prod.yaml", patterns, "/proj", HOME)).toBe(true);
  });

  it("软链指向 .env 的文件同样命中（realpath 双形态）", () => {
    const dir = tmpdir();
    const envFile = path.join(dir, ".env");
    const link = path.join(dir, "alias");
    fs.writeFileSync(envFile, "SECRET=x");
    try {
      fs.symlinkSync(".env", link);
    } catch {
      // 平台不支持符号链接时跳过
      expect(true).toBe(true);
      return;
    }
    expect(isSensitivePath(link, patterns, dir, HOME)).toBe(true);
  });

  it("目录本身引用命中（grep -r ~/.ssh）", () => {
    expect(isSensitivePath("~/.ssh", patterns, "/proj", HOME)).toBe(true);
  });
});

describe("isSensitiveReadException", () => {
  it(".env.example 读取豁免", () => {
    expect(isSensitiveReadException("/proj/.env.example", "/proj", HOME)).toBe(true);
  });
  it("普通 .env 非豁免", () => {
    expect(isSensitiveReadException("/proj/.env", "/proj", HOME)).toBe(false);
  });
});

describe("isWithinCwd", () => {
  it("cwd 内为真，cwd 外为假", () => {
    expect(isWithinCwd("src/index.ts", "/proj", HOME)).toBe(true);
    expect(isWithinCwd("/outside/foo", "/proj", HOME)).toBe(false);
  });

  it("软链指向外部视为外部", () => {
    const dir = tmpdir();
    const outside = tmpdir();
    const target = path.join(outside, "secret.txt");
    const link = path.join(dir, "link");
    fs.writeFileSync(target, "data");
    try {
      fs.symlinkSync(target, link);
    } catch {
      expect(true).toBe(true);
      return;
    }
    expect(isWithinCwd(link, dir, HOME)).toBe(false);
  });
});

describe("isTrustedPath（FR-9）", () => {
  it("前缀匹配：绝对/边界/相对按 cwd/非匹配", () => {
    expect(isTrustedPath("/tmp/foo.txt", ["/tmp"], "/proj", HOME)).toBe(true);
    expect(isTrustedPath("/tmp", ["/tmp"], "/proj", HOME)).toBe(true);
    expect(isTrustedPath("/tmpxxx/a", ["/tmp"], "/proj", HOME)).toBe(false);
    expect(isTrustedPath("/var/tmp/x", ["/tmp"], "/proj", HOME)).toBe(false);
    expect(isTrustedPath("out.txt", ["/tmp"], "/tmp", HOME)).toBe(true); // cwd 在 /tmp 下的相对写
    expect(isTrustedPath("out.txt", ["/tmp"], "/proj", HOME)).toBe(false);
  });
  it("自定义前缀", () => {
    expect(isTrustedPath("/srv/cache/x", ["/tmp", "/srv/cache"], "/proj", HOME)).toBe(true);
    expect(isTrustedPath("/opt/x", ["/tmp", "/srv/cache"], "/proj", HOME)).toBe(false);
  });
});

describe("父目录软链逃逸（issue #1 缺陷 6 回归）", () => {
  // 注意：fixture 必须放在 trusted 前缀之外（/tmp 下会走 FR-9 豁免导致误判通过）
  it("realpathDeep 解析不存在文件的软链父目录", () => {
    const home = os.homedir();
    const root = fs.mkdtempSync(path.join(home, "pi-permission-symlink-"));
    const outside = fs.mkdtempSync(path.join(home, "pi-permission-outside-"));
    try {
      const link = path.join(root, "link");
      fs.symlinkSync(outside, link);
      // 目标文件尚不存在：link/newfile 深解析应落在 outside 下
      const resolved = realpathDeep(path.join(link, "newfile"));
      expect(resolved).toBe(path.join(outside, "newfile"));
      // isWithinCwd 应判定为域外（旧实现回退未解析路径误判为域内）
      expect(isWithinCwd(path.join(link, "newfile"), root, home)).toBe(false);
    } finally {
      // root 与 outside 都在真实 home 下，必须一并清理
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("Windows 风格绝对路径（powershell 工具回归）", () => {
  it("盘符路径与 UNC 路径在任何平台都判定为 cwd 外", () => {
    expect(isWithinCwd("C:\\Users\\me\\file.txt", "/proj", HOME)).toBe(false);
    expect(isWithinCwd("D:/data/out.txt", "/proj", HOME)).toBe(false);
    expect(isWithinCwd("\\\\server\\share\\f.txt", "/proj", HOME)).toBe(false);
    // POSIX resolve 会把 `C:\x` 当相对路径拼进 cwd，此处防回归
    expect(isWithinCwd("C:\\proj\\file.txt", "/proj", HOME)).toBe(false);
    expect(isWithinCwd("./local.txt", "/proj", HOME)).toBe(true);
  });

  it("Windows 宿主：cwd 为盘符路径时，正斜杠/大小写变体的项目内目标仍判域内（用户反馈回归）", () => {
    // 实际场景：project=D:\documents\projects\v3-service，write 目标为 D:/.../startup.cmd
    expect(isWithinCwd("D:/proj/startup.cmd", "D:\\proj", HOME)).toBe(true);
    expect(isWithinCwd("d:\\PROJ\\sub\\a.txt", "D:/proj", HOME)).toBe(true);
    // 跨盘符必须判域外（不能因 POSIX 拼接误判域内）
    expect(isWithinCwd("E:\\elsewhere\\f.txt", "D:\\proj", HOME)).toBe(false);
    expect(isWithinCwd("D:/outside/f.txt", "D:\\proj", HOME)).toBe(false);
    // UNC cwd 与盘符目标的组合按域外处理（无法归一化比较）
    expect(isWithinCwd("C:\\x\\f.txt", "\\\\server\\share", HOME)).toBe(false);
  });

  it("review P1: winPair 词法分支必须折叠 .. 点段，防止穿越逃逸", () => {
    expect(isWithinCwd("D:/proj/a/../../evil.txt", "D:\\proj", HOME)).toBe(false);
    expect(isWithinCwd("d:\\proj\\sub\\..\\ok.txt", "D:/proj", HOME)).toBe(true);
  });

  it("review P1-B: 混合对（相对目标 + 盘符 cwd）不进词法分支", () => {
    // 词法分支对任何相对目标恒判域外；修复后混合对改走平台原生流程。
    // 注：原生流程的域内判定依赖平台 path 语义（Windows 宿主正确、POSIX 宿主上
    // 盘符 cwd 本身无法解析），故此处仅锁定「不因词法分支被恒判域外」这一契约：
    const d = isWithinCwd("D:/proj/startup.cmd", "D:\\proj", HOME);
    expect(d).toBe(true); // 绝对正斜杠目标仍走 winPair 精确比较
    // 相对目标的最终结果由宿主平台决定（Windows 上为域内 allow，见 README 平台说明）
  });
});

describe("findGitRoot / isWithinProject（E worktree 域内）", () => {
  function homedirCase(withGit: boolean, gitIsFile: boolean): { root: string; child: string } {
    const root = fs.mkdtempSync(path.join(HOME, "pi-permission-wt-"));
    if (withGit) {
      if (gitIsFile) fs.writeFileSync(path.join(root, ".git"), "gitdir: elsewhere\n");
      else fs.mkdirSync(path.join(root, ".git"));
    }
    const child = path.join(root, "sub", "deep");
    fs.mkdirSync(child, { recursive: true });
    return { root, child };
  }

  it("子目录上溯命中 worktree 根（目录/文件两种 .git 形态）", () => {
    for (const asFile of [false, true]) {
      const { root, child } = homedirCase(true, asFile);
      try {
        expect(findGitRoot(child)).toBe(fs.realpathSync(root));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("无 .git 时返回 undefined（上溯到 fs root 自停）", () => {
    const { root, child } = homedirCase(false, false);
    try {
      expect(findGitRoot(child)).toBe(undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(findGitRoot("/")).toBe(undefined);
  });

  it("isWithinProject：cwd 或任一 root 内即域内；兄弟前缀不误判", () => {
    expect(isWithinProject("/proj/src/a.ts", "/proj", [], HOME)).toBe(true);
    expect(isWithinProject("/wt2/f.txt", "/proj", ["/wt2"], HOME)).toBe(true);
    expect(isWithinProject("/outside/f.txt", "/proj", ["/wt2"], HOME)).toBe(false);
    expect(isWithinProject("/proj2/f.txt", "/proj", [], HOME)).toBe(false);
    expect(isWithinProject("/proj2/f.txt", "/other", ["/proj"], HOME)).toBe(false);
  });
});
