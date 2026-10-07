---
name: web-browse
description: Render JavaScript-heavy web pages in headless Chrome and extract text, HTML, links, screenshots, or PDFs; supports waiting for selectors, clicking, typing, and JS evaluation via the CDP debug port. Can also drive a persistent VISIBLE Chrome (serve) so sites that require login/auth work. Use when curl/fetch returns only a navigation shell or empty content (SPAs, client-side rendered sites), when a page needs JS to execute before content appears, when interactive steps (click, type) are needed, when a page is behind a login, or when you need a screenshot of a page.
---

# Web browse

Controls headless Chrome over the CDP debug port (default 9222). Zero dependencies: system Chrome/Chromium + Node >= 22.

If nothing is listening on the port, the script launches its own headless Chrome, uses it, and kills it on exit. If a working CDP Chrome is already listening (e.g. one you started for debugging), it attaches to the first page tab — so you can also drive a browser you launched yourself with `--remote-debugging-port=9222`. If the port is occupied by something that is *not* a CDP endpoint (a stale process, another app), the script automatically picks a free port and launches there instead of failing.

## Usage

Run the script relative to this skill directory:

```
node scripts/browse.mjs [options] <command> [args...]
```

Commands:
- `text <url>` — visible text (body.innerText); the default workhorse
- `html <url>` — rendered DOM after JS runs; use for tables or exact markup
- `links <url>` — deduplicated hrefs; use to discover SPA navigation
- `eval <url> <js>` — evaluate JS in the page, print result (objects pretty-printed)
- `shot <url> [outfile]` — full-page PNG (default `/tmp/browse-<ts>.png`, path printed)
- `pdf <url> [outfile]` — print-to-PDF (default `/tmp/browse-<ts>.pdf`, path printed)
- `click <url> <selector>` — navigate, wait, click element; prints resulting url/title
- `type <url> <selector> <text>` — navigate, wait, type into input/textarea (fires React-compatible events)
- `serve` — start a persistent, VISIBLE Chrome with a saved profile (default port 9333); it stays running so you can log in
- `stop` — stop the persistent Chrome started by `serve`

Options:
- `--port <n>` CDP port (default 9222, or `$CDP_PORT`; `serve` defaults to 9333)
- `--profile <dir>` persistent profile dir for `serve` (default `~/.web-browse/chrome-profile`)
- `--settle <ms>` extra wait after load (default 1500; raise for slow pages)
- `--timeout <ms>` selector wait timeout (default 20000)
- `--selector <css>` wait for this selector after load, any command
- `--ua <string>`, `--window WxH` — only used when the script launches Chrome
- `--no-sandbox` force Chrome `--no-sandbox` (auto-retry on launch failure)
- `--keep` don't kill the Chrome the script launched
- `--no-launch` attach to an existing Chrome only, never launch

## Tips

- Output includes site navigation boilerplate. Pipe through grep to find the article body, e.g. `node scripts/browse.mjs text <url> | grep -i -A5 "keyword"`.
- On SPA homepages, run `links` first to find real content URLs, then `text` those.
- If text looks empty or like a loading shell, retry with larger `--settle`, or use `--selector` to wait for a specific element (e.g. `--selector "article"`).
- Prefer `--selector` over `--settle` when you know the element that marks content readiness.
- `shot` is useful to see what the bot actually got when an anti-bot wall (e.g. Cloudflare challenge) blocks text extraction.
- By default each run is a fresh, throwaway headless Chrome (no persistent session). For sites that need **login/auth**, use the persistent visible browser instead (see below).
- For complex interactive flows, prefer `eval` to drive the page's own JS, or use Playwright.

## Logging in / persistent browser (serve)

The default headless mode is stateless — cookies and logins don't survive between runs. When a site requires authentication, start a persistent, **visible** Chrome with a saved profile, log in by hand in that window, and every later command reuses the session:

```
node scripts/browse.mjs serve        # opens a visible Chrome (port 9333, profile ~/.web-browse/chrome-profile)
# ...log in to the site in that window...
node scripts/browse.mjs text <url>   # auto-attaches to the persistent browser (no --port needed)
node scripts/browse.mjs shot <url>   # same session, same cookies
node scripts/browse.mjs stop         # close it when done
```

- `serve` launches Chrome **without** `--headless`, so you can see and interact with the window. It uses a dedicated profile, so it won't touch your normal browser.
- While the persistent browser is running, any command without an explicit `--port` auto-attaches to it (detected via `~/.web-browse/current.json`). Pass `--port` to force a different browser, or `stop` first.
- Login state persists in the profile across `stop`/`serve` cycles, so you typically only log in once.
- The persistent browser drives its first page tab; keep the target site in that tab.

## Verify

After editing this skill, run: `node scripts/browse.mjs text https://example.com`
