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

import {
  rand,
  sleep,
  deepQueryHandle,
  waitForDeepVisible,
  humanClickHandle,
  deepActiveElement,
  humanTypeFocused,
  insertTextFocused,
  clearEditor,
} from './helpers.mjs';

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
// The account button (#expand-user-drawer-button) is a bare avatar — no handle.
// But several Shreddit components DO carry the CURRENT user's handle as a plain
// light-DOM attribute (verified live 2026-07-28 on a post page):
//   after-login-toast-dispatcher[username]  achievements-entrypoint[username]
//   community-author-flair[username]        [current-user-id]="t2_…"
// These are current-user components, unlike a page-wide a[href^="/user/"] (which
// matched a post author and caused the earlier false abort). Logged-in state is
// authoritative on shreddit-app[user-logged-in].

async function isLoggedIn(page) {
  return await page
    .evaluate(() => {
      const app = document.querySelector('shreddit-app');
      if (app && app.getAttribute('user-logged-in') === 'true') return true;
      return !!document.querySelector('comment-composer-host, #expand-user-drawer-button');
    })
    .catch(() => false);
}

async function readLoggedInUser(page) {
  try {
    return await page.evaluate(() => {
      for (const sel of ['after-login-toast-dispatcher[username]', 'achievements-entrypoint[username]', 'community-author-flair[username]']) {
        const el = document.querySelector(sel);
        const v = el && el.getAttribute('username');
        if (v) return v;
      }
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
// If we're ALREADY on the thread, stay put — under the Phase 2 approach flow we
// arrived here by browsing the subreddit and clicking the post, and reloading
// would throw that whole footprint away. Only navigate when we're somewhere else
// (e.g. a bare post_comment plan with no browse steps in front of it).
//
// Reloading used to be the guard against a reused AdsPower tab carrying a
// half-typed composer from a previous run (which once caused a doubled comment).
// That is now covered directly, by clearing the editor before typing.
async function ensureOnThread(page, threadUrl, redditPostId, log) {
  const already = await page.evaluate((id) => document.location.href.includes(id), redditPostId).catch(() => false);
  if (already) {
    log('already on the thread — keeping the page we browsed to.');
    return;
  }
  const url = toWwwReddit(threadUrl);
  log(`loading thread fresh: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(rand(1500, 3200));
  const ok = await page.evaluate((id) => document.location.href.includes(id), redditPostId).catch(() => false);
  if (!ok) throw new Error(`ABORT: not on the expected thread (${redditPostId}).`);
}

// --- composer ------------------------------------------------------------
// Mapped live on a real thread (2026-07-28, run 4 diagnostics):
//
//   main > comment-body-header > shreddit-async-loader
//     ├── faceplate-tracker > faceplate-tracker > faceplate-textarea-input
//     │      #shadow-root → textarea#innerTextArea   ← DECOY: always 0x0, never laid out
//     └── comment-composer-host                      ← the REAL composer
//           ├── faceplate-tracker > faceplate-textarea-input
//           │      #shadow-root → textarea#innerTextArea   ← COLLAPSED box (visible)
//           └── faceplate-form > shreddit-composer[event-source="comment_composer"]
//                 ├── div[slot="rte"][contenteditable][data-lexical-editor]  ← EXPANDED editor
//                 └── button#comment-composer-submit-button
//
// Two things this layout forces:
//  1. Selector matches must be VISIBILITY-FILTERED. The decoy sits earlier in BFS
//     order, so an unfiltered deep query returns a node with no box — which is
//     precisely why every "focus try N" logged `no usable boundingBox (null)`.
//  2. While collapsed, shreddit-composer / the rte div / the submit button all
//     measure 0x0. Clicking the collapsed textarea expands them AND drops the
//     caret straight into the Lexical div (confirmed: activeElement = that div).
//     So: click collapsed → WAIT for the rte to gain a box → type there.
const COLLAPSED = ['textarea[placeholder*="Join the conversation" i]'];
const EXPANDED = [
  'shreddit-composer[event-source="comment_composer"] div[slot="rte"][contenteditable="true"]',
  'shreddit-composer[event-source="comment_composer"] [contenteditable="true"][data-lexical-editor="true"]',
  'shreddit-composer[event-source="comment_composer"] [contenteditable="true"]',
];
const SUBMIT = [
  '#comment-composer-submit-button', // confirmed id, light DOM, inside shreddit-composer
  'shreddit-composer[event-source="comment_composer"] button[type="submit"]',
  'button[aria-label="Comment" i]',
];

// Guard: confirm a handle is really the COMMENT composer (placeholder "Join the
// conversation", or inside comment-composer-host / a comment shreddit-composer)
// and NOT the create-post title field. Climbs light + shadow ancestors.
async function isCommentComposer(handle) {
  return handle
    .evaluate((el) => {
      const ph = ((el.getAttribute && el.getAttribute('placeholder')) || '').toLowerCase();
      if (ph.includes('join the conversation')) return true;
      let node = el;
      for (let i = 0; i < 15 && node; i++) {
        const tag = node.tagName && node.tagName.toLowerCase();
        if (tag === 'comment-composer-host') return true;
        if (tag === 'shreddit-composer') return node.getAttribute('event-source') === 'comment_composer';
        node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      }
      return false;
    })
    .catch(() => false);
}

// Is the caret in the comment box right now? If not, keystrokes become Reddit's
// single-key shortcuts (save post / create post / copy) — the corruption we saw.
// Must pierce shadow roots: with focus in the collapsed <textarea>,
// document.activeElement is only the faceplate-textarea-input HOST.
async function focusInBox(page) {
  const a = await deepActiveElement(page);
  if (!a || a.tag === 'body' || !a.tag) return false;
  if (a.lexical || a.contenteditable === 'true') return true;
  if (a.tag === 'textarea' && (a.placeholder || '').toLowerCase().includes('join the conversation')) return true;
  return !!a.inComposer;
}

function describeActive(a) {
  return a ? `${(a.chain || []).join(' » ')}${a.lexical ? ' [lexical]' : ''}` : 'unknown';
}

// Whitespace-insensitive comparison — the Lexical editor reports paragraphs with
// its own newline shape, so only the words matter for "did it land intact".
const normalize = (s) => String(s || '').replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim();

async function readEditorText(handle) {
  return handle.evaluate((el) => (el.value != null ? el.value : el.innerText || el.textContent || '')).catch(() => '');
}

async function openComposerAndType(page, body, log) {
  await page.bringToFront().catch(() => {});

  // 1. The rich editor may already be open (rare); otherwise click the VISIBLE
  //    collapsed textarea to expand it. Both queries are visibility-filtered, so
  //    the 0x0 decoy textarea can no longer be picked up.
  let editor = await deepQueryHandle(page, EXPANDED);
  if (!editor) {
    const collapsed = await waitForDeepVisible(page, COLLAPSED, 15000);
    if (!collapsed) throw new Error('ABORT: could not find a visible comment box on the thread.');
    if (!(await isCommentComposer(collapsed))) {
      throw new Error('ABORT: the box found is NOT the comment composer (looks like the create-post box) — refusing to type.');
    }
    for (let i = 0; i < 3 && !editor; i++) {
      const c = await humanClickHandle(page, collapsed);
      log(
        c.ok
          ? `composer: clicked the collapsed box at (${Math.round(c.x)},${Math.round(c.y)}) ${Math.round(c.rect.w)}x${Math.round(c.rect.h)}, hit=${c.hit}`
          : `composer: collapsed box had no usable rect on try ${i} (${c.rect ? `${c.rect.w}x${c.rect.h}` : 'null'}).`
      );
      editor = await waitForDeepVisible(page, EXPANDED, 6000);
    }
  }
  if (!editor) throw new Error('ABORT: the comment box never expanded into the rich editor.');

  // 2. Clicking the collapsed box normally leaves the caret in the Lexical div
  //    already; if not, click the editor itself, then fall back to .focus().
  let ok = await focusInBox(page);
  for (let i = 0; i < 3 && !ok; i++) {
    const c = await humanClickHandle(page, editor);
    log(`focus try ${i}: ${c.ok ? `click (${Math.round(c.x)},${Math.round(c.y)}) hit=${c.hit}` : 'no usable rect'} -> ${describeActive(await deepActiveElement(page))}`);
    ok = await focusInBox(page);
    if (ok) break;
    await editor.focus().catch(() => {});
    await sleep(rand(250, 500));
    ok = await focusInBox(page);
  }
  if (!ok) {
    throw new Error(`ABORT: could not put the caret in the comment box (focus=${describeActive(await deepActiveElement(page))}) — refusing to type.`);
  }
  log(`composer: caret is in the box (${describeActive(await deepActiveElement(page))}).`);

  // 3. Never type on top of leftovers — a reused AdsPower tab once produced a
  //    doubled comment. We load fresh, and clear as a belt-and-braces guard.
  const existing = await readEditorText(editor);
  if (normalize(existing)) {
    log(`composer: clearing ${normalize(existing).length} leftover chars.`);
    await clearEditor(page, editor);
  }

  await humanTypeFocused(page, body);
  await sleep(rand(600, 1400));

  // 4. Verify letter-perfect. Fast keystrokes have dropped characters into these
  //    React/Lexical editors before; if the text doesn't match, clear and re-insert
  //    exactly via CDP Input.insertText, then re-verify. A comment that still
  //    doesn't match is NOT worth posting.
  let landedText = await readEditorText(editor);
  if (normalize(landedText) !== normalize(body)) {
    log(`composer: typed text mismatch (${normalize(landedText).length} vs ${normalize(body).length} chars) — clearing and re-inserting exactly.`);
    await clearEditor(page, editor);
    if (!(await focusInBox(page))) await editor.focus().catch(() => {});
    await insertTextFocused(page, body);
    await sleep(rand(500, 1000));
    landedText = await readEditorText(editor);
  }
  const landed = normalize(landedText).length;
  const exact = normalize(landedText) === normalize(body);
  log(`composer: box holds ${landed}/${normalize(body).length} chars${exact ? ' (exact match).' : ' — NOT an exact match.'}`);
  return { landed, exact, editor };
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

// The green "Comment" button. #comment-composer-submit-button is confirmed, but it
// only gains a layout box once the composer is expanded — so the query is
// visibility-filtered like everything else here (a 0x0 button can't be clicked).
// Fallback: an enabled, laid-out <button> whose text is exactly "Comment".
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
    return (
      btns.find((b) => {
        if (b.disabled || !/^comment$/i.test((b.textContent || '').trim())) return false;
        const r = b.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
      }) || null
    );
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
    // Real mouse click at measured coordinates — same reason as the composer:
    // Puppeteer's own click() relies on the CDP box model, which is unreliable here.
    const c = await humanClickHandle(page, btn, { padX: [10, 30], padY: [8, 18] });
    if (!c.ok) {
      await btn.click().catch(() => {});
    }
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

  // The browse/read theater runs ahead of this as its own plan steps; by here we
  // are already on the thread.
  const { landed, exact, editor } = await openComposerAndType(page, body, ctx.log);

  if (ctx.dryRun) {
    ctx.log(`DRY_RUN: composer holds ${landed} chars on new reddit (${exact ? 'exact' : 'MISMATCH'}) — NOT submitting.`);
    // Put the composer back the way we found it. Leaving a dry run's text behind
    // has bitten twice: Reddit keeps the draft (the next run logs "clearing N
    // leftover chars"), and the dirty page arms a "leave site?" prompt that blocks
    // the NEXT job's first navigation. autoHandleDialogs answers that prompt, but
    // not raising it at all is better than answering it.
    await clearEditor(page, editor).catch(() => {});
    ctx.log('DRY_RUN: composer cleared — the tab is left clean for the next job.');
    return { ok: true, dryRun: true, permalink: '', landed, exact };
  }

  // Never submit an empty/near-empty box, or one whose text doesn't match the
  // draft — a corrupted comment on a real account is worse than a failed job.
  if (landed < Math.min(20, body.length)) {
    throw new Error(`ABORT: comment box holds only ${landed} chars — refusing to submit.`);
  }
  if (!exact) {
    throw new Error(`ABORT: composer text does not match the draft (${landed} vs ${body.replace(/\s+/g, ' ').trim().length} chars) — refusing to submit.`);
  }

  const permalink = await submitAndConfirm(page, ctx.expectedUsername, ctx.log);
  return { ok: true, dryRun: false, permalink, landed, exact };
}
