// ============================================================
// Engage poster agent (LOCAL — runs on the posting Mac next to AdsPower).
//
// Drains Engage's `jobs` queue. For each queued job it:
//   1. opens the account's AdsPower profile via the Local API,
//   2. VERIFIES the logged-in user == the job's expectedUsername (aborts if not),
//   3. VERIFIES it's on the correct thread (aborts if not),
//   4. types the reply with human-like timing and submits,
//   5. writes the result back (job / draft / item / account counters).
//
// The Firestore half lives in agent-core.mjs (Engage schema). This file is the
// loop + the browser automation, ported byte-for-behaviour from ML Studio's
// agent — old.reddit.com markup, the same verify-before-submit safety.
//
// DRY_RUN=1 does everything EXCEPT the final submit (open, verify, type, stop).
// ============================================================

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import puppeteer from 'puppeteer-core';
import { createStore, gate } from './agent-core.mjs';
import { runPlan } from './reddit/executor.mjs';
import { WARMUP_TYPES } from './reddit/actions.mjs';
import { composeApproachPlan, describePlan } from './reddit/plan.mjs';
import { autoHandleDialogs } from './reddit/helpers.mjs';

// ---- Config ----
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
// Node does NOT expand ~ in a path — do it ourselves, since operators reach for it.
const rawKeyPath = process.env.SERVICE_ACCOUNT_PATH || './service-account.json';
const SERVICE_ACCOUNT_PATH = rawKeyPath.startsWith('~') ? join(homedir(), rawKeyPath.slice(1)) : rawKeyPath;
const ADSPOWER_API = (process.env.ADSPOWER_API || 'http://local.adspower.net:50325').replace(/\/$/, '');
// AdsPower added auth to the Local API: every /api/v1/* call now answers
// {"code":-1,"msg":"Require api-key"} without it. The key is in AdsPower →
// Settings → Local API, and it goes in an Authorization: Bearer header (the
// header is the form that works; api-key / X-API-KEY / ?api_key= do not).
const ADSPOWER_API_KEY = String(process.env.ADSPOWER_API_KEY || '').trim();
// The env value is only the DEFAULT. The live switch is agents/control.dryRun,
// set from the web UI and re-read every poll — so an operator can flip dry-run
// on/off without touching this file or restarting. See readDryRunOverride().
const DRY_RUN_DEFAULT = String(process.env.DRY_RUN || '').trim() === '1';
// Reclaim orphaned 'posting' jobs. Raised from 10m for the Phase 2 approach flow:
// a humanized job (browse + hunt + read + skim + type) legitimately runs 4-7
// minutes, and reclaiming a job that is still live would mark a real post failed.
const STALE_POSTING_MS = Number(process.env.STALE_POSTING_MS || 20 * 60 * 1000);
// Warm-up sessions are capped at 12 minutes (MAX_WALL_SEC), so one still claimed
// after 15 is dead — nearly always because the agent was restarted mid-run.
// Making it serve the posting window blocks every further session for that
// account for no reason, and unlike a stranded reply there is nothing to check:
// a browse posts nothing.
const STALE_WARMUP_MS = Number(process.env.STALE_WARMUP_MS || 15 * 60 * 1000);
// How stale captured stats may get before the agent re-reads the profile on its
// next session. Keeps the profile visit occasional (human), not every-post.
const STATS_MAX_AGE_MS = Number(process.env.STATS_MAX_AGE_MS || 3 * 24 * 60 * 60 * 1000); // 3 days
const CLOSE_AFTER = String(process.env.CLOSE_AFTER || '').trim() === '1';
// How often the heartbeat is written WHILE a job is running. A humanized job
// takes minutes; the web UI calls the agent offline after 20s without a stamp, so
// the beat has to be independent of the poll loop. Keep it well under that window.
const HEARTBEAT_MS = Math.min(Number(process.env.HEARTBEAT_MS || 5000), 10000);
// Posting surface. Env default stays 'old' (the proven path); the live switch is
// agents/control.postSurface, re-read every poll so 'new' can be tested and rolled
// back without a restart. See docs/NEW-REDDIT-PLAN.md.
const POST_SURFACE_DEFAULT = String(process.env.POST_SURFACE || '').trim() === 'new' ? 'new' : 'old';
// Effective dry-run + surface for the current poll. Updated each loop.
let dryRun = DRY_RUN_DEFAULT;
let postSurface = POST_SURFACE_DEFAULT;

