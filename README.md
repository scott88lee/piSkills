# piSkills

A collection of skills for [pi](https://github.com/badlogic/pi-mono) (the coding agent).

Each top-level directory is one self-contained skill.

## Skills

| Skill | Description |
| --- | --- |
| [web-browse](./web-browse) | Render JS-heavy pages in Chrome (headless or visible, CDP) and extract text, HTML, links, screenshots, or PDFs; supports clicking, typing, JS evaluation, and a persistent visible browser for human login; screenshots are viewable by the agent (multimodal) |

## Install

Copy any skill directory into your skills folder:

```bash
git clone https://github.com/scott88lee/piSkills
cp -r piSkills/web-browse ~/.agents/skills/
```

Skills are picked up automatically by pi (and other agents that read `~/.agents/skills/`).

## Requirements

- **web-browse**: system Chrome/Chromium + Node >= 22. No npm dependencies.

## Verify

```bash
node ~/.agents/skills/web-browse/scripts/browse.mjs text https://example.com
```
