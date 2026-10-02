// Posting a reply on the Shopify Community — the browser half.
//
// Connects to an AdsPower profile that is already signed in to the forum and
// walks the plan from plan.mjs: board → thread → read → reply. The decisions
// (route, text comparison, reading a refusal) live in plan.mjs, which is tested
// without a browser.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT MUST BE TRUE BEFORE A KEY IS PRESSED, AND BEFORE SUBMIT
//
// Before typing:  the forum app says the signed-in user IS the job's account;
//                 the page IS the job's thread (by topic id); the thread still
//                 accepts replies from this account.
// Before submit:  the composer service holds, word for word, the text we meant.
// Dry run:        everything above happens, then the composer is EMPTIED and
//                 closed — Discourse autosaves composer drafts to the server,
//                 and a rehearsal must not leave one sitting on the account.
//
// Every one of those failing is an ABORT that names what it saw, and nothing is
// submitted. Selectors below were read from the live forum (Discourse 2026.9)
// logged out; the signed-in composer is the part only a real run can confirm,
// so each lookup tries the known markup and then says plainly what it found.
// ════════════════════════════════════════════════════════════════════════════

import {
  autoHandleDialogs,
  clearEditor,
  humanClickHandle,
  humanDwell,
  humanScroll,
  startReadingAtTop,
  rand,
  sleep,
  withTimeout,
} from '../reddit/helpers.mjs';
import { openTaskTab } from '../tabs.mjs';
import { firstDifference, guardedInsert, guardedType, restoreOtherFields, sameText, snapshotOtherFields, TypingAborted } from '../typing.mjs';
import { classifyRefusal, composeShopifyPlan, isTopicUrl, MIN_POST_LENGTH, permalinkFor } from './plan.mjs';

const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 300_000);

const REPLY_BUTTONS = [
  '#topic-footer-buttons button.create',
  '.topic-footer-main-buttons button.create',
  '#topic-footer-buttons .btn-primary',
];
const EDITORS = ['#reply-control .ProseMirror[contenteditable="true"]', '#reply-control textarea.d-editor-input'];
const SUBMIT_BUTTONS = ['#reply-control .save-or-cancel button.create', '#reply-control button.btn-primary.create'];

/** Wait until the forum's own app has booted on this page. */
async function waitForApp(page, timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await page.evaluate(() => !!window.Discourse?.__container__).catch(() => false);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

/** Who the forum app says is signed in. */
async function signedInUser(page) {
  return page
    .evaluate(() => {
      const u = window.Discourse?.__container__?.lookup('service:current-user');
      return u ? { username: String(u.username || ''), id: Number(u.id) || null } : null;
    })
    .catch(() => null);
}

/** The composer's own copy of the text, and whether it is open. */
async function composerState(page) {
  return page
    .evaluate(() => {
      const model = window.Discourse?.__container__?.lookup('service:composer')?.model;
      const el = document.getElementById('reply-control');
      return {
        open: !!model && !!el && !el.classList.contains('closed'),
        reply: model ? String(model.reply || '') : null,
      };
    })
    .catch(() => ({ open: false, reply: null }));
}

/** Can this account reply to this thread, as far as the thread says. */
async function canReply(page) {
  return page
    .evaluate(() => {
      const topic = window.Discourse?.__container__?.lookup('controller:topic')?.model;
      if (!topic) return { known: false };
      return {
        known: true,
        canCreatePost: topic.details?.can_create_post !== false,
        closed: !!topic.closed,
        archived: !!topic.archived,
      };
    })
    .catch(() => ({ known: false }));
}

/** The highest post number this user already has on the page. */
async function myHighestPost(page, userId) {
  return page
    .evaluate((uid) => {
      let max = 0;
      for (const a of document.querySelectorAll('article[data-post-id]')) {
        if (Number(a.dataset.userId) !== uid) continue;
        const n = Number(String(a.id || '').replace('post_', ''));
        if (n > max) max = n;
      }
      return max;
    }, userId)
    .catch(() => 0);
}

/** The first VISIBLE element matching any selector, as a handle. */
async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const handles = await page.$$(sel).catch(() => []);
    for (const h of handles) {
      const box = await h.boundingBox().catch(() => null);
      if (box && box.width > 2 && box.height > 2) return { handle: h, selector: sel };
    }
  }
  return null;
}