// ---- Firebase admin (Engage) ----
let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
} catch (e) {
  console.error(`\nCannot read the Firebase key at:\n  ${SERVICE_ACCOUNT_PATH}\n`);
  console.error(`  ${e.message}\n`);
  console.error('Fix SERVICE_ACCOUNT_PATH in .env to an ABSOLUTE path to the Engage admin key,');
  console.error('e.g. /Users/<you>/.config/motherlink-engage/admin.json  (no ~).\n');
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const store = createStore({ db, FieldValue, Timestamp });

const log = (...a) => console.log(new Date().toISOString(), ...a);
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- AdsPower Local API ----
// AdsPower rate-limits the Local API to roughly one request per second and
// answers "Too many request per second" over that — which would fail a job for
// no reason, since start/stop land back-to-back. Serialise calls and keep a
// floor between them.
const ADSPOWER_MIN_GAP_MS = 1100;
let adspowerChain = Promise.resolve();
let adspowerLastAt = 0;

function adspower(path) {
  const run = async () => {
    const wait = ADSPOWER_MIN_GAP_MS - (Date.now() - adspowerLastAt);
    if (wait > 0) await sleep(wait);
    adspowerLastAt = Date.now();
    const res = await fetch(`${ADSPOWER_API}${path}`, {
      headers: ADSPOWER_API_KEY ? { Authorization: `Bearer ${ADSPOWER_API_KEY}` } : {},
    });
    const json = await res.json().catch(() => ({}));
    if (json.code !== 0) {
      const hint = /api-key/i.test(json.msg || '')
        ? ' — set ADSPOWER_API_KEY in .env (AdsPower → Settings → Local API)'
        : '';
      throw new Error(`AdsPower API ${path}: ${json.msg || 'unknown error'}${hint}`);
    }
    return json.data;
  };
  // Chain so two callers can never race the rate limit.
  const next = adspowerChain.then(run, run);
  adspowerChain = next.catch(() => {});
  return next;
}
const startProfile = (profileId) =>
  adspower(`/api/v1/browser/start?user_id=${encodeURIComponent(profileId)}&open_tabs=1&headless=0`);
async function stopProfile(profileId) {
  try {
    await adspower(`/api/v1/browser/stop?user_id=${encodeURIComponent(profileId)}`);
  } catch (e) {
    log('stopProfile warning:', e.message);
  }
}

// ---- Reddit helpers ----
function toOldReddit(url) {
  try {
    const u = new URL(url);
    u.hostname = 'old.reddit.com';
    return u.toString();
  } catch {
    return url;
  }
}
async function typeHuman(page, selector, text) {
  await page.waitForSelector(selector, { visible: true, timeout: 20000 });
  await page.click(selector);
  await sleep(rand(300, 900));
  for (const ch of text) {
    await page.type(selector, ch, { delay: rand(35, 110) });
    if (Math.random() < 0.04) await sleep(rand(250, 800));
  }
}
async function loggedInUser(page) {
  try {
    return await page.evaluate(() => {
      const a =
        document.querySelector('#header-bottom-right .user a[href*="/user/"]') ||
        document.querySelector('.user a[href*="/user/"]');
      const name = a && a.textContent ? a.textContent.trim() : '';
      return name || null;
    });
  } catch {
    return null;
  }
}

// Post a comment on a thread. Throws on any verification failure. Verbatim from
// ML Studio — this is the hard-won, load-bearing part.
async function postComment({ wsEndpoint, threadUrl, redditPostId, expectedUsername, body }) {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null, protocolTimeout: 120000 });
  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    await page.bringToFront().catch(() => {});
    autoHandleDialogs(page, log); // never wait on a "leave page?" prompt
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);

    await page.goto('https://old.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(rand(800, 1800));
    const who = await loggedInUser(page);
    if (!who) throw new Error('ABORT: no user is logged in to this AdsPower profile.');
    if (expectedUsername && who.toLowerCase() !== String(expectedUsername).toLowerCase())
      throw new Error(`ABORT: profile is logged in as "${who}", expected "${expectedUsername}".`);
    if (!expectedUsername)
      log(`WARNING: no expected username set — skipping the wrong-account safety check (logged in as "${who}").`);

    const oldUrl = toOldReddit(threadUrl);
    await page.goto(oldUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(rand(1200, 2600));
    const onRightThread = await page.evaluate(
      (id) => document.location.href.includes(id) || !!document.querySelector(`[data-fullname="t3_${id}"]`),
      redditPostId,
    );
    if (!onRightThread) throw new Error(`ABORT: not on the expected thread (${redditPostId}).`);

    const boxSel = 'div.commentarea > div.usertext textarea[name="text"]';
    const fallbackSel = 'div.commentarea textarea[name="text"]';
    const sel = (await page.$(boxSel)) ? boxSel : fallbackSel;
    if (!(await page.$(sel)))
      throw new Error('ABORT: could not find the comment box (locked/archived thread, or markup changed).');

    await typeHuman(page, sel, body);
    await sleep(rand(900, 2200));

    if (dryRun) {
      log('DRY_RUN: typed the comment but NOT submitting.');
      return { ok: true, dryRun: true, permalink: '' };
    }

    const taHandle = await page.$(sel);
    const btnHandle = await page.evaluateHandle((el) => {
      const form = el.closest('form');
      if (!form) return null;
      return (
        form.querySelector('button[type="submit"]') ||
        form.querySelector('button.save') ||
        Array.from(form.querySelectorAll('button')).find((b) => /^(save|comment|reply|post)$/i.test((b.textContent || '').trim())) ||
        form.querySelector('button')
      );
    }, taHandle);
    const submitBtn = btnHandle.asElement();
    if (!submitBtn) {
      await page.screenshot({ path: 'last-attempt.png' }).catch(() => {});
      throw new Error('ABORT: could not find the submit button in the comment form (saved last-attempt.png).');
    }
    log('submitting…');
    await sleep(rand(300, 800));
    await submitBtn.click().catch(() => {});
    await sleep(rand(2500, 4000));
    let stillFull = await page.$eval(sel, (el) => el.value.trim().length > 0).catch(() => true);
    if (stillFull) {
      log('first click did not submit — trying a direct click…');
      await submitBtn.evaluate((el) => el.click());
      await sleep(rand(2500, 4000));
    }

    const check = await page.evaluate((user) => {
      const errEl = document.querySelector('div.commentarea .error, .ratelimit, .status .error');
      const err = errEl && errEl.offsetParent !== null && errEl.textContent ? errEl.textContent.trim() : '';
      const box =
        document.querySelector('div.commentarea > div.usertext textarea[name="text"]') ||
        document.querySelector('div.commentarea textarea[name="text"]');
      const boxText = box ? box.value : '';
      let permalink = '';
      if (user) {
        const mine = Array.from(document.querySelectorAll('div.commentarea .comment')).find((c) => {
          const a = c.querySelector('a.author');
          return a && a.textContent.trim().toLowerCase() === String(user).toLowerCase();
        });
        permalink = mine?.querySelector('a.bylink')?.href || '';
      }
      return { err, boxText, permalink };
    }, expectedUsername);

    if (check.err) {
      await page.screenshot({ path: 'last-attempt.png' }).catch(() => {});
      throw new Error(`Reddit rejected the comment: "${check.err}" (saved last-attempt.png).`);
    }
    if (check.boxText && check.boxText.trim().length > 0) {
      await page.screenshot({ path: 'last-attempt.png' }).catch(() => {});
      throw new Error('Submit did not register — the comment box still has the text (saved last-attempt.png).');
    }
    if (!check.permalink) {
      log('WARNING: box cleared but could not confirm the comment by author — check username / shadowban.');
      await page.screenshot({ path: 'last-attempt.png' }).catch(() => {});
    }
    return { ok: true, dryRun: false, permalink: check.permalink };
  } finally {
    browser.disconnect();
  }
}

