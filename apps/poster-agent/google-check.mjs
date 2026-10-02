// One-off: pin an IPRoyal session, read its exit location, create an AdsPower
// profile on that proxy, Google a query inside it, save the results (and a screenshot of any CAPTCHA) as an Excel file.
// Run from apps/poster-agent:  node google-check.mjs "best apple in the world"

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import ExcelJS from 'exceljs';

const QUERY = process.argv[2] || 'best apple in the world';
const WAIT_MINUTES = 15; // how long to wait for a person to solve Google's check

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const agentEnv = readEnv('./.env');
const webEnv = readEnv('../web/.env.local');
const API = (agentEnv.ADSPOWER_API || 'http://127.0.0.1:50325').replace(/\/$/, '');
const KEY = agentEnv.ADSPOWER_API_KEY;
const PROXY = webEnv.REDDIT_PROXY_URL;
if (!KEY || !PROXY) throw new Error('Need ADSPOWER_API_KEY (apps/poster-agent/.env) and REDDIT_PROXY_URL (apps/web/.env.local)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The bare IPRoyal URL rotates IP on every request, so the location we read and
// the IP the browser gets would differ. A session suffix on the password pins it.
const p = new URL(PROXY);
const session = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
const proxy = {
  host: p.hostname,
  port: p.port,
  user: decodeURIComponent(p.username),
  pass: `${decodeURIComponent(p.password)}_session-${session}_lifetime-30m`,
};
const proxyUrl = `http://${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass)}@${proxy.host}:${proxy.port}`;

async function ads(method, path, body) {
  await sleep(1100); // AdsPower allows ~1 call/sec on some endpoints
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`AdsPower ${path}: ${json.msg || res.status}`);
  return json.data;
}

// A frame that never answers would otherwise block evaluate() for minutes.
const withTimeout = (ms, promise) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

// Google's EU consent popup shows up a beat after load, sometimes in an iframe or
// on consent.google.com. Poll every frame; the button ids are the same in every
// language (W0wltc = Reject all, L2AGLb = Accept all).
async function dismissConsent(page, waitMs = 8000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const frames = page.frames().filter((f) => f === page.mainFrame() || /google\./.test(f.url()));
    for (const frame of frames) {
      const clicked = await withTimeout(2000, frame.evaluate(() => {
        const words = /^(reject all|accept all|i agree|alle ablehnen|tout refuser|απόρριψη όλων|αποδοχή όλων)$/i;
        const btn = document.querySelector('#W0wltc') || document.querySelector('#L2AGLb') ||
          [...document.querySelectorAll('button, div[role="button"], input[type="submit"]')]
            .find((b) => words.test((b.innerText || b.value || '').trim()));
        if (!btn) return false;
        btn.click();
        return true;
      })).catch(() => false);
      if (clicked) {
        await sleep(2500);
        return true;
      }
    }
    await sleep(500);
  }
  return false;
}

// Runs inside the page. Works on Google's desktop AND mobile layouts: a result is
// any link that leaves Google and has a heading inside it.
function extractResults() {
  const googleOwned = /(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com)$/;
  const seen = new Set();
  const rows = [];
  for (const heading of document.querySelectorAll('a h3, a [role="heading"]')) {
    const a = heading.closest('a');
    // Google now sends result links through /goto?url=<opaque code>, so the real
    // address is not in the link. `url` is filled only when the link is direct;
    // otherwise `site` carries the address the page displays.
    let url = '';
    let googleLink = '';
    try {
      const u = new URL(a.href);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (!googleOwned.test(u.hostname)) url = u.href;
      else if (u.pathname === '/url') url = u.searchParams.get('q') || u.searchParams.get('url') || '';
      else if (u.pathname.startsWith('/goto')) googleLink = u.href;
      else continue;
    } catch {
      continue;
    }
    const title = (heading.innerText || '').replace(/\s+/g, ' ').trim();
    const key = url || googleLink;
    if (!title || !key || seen.has(key)) continue;
    seen.add(key);
    const block = a.closest('div[data-hveid], div.g, div.MjjYud') || a.parentElement;
    const lines = (block?.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const looksLikeAddress = (t) => /^https?:\/\/\S+/.test(t || '');
    const cite = [...(block?.querySelectorAll('cite') || [])].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).find(looksLikeAddress);
    const site = cite || lines.find(looksLikeAddress) || '';
    const snippet = lines.filter((l) => l.length > 40 && !title.includes(l) && !l.includes(title)).join(' ');
    rows.push({ title, url, site, google_link: googleLink, snippet: snippet.slice(0, 400) });
  }
  return rows;
}

