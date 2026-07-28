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

import { rand, sleep, humanTypeFocused, waitForDeep, queryFirst, humanScroll } from './helpers.mjs';

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
// Best-effort: confirm the open profile is the ACCOUNT we think it is. If we can
// positively read a DIFFERENT username → abort. If we can't read one at all →
// warn but proceed (the AdsPower profile is pinned to this account anyway).
// VALIDATE: which of these actually exposes the handle on Shreddit.
async function readLoggedInUser(page) {
  try {
    return await page.evaluate(() => {
      const pick = (el) => (el && el.textContent ? el.textContent.trim().replace(/^u\//i, '') : '');
      // 1) an account/profile link in the header
      const a =
        document.querySelector('a[href^="/user/"][href$="/"]') ||
        document.querySelector('#expand-user-drawer-button a[href^="/user/"]');
      const fromHref = a && a.getAttribute('href') ? a.getAttribute('href').split('/')[2] : '';
      if (fromHref) return fromHref;
      // 2) an aria-label / element carrying the username
      const lbl = document.querySelector('[aria-label^="u/"], [aria-label*="Account"]');
      const m = lbl && lbl.getAttribute('aria-label') ? lbl.getAttribute('aria-label').match(/u\/([A-Za-z0-9_-]+)/) : null;
      if (m) return m[1];
      return pick(document.querySelector('faceplate-tracker[source="account"] a'));
    });
  } catch {
    return '';
  }
}

async function verifyLoggedInUser(page, expectedUsername, log) {
  const who = await readLoggedInUser(page);
  if (!who) {
    log(`WARNING: could not read the logged-in user on new reddit — skipping the wrong-account check (profile is pinned to this account).`);
    return;
  }
  if (expectedUsername && who.toLowerCase() !== String(expectedUsername).toLowerCase()) {
    throw new Error(`ABORT: profile is logged in as "${who}", expected "${expectedUsername}".`);
  }
}

// --- navigation ----------------------------------------------------------
async function ensureOnThread(page, threadUrl, redditPostId, log) {
  const onRight = await page
    .evaluate((id) => document.location.href.includes(id), redditPostId)
    .catch(() => false);
  if (onRight) return;
  const url = toWwwReddit(threadUrl);
  log(`navigating to thread ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(rand(1500, 3200));
  const ok = await page.evaluate((id) => document.location.href.includes(id), redditPostId).catch(() => false);
  if (!ok) throw new Error(`ABORT: not on the expected thread (${redditPostId}).`);
}

// --- composer ------------------------------------------------------------
// VALIDATE these selectors. Shreddit's composer is <shreddit-composer>; the
// editable is a contenteditable div, sometimes gated behind a placeholder that
// must be clicked to reveal the editor. Puppeteer's `>>>` pierces OPEN shadow
// roots; if the root is closed these won't match and we need a CDP/keyboard
// fallback (noted below).
const COMPOSER_PLACEHOLDER = [
  'shreddit-composer',
  'button[aria-label*="comment" i]',
  '[data-testid="comment-submission-form-richtext"]',
];
const EDITABLE = [
  'shreddit-composer [contenteditable="true"]',
  'shreddit-composer >>> [contenteditable="true"]',
  '[contenteditable="true"][name="body"]',
  '[contenteditable="true"][role="textbox"]',
];
const SUBMIT = [
  'shreddit-composer button[type="submit"]',
  'shreddit-composer >>> button[type="submit"]',
  'button[slot="submit-button"]',
  'button[aria-label="Comment" i]',
];

async function openComposerAndType(page, body, log) {
  // Bring the composer into view (it's at the bottom of the thread).
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(rand(800, 1800));

  // Reveal the editor if it's behind a placeholder.
  const placeholder = await queryFirst(page, COMPOSER_PLACEHOLDER);
  if (placeholder) {
    await placeholder.click().catch(() => {});
    await sleep(rand(500, 1400));
  }

  const editable = await waitForDeep(page, EDITABLE.join(', '), 15000);
  if (!editable) {
    throw new Error('ABORT: could not find the new-reddit comment editor (contenteditable). Selectors need updating, or the shadow root is closed (needs a CDP/keyboard fallback).');
  }
  await editable.click().catch(() => {});
  await sleep(rand(300, 900));
  await humanTypeFocused(page, body); // types into the focused contenteditable
  await sleep(rand(600, 1600));
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

async function submitAndConfirm(page, expectedUsername, log) {
  const watcher = watchForCommentResponse(page);
  try {
    const btn = await queryFirst(page, SUBMIT);
    if (!btn) throw new Error('ABORT: could not find the new-reddit submit button.');
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
  await verifyLoggedInUser(page, ctx.expectedUsername, ctx.log);

  // A human glances around the thread before the box; harmless on new reddit.
  await humanScroll(page, { steps: rand(1, 3) });

  await openComposerAndType(page, body, ctx.log);

  if (ctx.dryRun) {
    ctx.log('DRY_RUN: typed the comment on new reddit but NOT submitting.');
    return { ok: true, dryRun: true, permalink: '' };
  }

  const permalink = await submitAndConfirm(page, ctx.expectedUsername, ctx.log);
  return { ok: true, dryRun: false, permalink };
}
