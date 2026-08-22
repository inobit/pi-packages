# @inobit/pi-themes

**English** | [中文](./README.zh-CN.md)

A curated theme pack for [Pi coding agent](https://pi.dev) with four families of **light + dark** variants. Pair them with Pi's `theme: "light/dark"` syntax to follow the terminal color scheme automatically (same mechanism as the built-in `light/dark`).

## Themes

| Theme | Variant | Palette source |
| --- | --- | --- |
| `rosepine` | Dark (Rosé Pine main) | [rose-pine](https://rosepinetheme.com/palette/) + opencode's built-in rosepine theme |
| `rosepine-dawn` | Light (Rosé Pine dawn) | Same as above |
| `tokyonight` | Dark (night variant) | [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) |
| `tokyonight-day` | Light (day variant) | Same as above |
| `catppuccin-latte` | Light (Latte flavor) | [Catppuccin palette](https://catppuccin.com/palette/) |
| `catppuccin-frappe` | Dark (Frappé flavor) | Same as above |
| `catppuccin-macchiato` | Dark (Macchiato flavor) | Same as above |
| `catppuccin-mocha` | Dark (Mocha flavor) | Same as above |
| `solarized-light` | Light (Solarized light) | [Solarized](https://ethanschoonover.com/solarized/) |
| `solarized-dark` | Dark (Solarized dark) | Same as above |

## Installation

```bash
pi install npm:@inobit/pi-themes
```

After installation, all ten themes appear in the `/settings` theme list.

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

```jsonc
// settings.json
{
  "theme": "catppuccin-latte/catppuccin-mocha"
}
```

```jsonc
// settings.json
{
  "theme": "solarized-light/solarized-dark"
}
```

You can also pick the paired entry directly in `/settings`. Pi uses the right-hand theme when the terminal is dark and the left-hand theme when it is light, updating live as the terminal scheme changes.

> Tip: to avoid customizing a theme for one side, mix with a built-in, e.g. `"theme": "rosepine-dawn/dark"`.

## Customization

Pi hot-reloads theme files on edit for instant feedback. See Pi's official [Themes](https://pi.dev/docs/themes) docs for the theme format and all color tokens.

## Credits

- Palette semantics follow the original designs of [Rosé Pine](https://rosepinetheme.com/palette/) (dawn/main), [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) (day/night), the [Catppuccin palette](https://catppuccin.com/palette/) (latte/frappé/macchiato/mocha), and [Solarized](https://ethanschoonover.com/solarized/) (light/dark).

## Development

```bash
pnpm --filter @inobit/pi-themes pack:check   # verify publish tarball
pi -ne -e ./packages/pi-themes
```

## License

MIT
