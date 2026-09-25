# @inobit/pi-permission

Pi coding agent 的权限控制扩展：按「效果可证明性 × 信任域」对 bash 命令与工具调用做确定性决策——敏感文件保护、信任域边界、危险操作确认、plan-build 只读模式。

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根目录 `AGENTS.md`，本文件只写本包的目标、架构、结构与包特有约束。

## 目标

- **只拦该拦的**：敏感文件读写、信任域外的写入与不可证执行、危险叠加命令；其余一概不打扰
- **fail-closed**：解析失败/看不懂的命令一律保守处理（ask 或静默 deny），绝不静默放行，也绝不因解析失败而崩溃拦截（插件自身异常降级为放行）
- **拒绝可行动**：每条 deny 反馈自包含「类别 + 原因 + 改道路径」，`terminate:false` 让模型自行调整而非卡死任务
- **降噪音**：会话批准记忆细粒度化（program/path/父目录）、hint 每 rule 会话一次、长命令中段省略展示

## 架构（决策模型）

命令按「副作用能否从参数完整推导」分三档，另加一层危险叠加：

| 档 | 判定 | 例子 |
| -- | ---- | ---- |
| **R 纯读者** | 无文件副作用 | cat/grep/jq/git status |
| **W 有界写者** | 写目标可从参数穷举 | touch/cp/mv/sed -i/重定向/find -delete |
| **X 不透明** | 效果不可推导：解释器、构建工具、未识别程序、解析失败降级 | python3/npm/make/bash -c/tar 解压 |

危险叠加（rm 递归（-r/-R/--recursive）/通配目标、chmod/chown/chgrp -R/--recursive、git 写子命令、curl\|sh、sudo、wrapper 家族）凌驾于档位之上。

决策管线：

```
前缀剥离（env/nice/timeout N/nohup/setsid/stdbuf/command/builtin/exec/time/VAR=x；
         sudo 不剥离直接叠加）→ 注册表查档 → 写动作扫描（R 可升级 W）→ glob/解析失败降 X
→ 信任域判定：T_plan = trustedExternalPaths（∪ os.tmpdir()）；T_build = cwd ∪ trusted；项目域 = cwd ∪ additionalProjectRoots ∪ findGitRoot 自动根（域内≠trusted，plan 写照样 deny）
→ 模式决策表（见下）
```

- **plan（只读契约）**：① 危险叠加静默 deny → ② 可枚举写目标 ∉ T_plan 静默 deny（含项目内文件）→ ③ 敏感文件 ask → ④ 全部段 R/W allow → ⑤ 含 X 段真兜底（strictPlanMode ? 静默 deny : ask，FR-10）
- **build**：① 危险叠加 ask → ② 敏感文件 ask → ③ 引用与写目标全部 ∈ T_build → allow（R/W/X 同权）→ ④ 纯 R（任意位置）allow → ⑤ 存在跨域引用兜底 ask（W 按 target 父目录、X 按 program 记忆）
- **yolo**：跳过全部判定直接放行，仅敏感文件仍 deny（FR-1）
- **前置层**：语法解析失败 → fail-closed（build=ask、plan=deny），不进上述决策表；`$()`/子 shell/进程替换/`bash -c` 在 bash 下先过 L1 内部门（内层全 R + 无 danger/cd/敏感才净化后走正常链，否则回退 fail-closed），powershell 维持 fail-closed
- 完整文案表（deny 反馈逐场景区分 + 红线）见仓库历史 plan.md B+ 节的设计裁决，改文案必须同步该表语义

## 源码结构（src/）

