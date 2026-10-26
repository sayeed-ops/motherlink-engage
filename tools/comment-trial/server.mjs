// Comment trial — a tiny local page to try the proposed autopilot comment flow
// before it is built into Engage. Separate from Engage: its own address,
// http://localhost:4700, and READ-ONLY against Engage's database.
//
// Start: double-click tools/comment-trial/start.command, or from the repo root:
//   node --env-file=apps/web/.env.local --experimental-transform-types --no-warnings \
//        --import ./tests/unit/register.mjs tools/comment-trial/server.mjs

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { listAccounts, runTrial } from './trial.mjs';

const PORT = Number(process.env.PORT || 4700);
const PAGE = new URL('./page.html', import.meta.url);
let running = false;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readFileSync(PAGE));
    }
    if (req.method === 'GET' && req.url === '/api/accounts') return json(res, 200, await listAccounts());
    if (req.method === 'POST' && req.url === '/api/run') {
      // One run at a time: Crawlzo and the AI are used one request at a time.
      if (running) return json(res, 409, { error: 'A run is already in progress.' });
      let body = '';
      for await (const chunk of req) body += chunk;
      const label = String(JSON.parse(body || '{}').label || '');
      running = true;
      try {
        return json(res, 200, await runTrial(label));
      } finally {
        running = false;
      }
    }
    res.writeHead(404).end();
  } catch (e) {
    running = false;
    json(res, 500, { error: e?.message || String(e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Comment trial → http://localhost:${PORT}  (read-only; Ctrl+C to stop)`));