// Capture Reddit-side stats (karma + account age) by BEHAVING LIKE A HUMAN.
//
// No API calls, no fetch, no `.json` endpoints — nothing a normal browser session
// wouldn't do. The agent simply navigates to the account's OWN profile page (a
// page real users visit), lets it sit a beat, and reads the numbers straight out
// of the rendered sidebar DOM — "copy the text, keep the important part". Because
// it's the account's own logged-in AdsPower browser on its own sticky IP, this is
// indistinguishable from the person glancing at their own karma. There is no
// request the human UI wouldn't also make, so there's nothing anomalous to flag.
//
// Read-only and best-effort: any failure is swallowed so it can never affect
// posting. Returns a plain-number snapshot, or null if it couldn't read the page.
// Subscriptions aren't shown on the profile sidebar, so this path leaves them
// unset (-1) — karma + age are the headline signals and both live here.
/** Parse NEW reddit's profile page (shreddit). Text-first, for the same reason
 *  the old.reddit parse is: class names churn, the words beside the numbers do
 *  not. Runs inside page.evaluate, so it must be self-contained. */
function parseNewRedditProfile() {
  // WRITTEN FROM A LIVE PROBE (2026-08-12), not from guesswork. What the page
  // actually contains:
  //     <span karma-number>3,892</span>
  //     "… 0 followers 3,892 Karma 1 Contributions 1 y Reddit Age …"
  //
  // Two things that broke three earlier attempts at this:
  //   - New reddit shows a COMBINED karma figure. There is no post/comment split
  //     like old.reddit's sidebar, so any parse demanding both labels declines.
  //   - The layout is NUMBER-then-LABEL ("3,892 Karma"), the opposite of what
  //     was assumed.
  const num = (s) => {
    const m = String(s || '').replace(/,/g, '').trim().match(/^([\d.]+)\s*([km])?/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1));
  };
  const flat = (document.body.innerText || '').replace(/\s+/g, ' ');

  // The attribute is the reliable read. The text pattern is only a fallback for
  // if it gets renamed — and it is anchored to the word "Karma" so a stray digit
  // elsewhere on the page cannot be mistaken for it, which is exactly how an
  // earlier version wrote a `1` over a real 3,892.
  let total = 0;
  const el = document.querySelector('[karma-number]');
  if (el) total = num(el.textContent);
  if (!total) {
    const m = flat.match(/([\d.,]+\s*[km]?)\s*karma\b/i);
    if (m) total = num(m[1]);
  }

  // Account age. New reddit gives a RELATIVE string ("1 y Reddit Age") rather
  // than a date, so prefer a real <time datetime> when one exists and
  // approximate otherwise. Coarse, but far better than 0 — which would blank the
  // account-age display entirely.
  let createdMs = 0;
  const t = document.querySelector('time[datetime]');
  if (t) {
    const d = Date.parse(t.getAttribute('datetime'));
    if (!Number.isNaN(d)) createdMs = d;
  }
  if (!createdMs) {
    const m = flat.match(/([\d.]+)\s*(y|yr|yrs|mo|mos|d)\s*reddit\s*age/i);
    if (m) {
      const n = parseFloat(m[1]);
      const u = m[2].toLowerCase();
      const days = u.startsWith('y') ? 365 : u.startsWith('mo') ? 30 : 1;
      if (Number.isFinite(n)) createdMs = Date.now() - n * days * 86400000;
    }
  }

  // linkKarma/commentKarma stay 0: new reddit genuinely does not publish the
  // split. Reporting a guessed division would be inventing data — totalKarma is
  // the number the dashboard leads on anyway.
  return { linkKarma: 0, commentKarma: 0, totalKarma: total, subscriptions: -1, redditCreatedAtMs: createdMs };
}

