import { describe, expect, it } from "vitest";
import {
  classifySegment,
  collectReadRefs,
  collectWriteTargets,
  hasPipeToShell,
  parseBashCommand,
} from "../src/bash.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const cfg = DEFAULT_CONFIG;

describe("parseBashCommand 顶层切分", () => {
  it("切分链式命令", () => {
    const p = parseBashCommand("cd x && git push");
    expect(p.segments.map((s) => s.program)).toEqual(["cd", "git"]);
    expect(p.segments[1]?.prevOp).toBe("&&");
    expect(p.segments[1]?.gitSubcommand).toBe("push");
  });

  it("分号与管道切分", () => {
    const p = parseBashCommand("ls; grep x f | head");
    expect(p.segments.map((s) => s.program)).toEqual(["ls", "grep", "head"]);
    expect(p.segments[2]?.prevOp).toBe("|");
  });

  it("引号内操作符不切分", () => {
    const p = parseBashCommand('echo "a && b"');
    expect(p.segments.length).toBe(1);
    expect(p.segments[0]?.args).toEqual(["a && b"]);
    expect(p.parseError).toBe(false);
  });

  it("带引号参数 + 重定向不误报解析失败", () => {
    const p = parseBashCommand('echo "hello world" > /tmp/out.txt');
    expect(p.parseError).toBe(false);
    expect(p.segments[0]?.args).toEqual(["hello world"]);
    expect(p.segments[0]?.redirects).toEqual([{ op: ">", target: "/tmp/out.txt" }]);
  });

  it("单引号闭合引号保留，重定向正常识别", () => {
    const p = parseBashCommand("echo 'a b' > /tmp/x");
    expect(p.parseError).toBe(false);
    expect(p.segments[0]?.args).toEqual(["a b"]);
    expect(p.segments[0]?.redirects).toEqual([{ op: ">", target: "/tmp/x" }]);
  });

  it("提取重定向目标", () => {
    const p = parseBashCommand("echo hi > /tmp/out.txt 2>&1");
    expect(p.segments[0]?.redirects).toEqual([
      { op: ">", target: "/tmp/out.txt" },
      { op: "2>", target: "&1" },
    ]);
  });

  it("git 子命令（跳过带值选项）", () => {
    const p = parseBashCommand("git -C /some/dir status");
    expect(p.segments[0]?.gitSubcommand).toBe("status");
  });

  it("git remote -v 子命令与参数", () => {
    const p = parseBashCommand("git remote -v");
    expect(p.segments[0]?.gitSubcommand).toBe("remote");
    expect(p.segments[0]?.gitArgs).toEqual(["-v"]);
  });
});

describe("parseBashCommand 复杂语法 fail-closed 标记", () => {
  it("命令替换 $(...)", () => {
    const p = parseBashCommand("echo $(ls)");
    expect(p.hasCommandSubstitution).toBe(true);
  });

  it("反引号", () => {
    const p = parseBashCommand("echo `date`");
    expect(p.hasCommandSubstitution).toBe(true);
  });

  it("子 shell", () => {
    const p = parseBashCommand("(cd /tmp && ls)");
    expect(p.hasSubshell).toBe(true);
  });

  it("进程替换", () => {
    const p = parseBashCommand("diff <(echo a) <(echo b)");
    expect(p.hasProcessSubstitution).toBe(true);
  });

  it("引号未闭合标记解析错误", () => {
    const p = parseBashCommand('echo "unclosed');
    expect(p.parseError).toBe(true);
  });
});