async function waitVisible(page, selectors, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = await firstVisible(page, selectors);
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

/** Visible refusal text from Discourse's dialog / modal / field tip, if any. */
async function refusalText(page) {
  return page
    .evaluate(() => {
      const visible = (el) => !!el && el.getBoundingClientRect().height > 0;
      const pick = [
        '.dialog-container .dialog-body',
        '.d-modal .d-modal__body',
        '#reply-control .popup-tip.bad',
        '.bootbox.modal .modal-body',
      ];
      for (const sel of pick) {
        for (const el of document.querySelectorAll(sel)) if (visible(el) && el.textContent.trim()) return el.textContent.trim();
      }
      return '';
    })
    .catch(() => '');
}

/**
 * Close the forum's own popups that sit over the composer.
 *
 * Discourse opens "composer messages" beside the editor — "Thanks for
 * contributing to Shopify Community!" for new users, "similar topics", "you've
 * already replied" — and user tips ("Got it"). Seen live 2026-09-17 taking the
 * click meant for the editor. Closed by their own close button, never by Escape:
 * Escape with no popup open closes the COMPOSER.
 */
async function dismissOverlays(page) {
  return page
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      let closed = 0;
      for (const pop of document.querySelectorAll('.composer-popup, .composer-popup-container > *, .user-tip__container, .fk-d-tooltip__content')) {
        if (!visible(pop)) continue;
        const btn =
          pop.querySelector('.close, button.close, .composer-popup__close, [aria-label*="close" i], [aria-label*="dismiss" i]') ||
          [...pop.querySelectorAll('button')].find((b) => /^(got it|dismiss|close|×|✕)$/i.test((b.textContent || '').trim()));
        if (btn) {
          btn.click();
          closed += 1;
        }
      }
      return closed;
    })
    .catch(() => 0);
}

/** Is the caret in the composer's editor — not the search box, not the page? */
async function caretInEditor(page) {
  return page
    .evaluate(() => {
      const a = document.activeElement;
      if (!a) return false;
      const editor = a.closest('#reply-control .ProseMirror, #reply-control textarea.d-editor-input');
      return !!editor || (a.matches && a.matches('#reply-control textarea.d-editor-input'));
    })
    .catch(() => false);
}

/** Empty the composer and close it, answering the discard prompt. Best effort,
 *  and reported — a dry run must not leave an autosaved draft behind. */