// ---- Follow-state capture ---------------------------------------------------
// Which communities does this account ACTUALLY follow?
//
// We keep our own record from confirmed joins, but that only ever knows about
// joins WE made. Communities joined by hand in AdsPower are invisible to it, and
// the composer would keep aiming discovery legs at them — harmless (the button
// check turns each into a no-op) but wasteful.
//
// ADDITIVE ONLY, deliberately. This parse is written against markup that has not
// been verified live, and the failure mode of an authoritative-but-wrong read is
// far worse than an incomplete one: shrinking the known set costs a wasted leg,
// but wrongly ADDING a community means it is never joined and nothing says so.
// So the caller merges with arrayUnion and this never reports absence.
//
// Same human contract as the stats capture: a page a real user opens, dwell,
// read the rendered DOM. No fetch, no .json, no request a browser would not make.
function parseSubscribedCommunities() {
  // The left nav rail lists the account's own communities. Scoped to the nav so
  // that "popular this week" style links elsewhere on the page cannot leak in,
  // and to /r/<name>/ exactly so a link to a POST inside a community is not read
  // as a membership.
  const roots = [
    document.querySelector('nav'),
    document.querySelector('reddit-sidebar-nav'),
    document.querySelector('[data-testid="left-sidebar"]'),
  ].filter(Boolean);
  if (!roots.length) return [];

  const out = new Set();
  for (const root of roots) {
    for (const a of root.querySelectorAll('a[href^="/r/"]')) {
      const m = /^\/r\/([A-Za-z0-9_]+)\/?$/.exec(a.getAttribute('href') || '');
      if (!m) continue;
      const name = m[1].toLowerCase();
      // The nav also carries the topic feeds and default destinations. These are
      // not memberships and must never be recorded as such.
      if (['popular', 'all', 'news', 'explore', 'home'].includes(name)) continue;
      out.add(name);
    }
  }
  return [...out];
}

async function captureFollowedSubreddits({ wsEndpoint }) {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null, protocolTimeout: 120000 });
  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    autoHandleDialogs(page, log);

    await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(rand(1500, 3000));

    // The communities list is collapsed behind a disclosure in the nav. Best
    // effort: if it will not open we simply read whatever is already expanded.
    const toggle = await page
      .$('nav faceplate-expandable-section-helper summary, nav details summary')
      .catch(() => null);
    if (toggle) {
      await toggle.click().catch(() => {});
      await sleep(rand(700, 1600));
    }

    const subs = await page.evaluate(parseSubscribedCommunities).catch(() => []);
    if (!subs.length) {
      log('follow-state: nothing readable in the nav — leaving the known list untouched.');
      return [];
    }
    log(`follow-state: nav lists ${subs.length} community/communities.`);
    return subs;
  } finally {
    browser.disconnect();
  }
}

