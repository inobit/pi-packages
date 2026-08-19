import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSensitivePath,
  isSensitiveReadException,
  isTrustedPath,
  isWithinCwd,
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
