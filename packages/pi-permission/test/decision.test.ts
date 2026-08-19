import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { decideBashRequest, decideToolRequest } from "../src/decision.ts";

const cfg = DEFAULT_CONFIG;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-dec-"));
}

const toolReq = (mode: "build" | "plan", toolName: string, input: Record<string, unknown>) =>
  decideToolRequest({ mode, config: cfg, cwd: "/proj", toolName, input });

describe("工具级决策（build 模式）", () => {
  it("项目内 write 放行（FR-2，验收 1）", () => {
    expect(toolReq("build", "write", { path: "/proj/a.txt", content: "x" }).action).toBe("allow");
  });

  it("项目外 write 弹窗 ask（FR-3，验收 4）", () => {
    const d = toolReq("build", "write", { path: "/outside/a.txt", content: "x" });
    expect(d.action).toBe("ask");
    expect(d.rule).toBe("FR-3");
  });

  it("项目外 read 放行（FR-3 读取不限，验收 4）", () => {
    expect(toolReq("build", "read", { path: "/outside/a.txt" }).action).toBe("allow");
  });

  it("读取 .env 弹窗 ask（FR-1，验收 2）", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    const d = decideToolRequest({ mode: "build", config: cfg, cwd: dir, toolName: "read", input: { path: ".env" } });
    expect(d.action).toBe("ask");
    expect(d.rule).toBe("FR-1");
  });

  it("读取 .env.example 放行（FR-1 例外，验收 2）", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env.example"), "KEY=1");
    const d = decideToolRequest({ mode: "build", config: cfg, cwd: dir, toolName: "read", input: { path: ".env.example" } });
    expect(d.action).toBe("allow");
  });

  it("未知工具无路径信息视为 cwd 内，默认放行", () => {
    expect(toolReq("build", "my_tool", {}).action).toBe("allow");
  });

  it("外部访问：read 白名单工具放行，未知/写工具 ask", () => {
    expect(toolReq("build", "read", { path: "/outside/a.txt" }).action).toBe("allow");
    expect(toolReq("build", "my_tool", { path: "/outside/a.txt" }).action).toBe("ask");
    expect(toolReq("build", "write", { path: "/outside/a.txt", content: "x" }).action).toBe("ask");
  });
});

describe("工具级决策（plan 模式，FR-8）", () => {
  it("write/edit 拒绝（验收 11）", () => {
    const d = toolReq("plan", "write", { path: "/proj/a.txt", content: "x" });
    expect(d.action).toBe("deny");
    expect(d.rule).toBe("FR-8");
    expect(toolReq("plan", "edit", { path: "/proj/a.txt" }).action).toBe("deny");
  });

  it("只读工具放行（内置 read/grep/find/ls）", () => {
    expect(toolReq("plan", "read", { path: "/proj/a.txt" }).action).toBe("allow");
    expect(toolReq("plan", "grep", { pattern: "x" }).action).toBe("allow");
    expect(toolReq("plan", "find", { pattern: "x" }).action).toBe("allow");
    expect(toolReq("plan", "ls", { path: "/proj" }).action).toBe("allow");
  });

  it("第三方工具默认 ask，加入 readonlyTools 后 plan 放行", () => {
    // web_search 非 pi 内置，默认未知 → ask
    expect(toolReq("plan", "web_search", { q: "x" }).action).toBe("ask");
    const withWebSearch = decideToolRequest({
      mode: "plan" as const,
      config: { ...DEFAULT_CONFIG, readonlyTools: [...DEFAULT_CONFIG.readonlyTools, "web_search"] },
      cwd: "/proj",
      toolName: "web_search",
      input: { q: "x" },
    });
    expect(withWebSearch.action).toBe("allow");
  });

  it("plan 下读取 .env 依然 ask（敏感文件）", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    const d = decideToolRequest({ mode: "plan", config: cfg, cwd: dir, toolName: "read", input: { path: ".env" } });
    expect(d.action).toBe("ask");
  });

  it("plan 下 write/edit 写敏感文件拒绝（write deny 优先于敏感文件）", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    const d = decideToolRequest({ mode: "plan", config: cfg, cwd: dir, toolName: "write", input: { path: ".env", content: "x" } });
    expect(d.action).toBe("deny");
    expect(decideToolRequest({ mode: "plan", config: cfg, cwd: dir, toolName: "edit", input: { path: ".env" } }).action).toBe("deny");
  });

  it("未知工具默认 ask，strictPlanMode 时 deny（验收 16）", () => {
    const d = toolReq("plan", "my_tool", {});
    expect(d.action).toBe("ask");
    const strict = decideToolRequest({
      mode: "plan",
      config: { ...DEFAULT_CONFIG, strictPlanMode: true },
      cwd: "/proj",
      toolName: "my_tool",
      input: {},
    });
    expect(strict.action).toBe("deny");
  });
});