async function captureAccountStats({ wsEndpoint, username, accountId }) {
  if (!username) return null; // no profile to visit without a handle
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null, protocolTimeout: 120000 });
  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    autoHandleDialogs(page, log); // stats capture navigates too

    // TRY THE ACCOUNT'S OWN SURFACE FIRST.
    //
    // This used to go straight to old.reddit because the sidebar parse is easy
    // there — written when POST_SURFACE was 'old'. After the 2026-07-29 switch
    // that made it the one surface these accounts otherwise never touch, which
    // splits the footprint the switch existed to keep on one surface. Now it
    // reads the profile where the account actually lives, and only falls back to
    // old.reddit if that yields nothing — so a shreddit markup change costs us
    // the tidy path, never the capture itself.
    if (postSurface === 'new') {
      try {
        await page.goto(`https://www.reddit.com/user/${encodeURIComponent(username)}/`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        await sleep(rand(1500, 3200)); // actually look at the page
        await page.evaluate(() => window.scrollBy(0, 120 + Math.random() * 200)).catch(() => {});
        await sleep(rand(400, 1100));
        const snapNew = await page.evaluate(parseNewRedditProfile);
        if (snapNew && snapNew.totalKarma > 0) {
          log(`stats: read from new reddit — karma ${snapNew.totalKarma}.`);
          await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await sleep(rand(900, 2200));
          return snapNew;
        }

        log('stats: new-reddit profile gave no karma — falling back to old.reddit for this capture.');
      } catch (e) {
        log(`stats: new-reddit profile read failed (${e.message}) — falling back to old.reddit.`);
      }
    }

    // Visit the account's own profile — exactly what a curious user does.
    const profileUrl = `https://old.reddit.com/user/${encodeURIComponent(username)}/`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(rand(1500, 3200)); // human dwell — actually look at the page
    await page.evaluate(() => window.scrollBy(0, 120 + Math.random() * 200)).catch(() => {});
    await sleep(rand(400, 1100));

    // Read the sidebar text and pull out only karma + cake day. Text parsing is
    // more robust to old.reddit's occasional markup tweaks than exact selectors.
    const snap = await page.evaluate(() => {
      const side = document.querySelector('.side') || document.body;
      const text = (side.innerText || '').replace(/ /g, ' ');
      const num = (s) => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0;

      // "12,345 post karma" / "6,789 comment karma" (labels sit next to numbers).
      let link = 0;
      let comment = 0;
      const pm = text.match(/([\d,]+)\s*(?:post|link)\s*karma/i);
      const cm = text.match(/([\d,]+)\s*comment\s*karma/i);
      if (pm) link = num(pm[1]);
      if (cm) comment = num(cm[1]);
      // Fallback to the explicit karma spans if the labels moved.
      if (!link) link = num(document.querySelector('span.karma:not(.comment-karma)')?.textContent);
      if (!comment) comment = num(document.querySelector('span.karma.comment-karma')?.textContent);

      // Cake day — the exact date lives in a <time> element's datetime/title.
      let createdMs = 0;
      const timeEl = side.querySelector('time[datetime]') || document.querySelector('.age time[datetime]');
      if (timeEl) {
        const d = Date.parse(timeEl.getAttribute('datetime'));
        if (!Number.isNaN(d)) createdMs = d;
      }
      if (!createdMs) {
        const t2 = side.querySelector('time[title]');
        if (t2) {
          const d = Date.parse(t2.getAttribute('title'));
          if (!Number.isNaN(d)) createdMs = d;
        }
      }

      return { linkKarma: link, commentKarma: comment, totalKarma: link + comment, subscriptions: -1, redditCreatedAtMs: createdMs };
    });

    // NEVER LEAVE THE ACCOUNT PARKED ON OLD.REDDIT.
    //
    // This function reads the profile from old.reddit because the sidebar parse
    // is easy there — written when POST_SURFACE was 'old'. Since the 2026-07-29
    // switch to new reddit that is a surface it otherwise never touches, and
    // because this runs LAST in a job, the browser was being left sitting on it:
    // a session that browses www.reddit.com for seven minutes and then ends on
    // old.reddit is precisely the split footprint the new-reddit move existed to
    // eliminate. Affects posting too, not just warm-up.
    //
    // Going home afterwards is the cheap half of the fix. The real one is to
    // parse the profile on whichever surface the account actually uses, so
    // old.reddit is never opened at all.
    const home = postSurface === 'new' ? 'https://www.reddit.com/' : 'https://old.reddit.com/';
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(rand(900, 2200));

    // If the sidebar gave us nothing usable, report no-capture rather than zeros.
    if (!snap || (!snap.totalKarma && !snap.redditCreatedAtMs)) return null;
    return snap;
  } finally {
    browser.disconnect();
  }
}

// Whether to bother capturing this session. Keeping it human means NOT visiting
// the profile after every single comment (that regularity is its own tell): do it
// on first-ever capture, when the last one is stale, or when an operator asked via
// the "Update data" button. Otherwise skip — the karma didn't meaningfully move.
function shouldCaptureStats(account, nowMs) {
  if (account.statsRefreshRequestedAt) return true;
  const last = account.stats?.capturedAtMs || 0;
  if (!last) return true;
  return nowMs - last >= STATS_MAX_AGE_MS;
}

// Post via NEW reddit — connect to the open AdsPower profile and run the plan
// through the shared executor. The plan is the humanized approach itinerary
// (subreddit → browse → find the post → read → maybe skim comments → comment);
// Phase 3 will generate it at enqueue time and store it on the job for display,
// which changes nothing here. Returns the same { ok, dryRun, permalink } shape as
// the old.reddit postComment().
async function postViaNewReddit({ wsEndpoint, job }) {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null, protocolTimeout: 120000 });
  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    await page.bringToFront().catch(() => {});
    // Answer "Reload site? Changes you made may not be saved." without a human.
    // The AdsPower tab is reused between jobs, so a previous run that typed but
    // didn't submit (every dry run) leaves the composer dirty — and the FIRST
    // navigation of the next job then hangs on that dialog forever.
    autoHandleDialogs(page, log);
    // Treat the page as focused even when the AdsPower window isn't frontmost, so
    // Chromium will move DOM focus onto the comment box (else activeElement stays
    // BODY and keystrokes become Reddit shortcuts).
    try {
      const cdp = await page.target().createCDPSession();
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      log('focus emulation ON.');
    } catch (e) {
      log(`focus emulation unavailable: ${e.message}`);
    }
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);
    const ctx = {
      threadUrl: job.threadUrl,
      redditPostId: job.redditPostId,
      subreddit: job.subreddit,
      expectedUsername: job.expectedUsername,
      body: job.body,
      dryRun,
      log,
    };
    // job.approachPlan is honoured when present (Phase 3 stores it at enqueue
    // time); otherwise compose one now.
    const plan = Array.isArray(job.approachPlan) && job.approachPlan.length ? job.approachPlan : composeApproachPlan(job);
    log(`approach plan: ${describePlan(plan)}`);
    const { terminalResult, trace } = await runPlan(page, plan, ctx);
    return { ...(terminalResult || { ok: false, dryRun, permalink: '' }), trace };
  } finally {
    browser.disconnect();
  }
}