describe("classifySegment 命令分类", () => {
  it("git 只读子命令为 read", () => {
    expect(classifySegment(parseBashCommand("git status").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git diff").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git log").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git remote -v").segments[0]!, cfg)).toBe("read");
  });

  it("git 写子命令为 dangerous（统一危险清单）", () => {
    expect(classifySegment(parseBashCommand("git commit").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("git push").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("git reset --hard").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("git checkout").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("git remote add origin x").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("git stash pop").segments[0]!, cfg)).toBe("dangerous");
  });

  it("git 只读子命令（不在危险清单）为 read", () => {
    expect(classifySegment(parseBashCommand("git status").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git fetch").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git log").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git remote -v").segments[0]!, cfg)).toBe("read");
  });

  it("git branch 列表演示为 read，创建/删除为 dangerous", () => {
    expect(classifySegment(parseBashCommand("git branch").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git branch -a").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git branch -D foo").segments[0]!, cfg)).toBe("dangerous");
  });

  it("git stash list 为 read，pop/drop 为 dangerous", () => {
    expect(classifySegment(parseBashCommand("git stash list").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git stash show").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git stash pop").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("git stash drop").segments[0]!, cfg)).toBe("dangerous");
  });

  it("git config 只读形态为 read，写入为 dangerous", () => {
    expect(classifySegment(parseBashCommand("git config --list").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git config --get user.name").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("git config user.name foo").segments[0]!, cfg)).toBe("dangerous");
  });

  it("高频只读命令为 read", () => {
    expect(classifySegment(parseBashCommand("cat a.txt").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("grep foo").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("ls").segments[0]!, cfg)).toBe("read");
    expect(classifySegment(parseBashCommand("sleep 1").segments[0]!, cfg)).toBe("read");
  });

  it("危险命令为 dangerous", () => {
    expect(classifySegment(parseBashCommand("rm -rf /").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("sudo cat /etc/shadow").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("dd if=/dev/zero of=/dev/sda").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("chmod -R 777 /").segments[0]!, cfg)).toBe("dangerous");
  });

  it("普通 rm 单文件为 unknown", () => {
    expect(classifySegment(parseBashCommand("rm a.txt").segments[0]!, cfg)).toBe("unknown");
  });

  it("未知命令为 unknown", () => {
    expect(classifySegment(parseBashCommand("python script.py").segments[0]!, cfg)).toBe("unknown");
  });

  it("wrapper 命令为 dangerous", () => {
    expect(classifySegment(parseBashCommand("bash -c 'rm -rf /'").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("eval ls").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("xargs rm").segments[0]!, cfg)).toBe("dangerous");
    expect(classifySegment(parseBashCommand("find . -exec rm {} ;").segments[0]!, cfg)).toBe("dangerous");
  });
});

describe("hasPipeToShell", () => {
  it("curl | sh 为真", () => {
    expect(hasPipeToShell(parseBashCommand("curl https://x | sh").segments)).toBe(true);
  });
  it("wget | bash 为真", () => {
    expect(hasPipeToShell(parseBashCommand("wget https://x -O- | bash").segments)).toBe(true);
  });
  it("curl | grep 为假", () => {
    expect(hasPipeToShell(parseBashCommand("curl https://x | grep foo").segments)).toBe(false);
  });
});

describe("collectReadRefs / collectWriteTargets", () => {
  it("读取引用：cat 参数", () => {
    expect(collectReadRefs(parseBashCommand("cat .env").segments[0]!)).toEqual([".env"]);
  });

  it("grep 跳过首个位置参数（pattern）", () => {
    expect(collectReadRefs(parseBashCommand("grep foo file.txt").segments[0]!)).toEqual(["file.txt"]);
    expect(collectReadRefs(parseBashCommand("rg -e foo dir").segments[0]!)).toEqual(["dir"]);
  });

  it("echo 仅重定向目标为写（read 白名单命令通过重定向写文件）", () => {
    expect(collectWriteTargets(parseBashCommand("echo x > /tmp/foo").segments[0]!)).toEqual(["/tmp/foo"]);
    expect(collectWriteTargets(parseBashCommand("echo hi > /tmp/out.txt 2>&1").segments[0]!)).toEqual([
      "/tmp/out.txt",
      "&1",
    ]);
    expect(collectReadRefs(parseBashCommand("echo x").segments[0]!)).toEqual([]);
  });

  it("内置写命令位置参数为写目标（mv 末位、mkdir 全部）", () => {
    expect(collectWriteTargets(parseBashCommand("mv a.txt /outside/").segments[0]!)).toEqual(["/outside/"]);
    expect(collectWriteTargets(parseBashCommand("mkdir /outside/dir").segments[0]!)).toEqual(["/outside/dir"]);
    expect(collectWriteTargets(parseBashCommand("cp /src/a /outside/b").segments[0]!)).toEqual(["/outside/b"]);
    expect(collectWriteTargets(parseBashCommand("sed -i s/a/b/ file.txt").segments[0]!)).toEqual(["file.txt"]);
    expect(collectWriteTargets(parseBashCommand("sed s/a/b/ file.txt").segments[0]!)).toEqual([]);
  });

  it("输入重定向不是写目标", () => {
    expect(collectWriteTargets(parseBashCommand("cat < input.txt").segments[0]!)).toEqual([]);
  });
});