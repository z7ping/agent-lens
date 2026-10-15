# Agent brand icons

Locally bundled to avoid remote image requests at runtime.

| Local file | Source | Notes |
| --- | --- | --- |
| `pi.svg` | [LobeHub icons: Pi](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/pi.svg) | Pi brand mark |
| `codex.svg` | [LobeHub icons: Codex](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/codex.svg) | Monochrome |
| `claude-code.svg` | [LobeHub icons: Claude Code](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/claudecode-color.svg) | Official brand color |
| `hermes.svg` | [LobeHub icons: Hermes Agent](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/hermesagent.svg) | Monochrome |
| `opencode.svg` | [OpenCode favicon](https://github.com/anomalyco/opencode/blob/dev/packages/app/public/favicon-v3.svg) | Sourced from the OpenCode repository (path and branch reflect retrieval) |

LobeHub icons are distributed under the MIT License in `LICENSE.lobe-icons.txt` (included). Logo names and brand assets remain trademarks of their respective owners; use only for identifying their products. If a project does not have a verified logo, the UI uses a neutral generic agent icon rather than inventing one.

Theme adaptation: the `AgentLogo` component uses a fixed local asset map; monochrome logos are inverted for dark mode in its shared stylesheet. No runtime remote fetch or user-provided paths.