// ---- Warm-up ----------------------------------------------------------------
// A browsing session. Same executor, same primitives, same profile lifecycle as
// posting — the ONLY difference is the plan it is handed, which is exactly what
// executor.mjs was built for.
//
// Two guarantees this function is responsible for:
//   1. It can never post. The plan is filtered to WARMUP_TYPES, so even a
//      corrupt or hand-edited job carrying post_comment cannot submit anything.
//   2. It can never fail the account. Every warm-up primitive soft-skips, so a
//      session degrades to "did less than planned" rather than throwing.
async function runWarmupSession({ wsEndpoint, job }) {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null, protocolTimeout: 120000 });
  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    await page.bringToFront().catch(() => {});
    autoHandleDialogs(page, log);
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);

    const raw = Array.isArray(job.warmupPlan) ? job.warmupPlan : [];
    // The backstop. The composer is already gated on the same list; this is the
    // agent refusing to be the reason a warm-up posts something.
    const plan = raw.filter((s) => s && WARMUP_TYPES.has(s.type));
    const dropped = raw.length - plan.length;
    if (dropped) log(`warm-up: dropped ${dropped} step(s) not in the warm-up vocabulary.`);
    if (!plan.length) return { trace: [], summary: { planned: 0, ran: 0, skipped: 0, failed: 0, upvoted: 0 } };

    const ctx = { subreddit: job.subreddit || '', expectedUsername: job.expectedUsername || '', dryRun, log };
    log(`warm-up plan: ${plan.length} step(s) — ${plan.map((s) => s.type).join(' → ')}`);

    let trace = [];
    try {
      const res = await runPlan(page, plan, ctx);
      trace = res.trace || [];
    } catch (e) {
      // A warm-up primitive should never throw, but open_home/scroll_feed are
      // shared with posting and are not wrapped. Keep the partial trace: a
      // session that got 8 steps in is still a session, and the trace is what
      // stuck-detection reads later.
      trace = e.trace || [];
      log(`warm-up: stopped early — ${e.message}`);
    }

    const summary = {
      planned: plan.length,
      ran: trace.length,
      skipped: trace.filter((t) => t.skipped).length,
      failed: trace.filter((t) => t.ok === false).length,
      upvoted: trace.filter((t) => t.upvoted === true).length,
      // The LIVE switch as of this session — deliberately not job.dryRun, which
      // nothing writes. Reading it off the job made the first real run record
      // itself as live when it was a dry run, which would have made the whole
      // history untrustworthy.
      dryRun,
      // A dry run places no votes and that is not a failure. Counting intent
      // separately stops "allowed 1, placed 0" reading as a drifted selector —
      // the one signal stuck-detection is meant to key on.
      wouldUpvote: trace.filter((t) => t.dryRun === true).length,
      // Joins CONFIRMED by re-reading the button, not merely clicked.
      joined: trace.filter((t) => t.type === 'join_subreddit' && t.joined === true).length,
      // Skipped because the account already followed it — expected and healthy,
      // not a miss. Kept separate so it cannot be mistaken for a drifted selector.
      alreadyJoined: trace.filter((t) => t.type === 'join_subreddit' && t.reason === 'already-joined').length,
    };
    return { trace, summary };
  } finally {
    browser.disconnect();
  }
}

// ---- Job processing ----
const deferLogged = {};
let postedSession = 0;
// Live status, published on every heartbeat.
//
// `currentJob` is what the agent is doing RIGHT NOW (null when idle) and
// `queuedCount` is how many are still WAITING — the running one is not counted,
// since it isn't waiting. Both exist because a single per-poll number couldn't
// express "busy for the next six minutes": the loop blocks inside processJob(),
// so the chip froze on its pre-claim count and then went offline. `stage` is
// mutated in place as the job advances; the ticker publishes whatever it holds.
let currentJob = null;
let queuedCount = 0;
const setStage = (stage) => {
  if (currentJob) currentJob.stage = stage;
};
const beat = () =>
  store.heartbeat({ dryRun, queued: queuedCount, postedSession, pid: process.pid, current: currentJob });

/** Keep the heartbeat fresh across a long job. Returns a stop function; always
 *  call it in a finally, or the timer outlives the job it describes. */
function startHeartbeatTicker() {
  const t = setInterval(() => {
    beat().catch(() => {});
  }, HEARTBEAT_MS);
  t.unref?.(); // never hold the process open on this alone
  return () => clearInterval(t);
}

