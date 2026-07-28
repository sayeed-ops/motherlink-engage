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

import { rand, sleep, humanTypeFocused, deepQueryHandle, humanScroll } from './helpers.mjs';

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
// Confirm the open profile is the ACCOUNT we think it is. The trap (found live):
// a page-wide `a[href^="/user/"]` matches POST/COMMENT AUTHORS, not the logged-in
// user — so we must read from the HEADER / account button only. Strategies below,
// most-reliable first. VALIDATE which one actually carries the handle on Shreddit
// and prune the rest. Returns the handle, or '' if it genuinely can't be read.
async function readLoggedInUser(page) {
  try {
    return await page.evaluate(() => {
      const grab = (s) => {
        const m = s && s.match(/u\/([A-Za-z0-9_\-]+)/i);
        return m ? m[1] : '';
      };
      // 1) The account-drawer button in the top-right (this IS your account).
      const btn = document.querySelector(
        '#expand-user-drawer-button, button[aria-label*="account" i], button[aria-label*="profile" i], faceplate-dropdown-menu[aria-label*="account" i]',
      );
      if (btn) {
        const fromLabel = grab(btn.getAttribute('aria-label') || '');
        if (fromLabel) return fromLabel;
        const img = btn.querySelector('img[alt]');
        const fromAlt = img && grab(img.getAttribute('alt') || '');
        if (fromAlt) return fromAlt;
        const a = btn.querySelector('a[href^="/user/"]');
        if (a) return (a.getAttribute('href') || '').split('/')[2] || '';
      }
      // 2) A user link inside the page HEADER/BANNER only (never the post body).
      const header = document.querySelector('reddit-header-large, header, [role="banner"], #header, #navbar');
      if (header) {
        const a = header.querySelector('a[href^="/user/"]');
        if (a) return (a.getAttribute('href') || '').split('/')[2] || '';
      }
      return '';
    });
  } catch {
    return '';
  }
}

// lenient=true (dry-run) turns a mismatch into a warning so the rest of the flow
// can be observed; lenient=false (live) hard-aborts — never post as the wrong user.
async function verifyLoggedInUser(page, expectedUsername, log, lenient) {
  const who = await readLoggedInUser(page);
  if (!who) {
    log('WARNING: could not read the logged-in user on new reddit — skipping the wrong-account check (profile is pinned to this account). VALIDATE the header selector.');
    return;
  }
  if (expectedUsername && who.toLowerCase() !== String(expectedUsername).toLowerCase()) {
    const msg = `profile reads as "${who}", expected "${expectedUsername}"`;
    if (lenient) {
      log(`WARNING (dry-run): ${msg} — continuing so the composer can be tested. If "${who}" is actually a post/comment author, the header selector still needs work.`);
      return;
    }
    throw new Error(`ABORT: ${msg}.`);
  }
  log(`logged-in user check OK: "${who}".`);
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
// Verified live: the comment box is a real <textarea id="innerTextArea">
// (placeholder "Join the conversation") inside an OPEN faceplate shadow root.
// We deep-walk the open roots to grab it, click it (it may expand into a richer
// editor), then type into whatever ends up focused. VALIDATE the submit button
// (not exercised in dry-run) next round.
const EDITABLE = [
  'textarea#innerTextArea',
  'textarea[placeholder*="Join the conversation" i]',
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

  let editable = await deepQueryHandle(page, EDITABLE);
  if (!editable) {
    throw new Error('ABORT: could not find the comment box (textarea#innerTextArea / composer) — selectors need updating.');
  }
  // Clicking may swap the collapsed textarea for an expanded rich editor.
  await editable.click().catch(() => {});
  await sleep(rand(700, 1600));
  const expanded = await deepQueryHandle(page, EDITABLE);
  const target = expanded || editable;

  await target.focus().catch(() => target.click().catch(() => {}));
  await sleep(rand(300, 900));
  await humanTypeFocused(page, body); // page.keyboard.type → goes to the focused editable
  await sleep(rand(600, 1600));

  // Confirm the text actually landed (typing can silently miss if focus was lost).
  const landed = await target.evaluate((el) => (el.value ?? el.textContent ?? '').trim().length).catch(() => 0);
  log(`composer: typed ${body.length} chars, box now holds ${landed}.`);
  if (!landed) log('WARNING: the comment box looks empty after typing — focus/selector may need adjusting.');
  return target;
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
    const btn = await deepQueryHandle(page, SUBMIT);
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
  await verifyLoggedInUser(page, ctx.expectedUsername, ctx.log, ctx.dryRun);

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