console.log(`1/5 Checking exit location for IPRoyal session ${session}…`);
const loc = JSON.parse(execFileSync('curl', ['-s', '--max-time', '20', '-x', proxyUrl, 'https://ipinfo.io/json'], { encoding: 'utf8' }));
console.log(`    ${loc.ip} — ${loc.city}, ${loc.region}, ${loc.country} (${loc.timezone})`);

console.log('2/5 Creating AdsPower profile…');
const groups = await ads('GET', '/api/v1/group/list?page_size=1');
const groupId = groups.list[0].group_id;
const profileName = `google-check ${loc.city || ''} ${new Date().toISOString().slice(0, 16)}`.trim();
const created = await ads('POST', '/api/v1/user/create', {
  name: profileName,
  group_id: groupId,
  remark: `IPRoyal session ${session}, ${loc.ip} ${loc.city}, ${loc.country}`,
  user_proxy_config: {
    proxy_soft: 'other',
    proxy_type: 'http',
    proxy_host: proxy.host,
    proxy_port: proxy.port,
    proxy_user: proxy.user,
    proxy_password: proxy.pass,
  },
  // Desktop only — left to itself AdsPower may pick an Android phone, and Google's
  // mobile page hides each result's real link. Timezone/language/geo stay on
  // AdsPower's defaults, which follow the proxy IP.
  fingerprint_config: {
    random_ua: { ua_browser: ['chrome'], ua_system_version: ['Windows', 'Mac OS X'] },
  },
});
const profileId = created.id;
console.log(`    profile ${profileId} (“${profileName}”)`);

console.log('3/5 Opening the profile…');
const started = await ads('GET', `/api/v1/browser/start?user_id=${profileId}&open_tabs=1`);
const browser = await puppeteer.connect({ browserWSEndpoint: started.ws.puppeteer, defaultViewport: null });
const userAgent = await browser.userAgent();
console.log(`    device: ${/Mobile|Android|iPhone/i.test(userAgent) ? 'MOBILE — results will lack direct links' : 'desktop'} (${userAgent.match(/\(([^)]+)\)/)?.[1] || userAgent})`);