// `job` is the data the claim transaction already read — no second fetch. The
// claim only writes status/claimedAt/attempts, none of which this function uses.
async function processJob(ref, job) {
  const nowMs = Date.now();
  if (!job.adsPowerProfileId) return store.failJob(ref, 'No AdsPower profile id on the job.');

  const accountSnap = await store.accountRef(job.accountId).get();
  if (!accountSnap.exists) return store.failJob(ref, 'Account no longer exists.');
  const account = accountSnap.data();
  const kind = job.kind === 'warmup' ? 'warmup' : 'post';

  if (kind === 'warmup') {
    // The POSTING rails deliberately do NOT apply. dailyCap and
    // minIntervalMinutes count submitted comments; letting a browse consume a
    // posting slot would silently throttle real replies. The STATUS rails still
    // apply — never drive a banned or flagged account anywhere.
    if (account.status === 'banned' || account.status === 'flagged') {
      return store.failJob(ref, `Account ${account.status} — not browsing from it.`);
    }
  } else {
    const g = gate(account, nowMs);
    if (!g.ok) {
      if (g.hard) return store.failJob(ref, g.reason);
      await store.deferJob(ref);
      const t = Date.now();
      if (!deferLogged[ref.id] || t - deferLogged[ref.id] > 60000) {
        log(`job ${ref.id} waiting: ${g.reason}`);
        deferLogged[ref.id] = t;
      }
      return 'deferred';
    }
  }

  // Past the rails — this job is really going to run, so publish it. Deliberately
  // AFTER the gate: a job deferred every poll (min interval not elapsed) would
  // otherwise flash "starting" into the UI every few seconds and back out again.
  currentJob = {
    jobId: ref.id,
    subreddit: job.subreddit || '',
    expectedUsername: job.expectedUsername || '',
    startedAtMs: Date.now(),
    stage: 'starting',
  };
  await beat(); // don't make the UI wait for the ticker's first tick

  let data;
  setStage('opening profile');
  try {
    data = await startProfile(job.adsPowerProfileId);
  } catch (e) {
    return store.failJob(ref, `AdsPower could not open profile ${job.adsPowerProfileId}: ${e.message}`);
  }
  const wsEndpoint = data?.ws?.puppeteer;
  if (!wsEndpoint) return store.failJob(ref, 'AdsPower did not return a Puppeteer endpoint.');
  await sleep(1500);

  // --- warm-up: browse, then stop. Never reaches the posting path below. ---
  if (kind === 'warmup') {
    setStage(`warming up${job.subreddit ? ` · r/${job.subreddit}` : ''}`);
    let out;
    try {
      out = await runWarmupSession({ wsEndpoint, job });
    } catch (e) {
      if (CLOSE_AFTER) await stopProfile(job.adsPowerProfileId);
      return store.failJob(ref, e.message, e.trace);
    }

    // Reconcile what the account really follows. Gated on the same cadence as
    // the stats capture so it is occasional rather than every session, and
    // ADDITIVE — see captureFollowedSubreddits on why an unverified parse must
    // never be allowed to shrink the known set.
    if (shouldCaptureStats(account, Date.now())) {
      setStage('reading followed communities');
      try {
        const subs = await captureFollowedSubreddits({ wsEndpoint });
        if (subs.length) await store.mergeFollowedSubreddits(job.accountId, subs);
      } catch (e) {
        log(`warm-up ${ref.id} follow-state capture skipped: ${e.message}`);
      }
    }

    // The profile is open and logged in RIGHT NOW, and this session posted
    // nothing — which makes it a better moment to read karma than a posting run.
    if (job.expectedUsername && shouldCaptureStats(account, Date.now())) {
      setStage('reading account stats');
      try {
        const snap = await captureAccountStats({ wsEndpoint, username: job.expectedUsername, accountId: job.accountId });
        if (snap) await store.writeAccountStats(job.accountId, snap, Date.now());
      } catch (e) {
        log(`warm-up ${ref.id} stats capture skipped: ${e.message}`);
      }
    }

    if (CLOSE_AFTER) await stopProfile(job.adsPowerProfileId);
    await store.completeWarmupRun(ref, job, out);
    const s = out.summary;
    log(`warm-up ${ref.id} done — ${s.ran}/${s.planned} step(s), ${s.skipped} skipped, ${s.upvoted} upvote(s)${dryRun ? ' [DRY RUN]' : ''}.`);
    return;
  }

  let result;
  setStage(postSurface === 'new' ? `posting to r/${job.subreddit || '?'}` : 'posting');
  try {
    result =
      postSurface === 'new'
        ? await postViaNewReddit({ wsEndpoint, job })
        : await postComment({
            wsEndpoint,
            threadUrl: job.threadUrl,
            redditPostId: job.redditPostId,
            expectedUsername: job.expectedUsername,
            body: job.body,
          });
  } catch (e) {
    if (CLOSE_AFTER) await stopProfile(job.adsPowerProfileId);
    // runPlan attaches the partial trace to the error — a failed job keeps the
    // record of how far it got, which is the half you most want when debugging.
    return store.failJob(ref, e.message, e.trace);
  }

  // Opportunistic, human-like stats capture — the profile is open and logged in
  // RIGHT NOW. When due (first-ever / stale / operator-requested), the agent
  // visits this account's own profile page and reads karma + age from the sidebar
  // like a person would. Best-effort: never let it affect the post outcome. Runs
  // on dry-run too (read-only). Do it BEFORE CLOSE_AFTER tears the profile down.
  if (job.expectedUsername && shouldCaptureStats(account, Date.now())) {
    setStage('reading account stats');
    try {
      const snap = await captureAccountStats({ wsEndpoint, username: job.expectedUsername, accountId: job.accountId });
      if (snap) {
        await store.writeAccountStats(job.accountId, snap, Date.now());
        log(`job ${ref.id} stats captured from profile — karma ${snap.totalKarma}.`);
      } else {
        log(`job ${ref.id} stats capture: sidebar not readable, skipped.`);
      }
    } catch (e) {
      log(`job ${ref.id} stats capture skipped: ${e.message}`);
    }
  }

  if (CLOSE_AFTER) await stopProfile(job.adsPowerProfileId);

  if (result.dryRun) {
    await store.failJob(
      ref,
      'Dry run — typed but did not submit. Turn off Dry run on the Accounts page to post for real, then Post again.',
      result.trace,
    );
    log(`job ${ref.id} DRY_RUN complete (not posted).`);
    return;
  }

  await store.writeSuccess(ref, job, account, result.permalink, result.trace);
  postedSession += 1;
  log(`job ${ref.id} POSTED ${result.permalink || job.threadUrl}`);
}

