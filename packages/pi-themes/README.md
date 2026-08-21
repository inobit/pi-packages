# @inobit/pi-themes

**English** | [中文](./README.zh-CN.md)

A curated theme pack for [Pi coding agent](https://pi.dev) with two families, each shipping **light + dark** variants. Pair them with Pi's `theme: "light/dark"` syntax to follow the terminal color scheme automatically (same mechanism as the built-in `light/dark`).

## Themes

| Theme | Variant | Palette source |
| --- | --- | --- |
| `rosepine` | Dark (Rosé Pine main) | [rose-pine](https://rosepinetheme.com/palette/) + opencode's built-in rosepine theme |
| `rosepine-dawn` | Light (Rosé Pine dawn) | Same as above |
| `tokyonight` | Dark (night variant) | [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) |
| `tokyonight-day` | Light (day variant) | Same as above |

## Installation

```bash
pi install npm:@inobit/pi-themes
```

After installation, all four themes appear in the `/settings` theme list.

## Usage

**Pin to a single theme**:

```bash
# Pick in /settings, or write to settings.json
"theme": "rosepine-dawn"
```

**Auto-switch with terminal scheme**: set `theme` to a paired string — left of the slash is the light theme, right is the dark theme:

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

You can also pick the paired entry directly in `/settings`. Pi uses the right-hand theme when the terminal is dark and the left-hand theme when it is light, updating live as the terminal scheme changes.

> Tip: to avoid customizing a theme for one side, mix with a built-in, e.g. `"theme": "rosepine-dawn/dark"`.

## Customization

Pi hot-reloads theme files on edit for instant feedback. See Pi's official [Themes](https://pi.dev/docs/themes) docs for the theme format and all color tokens.

## Credits

- Palette semantics follow the original designs of [Rosé Pine](https://rosepinetheme.com/palette/) (dawn/main) and [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) (day/night).

## License

MIT