| 文件 | 职责 |
| -- | ---- |
| `index.ts` | 工厂装配：tool_call 拦截、approvalKey 细粒度记忆（FR-10 键按模式隔离）、CONFIG_HINTS（每 rule 会话一次）、denyFeedback（用户拒绝 vs 规则拒绝双后缀）、/readonly-tools 装配 |
| `bash.ts` | 自研简化解析器：顶层切分/token 化/重定向抽取、启动器前缀剥离、R/W/X 分类器（+ approvalId）、写动作扫描（find flag/sed -i/sort -o 等）、git 子命令三向归类 |
| `powershell.ts` | PowerShell 同构管线（pi 0.84.3+ Windows 可选工具）：别名归一化、cmdlet 读/写/危险注册表（命名参数路径抽取）、固定危险形态（iex/icm/Set-ExecutionPolicy/& 调用操作符/点源/脚本块/Remove-Item -Recurse）、`$()`/裸括号/@splatting fail-closed、原生 exe 回退 bash 分类；导出 POWERSHELL_ADAPTER |
| `decision.ts` | 双模式决策引擎（§上表）、ShellAdapter 通用核心（decideShellRequest，bash/powershell 共用决策表）、displayCommand 中段省略与分行展示、resolveSegmentCwds cd 跟踪、yolo 短路 |
| `path.ts` | normalizePath / realpathDeep（最深存在祖先解析，防父目录软链逃逸）/ isSensitivePath 三形态匹配 / isTrustedPath / isWithinCwd（Windows 盘符与 UNC 绝对路径恒为域外） |
| `config.ts` | DEFAULT_CONFIG 三注册表（读者/W/危险）+ 分层合并（数组并集）+ getAgentDir |
| `mode.ts` | plan/build/yolo 状态机、/plan /build /yolo 命令、Alt+P 快捷键、系统提示注入（plan 常驻、build/yolo 切入首轮一次性公告） |
| `tools.ts` | `/readonly-tools` 三级管理（session/project/global，每层只改自己，其他层锁定） |
| `ui.ts` | y/s/n/r 四选项确认弹窗（r 进 emacs 输入自定义理由），无 UI 环境降级为 deny |
| `audit.ts` | review/debug 双流 JSONL 日志：脱敏、字段宽度上限、按项目分目录、0600、大小轮转 |

依赖方向：`index → decision / config / mode / tools / ui / audit`；`decision → bash / powershell / path / config`。

## 设计约束（改动前必读）

- **三档完备是安全基石**：每个段必属 R/W/X 之一；未识别程序、glob/冷门语法解析失败一律降 X——禁止新增「看起来无害就当 R」的规则；禁止恢复「不在清单的 git 子命令视为只读」（假只读漏洞）
- **危险叠加与档位无关**：改写重试（如把 `python3 x.py` 拆成 mv/cp）永远逃不出叠加与敏感检查——这是「邀请改写」类文案的安全前提，动分类器时不得破坏
- **敏感判定永远优先于信任域**：trusted 目录内的敏感文件写仍弹窗（如 `/tmp/.env`）；危险叠加最先拦截
- **FR-10 批准键按模式隔离**（`unverified:<mode>:<program>`）：build 的执行器批准不得泄漏到 plan 只读契约；plan 无任何执行器豁免配置（设计裁决，勿重新引入）
- **realpathDeep 是写边界保证**：不存在目标的父目录软链必须深解析；新增路径判定入口时必须用 deep 形态而非 `realpathOf ?? abs`
- **find 起始路径识别**依赖带值选项表（FIND_OPTION_WITH_VALUE），扩充 find 相关处理时同步维护；省略起始路径默认 `.`
- **启动器剥离清单扩充必须配边界测试**：嵌套组合（sudo env nice timeout）、各家 flag（env -i/-u、timeout 30s、nice -n 5、time -p）、裸启动器回退；sudo/su 永不剥离
- **deny 文案三层纪律**：指令式而非解释式；用户拒绝（n 键）后缀 `User declined; do not retry this operation or variants.` 强停含变体；禁 bypass/work around 类措辞、禁教模型自行切模式；改文案同步回归断言
- **测试非交互运行**：`CI=true pnpm --filter @inobit/pi-permission test`（vitest 检测到 TTY 会进 watch 模式挂死）；软链/边界类 fixture 放 homedir 下，勿放 `/tmp`（trusted 前缀会掩盖越界）
