# Changelog

## [0.2.0] - 2026-08-21

- Add two families with six themes: Catppuccin (`catppuccin-latte` light / `catppuccin-frappe`, `catppuccin-macchiato`, `catppuccin-mocha` dark) and Solarized (`solarized-light` / `solarized-dark`)
- Catppuccin colors taken from the official palette; all four flavors share an isomorphic token mapping, mode differences live entirely in `vars` (including blended `bgSearch` / diff backgrounds)
- Solarized shares one color mapping across both modes; base-tone inversion is absorbed by `vars` (dark text = base0, light text = base00), accent tones identical in both modes
- New pairing examples: `"theme": "catppuccin-latte/catppuccin-mocha"`, `"theme": "solarized-light/solarized-dark"`

## [0.1.0] - 2026-08-19

- Add two families with four themes: Rosé Pine (`rosepine` dark / `rosepine-dawn` light), TokyoNight (`tokyonight` dark / `tokyonight-day` light)
- Distributed via `pi.themes` declaration, auto-registered in `/settings` theme list after install
- Each family ships dark + light, supports paired `theme: "light/dark"` auto-switching
- Palette semantics aligned with upstream: rosepine uses love/gold/rose/pine/foam/iris native palette; tokyonight day/night follows official palette and treesitter/base highlight mapping
