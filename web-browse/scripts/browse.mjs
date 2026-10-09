#!/usr/bin/env node
/**
 * browse.mjs — control Chrome over the CDP debug port (default 9222).
 * Zero dependencies; requires Node >= 22 (global WebSocket) and system Chrome/Chromium.
 *
 * If nothing is listening on the port, the script launches its own Chrome (headless
 * by default; --visible for a visible window), uses it, and kills it on exit
 * (unless --keep). If a Chrome is already listening (e.g. one you started for
 * debugging), it attaches to the first page tab.
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const USAGE = `Usage: node browse.mjs [options] <command> [args...]

Commands:
  text <url>                        print visible text (body.innerText)
  html <url>                        print rendered DOM after JS runs
  links <url>                       print deduplicated hrefs
  eval <url> <js>                   evaluate JS in the page, print result
  shot <url> [outfile]              full-page PNG (default /tmp/browse-<ts>.png)
  pdf <url> [outfile]               print-to-PDF (default /tmp/browse-<ts>.pdf)
  click <url> <selector>            navigate, wait, click element
  type <url> <selector> <text>      navigate, wait, type into input/textarea
  serve                   start a persistent Chrome (visible by default; --headless
                            to run without a window); log in here; stays running
  stop                    stop the persistent Chrome started by serve

Options:
  --port <n>        CDP debug port (default 9222, or $CDP_PORT; serve defaults to 9333)
  --profile <dir>   persistent profile dir for serve (default ~/.web-browse/chrome-profile)
  --settle <ms>     extra wait after page load (default 1500)
  --timeout <ms>    selector wait timeout (default 20000)
  --selector <css>  wait for this selector after load (any command)
  --ua <string>     user agent (only when this script launches Chrome)
  --window WxH      viewport (default 1280,1600; only when launching)
  --visible         launch Chrome with a VISIBLE window (default: headless)
  --headless        force headless (default for one-shot commands; overrides
                    serve's default of a visible window)
  --no-sandbox      pass --no-sandbox to Chrome (auto-retry on launch failure)
  --keep            don't kill the Chrome this script launched
  --no-launch       attach to an existing Chrome on the port; never launch`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- args ----------------
const argv = process.argv.slice(2);
const envPortSet = !!process.env.CDP_PORT;
const opts = {
  port: parseInt(process.env.CDP_PORT || '9222', 10),
  portExplicit: false,
  profile: path.join(homedir(), '.web-browse', 'chrome-profile'),
  settle: 1500,
  timeout: 20000,
  selector: null,
  ua: null,
  window: '1280,1600',
  visible: false,
  headless: false,
  noSandbox: false,
  keep: false,
  noLaunch: false,
};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--port': opts.port = parseInt(argv[++i], 10); opts.portExplicit = true; break;
    case '--profile': opts.profile = argv[++i]; break;
    case '--settle': opts.settle = parseInt(argv[++i], 10); break;
    case '--timeout': opts.timeout = parseInt(argv[++i], 10); break;
    case '--selector': opts.selector = argv[++i]; break;
    case '--ua': opts.ua = argv[++i]; break;
    case '--window': opts.window = argv[++i]; break;
    case '--visible': opts.visible = true; break;
    case '--headless': opts.headless = true; break;
    case '--no-sandbox': opts.noSandbox = true; break;
    case '--keep': opts.keep = true; break;
    case '--no-launch': opts.noLaunch = true; break;
    case '-h': case '--help': console.log(USAGE); process.exit(0); break;
    default:
      if (a.startsWith('--')) { console.error(`unknown option: ${a}`); process.exit(2); }
      pos.push(a);
  }
}
const [command, ...args] = pos;
if (!command) { console.error(USAGE); process.exit(2); }

const HOST = '127.0.0.1';

// ---------------- CDP client ----------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    };
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error('websocket connect timeout')), 10000);
      ws.onopen = () => { clearTimeout(timer); resolve(new CDP(ws)); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`websocket error connecting to ${wsUrl}`)); };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 90000);
    });
  }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

// ---------------- HTTP helpers for the CDP endpoint ----------------
function httpJson(p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: opts.port, path: p, method }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${p}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`bad JSON from ${p}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function portAlive() {
  try { await httpJson('/json/version'); return true; } catch { return false; }
}

// Is *anything* (CDP or not) accepting TCP connections on the port?
function portListening() {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: opts.port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

// Find a free TCP port by briefly binding to port 0.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, HOST, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

// Is a working CDP endpoint listening on a SPECIFIC port?
function cdpAlive(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port, path: '/json/version', method: 'GET' }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ---------------- persistent browser state ----------------
const STATE_FILE = path.join(homedir(), '.web-browse', 'current.json');
function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function writeState(obj) {
  try { mkdirSync(path.dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2)); } catch {}
}
function clearState() {
  try { rmSync(STATE_FILE, { force: true }); } catch {}
}

async function waitForPort(timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portAlive()) return true;
    await delay(250);
  }
  return false;
}

// ---------------- Chrome lifecycle ----------------
function findChrome() {
  // 1. Explicit override wins.
  if (process.env.CHROME_BIN) {
    try { if (spawnSync(process.env.CHROME_BIN, ['--version'], { stdio: 'ignore' }).status === 0) return process.env.CHROME_BIN; } catch {}
  }
  // 2. Common install locations (macOS app bundles, Linux, Windows).
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    process.env.HOME ? `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` : null,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const b of candidates) {
    try { if (spawnSync(b, ['--version'], { stdio: 'ignore' }).status === 0) return b; } catch {}
  }
  // 3. Fall back to PATH lookups.
  for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { if (spawnSync(b, ['--version'], { stdio: 'ignore' }).status === 0) return b; } catch {}
  }
  return null;
}

function launchChrome(useNoSandbox) {
  const bin = findChrome();
  if (!bin) throw new Error('no Chrome/Chromium binary found (set CHROME_BIN or install Chrome)');
  const profile = mkdtempSync(path.join(tmpdir(), 'cdp-profile-'));
  const a = [
    ...(!opts.visible ? ['--headless=new'] : []),
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    `--window-size=${opts.window}`,
    'about:blank',
  ];
  if (opts.ua) a.push(`--user-agent=${opts.ua}`);
  if (useNoSandbox) a.push('--no-sandbox');
  const proc = spawn(bin, a, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err += d.toString()));
  return { proc, profile, bin, getErr: () => err };
}

async function acquireChrome() {
  if (await portAlive()) {
    console.error('[browse] attaching to existing Chrome on port ' + opts.port);
    return null; // not ours to kill
  }
  if (opts.noLaunch) throw new Error(`no working CDP Chrome on port ${opts.port} (start one with --remote-debugging-port=${opts.port}, or drop --no-launch to let this script launch its own)`);
  // Port is occupied by something that is NOT a working CDP endpoint. Launching
  // on it would fail to bind, so pick a free port instead of erroring out.
  if (await portListening()) {
    const free = await findFreePort();
    console.error(`[browse] port ${opts.port} is in use by a non-CDP process; launching on free port ${free} instead`);
    opts.port = free;
  }
  const tryLaunch = (noSandbox) =>
    new Promise((resolve, reject) => {
      const c = launchChrome(noSandbox);
      c.proc.on('error', reject);
      setTimeout(async () => {
        if (await portAlive()) resolve(c);
        else {
          c.proc.kill('SIGKILL');
          rmSync(c.profile, { recursive: true, force: true });
          reject(new Error(`Chrome did not open debug port (stderr: ${c.getErr().slice(-300)})`));
        }
      }, 8000);
      // fail fast if the process dies immediately
      c.proc.on('exit', (code) => {
        if (code !== null && code !== 0) {
          rmSync(c.profile, { recursive: true, force: true });
          reject(new Error(`Chrome exited early (code ${code}): ${c.getErr().slice(-300)}`));
        }
      });
    });
  try {
    return await tryLaunch(opts.noSandbox);
  } catch (e) {
    if (!opts.noSandbox) {
      console.error('[browse] retrying with --no-sandbox');
      return await tryLaunch(true);
    }
    throw e;
  }
}

function releaseChrome(chrome) {
  if (!chrome) return;
  if (opts.keep) { console.error('[browse] keeping Chrome alive (pid ' + chrome.proc.pid + ')'); return; }
  try { chrome.proc.kill('SIGKILL'); } catch {}
  rmSync(chrome.profile, { recursive: true, force: true });
}

// ---------------- page ops ----------------
async function getPageTarget() {
  const targets = await httpJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (page) return page;
  // Chrome >= 111 requires PUT for /json/new
  try { return await httpJson('/json/new?about:blank', 'PUT'); }
  catch { return await httpJson('/json/new?about:blank', 'GET'); }
}

async function evalJs(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown'));
  }
  return r.result.value;
}

async function navigate(cdp, url) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  // poll readyState (robust even if loadEventFired was missed)
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const st = await evalJs(cdp, 'document.readyState').catch(() => 'loading');
    if (st === 'complete') break;
    await delay(200);
  }
  if (opts.settle > 0) await delay(opts.settle);
  if (opts.selector) {
    const t1 = Date.now();
    while (Date.now() - t1 < opts.timeout) {
      const found = await evalJs(cdp, `!!document.querySelector(${JSON.stringify(opts.selector)})`);
      if (found) return;
      await delay(250);
    }
    throw new Error(`selector not found within ${opts.timeout}ms: ${opts.selector}`);
  }
}

function printValue(v) {
  if (typeof v === 'string') process.stdout.write(v + '\n');
  else process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}

// ---------------- persistent browser (serve/stop) ----------------
async function runServeOrStop(command) {
  if (command === 'stop') {
    const st = readState();
    const profile = st?.profile || opts.profile;
    let stopped = [];
    if (process.platform === 'win32') {
      // No pgrep on Windows: kill the stored main PID and its whole process tree.
      if (st?.pid) {
        const r = spawnSync('taskkill', ['/PID', String(st.pid), '/T', '/F'], { stdio: 'ignore' });
        if (r.status === 0) stopped = [`pid ${st.pid} + tree`];
      }
    } else {
      // Unix (macOS/Linux): sweep every process tied to this profile dir (main + helpers).
      const out = spawnSync('pgrep', ['-f', `user-data-dir=${profile}`], { encoding: 'utf8' });
      const pids = (out.stdout || '').trim().split('\n').filter(Boolean);
      for (const p of pids) { try { process.kill(parseInt(p, 10), 'SIGTERM'); stopped.push(p); } catch {} }
    }
    if (stopped.length) console.error(`[browse] stopped persistent Chrome (${stopped.join(', ')})`);
    else console.error('[browse] no persistent Chrome found for profile ' + profile);
    clearState();
    return;
  }
  // serve: launch a persistent Chrome (visible by default; --headless to run
  // without a window) with a saved profile
  const bin = findChrome();
  if (!bin) throw new Error('no Chrome/Chromium binary found (set CHROME_BIN or install Chrome)');
  const port = (opts.portExplicit || envPortSet) ? opts.port : 9333;
  opts.port = port;
  const profile = opts.profile;
  mkdirSync(profile, { recursive: true });
  if (await cdpAlive(port)) {
    console.error(`[browse] a CDP Chrome is already running on port ${port}; leaving it as-is`);
    writeState({ port, profile, pid: null, started: new Date().toISOString() });
    return;
  }
  const a = [
    ...(opts.headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    `--window-size=${opts.window}`,
    'about:blank',
  ];
  if (opts.ua) a.push(`--user-agent=${opts.ua}`);
  const proc = spawn(bin, a, { detached: true, stdio: 'ignore' });
  const pid = proc.pid;
  proc.unref();
  const ok = await waitForPort(15000);
  if (!ok) throw new Error(`persistent Chrome did not open debug port ${port}`);
  writeState({ port, profile, pid, started: new Date().toISOString() });
  console.error(`[browse] persistent Chrome running (pid ${pid}) on port ${port}`);
  console.error(`[browse] profile: ${profile}`);
  console.error(`[browse] Log in to any site in that window. Other commands now auto-attach, e.g.:`);
  console.error(`  node ${process.argv[1]} text <url>`);
  console.error(`  node ${process.argv[1]} stop   # when you're done`);
}

// ---------------- main ----------------
if (command === 'serve' || command === 'stop') {
  try { await runServeOrStop(command); }
  catch (e) { console.error('error: ' + e.message); process.exit(1); }
  process.exit(0);
}
// If no explicit port was given and a persistent browser is running, attach to it.
if (!opts.portExplicit && !envPortSet) {
  const st = readState();
  if (st && (await cdpAlive(st.port))) {
    console.error(`[browse] attaching to persistent Chrome on port ${st.port}`);
    opts.port = st.port;
  }
}
const chrome = await acquireChrome();
let exitCode = 0;
try {
  const target = await getPageTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);

  switch (command) {
    case 'text': {
      if (!args[0]) throw new Error('text <url> required');
      await navigate(cdp, args[0]);
      printValue(await evalJs(cdp, 'document.body ? document.body.innerText : ""'));
      break;
    }
    case 'html': {
      if (!args[0]) throw new Error('html <url> required');
      await navigate(cdp, args[0]);
      printValue(await evalJs(cdp, 'document.documentElement.outerHTML'));
      break;
    }
    case 'links': {
      if (!args[0]) throw new Error('links <url> required');
      await navigate(cdp, args[0]);
      const links = await evalJs(cdp,
        `[...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => !h.startsWith('javascript:')).filter((v,i,s) => s.indexOf(v) === i)`);
      for (const l of links) console.log(l);
      break;
    }
    case 'eval': {
      if (!args[0] || !args[1]) throw new Error('eval <url> <js-expression> required');
      await navigate(cdp, args[0]);
      printValue(await evalJs(cdp, args[1], true));
      break;
    }
    case 'shot': {
      if (!args[0]) throw new Error('shot <url> [outfile] required');
      await navigate(cdp, args[0]);
      const out = args[1] || `/tmp/browse-${Date.now()}.png`;
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(out, Buffer.from(r.data, 'base64'));
      console.log(out);
      break;
    }
    case 'pdf': {
      if (!args[0]) throw new Error('pdf <url> [outfile] required');
      await navigate(cdp, args[0]);
      const out = args[1] || `/tmp/browse-${Date.now()}.pdf`;
      const r = await cdp.send('Page.printToPDF', { printBackground: true });
      writeFileSync(out, Buffer.from(r.data, 'base64'));
      console.log(out);
      break;
    }
    case 'click': {
      if (!args[0] || !args[1]) throw new Error('click <url> <selector> required');
      await navigate(cdp, args[0]);
      const res = await evalJs(cdp, `(() => {
        const el = document.querySelector(${JSON.stringify(args[1])});
        if (!el) return 'not-found';
        el.scrollIntoView({ block: 'center' });
        el.click();
        return 'clicked';
      })()`);
      if (res !== 'clicked') throw new Error(`click failed: ${res}`);
      await delay(Math.max(opts.settle, 1500));
      printValue({ clicked: args[1], url: await evalJs(cdp, 'location.href'), title: await evalJs(cdp, 'document.title') });
      break;
    }
    case 'type': {
      if (!args[0] || !args[1] || !args[2]) throw new Error('type <url> <selector> <text> required');
      await navigate(cdp, args[0]);
      const res = await evalJs(cdp, `(() => {
        const el = document.querySelector(${JSON.stringify(args[1])});
        if (!el) return 'not-found';
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, ${JSON.stringify(args[2])});
        else el.value = ${JSON.stringify(args[2])};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'typed';
      })()`);
      if (res !== 'typed') throw new Error(`type failed: ${res}`);
      printValue({ typed: args[2], into: args[1] });
      break;
    }
    default:
      console.error(USAGE);
      exitCode = 2;
  }
  cdp.close();
} catch (e) {
  console.error('error: ' + e.message);
  exitCode = 1;
} finally {
  releaseChrome(chrome);
}
process.exit(exitCode);
