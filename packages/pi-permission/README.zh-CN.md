# @inobit/pi-permission

[English](./README.md) | **中文**

轻量权限控制扩展，用于 [Pi coding agent](https://pi.dev)。按「效果可证明性」分档决策，只拦该拦的，其余一概不打扰：

1. **敏感文件保护**：`.env`、`~/.ssh/*`、`*.pem`、`.npmrc`、`~/.config/gh/hosts.yml` 等，任何通道（工具/bash）的读与写都弹窗确认。
2. **信任域边界**：plan 只读（跨域写静默拒绝）；build 下信任域 = 项目目录 ∪ trusted 路径，域内放行、跨域设门。
3. **危险操作确认**：`git push`/`rm -rf`、`sudo`、`curl | sh` 等危险叠加始终确认；不可证执行（解释器/未知程序）在 plan 下确认、build 域内放行。
4. **plan/build 模式**：`/plan` 只读（跨域写静默拒绝），`/build` 回到正常模式。

## 效果分类模型（R/W/X）

命令按「副作用能否从参数完整推导」分三档，另加一层危险叠加：

| 档 | 判定 | 例子 |
| -- | ---- | ---- |
| **R 纯读者** | 无文件副作用 | cat/grep/jq/git status/sort(无 -o) |
| **W 有界写者** | 写目标可从参数穷举（可解析） | touch/mkdir/cp/mv/sed -i/重定向/find -delete |
| **X 不透明** | 效果不可从参数推导——解释器、构建工具、一切未识别程序与解析失败降级 | python3/npm/make/bash -c/tar 解压/patch |

危险叠加（rm 递归/通配目标、chmod/chown -R、git 写子命令、curl\|sh、sudo、bash -c、xargs、find -exec）凌驾于档位之上，维持既有产品契约。

## 特性

- 零第三方依赖（除 pi 核心包），纯本地确定性决策，fail-closed 绝不静默放行
- 只读/写精确区分到路径粒度，符号链接/相对路径不可绕过，cd 后相对路径正确判定
- 敏感文件规则跨所有工具 + bash 统一生效
- trusted 临时目录（`/tmp`）豁免：plan/build 下 /tmp 内读写直接放行（计划中用临时文件验证计算友好），危险/敏感判定不受影响
- 高频必需操作（`cat`/`grep`/`ls`/`git status`/`sleep` 等）零打扰

## 安装

```bash
pi install npm:@inobit/pi-permission
```

## 命令

```
/plan   进入只读规划模式（写操作拒绝，状态栏显示 Plan）
/build  回到正常模式（Build）
/chill  进入 chill 模式（"放松"档：只有严重操作才弹窗，敏感文件仍拦，状态栏显示 Chill）
/yolo   进入 yolo 模式（彻底放行但敏感文件仍拦，需二次确认，状态栏显示 Yolo）
/readonly-tools   管理 plan 模式只读工具（空格多选，session/project/global 三级）
```

- 默认 `defaultMode`（默认 build）模式，会话级、不持久化（重启回到 `defaultMode`），`yolo` 需 `y: confirm yolo` 二次确认且无快捷键，`chill` 无需二次确认
- **切换快捷键**：`Alt+P` 按 plan → build → chill → plan 循环切换（可在 `toggleModeShortcut` 配置中改为其他键位，空字符串禁用，键位格式见 pi [keybindings](https://pi.dev/docs/keybindings)）
- 状态栏：`Plan` 绿 / `Build` 主题色 / `Chill` 橙 / `Yolo` 红（主题色），键名 `pi-permission-mode`

## 核心决策路径

### plan 模式（只读契约）

```
危险叠加命中（rm -rf / git push / sudo / curl|sh …）      → 静默 deny
可枚举写目标超出信任域 T_plan（含项目内文件）               → 静默 deny
涉及敏感文件（读或写）                                     → ask
全部段为 R 或 W（写目标已证明全在信任域内）                 → allow
含 X 段真兜底（解释器/未知程序/解析失败降级）               → strict ? 静默 deny : ask
```

### build 模式

```
危险叠加命中                                              → ask
涉及敏感文件（读或写）                                     → ask
所有段的引用与写目标全部 ∈ 信任域 T_build（cwd ∪ trusted）  → allow（R/W/X 同权）
纯 R（引用任意位置）                                       → allow
其余（W/X 存在跨域引用）                                   → ask
```

前置层：语法解析失败 / `$()` / 子 shell / 进程替换 → fail-closed（build=ask，plan=deny），不进上表。yolo 模式跳过全部判定直接放行，仅敏感文件仍 deny。ask 弹窗选 `s` 按 program/path/父目录粒度会话内免问；hint 每 rule 会话内只提示一次。

### chill 模式（"放松"档）

chill 取英文"放松"义（chill = relaxed），不是"冷/冻结"。它位于 build 与 yolo 之间：取消信任域与不可证执行两道关卡，只保留**严重操作**（critical）与**敏感文件**两处拦截。解析失败、变量缺失、多层嵌套包装一律放行。chill 的放行只写 debug 日志（默认关闭）。

```
涉及敏感文件（读或写）                                    → deny（FR-1；chillSensitiveAction=ask 时改弹窗）
命中严重清单（配置清单 / 固定规则 / 静态字面载荷）          → ask（FR-4）
其余（危险叠加、跨域引用、wrapper、X 程序、不可解析、未知）  → allow（FR-5）
```

严重集合是危险谓词集中"主机级、难以逆转"的子集（不变式 `critical ⟹ danger`），因此**每个 critical 命令在 build 也 ask、在 plan 也 deny**。chill 的弹窗范围是该集合的收窄子集：`rm`/`Remove-Item` 仅当递归（`-r`/`-R`/`--recursive`）命中下列黑名单路径或通配目标时才 ask，`chmod` 仅数字 token `0?777` 命中时 ask。chill 会弹窗的默认清单全文：

```
bash   rm -r/-R/--recursive 命中黑名单路径或通配目标、chmod 777/0777/7777、
       dd、mkfs*、fdisk、gdisk、parted、wipefs、shutdown、reboot、halt、poweroff、init、管道执行（curl|sh 等）
PS     Format-Volume、diskpart、Remove-Computer、Restart-Computer、Stop-Computer、Clear-Eventlog、
       Remove-Item -Recurse 命中黑名单路径或通配目标、iex/Invoke-Expression、icm/Invoke-Command、嵌套 pwsh/powershell
共用   解释器 -c/-e 字面载荷命中 critical 谓词（rm -rf /、dd、shutdown 等）
```

两套 `rm`/`Remove-Item` 黑名单全文（清单之外一律不在黑名单内）：

- **bash POSIX（15 条 + `~`/`$HOME` 字面形态）**：Linux `/` `/bin` `/sbin` `/lib` `/lib64` `/usr` `/etc` `/boot` `/opt` `/root` `/home`，外加 macOS 对照 `/Users` `/System` `/Library` `/Applications`，外加 `~`、`~user`、`$HOME`、`${HOME}` 字面（`~`/`$HOME` 经 `os.homedir()` 展开，Linux 归 `/home/<user>` 或 `/root`，macOS 归 `/Users/<user>`；`~user` 不可展开，故任何 `~` 前缀整体拦）。`/usr/local` 与 `/opt/homebrew` 无需单列（已被 `/usr`、`/opt` 前缀覆盖）。`/var` `/srv` `/dev` `/proc` `/sys` `/tmp` `/mnt` 有意不在内，`/private`（`/etc` `/tmp` `/var` 的 symlink 宿主，列了会误拦 `/private/tmp`）与 `/Volumes`（挂载卷，同 `/mnt` 口径）同样不列。匹配为大小写敏感（POSIX 语义），归一（`~`/`$HOME` 展开、`//` 压成 `/`、去尾斜杠）后命中 = 等于条目或以「条目 + `/`」开头；`/` 只匹配精确根。
- **bash Windows 形态目标（git-bash：盘符、反斜杠、`$env:` 写法）**：任意盘符根（`X:\` 精确根，`X:\Users` 不算）、Windows 目录（`$env:SystemRoot` 展开，含 `System32`，`SystemRoot` 优先于缺省回退值 `C:\Windows`）、用户主目录（`os.homedir()`、`$env:USERPROFILE`/`$env:HOMEPATH`、`~` 展开）。匹配为大小写不敏感，`\` 与 `/` 统一、`//` 压成 `/`、去尾分隔符。
- **PowerShell（`Remove-Item`）**：与上述 Windows 对照同口径三条——任意盘符根、`$env:SystemRoot`（缺省 `C:\Windows`）、当前用户主目录（`~`/`$HOME`/`$env:USERPROFILE`/`$env:HOMEPATH`，未定义时回退 `os.homedir()`）。

已知取舍：**chill 不拦系统路径上的递归 `chmod`/`chown`**——`chown -R alice /home`、`chmod -R 755 /etc`、`Remove-Item -Recurse C:\tmp` 一律放行（它们仍是 `danger`，build 下照常 ask、plan 下 deny）。`chmod 644 report777.md` 也不受影响：数字规则只整 token 匹配 `0?777`。

`dangerousBashCommands`/`dangerousPowerShellCommands` 仍是完全可配置的（跨层并集）；`criticalBashCommands`/`criticalPowerShellCommands` 同样可追加配置，其默认值是危险默认值的子集（bash 15/15、PowerShell 6/6 重合），因此默认安装下本次发布只改变 chill 行为（外加下面两条共享固定规则），`plan`/`build`/`yolo` 既有语义不变。chill 的静态字面展开上限 2 层，且不展开脚本文件、编码载荷与动态值。

### build 行为变化（两条共享固定规则）

以下两类谓词现在**所有模式**下都是 critical，因此 build 由原来的放行改为 ask、plan 由 ask 改为 deny：

- 裸 `chmod 777 <file>` / `chmod 0777`——只匹配数字 token `0?777`；符号形态（`a+rwx`、`u=rwx,go=rwx`）与 `chmod 644` 不受影响
- 解释器字面载荷命中 critical 命令：`python3 -c "os.system('rm -rf /')"`、`node -e "require('child_process').exec('dd if=/dev/zero of=/dev/sda')"`；混淆、base64 编码、拼接与脚本文件形态维持原有 X 处理

## 威胁模型与残余风险（务必知悉）

- build 信任域内放行 = 接受域内任意代码执行的完整能力包。脚本内容可以隐形跨越信任域（写 `~/.ssh`、联网）——权限系统看到的是命令表面而非代码行为。**本扩展是进程内规则层，不是沙箱**；真隔离请用容器/一次性环境
- W 类安全性 = 目标枚举的正确性；冷门语法解析失败会保守降级为 X，但枚举 bug 本身会成为误放行
- TOCTOU/符号链接竞态仅能缓解不能根除；多用户机器上 `/tmp` 世界可写
- plan 无任何执行器豁免机制：X 段一律 ask（strict 下静默 deny），只读契约完整
- **chill 是便利档不是安全档**：它和 build 一样允许域内任意代码执行（解释器、构建工具）与不可解析命令，区别只是不再弹窗。chill 的会话级批准按模式隔离（键 `dangerous:<mode>:...`），不会把 build 下的同一程序也放行
- PowerShell 工具下 POSIX 形态 `rm -rf /`（含 `& "rm -rf /"`）归一为 `remove-item` + POSIX `/`，`/` 非盘符根故不经 remove-item 黑名单，chill 直接放行；bash 工具不受影响（`rm -rf /` 照常 ask）
- 解释器 `-c`/`-e` 字面载荷用的是**宽** critical 谓词（与 build/plan 同一套），不按 chill 收窄黑名单判定：`python3 -c "os.system('rm -rf ./dist')"` 在 chill 仍弹窗，而同形态顶层 `rm -rf ./dist` 放行——解释器字面一律取保守（宁多弹一次不漏）
- `cmd /c "…"` 的引号载荷不做解释器字面解包：`cmd /c "rm -rf /"` 在 chill 直接放行（build 靠 wrapper danger 走 FR-10 弹窗）；PowerShell 工具下 `bash -c "…"` 同样未被当作 wrapper，chill 与 build 均放行（bash 工具下 `bash -c` 仍带 wrapper 标记，不受影响）
- `mkfs*` 由固定**前缀规则**匹配（任何 `mkfs.<fs>` 形态），无法通过改 `criticalBashCommands` 移除；反之你自行追加的 critical 条目只参与并集匹配，不受该固定规则覆盖
- `chmod` 数字规则只匹配字面数字 token `777`/`0777`/`7777`（位置不限），不解析实际权限位（`chmod 40777`、`chmod a+rwx`、umask 等价写法均不算 critical）
- 解释器字面载荷检测是对 `-c`/`-e` 字符串做正则浅扫，混淆、base64/十六进制编码与拼接形态不在覆盖范围（chill 下放行）。字符串里**仅提到**危险命令同样命中（`python3 -c "print('rm -rf /')"` 会弹窗），属浅层网而非静态分析器

## 配置

按层级合并（数组字段跨层**并集**去重，非数组字段高层覆盖）：

| 层级 | 位置 |
| -- | ---- |
| 全局 | `~/.pi/agent/extensions/pi-permission/config.json` |
| 项目 | `.pi/extensions/pi-permission/config.json`（需项目被信任） |
| session | 内存（`/readonly-tools` 选 session，重启失效） |

| 字段 | 含义 | 默认 |
| -- | ---- | ---- |
| `sensitivePatterns` | 敏感文件 glob 清单 | `*.env` `*.env.*` `~/.ssh/*` `*.pem` `*.key` `id_rsa*` `credentials.json` `secrets*.yaml` `~/.aws/*` `.npmrc` `~/.config/gh/hosts.yml` |
| `envExampleReadAllowed` | `.env.example` 读取免弹窗 | `true` |
| `readonlyBashCommands` | bash read 白名单 | 高频只读命令（cat/grep/ls/...，92 项） |
| `dangerousBashCommands` | 敏感操作统一清单（`sudo` 或 `git commit`） | git 写子命令 + 危险 shell |
| `readonlyPowerShellCommands` | PowerShell read 白名单（规范 cmdlet 名，匹配前别名已归一化） | 只读 cmdlet（get-childitem/get-content/select-string/...） |
| `dangerousPowerShellCommands` | PowerShell 敏感操作清单 | start-process / add-type / register-scheduledtask / ... |
| `criticalPowerShellCommands` | PowerShell 严重操作清单（critical，比 dangerous 高一级） | format-volume、diskpart、remove-computer、restart-computer、stop-computer、clear-eventlog |
| `criticalBashCommands` | bash 严重操作清单（critical，比 dangerous 高一级；chill 恒弹窗，其它模式下与 dangerous 取并集参与匹配） | dd、mkfs、fdisk、gdisk、parted、wipefs、shutdown、reboot、halt、poweroff、init |
| `chillSensitiveAction` | chill 模式下敏感文件 deny（默认）或 ask | `deny` |
| `defaultMode` | 会话启动时的模式（仅 build/chill；`plan`、`yolo` 与非法值回退 build） | `build` |
| `trustedExternalPaths` | trusted 外部路径前缀：前缀下读写直接放行（如 `/tmp` 临时文件；运行时并入系统临时目录 `os.tmpdir()`） | `["/tmp"]` |
| `additionalProjectRoots` | 附加项目根：视为域内（对标 OpenCode 启动目录 ∪ worktree 根）；域内≠trusted——plan 下写此类目录照样 deny；自动识别的 git 根恒包含 | `[]` |
| `readonlyTools` | 工具 read 白名单（各层并集） | `read grep find ls` |
| `strictPlanMode` | plan 下不可证执行（X 段兜底）由 ask 收紧为静默 deny | `false` |
| `toggleModeShortcut` | plan/build 切换快捷键（空字符串禁用） | `alt+p` |
| `reviewLog` | 审查日志开关（FR-6） | `true` |
| `debugLog` | 调试日志开关（与审查日志分离，详细事件） | `false` |
| `logDir` | 日志目录（相对 `~/.pi/agent`，尊重 `PI_CODING_AGENT_DIR`；支持绝对路径与 `~/`，0600；扩展目录仅放配置） | `logs/pi-permission` |

> 固定规则（不可配置）：内置写工具 `write`/`edit`、`rm` 递归/通配目标、`chmod -R`、`chown -R`、
> `curl/wget | sh/bash`、`bash -c`/`eval`/`sudo`/`xargs`/`find -exec`、`find -delete/-fls/-fprint*` 恒为敏感操作或写动作；
> `chmod` 数字形态 `0?777` 与解释器 `-c`/`-e` 字面载荷命中 critical 命令恒为 critical（所有模式共享，见上「build 行为变化」）；
> 重定向 `>`/`>>` 写目标固定检测；启动器前缀（`env`/`nice`/`timeout N`/`nohup`/`setsid`/`stdbuf`/`VAR=x`）自动剥离后按真实程序分类（`sudo` 不剥离直接拦截）；git 未识别子命令按 X 处理。
> 弹窗 reason 带 `[bash]` / `[tool:<name>]` 来源前缀；hint 每 rule 会话内只展示一次。
>
> **PowerShell 工具**（pi 0.84.3+，仅 Windows，需在 `defaultTools` 中显式启用）：与 bash 同一套 R/W/X 管线。别名先归一化（`gci`→`get-childitem`、`rm`→`remove-item`、`cat`→`get-content` 等）；原生 exe（git/node/npm）回退复用 bash 注册表。
> PowerShell 固定危险形态（不可配置）：`iex`/`Invoke-Expression`、`icm`/`Invoke-Command`、`Set-ExecutionPolicy`、嵌套 `pwsh`/`powershell` 调用（含 `-EncodedCommand`）、调用操作符 `&`、点源 `. ./x.ps1`、脚本块 `{...}`、`Remove-Item -Recurse/-Force`、管道执行（`irm|iex`）；`$()` 子表达式、裸括号分组、@splattting、here-string 一律 fail-closed。二义性名称保守处理：`curl`/`wget` 按 X（PS 5.1 别名 vs PS 7 真 exe），`sc` 恒按服务控制器处理。
>
> **日志位置**：默认 `~/.pi/agent/logs/pi-permission/<project>/pi-permission-{review,debug}.jsonl`（更规范，与 `pi-debug.log` 同级），按项目分目录隔离，文件 `0600`、目录 `0700`、支持大小轮转。扩展目录 `~/.pi/agent/extensions/pi-permission` 仅放 `config.json`。自定义可用绝对路径或 `~/`，如 `"logDir": "~/my-logs/pi-permission"` 或 `"/var/log/pi-permission"`。
>
> **信任域边界**：敏感判定永远优先于信任域——即使位于 trusted 目录内，命中敏感文件的写入（如 `/tmp/.env`）plan/build 下均弹窗确认；危险命令与路径无关，始终最先拦截；realpath 双形态防软链逃逸。

## 询问弹窗（Ask Dialog）

`ask`（需确认）为 4 选项选择器 + 可选 emacs 输入。所有拒绝均为 `terminate:false` 让模型立即看到 `reason` 并继续，仅 `Esc` 硬终止为 `true`。

| 按键 | 动作 | terminate | 审计 |
| --- | --- | --- | --- |
| `y` | 允许本次 | — | `allow-after-ask` |
| `s` | 允许本会话（记忆为 `<session>:<approvalKey>`） | — | `allow-after-ask` + `sessionApprovals` |
| `n` | 拒绝（默认） | `false`（模型继续） | `deny` |
| `r` | 拒绝并给出理由 → emacs 输入 | `false`（完全替换 `denyFeedback` 文本，模型继续） | `deny` + `customReason`（截断、脱敏） |
| `Esc`（选择器上） | 硬终止 — 拒绝并停止 | `true`（强制） | `deny` + `terminatedByEsc`（`reason="[pi-permission] Denied by user — stopping."`） |

**`r` 第二层**（`ctx.ui.input`，继承 `tui.input.*` 的 emacs 键位 `C-a/e/k/u/f/b`）：标题 `Deny reason — emacs keys, Enter submit, Esc to go back`，占位符 `e.g. use .env.example instead`。空输入（`trim()===""`）提示 `reason cannot be empty` 并停留；`Esc`（`input===undefined`）回到 4 选项选择器；`Enter` 非空返回 `{kind:"reason", customReason}`，文本完全替换为 `[pi-permission] User denied: <custom>`。无 UI（`rpc`/`print`）降级为 `notify` + 默认 `deny`。

```
ask → 选择 [y/s/n/r]
  ├─ y/s → 允许（s 会话记忆）
  ├─ n   → 拒绝（默认，terminate:false 模型继续）
  ├─ r   → 输入（emacs）
  │        ├─ 非空回车 → 拒绝并替换理由（terminate:false）
  │        ├─ 空回车   → 停留（提示）
  │        └─ Esc     → 回到选择器
  └─ Esc  → 拒绝并硬终止（强制 true）
```

## /readonly-tools 交互

空格选中/取消选中、`↑`/`↓`/`j`/`k` 移动、`Enter` 完成、`Esc`/`q` 取消。先选编辑目标（**每层只改自己，其他层锁定**）：

- **session**（内存，会话级）：内置 + 全局 + 项目已配置工具锁定
- **project**（写项目 `.pi/extensions/pi-permission/config.json`）：内置 + 全局已配置锁定，需项目被信任
- **global**（写全局 config.json）：仅内置工具锁定

内置工具（`read`/`grep`/`find`/`ls`）、`bash`、`write`/`edit` 恒锁定。

## 与状态栏插件集成

- **pi 内置 statusline**：`Plan`/`Build` 显示在 footer 扩展状态行，无需配置。
- **pi-powerline-footer**：状态值不带 `[` 前缀，进入 `extension_statuses` 聚合段；放主状态栏最左边时配置：

```json
{
  "powerline": {
    "preset": "default",
    "placement": "below",
    "customItems": [
      { "id": "pi-mode", "statusKey": "pi-permission-mode", "position": "left", "excludeFromExtensionStatuses": true }
    ],
    "layout": { "left": ["custom:pi-mode", "model", "thinking", "shell_mode", "path", "git", "queue", "context_pct", "cache_read", "cost"] }
  }
}
```

## 开发

```bash
pnpm --filter @inobit/pi-permission check   # tsc --noEmit
pnpm --filter @inobit/pi-permission test    # vitest
pnpm --filter @inobit/pi-permission pack:check
pi -ne -e ./packages/pi-permission
```

## License

MIT