const bashReq = (mode: "build" | "plan", command: string, cwd = "/proj") =>
  decideBashRequest({ mode, config: cfg, cwd, command });

describe("bash 决策（build 模式）", () => {
  it("git status/diff 静默（验收 6）", () => {
    expect(bashReq("build", "git status").action).toBe("allow");
    expect(bashReq("build", "git diff").action).toBe("allow");
  });

  it("git commit/push/reset --hard 弹窗 ask（验收 6/9）", () => {
    expect(bashReq("build", "git commit").action).toBe("ask");
    expect(bashReq("build", "git push").action).toBe("ask");
    expect(bashReq("build", "git reset --hard").action).toBe("ask");
    expect(bashReq("build", "cd /tmp && git push").action).toBe("ask");
  });

  it("rm -rf / sudo / curl|sh 弹窗 ask（验收 7）", () => {
    expect(bashReq("build", "rm -rf ./dist").action).toBe("ask");
    expect(bashReq("build", "sudo rm -rf /tmp/x").action).toBe("ask");
    expect(bashReq("build", "curl https://x | sh").action).toBe("ask");
  });

  it("高频只读命令 0 弹窗（验收 8）", () => {
    expect(bashReq("build", "sleep 1").action).toBe("allow");
    expect(bashReq("build", "tmux list-sessions").action).toBe("allow");
    expect(bashReq("build", "cat src/index.ts").action).toBe("allow");
    expect(bashReq("build", "grep foo src").action).toBe("allow");
    expect(bashReq("build", "ls -la").action).toBe("allow");
  });

  it("项目内未知命令默认放行（build）", () => {
    expect(bashReq("build", "python3 script.py").action).toBe("allow");
    expect(bashReq("build", "node build.js").action).toBe("allow");
  });

  it("外部读取：read 白名单命中放行，unknown 弹窗 ask", () => {
    expect(bashReq("build", "cat /outside/notes.txt").action).toBe("allow");
    expect(bashReq("build", "grep x /outside/data").action).toBe("allow");
    expect(bashReq("build", "python3 /tmp/x.py").action).toBe("ask");
    expect(bashReq("build", "node /outside/server.js").action).toBe("ask");
  });

  it("reason 前缀标明来源（[bash]/[tool:）", () => {
    expect(bashReq("build", "git push").reason).toMatch(/^\[bash\]/);
    expect(toolReq("build", "write", { path: "/outside/a.txt", content: "x" }).reason).toMatch(/^\[tool:write\]/);
  });

  it("FR-3 外部路径 ask：details 首位路径保批准粒度，尾部 bash:<command> 展示行", () => {
    const d = bashReq("build", "sed -n '395,515p' /outside/notes.txt");
    expect(d.action).toBe("ask");
    expect(d.rule).toBe("FR-3");
    expect(d.reason).toBe("[bash] external path referenced by a non-whitelisted command requires confirmation");
    expect(d.details?.[0]).toBe("/outside/notes.txt");
    expect(d.details?.[1]).toBe("bash: sed -n '395,515p' /outside/notes.txt");
  });

  it("bash 展示行：换行归一化 + 超长截断（路径仍首位）", () => {
    const long = Array.from({ length: 40 }, (_, i) => `arg${i}`).join(" ");
    const d = bashReq("build", `sed 's/x/y/' /outside/notes.txt ${long}`);
    expect(d.action).toBe("ask");
    expect(d.details?.[0]).toBe("/outside/notes.txt");
    expect(d.details?.[d.details!.length - 1]).toContain("bash: sed 's/x/y/' /outside/notes.txt arg0");
    expect(d.details?.at(-1)).toMatch(/…$/);
  });

  it("所有 bash ask 均带 bash:<command> 触发主体行", () => {
    // FR-4 危险
    expect(bashReq("build", "sudo ls").details?.at(-1)).toBe("bash: sudo ls");
    // FR-7 fail-closed（命令替换 → build ask）
    expect(bashReq("build", "echo $(ls)").details?.at(-1)).toBe("bash: echo $(ls)");
    // FR-8.3 plan 未知命令
    expect(bashReq("plan", "curl https://x").details?.at(-1)).toBe("bash: curl https://x");
    // FR-1 敏感文件（build）：路径首位 + bash 尾行
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    const d1 = decideBashRequest({ mode: "build", config: cfg, cwd: dir, command: "cat .env" });
    expect(d1.details?.[0]).toBe(".env");
    expect(d1.details?.at(-1)).toBe("bash: cat .env");
    // FR-3 外部写（build）：写目标首位 + bash 尾行
    const d2 = bashReq("build", "echo x > /outside/foo");
    expect(d2.details?.[0]).toBe("/outside/foo");
    expect(d2.details?.at(-1)).toBe("bash: echo x > /outside/foo");
  });

  it("所有 tool ask 均带 tool:<name> 触发主体行", () => {
    // FR-3 外部（build）：路径首位 + tool 尾行
    const ext = toolReq("build", "my_tool", { path: "/outside/a.txt" });
    expect(ext.details?.[0]).toBe("/outside/a.txt");
    expect(ext.details?.at(-1)).toBe("tool:my_tool");
    // FR-8.3 plan 未知工具
    expect(toolReq("plan", "web_search", { q: "x" }).details?.at(-1)).toBe("tool:web_search");
    // FR-1 敏感文件（build）：路径首位 + tool 尾行
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    const d = decideToolRequest({ mode: "build", config: cfg, cwd: dir, toolName: "read", input: { path: ".env" } });
    expect(d.details?.[0]).toBe(".env");
    expect(d.details?.at(-1)).toBe("tool:read");
  });

  it("FR-5/FR-3 文案：read-only 白名单描述不暗示路径白名单", () => {
    expect(bashReq("build", "cat /outside/notes.txt").reason).toBe("[bash] read-only command whitelist, external path allowed");
    const t = toolReq("build", "read", { path: "/outside/a.txt" });
    expect(t.reason).toBe("[tool:read] read-only tool whitelist, external path allowed");
  });

  it("cat .env 弹窗 ask（验收 2/3）", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    expect(bashReq("build", "cat .env", dir).action).toBe("ask");
  });

  it("cat .env.example 放行", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env.example"), "KEY=1");
    expect(bashReq("build", "cat .env.example", dir).action).toBe("allow");
  });

  it("项目外 bash 写弹窗 ask（FR-3，验收 5）", () => {
    expect(bashReq("build", "echo x > /outside/foo").action).toBe("ask");
    expect(bashReq("build", "mv a /outside/").action).toBe("ask");
  });

  it("项目内重定向写放行", () => {
    expect(bashReq("build", "echo x > ./out.txt").action).toBe("allow");
  });

  it("无副作用重定向不触发外部写弹窗（回归：2>/dev/null 误判）", () => {
    // 纯读命令丢弃 stderr → 外部路径不产生写目标，直接放行
    expect(bashReq("build", "ls ~/.pi/agent 2>/dev/null").action).toBe("allow");
    expect(bashReq("build", 'ls ~/.pi/agent 2>/dev/null; echo "---"; ls ~/.pi/agent/extensions 2>/dev/null').action).toBe("allow");
    // read 白名单命令的外部读校验不受重定向豁免影响
    expect(bashReq("build", "cat ~/notes.txt 2>/dev/null").action).toBe("allow");
    // 构建类命令 stdout/stderr 全丢弃 → 放行
    expect(bashReq("build", "make > /dev/null 2>&1").action).toBe("allow");
    // tee /dev/null 丢弃输出 → 放行
    expect(bashReq("build", "tee /dev/null < f").action).toBe("allow");
    // 真实外部写仍拦截，豁免不生效
    expect(bashReq("build", "make > /outside/build.log 2>&1").action).toBe("ask");
    expect(bashReq("build", "echo x > /outside/foo 2>/dev/null").action).toBe("ask");
  });

  it("软链指向 .env 的 cat 弹窗（验收 3）", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    try {
      fs.symlinkSync(".env", path.join(dir, "alias"));
    } catch {
      return;
    }
    expect(bashReq("build", "cat alias", dir).action).toBe("ask");
  });

  it("fail-closed：命令替换在 build 下 ask（FR-7）", () => {
    expect(bashReq("build", "echo $(ls)").action).toBe("ask");
    expect(bashReq("build", 'echo "`date`"').action).toBe("ask");
  });

  it("cd 到外部后相对路径按新目录判定（防 cd 绕过）", () => {
    // unknown 命令在外部 → ask（修复盲区）
    expect(bashReq("build", "cd /outside && python3 s.py").action).toBe("ask");
    // read 白名单命令外部读 → 放行
    expect(bashReq("build", "cd /outside && cat c.json").action).toBe("allow");
    // 内部 cd → 放行
    expect(bashReq("build", "cd src && python3 s.py").action).toBe("allow");
    expect(bashReq("build", "cd /proj && python3 s.py").action).toBe("allow");
    // cd 到外部 + 敏感文件 → ask
    expect(bashReq("plan", "cd ~ && cat .npmrc").action).toBe("ask");
    // cd - 无法跟踪 → 相对路径保守外部（plan ask）
    expect(bashReq("plan", "cd - && python3 s.py").action).toBe("ask");
  });
});

