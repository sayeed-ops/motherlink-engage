// ============================================================
// Motherlink Agent — local control panel (supervisor).
//
// The poster agent (index.mjs) is a plain process: after a reboot it's dead, and
// nothing on the web can start it (no process is listening). This supervisor is
// the thing you launch once on the host; it then runs the agent AS A CHILD and
// gives you a browser control panel at http://127.0.0.1:4599 — Start / Stop /
// Restart, live logs, crash auto-restart, and an optional "start at login" so
// even the one launch goes away.
//
// It is intentionally ZERO-DEPENDENCY (Node http + child_process only) and binds
// to 127.0.0.1 ONLY — the control surface never leaves the machine. It reads no
// secrets and talks to no cloud; the child (index.mjs) does all of that. The web
// app's on/off (agents/control.enabled) still works and composes: this panel
// controls the PROCESS locally; the web switch pauses/resumes it remotely.
// ============================================================

import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_PATH = fileURLToPath(import.meta.url);
const NODE_BIN = process.execPath;
const PORT = Number(process.env.PANEL_PORT || 4599);
const HOST = '127.0.0.1';
const LABEL = 'io.motherlink.engage.agent-panel';
// Auto-start the agent when the panel launches, so opening the panel == agent on.
const AUTOSTART_AGENT = String(process.env.PANEL_NO_AUTOSTART || '') !== '1';

// ---- Child process management ----

let child = null;
let desiredRunning = false;
let startedAt = 0;
let restarts = 0;
let rapidCrashes = 0;
const MAX_RAPID = 5;

const logs = []; // ring buffer of { t, line }
const MAX_LOGS = 500;
const sseClients = new Set();

function pushLog(line) {
  const entry = { t: Date.now(), line: String(line) };
  logs.push(entry);
  while (logs.length > MAX_LOGS) logs.shift();
  broadcast('log', entry);
}

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      /* client gone; cleaned up on close */
    }
  }
}

function status() {
  return {
    running: !!child,
    pid: child?.pid ?? null,
    startedAt: startedAt || null,
    uptimeMs: child ? Date.now() - startedAt : 0,
    restarts,
    desiredRunning,
    autostart: autostartState(),
    port: PORT,
  };
}

const broadcastStatus = () => broadcast('status', status());

function splitLines(buf) {
  return buf.toString('utf8').split(/\r?\n/).filter((l) => l.length > 0);
}

function startChild() {
  if (child) return;
  desiredRunning = true;
  const hasEnv = existsSync(join(AGENT_DIR, '.env'));
  const args = hasEnv ? ['--env-file=.env', 'index.mjs'] : ['index.mjs'];
  try {
    child = spawn(NODE_BIN, args, { cwd: AGENT_DIR, env: process.env });
  } catch (e) {
    pushLog(`[panel] failed to launch agent: ${e.message}`);
    child = null;
    broadcastStatus();
    return;
  }
  startedAt = Date.now();
  pushLog(`[panel] agent started (pid ${child.pid})${hasEnv ? '' : ' — WARNING: no .env found, it will likely fail on the service-account key'}`);

  child.stdout.on('data', (d) => splitLines(d).forEach(pushLog));
  child.stderr.on('data', (d) => splitLines(d).forEach(pushLog));

  child.on('exit', (code, signal) => {
    const ranMs = Date.now() - startedAt;
    child = null;
    pushLog(`[panel] agent exited (code ${code ?? '—'}, signal ${signal || 'none'}) after ${Math.round(ranMs / 1000)}s`);
    broadcastStatus();
    if (!desiredRunning) return; // explicit stop — stay down

    // Crash: auto-restart with backoff, and bail out of a tight crash loop.
    restarts += 1;
    if (ranMs < 4000) rapidCrashes += 1;
    else rapidCrashes = 0;
    if (rapidCrashes >= MAX_RAPID) {
      desiredRunning = false;
      pushLog(`[panel] agent crashed ${MAX_RAPID}× quickly — giving up. Fix the issue (check logs above) and click Start.`);
      broadcastStatus();
      return;
    }
    const delay = rapidCrashes > 0 ? 8000 : 2000;
    pushLog(`[panel] restarting in ${delay / 1000}s…`);
    setTimeout(() => {
      if (desiredRunning && !child) startChild();
    }, delay);
  });

  broadcastStatus();
}

function stopChild() {
  desiredRunning = false;
  rapidCrashes = 0;
  if (!child) return;
  pushLog('[panel] stopping agent…');
  const c = child;
  try {
    c.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (child === c) {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
  }, 5000);
}

function restartChild() {
  if (child) {
    // Restart once the current child has exited.
    const c = child;
    const onExit = () => setTimeout(() => startChild(), 300);
    c.once('exit', onExit);
    stopChild();
    desiredRunning = true; // stopChild cleared it; we DO want it back
  } else {
    startChild();
  }
}

// ---- Start at login (best-effort, per-OS) ----