let results = [];
let status = 'ok';
let browserIp = '';
let landedUrl = '';
let shot = null; // { buffer, width, height } of the check page, if Google showed one
let checkShown = 'no';
try {
  const page = await browser.newPage();

  await page.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 30000 });
  browserIp = await page.evaluate(() => { try { return JSON.parse(document.body.innerText).ip; } catch { return ''; } });
  console.log(`    browser exit IP: ${browserIp}${browserIp && browserIp !== loc.ip ? '  (differs from step 1!)' : ''}`);

  console.log(`4/5 Searching Google for “${QUERY}”…`);
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(QUERY)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (await dismissConsent(page, 5000)) {
    console.log('    dismissed cookie popup');
    if (!page.url().includes('/search')) await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  const isCheckPage = async () =>
    page.url().includes('/sorry/') || !!(await page.$('#captcha-form').catch(() => null));
  const readResults = () => withTimeout(10000, page.evaluate(extractResults)).catch(() => []);
  const hasResults = async () => !(await isCheckPage()) && (await readResults()).length > 0;

  // Give the page up to 15s to show either results or Google's check.
  for (let i = 0; i < 15 && !(await hasResults()) && !(await isCheckPage()); i++) await sleep(1000);
  landedUrl = page.url();
  console.log(`    landed on: ${landedUrl}`);

  if (!(await hasResults())) {
    checkShown = (await isCheckPage()) ? 'yes' : 'no results visible';
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null);
    const buffer = await page.screenshot({ type: 'png' }).catch(() => null);
    if (buffer && size) shot = { buffer: Buffer.from(buffer), ...size };

    console.log(`\n    ${checkShown === 'yes' ? 'Google is showing a check instead of results.' : 'No search results are visible on the page yet.'}`);
    console.log(`    → Solve it in the AdsPower window, in the SAME tab. I'll wait up to ${WAIT_MINUTES} minutes.`);
    console.log(`    → If the page has no puzzle (just "unusual traffic"), reload it or search again in that tab.\n`);
    const deadline = Date.now() + WAIT_MINUTES * 60000;
    let lastNote = Date.now();
    while (Date.now() < deadline && !(await hasResults())) {
      if (page.isClosed()) throw new Error('Target closed');
      if (Date.now() - lastNote > 60000) {
        console.log(`    still waiting… ${Math.ceil((deadline - Date.now()) / 60000)} min left`);
        lastNote = Date.now();
      }
      await sleep(2000);
    }
  }

  if (await hasResults()) {
    await sleep(1500); // let the rest of the results render
    landedUrl = page.url();
    results = await readResults();
    status = results.length ? 'ok' : 'no results parsed';
    if (checkShown !== 'no') console.log('    results page is showing now');
  } else {
    status = `blocked — not solved within ${WAIT_MINUTES} min`;
  }
} catch (e) {
  status = `error: ${e.message}`;
  console.log(`    ${status}`);
  if (/target closed|detached/i.test(e.message)) console.log('    the tab was closed — keep working in the same tab the script opened');
} finally {
  browser.disconnect();
  // Only close the browser once the results are saved; otherwise leave it open to look at.
  if (status === 'ok') await ads('GET', `/api/v1/browser/stop?user_id=${profileId}`).catch(() => {});
  else console.log('    leaving the browser open');
}

console.log('5/5 Writing Excel file…');
const file = `google-results-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.xlsx`;
const header = ['rank', 'title', 'url', 'site', 'google_link', 'snippet', 'query', 'status', 'profile_id', 'proxy_session', 'exit_ip', 'browser_ip', 'city', 'region', 'country', 'timezone', 'check_shown', 'landed_url', 'searched_at'];
const meta = { query: QUERY, status, profile_id: profileId, proxy_session: session, exit_ip: loc.ip, browser_ip: browserIp, city: loc.city, region: loc.region, country: loc.country, timezone: loc.timezone, check_shown: checkShown, landed_url: landedUrl, searched_at: new Date().toISOString() };
const rows = (results.length ? results : [{}]).map((r, i) => ({ rank: r.title ? i + 1 : '', ...r, ...meta }));

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('Results');
sheet.columns = header.map((h) => ({ header: h, key: h, width: ['title', 'url', 'site', 'google_link', 'snippet', 'landed_url'].includes(h) ? 50 : 18 }));
sheet.getRow(1).font = { bold: true };
rows.forEach((r) => sheet.addRow(r));

if (shot) {
  const shotSheet = workbook.addWorksheet('Screenshot');
  shotSheet.getColumn(1).width = 30;
  shotSheet.addRow([`Google's check page, before it was solved. Final status: ${status}`]);
  shotSheet.addRow([`Profile ${profileId} — ${loc.ip} (${loc.city}, ${loc.country})`]);
  shotSheet.addRow([landedUrl]);
  const scale = Math.min(1, 1000 / shot.width);
  const imageId = workbook.addImage({ buffer: shot.buffer, extension: 'png' });
  shotSheet.addImage(imageId, { tl: { col: 0, row: 4 }, ext: { width: Math.round(shot.width * scale), height: Math.round(shot.height * scale) } });
}
await workbook.xlsx.writeFile(file);

console.log(`\nDone — ${results.length} results, status: ${status}`);
console.log(`Saved: apps/poster-agent/${file}`);
console.log(`Profile ${profileId} kept in AdsPower (delete it there if you don't need it).`);
