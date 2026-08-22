# @inobit/pi-packages

**English** | [中文](./README.zh-CN.md)

A pnpm workspace monorepo of extensions for [Pi coding agent](https://pi.dev). Targets `@earendil-works/pi-coding-agent` 0.84.2+, loaded directly via jiti — no build step.

## Packages

| Package | Description |
| -- | --- |
| [`@inobit/pi-permission`](packages/pi-permission) | Lightweight permission control: sensitive file protection / project-boundary read-write separation / dangerous operation confirmation / plan-build read-only mode |
| [`@inobit/pi-reader`](packages/pi-reader) | Reading mode: `alt+o` to toggle read-only, Vim-style paging (`ctrl-u/d/f/b` `gg/G` `j/k`), `?` help |
| [`@inobit/pi-todo`](packages/pi-todo) | Minimal-intrusion task list: `todo` tool + `/todos` command + persistent panel above the editor, state stored on the session branch and replayable |
| [`@inobit/pi-undo`](packages/pi-undo) | Undo last prompt: `/undo` + `alt+u`, single-per-turn, queue-aware, abort-then-undo |
| [`@inobit/pi-themes`](packages/pi-themes) | Curated themes: Rosé Pine, Tokyonight, Catppuccin and Solarized families with light & dark variants supporting `theme: "light/dark"` paired auto-switching |

See each package's README (links above) for installation, configuration, and usage.

## Requirements

| Item | Version |
| -- | --- |
| Node.js | >=24 |
| pnpm | 11.22.0 (locked via `packageManager`) |
| Pi coding agent | 0.84.2+ |

## Development

```bash
pnpm install                # install dependencies
pnpm check                  # type-check entire workspace (= pnpm -r run check)
pnpm test                   # run all tests (= pnpm -r run test)
pnpm --filter <pkg> test    # single package (e.g. --filter @inobit/pi-permission)
pnpm --filter <pkg> pack:check   # verify publish tarball
pi -ne -e ./packages/<pkg>   # local smoke (jiti direct load, --no-extensions excludes installed old version)
```

## License

MIT
