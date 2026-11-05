# piSkills

A collection of skills and extensions for [pi](https://github.com/badlogic/pi-mono) (the coding agent).

Each top-level skill directory (e.g. `web-browse/`) is self-contained.
`extensions/` holds pi **extensions** — executable behaviour rather than instructions.

## Skills

| Skill | Description |
| --- | --- |
| [web-browse](./web-browse) | Render JS-heavy pages in Chrome (headless or visible, CDP) and extract text, HTML, links, screenshots, or PDFs; supports clicking, typing, JS evaluation, and a persistent visible browser for human login; screenshots are viewable by the agent (multimodal) |

## Extensions

| Extension | Description |
| --- | --- |
| [sudo-confirm](./extensions/sudo-confirm) | Blocks any bash command containing `sudo` until you confirm it in the terminal; fails closed in non-interactive modes. Includes the matching passwordless-sudo setup and example `models.json` / `settings.json` for reproducing a pi setup on a new machine |

## Install

```bash
git clone https://github.com/scott88lee/piSkills

# skill -> ~/.agents/skills/
cp -r piSkills/web-browse ~/.agents/skills/

# extension -> ~/.pi/agent/extensions/
mkdir -p ~/.pi/agent/extensions
cp piSkills/extensions/sudo-confirm/sudo-confirm.ts ~/.pi/agent/extensions/
```

Skills are picked up automatically by pi (and other agents that read `~/.agents/skills/`).
Extensions load from `~/.pi/agent/extensions/` on pi startup; restart pi or run
`/reload` after adding one.

## Requirements

- **web-browse**: system Chrome/Chromium + Node >= 22. No npm dependencies.
- **sudo-confirm**: none. pi compiles the TypeScript for you.

## Verify

```bash
# web-browse
node ~/.agents/skills/web-browse/scripts/browse.mjs text https://example.com

# sudo-confirm — ask pi to run `sudo id`; it should prompt for confirmation first
```
