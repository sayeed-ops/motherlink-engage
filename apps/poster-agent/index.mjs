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

// ---- Config ----
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
// Node does NOT expand ~ in a path — do it ourselves, since operators reach for it.
const rawKeyPath = process.env.SERVICE_ACCOUNT_PATH || './service-account.json';
const SERVICE_ACCOUNT_PATH = rawKeyPath.startsWith('~') ? join(homedir(), rawKeyPath.slice(1)) : rawKeyPath;
const ADSPOWER_API = (process.env.ADSPOWER_API || 'http://local.adspower.net:50325').replace(/\/$/, '');
const DRY_RUN = String(process.env.DRY_RUN || '').trim() === '1';
const CLOSE_AFTER = String(process.env.CLOSE_AFTER || '').trim() === '1';

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
async function adspower(path) {
  const res = await fetch(`${ADSPOWER_API}${path}`);
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`AdsPower API ${path}: ${json.msg || 'unknown error'}`);
  return json.data;
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

    if (DRY_RUN) {
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

// ---- Job processing ----
const deferLogged = {};
let postedSession = 0;

async function processJob(ref) {
  const job = (await ref.get()).data();
  const nowMs = Date.now();
  if (!job.adsPowerProfileId) return store.failJob(ref, 'No AdsPower profile id on the job.');

  const accountSnap = await store.accountRef(job.accountId).get();
  if (!accountSnap.exists) return store.failJob(ref, 'Account no longer exists.');
  const account = accountSnap.data();
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

  let data;
  try {
    data = await startProfile(job.adsPowerProfileId);
  } catch (e) {
    return store.failJob(ref, `AdsPower could not open profile ${job.adsPowerProfileId}: ${e.message}`);
  }
  const wsEndpoint = data?.ws?.puppeteer;
  if (!wsEndpoint) return store.failJob(ref, 'AdsPower did not return a Puppeteer endpoint.');
  await sleep(1500);

  let result;
  try {
    result = await postComment({
      wsEndpoint,
      threadUrl: job.threadUrl,
      redditPostId: job.redditPostId,
      expectedUsername: job.expectedUsername,
      body: job.body,
    });
  } catch (e) {
    if (CLOSE_AFTER) await stopProfile(job.adsPowerProfileId);
    return store.failJob(ref, e.message);
  }
  if (CLOSE_AFTER) await stopProfile(job.adsPowerProfileId);

  if (result.dryRun) {
    await store.failJob(ref, 'DRY_RUN — typed but did not submit. Set DRY_RUN=0 to post for real.');
    log(`job ${ref.id} DRY_RUN complete (not posted).`);
    return;
  }

  await store.writeSuccess(ref, job, account, result.permalink);
  postedSession += 1;
  log(`job ${ref.id} POSTED ${result.permalink || job.threadUrl}`);
}

// ---- Main loop ----
let running = true;
process.on('SIGINT', () => (running = false));
process.on('SIGTERM', () => (running = false));

async function main() {
  log(`agent started — DRY_RUN=${DRY_RUN}, poll=${POLL_INTERVAL_MS}ms, AdsPower=${ADSPOWER_API}, project=${serviceAccount.project_id}`);
  if (serviceAccount.project_id !== 'motherlink-engage') {
    log(`ERROR: this key is for "${serviceAccount.project_id}", not motherlink-engage.`);
    log('Point SERVICE_ACCOUNT_PATH at the Engage admin key (~/.config/motherlink-engage/admin.json), then restart.');
    process.exit(1);
  }
  // Startup connectivity check — write one heartbeat and surface any failure here,
  // rather than letting the loop's swallowed heartbeat hide a misconfiguration.
  try {
    await db.collection('agents').doc('agent').set(
      { lastSeenAt: FieldValue.serverTimestamp(), dryRun: DRY_RUN, queued: 0, postedSession: 0, pid: process.pid },
      { merge: true },
    );
    log('connected to Engage — heartbeat written. The Accounts chip should go green within ~20s.');
  } catch (e) {
    log(`ERROR: connected but could NOT write agents/agent: ${e.message}`);
    log('The key likely lacks write access. Use the Engage ADMIN key, not a read-only one.');
    process.exit(1);
  }

  while (running) {
    try {
      const { ref, size } = await store.claimOldestQueued();
      await store.heartbeat({ dryRun: DRY_RUN, queued: size, postedSession, pid: process.pid });
      log(`poll — ${size} queued job(s)`);
      if (ref) {
        const outcome = await processJob(ref);
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