async function discardComposer(page, log) {
  const editor = await firstVisible(page, EDITORS);
  if (editor) {
    await clearEditor(page, editor.handle).catch(() => {});
    await sleep(rand(600, 1200));
  }
  const cancel = await firstVisible(page, ['#reply-control .save-or-cancel .cancel', '#reply-control button.cancel', '#reply-control .discard-button']);
  if (cancel) await cancel.handle.click().catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await sleep(rand(700, 1300));
  // "Discard draft?" confirmation, when Discourse asks.
  const confirm = await page
    .evaluateHandle(() => {
      const buttons = [...document.querySelectorAll('.dialog-container button, .d-modal button')];
      return buttons.find((b) => /discard|abandon|yes/i.test(b.textContent || '')) || null;
    })
    .catch(() => null);
  const el = confirm?.asElement?.();
  if (el) {
    await el.click().catch(() => {});
    await sleep(800);
  }
  const state = await composerState(page);
  const cleared = !state.open || !state.reply;
  log(`dry run: composer ${cleared ? 'emptied and closed' : 'could NOT be confirmed empty — check the account for a saved draft'}.`);
  return cleared;
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

async function openBoard(page, step, ctx) {
  await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForApp(page);
  await sleep(rand(1500, 3500));
  await humanScroll(page, { steps: step.bursts, distance: [250, 650] });
  ctx.log(`open_board: ${step.url} — ${step.bursts} scroll burst(s).`);
  return { ok: true };
}

async function findTopic(page, step, ctx) {
  const id = String(ctx.job.topicId);
  for (let i = 0; i <= step.maxScrolls; i += 1) {
    const link = await page
      .evaluateHandle((topicId) => {
        const re = new RegExp(`/${topicId}(?:[/?#]|$)`);
        return [...document.querySelectorAll('a.raw-topic-link')].find((a) => re.test(a.getAttribute('href') || '')) || null;
      }, id)
      .catch(() => null);
    const el = link?.asElement?.();
    if (el) {
      const click = await humanClickHandle(page, el);
      if (click.ok) {
        const until = Date.now() + 20_000;
        while (Date.now() < until && !isTopicUrl(page.url(), ctx.job)) await sleep(400);
        if (isTopicUrl(page.url(), ctx.job)) {
          ctx.log(`find_topic: found it in the listing after ${i} scroll(s) and opened it.`);
          return { ok: true, found: true, scrolls: i };
        }
      }
    }
    await humanScroll(page, { steps: 1, distance: [400, 800] });
  }
  ctx.log('find_topic: not in the first screens of the board — going to it directly.');
  return { ok: true, found: false, skipped: true };
}

async function openTopic(page, step, ctx) {
  if (!isTopicUrl(page.url(), ctx.job)) {
    await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  if (!(await waitForApp(page))) throw new Error('ABORT: the forum app did not load on the thread page.');
  await page.waitForSelector('article[data-post-id]', { timeout: 30_000 }).catch(() => {});
  if (!isTopicUrl(page.url(), ctx.job)) throw new Error(`ABORT: not on the expected thread (${ctx.job.topicId}) — at ${page.url()}.`);

  const me = await signedInUser(page);
  if (!me) throw new Error('ABORT: nobody is signed in to the Shopify Community in this AdsPower profile.');
  const expected = String(ctx.job.expectedUsername || '').trim();
  if (!expected) throw new Error('ABORT: the job names no forum username, so the account cannot be verified.');
  if (me.username.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`ABORT: signed in as "${me.username}", expected "${expected}".`);
  }
  ctx.me = me;

  // The forum reopens a thread you have read at your LAST-READ post (its URL
  // then carries that post number), and a reused tab may be sitting at the reply
  // box. Either way, reading has to start at the question: reopen at post 1.
  const at = page.url().match(/\/t\/[^/]+\/\d+\/(\d+)/);
  const y = await page.evaluate(() => window.scrollY).catch(() => 0);
  if ((at && Number(at[1]) > 1) || y > 250) {
    ctx.log(`open_topic: the thread opened at ${at ? `post ${at[1]}` : `${Math.round(y)}px down`} — reopening it at the first post.`);
    await page.goto(`${step.url}/1`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForApp(page);
    await page.waitForSelector('article#post_1', { timeout: 20_000 }).catch(() => {});
    await sleep(rand(800, 1600));
    await startReadingAtTop(page, { log: ctx.log, label: 'open_topic' });
  }
  ctx.log(`open_topic: on the thread, signed in as ${me.username}.`);
  return { ok: true, username: me.username };
}

async function readTopic(page, step, ctx) {
  await startReadingAtTop(page, { log: ctx.log, label: 'read_topic' });
  await humanDwell(page, step.seconds, { maxSeconds: 120 });
  ctx.log(`read_topic: read for ~${step.seconds}s.`);
  return { ok: true, seconds: step.seconds };
}

async function reply(page, step, ctx) {
  const { job } = ctx;
  const text = String(job.body || '').trim();
  if (text.length < MIN_POST_LENGTH) throw new Error(`ABORT: the reply is shorter than the forum's ${MIN_POST_LENGTH}-character minimum.`);

  const status = await canReply(page);
  if (status.known && (status.closed || status.archived || !status.canCreatePost)) {
    throw new Error(`ABORT: the thread does not accept a reply from this account (${status.closed ? 'closed' : status.archived ? 'archived' : 'not permitted'}).`);
  }
  const before = await myHighestPost(page, ctx.me.id);

  // Open the composer: the footer Reply button, as a person does; Discourse's
  // own shortcut (Shift+R, "reply to topic") if the button is not found.
  let opened = 'button';
  const button = await firstVisible(page, REPLY_BUTTONS);
  if (button) {
    const click = await humanClickHandle(page, button.handle);
    if (!click.ok) opened = 'shortcut';
  } else {
    opened = 'shortcut';
  }
  if (opened === 'shortcut') {
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyR');
    await page.keyboard.up('Shift');
  }
  const editor = await waitVisible(page, EDITORS, 15_000);
  if (!editor) throw new Error(`ABORT: the reply box did not open (tried the ${opened}).`);
  const rich = editor.selector.includes('ProseMirror');
  ctx.log(`reply: composer open via ${opened}, ${rich ? 'rich' : 'markdown'} editor.`);

  // Popups open with the composer; close them before the first click.
  await sleep(rand(600, 1200));
  if (await dismissOverlays(page)) ctx.log('reply: closed a forum popup over the composer.');

  const focusEditor = async () => {
    await dismissOverlays(page);
    const ed = (await firstVisible(page, EDITORS))?.handle || editor.handle;
    const c = await humanClickHandle(page, ed, { padX: [20, 80], padY: [10, 30] });
    if (!c.ok || !(await caretInEditor(page))) await ed.focus().catch(() => {});
  };
  await focusEditor();
  await sleep(rand(400, 900));
  if (!(await caretInEditor(page))) throw new Error('ABORT: could not put the caret in the reply box — nothing was typed.');

  // A draft saved by an earlier session would be typed after, not replaced.
  const existing = await composerState(page);
  if (existing.reply && existing.reply.trim()) {
    ctx.log('reply: the composer already held text (a saved draft) — clearing it first.');
    await clearEditor(page, editor.handle);
    await sleep(rand(400, 800));
  }

  // Every other field on the page, so anything typed into one by mistake can
  // be put back (the search box, a filter).
  const fields = await snapshotOtherFields(page, editor.handle);
  const guard = {
    isFocused: () => caretInEditor(page),
    refocus: focusEditor,
    dismissOverlays: () => dismissOverlays(page),
    paragraphEnters: rich ? 1 : 2, // markdown needs a blank line
    log: ctx.log,
  };
  const cleanStray = async () => {
    const fixed = await restoreOtherFields(page, fields);
    for (const f of fixed) ctx.log(`reply: removed stray text from "${f.label}" ("${f.stray}").`);
    return fixed.length;
  };

  try {
    await guardedType(page, text, guard);
  } catch (e) {
    await cleanStray();
    await discardComposer(page, ctx.log);
    if (e instanceof TypingAborted) throw new Error(`ABORT: ${e.message} Nothing was submitted.`);
    throw e;
  }
  await sleep(rand(800, 1600));
  let stray = await cleanStray();

  // Letter for letter against the reply; repair once with an exact insert.
  let typed = await composerState(page);
  let repaired = false;
  if (!sameText(text, typed.reply)) {
    const d = firstDifference(text, typed.reply);
    ctx.log(`reply: the box does not match the reply (first difference at ${d?.at}: expected "${d?.expected}", found "${d?.got}") — clearing and inserting it exactly.`);
    await focusEditor();
    await clearEditor(page, editor.handle);
    try {
      await guardedInsert(page, text, guard);
    } catch (e) {
      await cleanStray();
      await discardComposer(page, ctx.log);
      throw new Error(`ABORT: ${e.message} Nothing was submitted.`);
    }
    await sleep(rand(800, 1400));
    stray += await cleanStray();
    typed = await composerState(page);
    repaired = true;
    if (!sameText(text, typed.reply)) {
      await discardComposer(page, ctx.log);
      throw new Error('ABORT: the reply box would not hold the reply as written — nothing was submitted.');
    }
  }
  ctx.log(`reply: the box holds the reply exactly${repaired ? ' (after one repair)' : ''}${stray ? `; ${stray} stray field(s) cleaned` : ''}.`);

  // Reread before sending.
  await sleep(step.reviewSeconds * 1000 + rand(0, 1500));

  if (ctx.dryRun) {
    ctx.log('DRY_RUN: typed and verified the reply, NOT submitting.');
    const cleared = await discardComposer(page, ctx.log);
    return { ok: true, dryRun: true, permalink: '', rich, repaired, draftCleared: cleared, terminal: true };
  }

  // The last look, immediately before the click: nothing may have changed it
  // during the reread, and nothing stray may be left on the page.
  await dismissOverlays(page);
  await cleanStray();
  const finalText = await composerState(page);
  if (!sameText(text, finalText.reply)) {
    throw new Error('ABORT: the reply changed in the box just before submitting — nothing was submitted.');
  }

  const submit = await firstVisible(page, SUBMIT_BUTTONS);
  if (submit) {
    await humanClickHandle(page, submit.handle);
  } else {
    ctx.log('reply: no Reply button found in the composer — using Ctrl/Cmd+Enter.');
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(mod);
    await page.keyboard.press('Enter');
    await page.keyboard.up(mod);
  }
  ctx.log('submitting…');

  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    await sleep(1000);
    const refusal = await refusalText(page);
    if (refusal) {
      const r = classifyRefusal(refusal);
      const e = new Error(r.reason);
      e.retryable = r.retryable;
      throw e;
    }
    const state = await composerState(page);
    const mine = await myHighestPost(page, ctx.me.id);
    if (!state.open && mine > before) {
      return { ok: true, dryRun: false, permalink: permalinkFor(job, mine), postNumber: mine, rich, repaired, terminal: true };
    }
    // The composer closed but the new post has not rendered: the URL carries
    // the post number once Discourse scrolls to it.
    const m = page.url().match(/\/t\/[^/]+\/\d+\/(\d+)/);
    if (!state.open && m && Number(m[1]) > before) {
      return { ok: true, dryRun: false, permalink: permalinkFor(job, Number(m[1])), postNumber: Number(m[1]), rich, repaired, terminal: true };
    }
  }
  const state = await composerState(page);
  throw new Error(
    state.open
      ? 'The Reply button was pressed but the composer is still open after 45s — outcome unknown. Check the thread before retrying.'
      : 'The composer closed but the new post could not be found — it may be awaiting moderation. Check the thread before retrying.',
  );
}

const STEPS = { open_board: openBoard, find_topic: findTopic, open_topic: openTopic, read_topic: readTopic, reply };

/**
 * Post (or, in dry run, rehearse) one reply.
 *
 * `jc` is the agent's job context: `jc.log`, and `jc.dryRun` as a GETTER — read
 * again at the moment of submit, so switching Shopify's dry run on while this
 * is typing still stops it.
 *
 * Returns { ok, dryRun, permalink, trace }; throws with `.trace` attached.
 */
export async function postToShopify({ puppeteer, wsEndpoint, job, jc }) {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null, protocolTimeout: 120_000 });
  const trace = [];
  try {
    // This job's Shopify Community tab — never whatever happened to be first,
    // which on a profile also signed in to Reddit was the operator's Reddit tab.
    const page = await openTaskTab(browser, { profileId: job.adsPowerProfileId, platform: 'shopify', log: jc.log });
    autoHandleDialogs(page, jc.log);
    try {
      const cdp = await page.target().createCDPSession();
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (e) {
      jc.log(`focus emulation unavailable: ${e.message}`);
    }
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(45_000);

    const ctx = {
      job,
      log: jc.log,
      me: null,
      get dryRun() {
        return jc.dryRun;
      },
    };
    const plan = composeShopifyPlan(job);
    jc.log(`shopify plan: ${plan.map((s) => s.type).join(' → ')}`);

    let result = null;
    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i];
      const started = Date.now();
      jc.log(`plan step ${i + 1}/${plan.length}: ${step.type}`);
      try {
        const out = await withTimeout(STEPS[step.type](page, step, ctx), STEP_TIMEOUT_MS, `step "${step.type}"`);
        trace.push({ type: step.type, ms: Date.now() - started, ...out });
        if (out.terminal) result = out;
      } catch (e) {
        trace.push({ type: step.type, ms: Date.now() - started, ok: false, error: String(e.message).slice(0, 300) });
        e.trace = trace;
        throw e;
      }
    }
    return { ...(result || { ok: false, dryRun: jc.dryRun, permalink: '' }), trace };
  } finally {
    browser.disconnect();
  }
}
