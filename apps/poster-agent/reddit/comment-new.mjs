// Phase 1 spike — post a comment on NEW reddit (Shreddit).
//
// This is the load-bearing unknown of the whole new-reddit move. Unlike
// old.reddit (a plain <textarea name="text"> + form POST), Shreddit's composer is
// a contenteditable rich-text editor inside a <shreddit-composer> web component,
// and success is confirmed from the create-comment network response rather than
// by scraping a virtualized comment list.
//
// EVERYTHING selector-ish here is best-effort and MUST be validated live on the
// Mac against a real thread — Shreddit markup is obfuscated and drifts. Record
// what actually worked in docs/NEW-REDDIT-PLAN.md → Validation log. All the
// fragile bits are contained in THIS file on purpose (cheap, localized repairs).
//
// Exposed as the `post_comment` primitive: typeAndSubmitComment(page, step, ctx).
// Respects ctx.dryRun (type but never submit). Returns { ok, permalink, dryRun }.

import { rand, sleep, deepQueryHandle, humanTypeFocused } from './helpers.mjs';

function toWwwReddit(url) {
  try {
    const u = new URL(url);
    u.hostname = 'www.reddit.com';
    return u.toString();
  } catch {
    return url;
  }
}

// --- logged-in identity --------------------------------------------------
// New reddit hides the handle behind the account menu (#expand-user-drawer-button
// is just an avatar, no username), so an exact-username read isn't cheaply
// available. Two-tier check instead:
//   1) HARD: an account must be logged in (composer / account button present) —
//      abort if not, so we never try to post from a logged-out profile.
//   2) BEST-EFFORT: read the handle if a cheap source exposes it; mismatch aborts
//      (live). If unreadable, rely on the AdsPower profile pinning (the profile IS
//      the account) and proceed with a note.

async function isLoggedIn(page) {
  return await page
    .evaluate(() => !!document.querySelector('#expand-user-drawer-button, shreddit-composer'))
    .catch(() => false);
}

async function readLoggedInUser(page) {
  try {
    return await page.evaluate(() => {
      const grab = (s) => {
        const m = s && s.match(/u\/([A-Za-z0-9_\-]+)/i);
        return m ? m[1] : '';
      };
      const btn = document.querySelector('#expand-user-drawer-button');
      if (btn) {
        const img = btn.querySelector('img[alt]');
        const fromAlt = img && grab(img.getAttribute('alt') || '');
        if (fromAlt) return fromAlt;
        const fromLabel = grab(btn.getAttribute('aria-label') || '');
        if (fromLabel) return fromLabel;
      }
      // A user link in the header/banner only (never the post/comment authors).
      const header = document.querySelector('reddit-header-large, header, [role="banner"]');
      const a = header && header.querySelector('a[href^="/user/"]');
      if (a) return (a.getAttribute('href') || '').split('/')[2] || '';
      return '';
    });
  } catch {
    return '';
  }
}

// lenient=true (dry-run) softens a username mismatch to a warning; lenient=false
// (live) hard-aborts. The logged-in check is enforced regardless.
async function verifyLoggedInUser(page, expectedUsername, log, lenient) {
  if (!(await isLoggedIn(page))) {
    throw new Error('ABORT: no account appears logged in on new reddit (no composer / account button) — check the AdsPower profile.');
  }
  const who = await readLoggedInUser(page);
  if (!who) {
    log('NOTE: logged in, but new reddit hides the handle behind the account menu — relying on the AdsPower profile pinning for account identity.');
    return;
  }
  if (expectedUsername && who.toLowerCase() !== String(expectedUsername).toLowerCase()) {
    const msg = `profile reads as "${who}", expected "${expectedUsername}"`;
    if (lenient) {
      log(`WARNING (dry-run): ${msg} — continuing.`);
      return;
    }
    throw new Error(`ABORT: ${msg}.`);
  }
  log(`logged-in user check OK: "${who}".`);
}

