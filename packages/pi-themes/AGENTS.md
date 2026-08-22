# @inobit/pi-themes

纯主题包：为 Pi coding agent 提供 Rosé Pine、TokyoNight、Catppuccin 与 Solarized 四族亮/暗主题，安装即注册，可配对自动切换。零运行时代码、零第三方依赖。

## 结构

- `themes/*.json`：10 个 pi 主题文件（`rosepine`/`rosepine-dawn`/`tokyonight`/`tokyonight-day`/`catppuccin-latte`/`catppuccin-frappe`/`catppuccin-macchiato`/`catppuccin-mocha`/`solarized-light`/`solarized-dark`），通过 package.json 的 `pi.themes` 声明分发，无扩展代码

## 本包特有约束（改主题前必读）

- **name 全局唯一**，且不能含 `/`（`/` 被 pi 保留作自动亮/暗配对语法）；新增/改名后同步 README 主题表与 CHANGELOG
- **51 个必填颜色 token 全量保留**，缺一个 pi 都不加载该主题；`vars` 引用必须是已定义的变量，支持嵌套引用
- 颜色值 4 种格式：hex / 256 索引 / vars 引用 / 空串（终端默认色）
- **两族语义各自的映射保持同构**：两套（亮/暗）映射结构一致、仅色值随变体变化——
  - rosepine：`accent=pine/foam`、`success=pine`、`error=love`、`warning=gold`、heading=iris、link=pine/foam、syntax 用 muted/pine/foam/gold/iris/subtle
  - tokyonight：`accent=blue`、`success=teal`、`error=red1`、`warning=yellow`、`mdHeading=blue`、`mdLink=teal`、`mdCode=green`、syntax 用 comment/purple/blue/green/orange/blue1/blue5/fgDark
  - catppuccin：四 flavor（latte 亮，frappé/macchiato/mocha 暗）colors 块逐字同构、差异全部在 vars（含自调 `bgSearch`/`diffAddBg`/`diffRemoveBg`）；`accent=mauve`、`success=green`、`error=red`、`warning=peach`、`mdHeading`/`mdLink`/`syntaxFunction=blue`、`mdCode`/`syntaxString=green`、`syntaxType=yellow`、`syntaxOperator/thinkingLow=sky`、`bashMode=teal`
  - solarized：亮暗共用同一 colors 块，base 反转全部下沉到 vars（暗底 text=base0/muted=base01，亮底 text=base00/muted=base1）；`accent=blue`、`success=green`、`error=red`、`warning=yellow`、`syntaxString`/`bashMode=cyan`、`syntaxKeyword=green`、`syntaxType=yellow`、thinking 渐变 cyan→blue→violet→magenta→red
- tool 状态背景（`toolSuccessBg`/`toolErrorBg`）用各主题的 diff add/delete 背景色，与前景 diff 色一致
- `thinking*` 边框按 pi 语义从弱到强渐变（灰 → 主题冷色 → 主题高亮色 → 红/玫红最醒目）
- 随手改色值可直接本地热重载预览（pi 对当前激活的主题文件有 watcher）；改完用脚本核对 colors 键数（55 = 51 必填 + 4 可选）与 vars 引用完整性
