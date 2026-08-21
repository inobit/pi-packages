# @inobit/pi-themes

[English](./README.md) | **中文**

一套精选的 [Pi coding agent](https://pi.dev) 主题包，内置两族主题，各含**亮色 + 暗色**变体，配合 pi 的 `theme: "亮/暗"` 配对语法可跟随终端配色自动切换（与内置 `light/dark` 同一机制）。

## 主题

| 主题名 | 变体 | 配色来源 |
| ------ | ---- | -------- |
| `rosepine` | 暗色（Rosé Pine main） | [rose-pine](https://rosepinetheme.com/palette/) + opencode 内置 rosepine 主题 |
| `rosepine-dawn` | 亮色（Rosé Pine dawn） | 同上 |
| `tokyonight` | 暗色（night 变体） | [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) |
| `tokyonight-day` | 亮色（day 变体） | 同上 |

## 安装

```bash
pi install npm:@inobit/pi-themes
```

安装后四个主题进入 `/settings` 的主题列表，可直接选用。

## 启用

**固定使用某个主题**：

```bash
# 在 /settings 里选，或 settings.json 写入
"theme": "rosepine-dawn"
```

**亮/暗自动切换（跟随终端配色）**：把 `theme` 设置成配对字符串，斜杠左侧是亮色、右侧是暗色：

```jsonc
// settings.json
{
  "theme": "rosepine-dawn/rosepine"
}
```

```jsonc
// settings.json
{
  "theme": "tokyonight-day/tokyonight"
}
```

也可在 `/settings` 里直接选择配对项。pi 检测终端为暗色时用右侧主题、亮色时用左侧主题，终端切换配色时实时跟随。

> 提示：不想为某个终端配色配定制主题时，可直接对内置主题取用，例如 `"theme": "rosepine-dawn/dark"`。

## 调整

编辑主题文件后 pi 自动热重载，所见即所得。主题格式与全部颜色 token 见 pi 官方 [Themes](https://pi.dev/docs/themes) 文档。

## 开发

```bash
pnpm --filter @inobit/pi-themes pack:check   # 检查发布 tarball
pi -ne -e ./packages/pi-themes
```

## 致谢

- 配色语义遵循 [Rosé Pine](https://rosepinetheme.com/palette/)（dawn/main 变体）与 [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim)（day/night 变体）的原生设计。