function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}
function desktopPath() {
  return join(homedir(), '.config', 'autostart', 'motherlink-agent-panel.desktop');
}

function autostartState() {
  try {
    if (platform() === 'darwin') return { supported: true, enabled: existsSync(plistPath()) };
    if (platform() === 'linux') return { supported: true, enabled: existsSync(desktopPath()) };
    if (platform() === 'win32') {
      try {
        execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'MotherlinkAgentPanel'], { stdio: 'pipe' });
        return { supported: true, enabled: true };
      } catch {
        return { supported: true, enabled: false };
      }
    }
  } catch {
    /* fall through */
  }
  return { supported: false, enabled: false };
}

function setAutostart(on) {
  try {
    if (platform() === 'darwin') {
      const p = plistPath();
      if (on) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(
          p,
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${NODE_BIN}</string><string>${SUPERVISOR_PATH}</string></array>
  <key>WorkingDirectory</key><string>${AGENT_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/motherlink-agent-panel.log</string>
  <key>StandardErrorPath</key><string>/tmp/motherlink-agent-panel.err</string>
</dict></plist>
`,
        );
        try { execFileSync('launchctl', ['load', '-w', p], { stdio: 'pipe' }); } catch { /* may already be loaded */ }
      } else {
        try { execFileSync('launchctl', ['unload', '-w', p], { stdio: 'pipe' }); } catch { /* not loaded */ }
        if (existsSync(p)) unlinkSync(p);
      }
      return { ok: true };
    }
    if (platform() === 'linux') {
      const p = desktopPath();
      if (on) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(
          p,
          `[Desktop Entry]
Type=Application
Name=Motherlink Agent Panel
Exec=${NODE_BIN} ${SUPERVISOR_PATH}
Path=${AGENT_DIR}
X-GNOME-Autostart-enabled=true
`,
        );
      } else if (existsSync(p)) {
        unlinkSync(p);
      }
      return { ok: true };
    }
    if (platform() === 'win32') {
      if (on) {
        execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'MotherlinkAgentPanel', '/t', 'REG_SZ', '/d', `"${NODE_BIN}" "${SUPERVISOR_PATH}"`, '/f'], { stdio: 'pipe' });
      } else {
        try { execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'MotherlinkAgentPanel', '/f'], { stdio: 'pipe' }); } catch { /* absent */ }
      }
      return { ok: true };
    }
    return { ok: false, error: 'Auto-start is not supported on this OS yet.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- HTTP server ----

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (req.method === 'GET' && path === '/api/status') {
    json(res, 200, status());
    return;
  }

  if (req.method === 'GET' && path === '/api/logs/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    // Backlog, then live.
    for (const entry of logs) res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && path === '/api/start') {
    startChild();
    json(res, 200, status());
    return;
  }
  if (req.method === 'POST' && path === '/api/stop') {
    stopChild();
    json(res, 200, status());
    return;
  }
  if (req.method === 'POST' && path === '/api/restart') {
    restartChild();
    json(res, 200, status());
    return;
  }
  if (req.method === 'POST' && path === '/api/autostart') {
    const body = await readBody(req);
    const result = setAutostart(!!body.enabled);
    pushLog(`[panel] start-at-login ${body.enabled ? 'enabled' : 'disabled'}${result.ok ? '' : ` — FAILED: ${result.error}`}`);
    broadcastStatus();
    json(res, result.ok ? 200 : 500, { ...result, autostart: autostartState() });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  const uri = `http://${HOST}:${PORT}`;
  pushLog(`[panel] control panel on ${uri}`);
  console.log(`\n  Motherlink Agent panel → ${uri}\n  (leave this window open; control the agent from the browser)\n`);
  tryOpen(uri);
  if (AUTOSTART_AGENT) startChild();
});

function tryOpen(uri) {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [uri], { stdio: 'ignore', detached: true, shell: platform() === 'win32' }).unref();
  } catch {
    /* opening a browser is a convenience, not required */
  }
}

// Clean shutdown — don't leave an orphaned agent child.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    desiredRunning = false;
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }
    setTimeout(() => process.exit(0), 500);
  });
}