// --- navigation ----------------------------------------------------------
// ALWAYS load the thread fresh — the AdsPower profile persists between jobs, so a
// reused tab can carry a half-typed composer from a previous run (which caused a
// doubled comment). A fresh document load gives a pristine, empty composer.
async function ensureOnThread(page, threadUrl, redditPostId, log) {
  const url = toWwwReddit(threadUrl);
  log(`loading thread fresh: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(rand(1500, 3200));
  const ok = await page.evaluate((id) => document.location.href.includes(id), redditPostId).catch(() => false);
  if (!ok) throw new Error(`ABORT: not on the expected thread (${redditPostId}).`);
}

// --- composer ------------------------------------------------------------
// Verified live: the comment box is a real <textarea id="innerTextArea">
// (placeholder "Join the conversation") inside an OPEN faceplate shadow root.
// We deep-walk the open roots to grab it, click it (it may expand into a richer
// editor), then type into whatever ends up focused. VALIDATE the submit button
// (not exercised in dry-run) next round.
// The AdsPower profile renders the composer as <textarea id="innerTextArea">
// (placeholder "Join the conversation") — that's what typed successfully live, so
// target it FIRST. The <shreddit-composer> richText contenteditable (seen in a
// plain Chrome window) is a fallback for that variant.
const EDITABLE = [
  'textarea#innerTextArea',
  'textarea[placeholder*="Join the conversation" i]',
  'shreddit-composer div[slot="rte"][contenteditable="true"]',
  'shreddit-composer [contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
];
const SUBMIT = [
  'shreddit-composer button[type="submit"]',
  'button[aria-label="Comment" i]',
  'button[slot="submit-button"]',
  'button[type="submit"]',
];

async function openComposerAndType(page, body, log) {
  // Bring the composer (bottom of the thread) into view.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(rand(800, 1800));

  // Find + click the box to focus it (clicking may expand it).
  const box = await deepQueryHandle(page, EDITABLE);
  if (!box) {
    throw new Error('ABORT: could not find the comment box — selectors need updating.');
  }
  await box.click().catch(() => {});
  await sleep(rand(600, 1300));

  const editable = (await deepQueryHandle(page, EDITABLE)) || box;
  await editable.click().catch(() => {});
  await editable.focus().catch(() => {});
  await sleep(rand(200, 500));

  // Type it in — keyboard events are the only method that reliably reaches these
  // framework-controlled composers (the fresh load already left the box empty).
  await humanTypeFocused(page, body);
  await sleep(rand(400, 900));

  const landed = await editable
    .evaluate((el) => (el.value ?? el.innerText ?? el.textContent ?? '').replace(/\s+$/, '').length)
    .catch(() => 0);
  log(`composer: box holds ${landed}/${body.length} chars.`);
  if (landed < body.length - 10) log('WARNING: box much shorter than the comment — inspect the composer.');
  return editable;
}

// --- submit + confirm via network ---------------------------------------
// Confirm the comment landed by watching the create-comment response, not by
// scraping the virtualized list. VALIDATE: the actual endpoint + JSON shape;
// we scan candidate responses for a permalink. DOM scrape is the fallback.
function watchForCommentResponse(page) {
  const captured = { permalink: '', seen: false };
  const handler = async (res) => {
    try {
      const url = res.url();
      if (!/reddit\.com\/(svc|graphql)|gql\.reddit\.com/i.test(url)) return;
      const text = await res.text().catch(() => '');
      if (!text || !/comment/i.test(text)) return;
      // permalink looks like /r/<sub>/comments/<id>/<slug>/<commentid>/
      const m = text.match(/\/r\/[^"\\/]+\/comments\/[a-z0-9]+\/[^"\\]*\/[a-z0-9]+\/?/i);
      if (m && !captured.permalink) {
        captured.permalink = m[0].startsWith('http') ? m[0] : `https://www.reddit.com${m[0]}`;
        captured.seen = true;
      }
    } catch {
      /* ignore individual response parse errors */
    }
  };
  page.on('response', handler);
  return { captured, stop: () => page.off('response', handler) };
}

// The green "Comment" button (screenshot-confirmed text). Try known selectors,
// then fall back to an enabled <button> whose text is exactly "Comment", across
// shadow roots. VALIDATE live — dry-run stops before this.
async function findSubmitButton(page) {
  const bySel = await deepQueryHandle(page, SUBMIT);
  if (bySel) return bySel;
  const handle = await page.evaluateHandle(() => {
    const btns = [];
    const walk = (r) => {
      r.querySelectorAll('button').forEach((b) => btns.push(b));
      r.querySelectorAll('*').forEach((n) => n.shadowRoot && walk(n.shadowRoot));
    };
    walk(document);
    return btns.find((b) => /^comment$/i.test((b.textContent || '').trim()) && !b.disabled) || null;
  });
  const el = handle.asElement();
  if (!el) {
    await handle.dispose().catch(() => {});
    return null;
  }
  return el;
}

async function submitAndConfirm(page, expectedUsername, log) {
  const watcher = watchForCommentResponse(page);
  try {
    const btn = await findSubmitButton(page);
    if (!btn) throw new Error('ABORT: could not find the new-reddit submit button ("Comment").');
    log('submitting…');
    await sleep(rand(300, 900));
    await btn.click().catch(() => {});
    // Give the network + UI time to settle.
    await sleep(rand(2500, 4500));

    if (watcher.captured.permalink) return watcher.captured.permalink;

    // Fallback: scrape the DOM for our just-posted comment by author.
    const permalink = await page
      .evaluate((user) => {
        const anchors = Array.from(document.querySelectorAll('a[href*="/comments/"]'));
        const mine = anchors.find((a) => a.href && a.href.toLowerCase().includes(`/${String(user).toLowerCase()}/`));
        return mine ? mine.href : '';
      }, expectedUsername)
      .catch(() => '');
    if (!permalink) {
      log('WARNING: could not confirm the comment via network or DOM — check the account/thread manually.');
    }
    return permalink;
  } finally {
    watcher.stop();
  }
}

// --- the primitive -------------------------------------------------------
export async function typeAndSubmitComment(page, step, ctx) {
  const body = (step && step.params && step.params.body) || ctx.body;
  if (!body) throw new Error('ABORT: no comment body to post.');

  await ensureOnThread(page, ctx.threadUrl, ctx.redditPostId, ctx.log);
  await sleep(rand(800, 1800));
  await verifyLoggedInUser(page, ctx.expectedUsername, ctx.log, ctx.dryRun);

  // Kept minimal for now: straight to the box. Human browse/read theater comes
  // later (Phase 2/3), reusing the same executor.
  await openComposerAndType(page, body, ctx.log);

  if (ctx.dryRun) {
    ctx.log('DRY_RUN: typed the comment on new reddit but NOT submitting.');
    return { ok: true, dryRun: true, permalink: '' };
  }

  const permalink = await submitAndConfirm(page, ctx.expectedUsername, ctx.log);
  return { ok: true, dryRun: false, permalink };
}