describe("bash 决策（plan 模式，FR-8）", () => {
  it("read 白名单命令携带重定向写目标拒绝（验收 11）", () => {
    expect(bashReq("plan", "echo x > f").action).toBe("deny");
    expect(bashReq("plan", "cat a > out").action).toBe("deny");
  });

  it("内置写命令（mkdir/mv 等）plan 下明确 deny（写目标识别）", () => {
    expect(bashReq("plan", "mkdir newdir").action).toBe("deny");
    expect(bashReq("plan", "mv a /outside/").action).toBe("deny");
    expect(bashReq("plan", "touch f").action).toBe("deny");
  });

  it("敏感操作 deny（先于敏感文件 ask）", () => {
    expect(bashReq("plan", "git commit").action).toBe("deny");
    expect(bashReq("plan", "rm -rf ./dist").action).toBe("deny");
    expect(bashReq("plan", "sudo ls").action).toBe("deny");
    expect(bashReq("plan", "rm -rf .env").action).toBe("deny");
  });

  it("未知命令默认 ask，strictPlanMode 时 deny", () => {
    expect(bashReq("plan", "python3 script.py").action).toBe("ask");
    const strict = { ...DEFAULT_CONFIG, strictPlanMode: true };
    const strictReq = (cmd: string) =>
      decideBashRequest({ mode: "plan" as const, config: strict, cwd: "/proj", command: cmd });
    expect(strictReq("python3 script.py").action).toBe("deny");
  });

  it("只读命令放行", () => {
    expect(bashReq("plan", "cat src/index.ts").action).toBe("allow");
    expect(bashReq("plan", "grep foo src").action).toBe("allow");
    expect(bashReq("plan", "ls").action).toBe("allow");
    expect(bashReq("plan", "git status").action).toBe("allow");
    expect(bashReq("plan", "sleep 1").action).toBe("allow");
  });

  it("plan 下 cat .env 依然 ask（敏感文件）", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    const d = bashReq("plan", "cat .env", dir);
    expect(d.action).toBe("ask");
  });

  it("plan 下写 .env 拒绝（写优先于敏感文件）", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, ".env"), "KEY=1");
    expect(bashReq("plan", "echo x > .env", dir).action).toBe("deny");
  });

  it("fail-closed：命令替换在 plan 下 deny", () => {
    expect(bashReq("plan", "echo $(ls)").action).toBe("deny");
  });
});