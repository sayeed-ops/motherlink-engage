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
// The comment box starts as a collapsed <textarea placeholder="Join the
// conversation"> and expands into the rich editor when clicked. Target the
// placeholder textarea FIRST (that's what focused + typed correctly, and the
// placeholder scoping avoids the create-POST box, whose placeholder is "Title").
const EDITABLE = [
  'textarea[placeholder*="Join the conversation" i]',
  'shreddit-composer[event-source="comment_composer"] div[slot="rte"][contenteditable="true"]',
  'shreddit-composer[event-source="comment_composer"] [contenteditable="true"]',
  'shreddit-composer[event-source="comment_composer"] textarea',
];
const SUBMIT = [
  '#comment-composer-submit-button', // confirmed id on AdsPower
  'shreddit-composer[event-source="comment_composer"] button[type="submit"]',
  'button[aria-label="Comment" i]',
];

// Guard: confirm a handle is really the COMMENT composer (placeholder "Join the
// conversation", or inside a <shreddit-composer event-source="comment_composer">)
// and NOT the create-post title field. Climbs light + shadow ancestors.
async function isCommentComposer(handle) {
  return handle
    .evaluate((el) => {
      const ph = (el.getAttribute && (el.getAttribute('placeholder') || '')).toLowerCase();
      if (ph.includes('join the conversation')) return true;
      let node = el;
      for (let i = 0; i < 10 && node; i++) {
        if (node.tagName && node.tagName.toLowerCase() === 'shreddit-composer') {
          return node.getAttribute('event-source') === 'comment_composer';
        }
        node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      }
      return false;
    })
    .catch(() => false);
}

// Is focus in the comment box right now? If not, keystrokes become Reddit's
// single-key shortcuts (save post / create post / copy) — the corruption we saw.
async function focusInBox(page) {
  return page
    .evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return false;
      if (a.getAttribute && a.getAttribute('contenteditable') === 'true') return true;
      if (a.tagName === 'TEXTAREA' && (a.getAttribute('placeholder') || '').toLowerCase().includes('join the conversation')) return true;
      return !!(a.closest && a.closest('shreddit-composer[event-source="comment_composer"]'));
    })
    .catch(() => false);
}

async function openComposerAndType(page, body, log) {
  await page.bringToFront().catch(() => {});

  const box = await deepQueryHandle(page, EDITABLE);
  if (!box) throw new Error('ABORT: could not find the comment box.');
  if (!(await isCommentComposer(box))) {
    throw new Error('ABORT: the editor found is NOT the comment composer (looks like the create-post box) — refusing to type.');
  }
  // Focus like a HUMAN: a real mouse click at the composer's actual screen
  // coordinates. This is what worked when the operator clicked manually —
  // ElementHandle.click()/DOM.focus computed odd geometry for the slotted shadow
  // contenteditable and didn't register. We click a point in the composer's upper
  // area (where the caret sits), verify focus, retry; abort if it won't take.
  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    const host =
      (await deepQueryHandle(page, [
        'shreddit-composer[event-source="comment_composer"]',
        'textarea[placeholder*="Join the conversation" i]',
      ])) || box;
    await host.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await sleep(rand(400, 800));
    const bb = await host.boundingBox().catch(() => null);
    if (bb && bb.width > 4 && bb.height > 4) {
      const x = bb.x + Math.min(30 + Math.random() * 40, bb.width * 0.4);
      const y = bb.y + Math.min(18 + Math.random() * 12, bb.height * 0.5);
      // DIAGNOSTIC: what element is actually at that pixel (is an overlay eating it)?
      const hit = await page
        .evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          return el ? `${el.tagName}${el.id ? '#' + el.id : ''}.${String(el.className || '').slice(0, 25)}` : 'none';
        }, { x, y })
        .catch(() => '?');
      await page.mouse.move(x, y).catch(() => {});
      await sleep(rand(80, 180));
      await page.mouse.click(x, y, { delay: rand(50, 120) }).catch(() => {});
      await sleep(rand(500, 900));
      const after = await page.evaluate(() => (document.activeElement ? document.activeElement.tagName : 'none')).catch(() => '?');
      log(`focus try ${i}: click (${Math.round(x)},${Math.round(y)}) bb=${Math.round(bb.width)}x${Math.round(bb.height)} hit=${hit} -> activeElement=${after}`);
    } else {
      log(`focus try ${i}: no usable boundingBox (${bb ? `${bb.width}x${bb.height}` : 'null'}).`);
    }
    ok = await focusInBox(page);
    if (ok) break;
    // Backstop: CDP focus on the editable in case the click missed.
    const editable = (await deepQueryHandle(page, EDITABLE)) || box;
    await editable.focus().catch(() => {});
    await sleep(rand(200, 400));
    ok = await focusInBox(page);
  }
  if (!ok) {
    const active = await page.evaluate(() => (document.activeElement ? `${document.activeElement.tagName}#${document.activeElement.id || ''}` : 'none')).catch(() => '?');
    throw new Error(`ABORT: could not put the caret in the comment box (activeElement=${active}) — refusing to type.`);
  }

  await humanTypeFocused(page, body);
  await sleep(rand(600, 1400));

  const target = (await deepQueryHandle(page, EDITABLE)) || box;
  const landed = await target
    .evaluate((el) => (el.value ?? el.innerText ?? el.textContent ?? '').replace(/\s+$/, '').length)
    .catch(() => 0);
  log(`composer: box holds ${landed}/${body.length} chars.`);
  return landed;
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
  const landed = await openComposerAndType(page, body, ctx.log);

  if (ctx.dryRun) {
    ctx.log(`DRY_RUN: composer holds ${landed} chars on new reddit — NOT submitting.`);
    return { ok: true, dryRun: true, permalink: '' };
  }

  // Never submit an empty/near-empty box for real.
  if (landed < Math.min(20, body.length)) {
    throw new Error(`ABORT: comment box holds only ${landed} chars — refusing to submit.`);
  }

  const permalink = await submitAndConfirm(page, ctx.expectedUsername, ctx.log);
  return { ok: true, dryRun: false, permalink };
}