// ---- Main loop ----
let running = true;
process.on('SIGINT', () => (running = false));
process.on('SIGTERM', () => (running = false));

async function main() {
  log(`agent started — DRY_RUN default=${DRY_RUN_DEFAULT} (live switch: agents/control.dryRun, set from the web UI), poll=${POLL_INTERVAL_MS}ms, AdsPower=${ADSPOWER_API}, project=${serviceAccount.project_id}`);
  if (serviceAccount.project_id !== 'motherlink-engage') {
    log(`ERROR: this key is for "${serviceAccount.project_id}", not motherlink-engage.`);
    log('Point SERVICE_ACCOUNT_PATH at the Engage admin key (~/.config/motherlink-engage/admin.json), then restart.');
    process.exit(1);
  }
  // Seed the control doc (create-only) so the web UI has a dry-run value to toggle,
  // then read whatever value is actually there — an operator may have set it earlier.
  await store.ensureControl(DRY_RUN_DEFAULT);
  const override = await store.readDryRunOverride();
  dryRun = override ?? DRY_RUN_DEFAULT;
  // POST_SURFACE (.env) is authoritative unless an operator EXPLICITLY sets
  // agents/control.postSurface (future UI / manual). We do NOT auto-seed the doc,
  // so `.env` rollback stays predictable: POST_SURFACE=old + restart → old.
  const surfaceOverride = await store.readSurfaceOverride();
  postSurface = surfaceOverride ?? POST_SURFACE_DEFAULT;
  log(`posting surface: ${postSurface}${postSurface === 'new' ? ' (NEW reddit — Phase 1 spike; roll back: POST_SURFACE=old + restart, or agents/control.postSurface="old" to flip live)' : ' (old.reddit — proven path)'}`);

  // Startup connectivity check — write one heartbeat and surface any failure here,
  // rather than letting the loop's swallowed heartbeat hide a misconfiguration.
  try {
    await db.collection('agents').doc('agent').set(
      {
        lastSeenAt: FieldValue.serverTimestamp(),
        dryRun,
        queued: 0,
        postedSession: 0,
        pid: process.pid,
        // Clear any `current` left behind by an agent that died mid-job, so the UI
        // never shows a phantom "posting…" from a process that no longer exists.
        current: FieldValue.delete(),
      },
      { merge: true },
    );
    log(`connected to Engage — heartbeat written (dry-run is ${dryRun ? 'ON' : 'OFF — posting for real'}). The Accounts chip should go green within ~20s.`);
  } catch (e) {
    log(`ERROR: connected but could NOT write agents/agent: ${e.message}`);
    log('The key likely lacks write access. Use the Engage ADMIN key, not a read-only one.');
    process.exit(1);
  }

  while (running) {
    try {
      // Live dry-run switch: re-read every poll so a UI toggle takes effect now.
      const ov = await store.readDryRunOverride();
      const nextDryRun = ov ?? DRY_RUN_DEFAULT;
      if (nextDryRun !== dryRun) log(`dry-run switched ${nextDryRun ? 'ON (will not submit)' : 'OFF (posting for real)'} from the web UI.`);
      dryRun = nextDryRun;

      // Live posting-surface switch (old ↔ new reddit), re-read every poll.
      const sv = await store.readSurfaceOverride();
      const nextSurface = sv ?? POST_SURFACE_DEFAULT;
      if (nextSurface !== postSurface) log(`posting surface switched to ${nextSurface === 'new' ? 'NEW reddit' : 'old.reddit'}.`);
      postSurface = nextSurface;

      // Un-stick jobs an earlier (stopped) agent left in 'posting'. Marked failed,
      // not re-queued — see reclaimStalePosting (avoids double-posting).
      const cleared = await store.reclaimStalePosting(STALE_POSTING_MS, Date.now(), STALE_WARMUP_MS);
      if (cleared) log(`cleared ${cleared} stuck 'posting' job(s) → failed; review and Post again in the UI if needed.`);

      // `queued` is what is still WAITING — the job just claimed is excluded, since
      // it's running, not waiting. processJob publishes `currentJob` once it clears
      // the account rails.
      const { ref, job, queued } = await store.claimOldestQueued();
      queuedCount = queued;
      currentJob = null;
      await beat();
      log(`poll — ${queued} waiting${ref ? `, working ${ref.id}` : ''}${dryRun ? ' [dry-run]' : ''}`);
      if (ref) {
        // The beat has to keep running INSIDE processJob: it blocks for minutes,
        // which is far longer than the UI's 20s online window.
        const stopTicker = startHeartbeatTicker();
        let outcome;
        try {
          outcome = await processJob(ref, job);
        } finally {
          stopTicker();
          // A deferred job went straight back to 'queued' — count it as waiting
          // again rather than under-reporting until the next poll.
          if (outcome === 'deferred') queuedCount += 1;
          currentJob = null;
          await beat(); // publish idle immediately, don't wait for the next poll
        }
        if (outcome !== 'deferred') continue;
      }
    } catch (e) {
      log('loop error:', e?.message || e);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  log('agent stopped.');
  process.exit(0);
}

main();