// ---- The panel page (inline, self-contained) ----

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Motherlink Agent</title>
<style>
  :root { --bg:#0a0a0a; --card:#111; --border:rgba(255,255,255,.10); --text:#ededed; --dim:#8a8a8a; --faint:#6a6a6a;
          --indigo:#7A77F0; --green:#62C073; --amber:#FF990A; --red:#FF6166; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; padding:28px; }
  .wrap { max-width:820px; margin:0 auto; }
  h1 { font-size:18px; font-weight:600; letter-spacing:-.02em; display:flex; align-items:center; gap:10px; }
  .tag { font-size:11px; color:var(--faint); border:1px solid var(--border); border-radius:6px; padding:2px 7px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:18px 20px; margin-top:16px; }
  .row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .between { justify-content:space-between; }
  .dot { width:10px; height:10px; border-radius:50%; flex:none; }
  .dot.on { background:var(--green); box-shadow:0 0 8px var(--green); }
  .dot.off { background:var(--red); }
  .state { font-weight:600; }
  .meta { color:var(--dim); font-size:12.5px; }
  button { font:inherit; font-size:13px; border-radius:8px; padding:8px 14px; cursor:pointer; border:1px solid var(--border);
           background:#1a1a1a; color:var(--text); display:inline-flex; align-items:center; gap:7px; }
  button:hover { border-color:rgba(255,255,255,.25); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button.primary { background:var(--indigo); border-color:var(--indigo); color:#fff; }
  button.danger { background:#2a1416; border-color:rgba(255,97,102,.5); color:#ff9a9d; }
  .logs { background:#000; border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-top:14px;
          font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; line-height:1.55; height:340px;
          overflow-y:auto; white-space:pre-wrap; word-break:break-word; color:#cfcfcf; }
  .logs .t { color:var(--faint); }
  .logs .panel { color:var(--indigo); }
  label.toggle { display:inline-flex; align-items:center; gap:8px; color:var(--dim); font-size:12.5px; cursor:pointer; }
  .hint { color:var(--faint); font-size:12px; margin-top:10px; }
  a { color:var(--indigo); }
</style></head>
<body><div class="wrap">
  <h1>Motherlink Agent <span class="tag">local control panel</span></h1>

  <div class="card">
    <div class="row between">
      <div class="row">
        <span id="dot" class="dot off"></span>
        <div>
          <div class="state" id="state">—</div>
          <div class="meta" id="meta"></div>
        </div>
      </div>
      <div class="row">
        <button class="primary" id="btnStart">Start</button>
        <button class="danger" id="btnStop">Stop</button>
        <button id="btnRestart">Restart</button>
      </div>
    </div>
    <div class="row between" style="margin-top:14px">
      <label class="toggle"><input type="checkbox" id="autostart"> Start at login (this machine)</label>
      <span class="meta" id="autonote"></span>
    </div>
    <div class="hint">This panel runs the agent as a child process. It pauses/resumes and shows logs.
      Live/dry-run and remote pause are still controlled from the Engage web app. Closing the window that
      launched this panel stops everything — enable "Start at login" for a hands-off setup.</div>
  </div>

  <div class="logs" id="logs"></div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const logsEl = $('logs');
  let stick = true;
  logsEl.addEventListener('scroll', () => { stick = logsEl.scrollTop + logsEl.clientHeight >= logsEl.scrollHeight - 20; });

  function addLog(e) {
    const d = new Date(e.t);
    const ts = d.toLocaleTimeString();
    const line = document.createElement('div');
    const isPanel = e.line.startsWith('[panel]');
    line.innerHTML = '<span class="t">' + ts + '</span>  <span class="' + (isPanel ? 'panel' : '') + '"></span>';
    line.querySelector('span:last-child').textContent = e.line;
    logsEl.appendChild(line);
    while (logsEl.childElementCount > 600) logsEl.removeChild(logsEl.firstChild);
    if (stick) logsEl.scrollTop = logsEl.scrollHeight;
  }

  function fmtUptime(ms) {
    if (!ms) return '';
    const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
    return h ? h+'h '+(m%60)+'m' : m ? m+'m '+(s%60)+'s' : s+'s';
  }

  function render(st) {
    const running = st.running;
    $('dot').className = 'dot ' + (running ? 'on' : 'off');
    $('state').textContent = running ? 'Running' : (st.desiredRunning ? 'Starting…' : 'Stopped');
    $('meta').textContent = running
      ? ('pid ' + st.pid + ' · up ' + fmtUptime(st.uptimeMs) + (st.restarts ? ' · ' + st.restarts + ' restart(s)' : ''))
      : 'agent process is not running';
    $('btnStart').disabled = running || st.desiredRunning;
    $('btnStop').disabled = !running && !st.desiredRunning;
    const a = st.autostart || {};
    $('autostart').checked = !!a.enabled;
    $('autostart').disabled = !a.supported;
    $('autonote').textContent = a.supported ? '' : 'not supported on this OS';
  }

  async function post(p) { await fetch(p, { method:'POST' }); }
  $('btnStart').onclick = () => post('/api/start');
  $('btnStop').onclick = () => post('/api/stop');
  $('btnRestart').onclick = () => post('/api/restart');
  $('autostart').onchange = (e) =>
    fetch('/api/autostart', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: e.target.checked }) })
      .then(r => r.json()).then(r => { if (r.autostart) render(Object.assign({}, lastStatus, { autostart: r.autostart })); });

  let lastStatus = {};
  const es = new EventSource('/api/logs/stream');
  es.addEventListener('log', (m) => addLog(JSON.parse(m.data)));
  es.addEventListener('status', (m) => { lastStatus = JSON.parse(m.data); render(lastStatus); });
  fetch('/api/status').then(r => r.json()).then((s) => { lastStatus = s; render(s); });
</script></body></html>`;
