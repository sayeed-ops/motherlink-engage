// Phase 2 — browse primitives for NEW reddit (Shreddit).
//
// The humanized approach: land on the subreddit, scroll the feed looking for the
// target post, open it by clicking the card, read it, sometimes skim the comment
// tree, then scroll back up to the composer. Only after all that does
// `post_comment` run.
//
// These are Layer-B bricks: one small human-timed function per micro-interaction,
// registered in actions.mjs and driven by the shared executor. WARM-UP WILL CALL
// THESE SAME FUNCTIONS (Phase 4) — a warm-up plan is just a different itinerary
// over the same primitives, so keep them independent of "we're here to post".
//
// Feed markup verified live 2026-07-28:
//   <shreddit-post id="t3_<postId>" permalink="/r/…" post-title="…" feedindex="N">
//     ├─ a[slot="full-post-link"]  (whole card, 732x270)
//     └─ a[slot="title"]#post-title-t3_<postId>  (700x24)  ← what a person clicks
// The feed is VIRTUALIZED: cards are removed from the DOM once scrolled well past
// (27 → 24 posts, first card gone after 6 screens). So the target check must run
// after EVERY scroll burst — checking once at the end would miss it.

import {
  rand,
  sleep,
  humanPause,
  humanDwell,
  humanScroll,
  humanClickHandle,
  humanScrollToElement,
  humanTypeFocused,
  readableScrollLimit,
  deepQueryHandle,
  deepQueryWithin,
  waitForDeepVisible,
} from './helpers.mjs';

export function subredditFromUrl(url) {
  const m = String(url || '').match(/\/r\/([A-Za-z0-9_]+)/);
  return m ? m[1] : '';
}

function subredditUrl(subreddit, sort) {
  const base = `https://www.reddit.com/r/${subreddit}/`;
  return sort && sort !== 'hot' ? `${base}${sort}/` : base;
}

async function onSubreddit(page, subreddit) {
  return page
    .evaluate((s) => location.pathname.toLowerCase().startsWith(`/r/${s.toLowerCase()}`), subreddit)
    .catch(() => false);
}

// --- open_home -----------------------------------------------------------
// Land on reddit.com and browse the home feed for a bit, the way a session
// actually starts. Everything else (searching out the subreddit, hunting the
// post) happens from here, so the account never teleports straight to a target.
export async function openHome(page, step, ctx) {
  const p = (step && step.params) || {};
  const bursts = p.bursts ?? rand(2, 5);
  ctx.log('open_home: https://www.reddit.com/');
  await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitForDeepVisible(page, ['shreddit-post'], 12000);
  await humanPause();

  for (let i = 0; i < bursts; i++) {
    await humanScroll(page, { steps: rand(2, 5), distance: [250, 700] });
    await humanPause(); // 0-13s: reading whatever caught the eye
  }
  const seen = await page.evaluate(() => document.querySelectorAll('shreddit-post').length).catch(() => 0);
  ctx.log(`open_home: browsed the feed, ${bursts} burst(s), ${seen} post(s) in view.`);
  return { ok: true, bursts };
}

// --- open_subreddit ------------------------------------------------------
// A direct visit. Now the FALLBACK rather than the default route (search_subreddit
// is the normal path), and still the primitive warm-up will want for "go straight
// to a sub I follow".
export async function openSubreddit(page, step, ctx) {
  const p = (step && step.params) || {};
  const subreddit = p.subreddit || subredditFromUrl(ctx.threadUrl);
  if (!subreddit) throw new Error('ABORT: no subreddit to open.');
  const sort = p.sort || 'hot';

  const url = subredditUrl(subreddit, sort);
  ctx.log(`open_subreddit: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(rand(1500, 3200));
  if (!(await onSubreddit(page, subreddit))) {
    throw new Error(`ABORT: could not land on r/${subreddit}.`);
  }
  await waitForDeepVisible(page, ['shreddit-post'], 12000);
  return { ok: true, subreddit, sort, via: 'direct' };
}

// --- search_subreddit ----------------------------------------------------
// Reach the subreddit the way a person does from their feed: type it into the
// header search, hit Enter, click the community result.
//
// The search box is a <textarea name="q"> inside faceplate-search-input's SHADOW
// root — a descendant selector from document can never reach it, so match the
// textarea itself and let the visibility filter drop the 0x0 duplicate.
//
// Best-effort by design: ANY failure falls through to a direct visit, so a
// drifted search selector can never fail a job.
// The EXACT community link, never a post that merely mentions the sub. Verified
// live: a posts-results page for "personalfinance" lists r/UKPersonalFinance
// FIRST, so a loose match lands on the wrong community.
const communityLink = (subreddit) => [
  `a[href="/r/${subreddit}/"]`,
  `a[href="https://www.reddit.com/r/${subreddit}/"]`,
  `a[href="/r/${subreddit}"]`,
];

async function focusSearchAndType(page, subreddit) {
  const box = await waitForDeepVisible(page, ['textarea[name="q"]', 'input[name="q"]'], 8000);
  if (!box) return false;
  const c = await humanClickHandle(page, box, { padX: [20, 60], padY: [6, 14] });
  if (!c.ok) return false;
  await sleep(rand(300, 900));
  await humanTypeFocused(page, subreddit);
  return true;
}

// ROUTE 1 — the typeahead dropdown. Type, wait for the suggestions, click the
// community entry without ever pressing Enter. Verified live: the dropdown offers
// `a[href="https://www.reddit.com/r/<sub>/"]` with the text "r/<sub>".
async function viaTypeahead(page, subreddit, log) {
  if (!(await focusSearchAndType(page, subreddit))) return false;
  await sleep(rand(900, 2000)); // suggestions populate
  const entry = await waitForDeepVisible(page, communityLink(subreddit), 6000);
  if (!entry) return false;
  await humanPause(); // reading the suggestions
  await humanClickHandle(page, entry, { padX: [10, 60], padY: [4, 16] });
  await sleep(rand(1800, 3200));
  const ok = await onSubreddit(page, subreddit);
  if (ok) log(`search_subreddit: picked r/${subreddit} from the search suggestions.`);
  return ok;
}

// ROUTE 2 — search, then switch the results tab to Communities and pick it there.
// The most reliable route for a small sub that never surfaces in post results.
async function viaCommunitiesTab(page, subreddit, log) {
  if (!(await focusSearchAndType(page, subreddit))) return false;
  await humanPause();
  await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(rand(1800, 3200));
  if (await onSubreddit(page, subreddit)) return true; // Enter went straight there

  const tab = await waitForDeepVisible(page, ['a[href*="type=communities"]'], 8000);
  if (!tab) return false;
  await humanPause(); // glancing at the tabs
  await humanClickHandle(page, tab, { padX: [8, 40], padY: [6, 16] });
  await sleep(rand(1800, 3200));

  const entry = await waitForDeepVisible(page, communityLink(subreddit), 8000);
  if (!entry) return false;
  await humanPause();
  await humanClickHandle(page, entry, { padX: [10, 60], padY: [4, 16] });
  await sleep(rand(1800, 3200));
  const ok = await onSubreddit(page, subreddit);
  if (ok) log(`search_subreddit: picked r/${subreddit} from the Communities tab.`);
  return ok;
}

// ROUTE 3 — search, then click the community from the ordinary posts results.
async function viaPostsResults(page, subreddit, log) {
  if (!(await focusSearchAndType(page, subreddit))) return false;
  await humanPause();
  await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(rand(1800, 3200));
  if (await onSubreddit(page, subreddit)) return true;

  await humanPause(); // scanning the results
  const entry = await waitForDeepVisible(page, communityLink(subreddit), 8000);
  if (!entry) return false;
  await humanClickHandle(page, entry, { padX: [10, 40], padY: [6, 16] });
  await sleep(rand(1800, 3200));
  const ok = await onSubreddit(page, subreddit);
  if (ok) log(`search_subreddit: picked r/${subreddit} from the posts results.`);
  return ok;
}

const ROUTES = { typeahead: viaTypeahead, communities: viaCommunitiesTab, posts: viaPostsResults };

export async function searchSubreddit(page, step, ctx) {
  const p = (step && step.params) || {};
  const subreddit = p.subreddit || subredditFromUrl(ctx.threadUrl);
  if (!subreddit) throw new Error('ABORT: no subreddit to search for.');
  const sort = p.sort || 'hot';

  // The route is chosen in the PLAN so the itinerary can be shown before it runs.
  // The others remain as fallbacks: a small sub may be missing from the typeahead
  // AND from post results, so we degrade route → route → direct visit rather than
  // failing, and every route verifies it actually landed on the right subreddit.
  const first = ROUTES[p.via] ? p.via : 'typeahead';
  const order = [first, ...Object.keys(ROUTES).filter((r) => r !== first)];

  for (const route of order) {
    const landed = await ROUTES[route](page, subreddit, ctx.log).catch(() => false);
    if (landed) {
      if (route !== first) ctx.log(`search_subreddit: "${first}" route did not land — recovered via "${route}".`);
      return finishSearch(page, subreddit, sort, route);
    }
    // Back to a clean slate before trying the next route.
    await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(rand(800, 1800));
  }

  ctx.log('search_subreddit: no search route landed — falling back to a direct visit.');
  await openSubreddit(page, { params: { subreddit, sort } }, ctx);
  return { ok: true, subreddit, sort, via: 'direct-fallback' };
}

async function finishSearch(page, subreddit, sort, via) {
  // Sorting is a normal click on the sub's own sort tabs; the URL is the same
  // thing that click produces.
  if (sort !== 'hot') {
    await humanPause();
    await page.goto(subredditUrl(subreddit, sort), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(rand(1200, 2600));
  }
  await waitForDeepVisible(page, ['shreddit-post'], 12000);
  return { ok: true, subreddit, sort, via };
}

// --- scroll_feed ---------------------------------------------------------
// Aimless browsing before the hunt begins — a person doesn't arrive and
// immediately start a systematic search.
export async function scrollFeed(page, step, ctx) {
  const bursts = (step && step.params && step.params.bursts) ?? rand(1, 3);
  for (let i = 0; i < bursts; i++) {
    await humanScroll(page, { steps: rand(2, 5), distance: [250, 700] });
    await humanPause();
  }
  const seen = await page.evaluate(() => document.querySelectorAll('shreddit-post').length).catch(() => 0);
  ctx.log(`scroll_feed: ${bursts} burst(s), ${seen} post(s) currently in the feed.`);
  return { ok: true, bursts };
}

// --- find_target ---------------------------------------------------------
// Scroll the feed hunting for the target card, with a hard budget. Found → open
// it by clicking the title like a person. Budget spent → navigate straight to the
// thread. Arrival is GUARANTEED either way; the browsing is theater, the fallback
// is the contract. (Queued drafts are often days old, so the post frequently
// isn't in Hot at all — the fallback is the normal case, not the failure case.)
async function findCardLink(page, redditPostId) {
  const id = `t3_${redditPostId}`;
  // Scoped to the CARD only. A bare `a[href*="/comments/<id>/"]` also matches
  // links on the thread page itself (permalinks), so a find_target that ran while
  // already on the thread would "find" the post without ever touching a feed.
  return deepQueryHandle(page, [
    `shreddit-post[id="${id}"] a[slot="title"]`,
    `shreddit-post[id="${id}"] a[slot="full-post-link"]`,
    `shreddit-post[id="${id}"] a[href*="/comments/"]`,
  ]);
}

async function onThread(page, redditPostId) {
  return page.evaluate((id) => location.pathname.includes(id), redditPostId).catch(() => false);
}

/** Is this card actually within scrolling-distance of what's on screen (rather
 *  than merely pre-rendered far below)? */
async function isNearViewport(handle) {
  return handle
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight * 1.5 && r.bottom > -window.innerHeight * 0.5;
    })
    .catch(() => true);
}

export async function findTarget(page, step, ctx) {
  const p = (step && step.params) || {};
  const redditPostId = p.redditPostId || ctx.redditPostId;
  const threadUrl = p.threadUrl || ctx.threadUrl;
  const maxScrolls = p.maxScrolls ?? 12;
  // A TIME budget as well as a scroll budget. With pauses of up to 13s between
  // bursts, a scroll count alone no longer bounds how long the hunt takes — 14
  // scrolls could run past the executor's per-step timeout and fail the job.
  const maxSeconds = p.maxSeconds ?? 120;
  const deadline = Date.now() + maxSeconds * 1000;
  if (!redditPostId) throw new Error('ABORT: find_target has no reddit post id.');

  for (let i = 0; i <= maxScrolls; i++) {
    const link = await findCardLink(page, redditPostId);
    // Reddit renders well ahead of the viewport, so the card is often already in
    // the DOM many screens below. "In the DOM" is NOT "scrolled to" — clicking it
    // straight away would teleport past everything in between. Keep scrolling
    // until it's actually near the viewport, then click it like a person who has
    // just spotted it. (Budget exhausted with it in reach → click anyway.)
    const near = link ? await isNearViewport(link) : false;
    const outOfTime = Date.now() > deadline;
    if (link && (near || i === maxScrolls || outOfTime)) {
      const where = await page
        .evaluate((id) => {
          const el = document.getElementById(`t3_${id}`);
          return el ? el.getAttribute('feedindex') : '?';
        }, redditPostId)
        .catch(() => '?');
      ctx.log(`find_target: found the post in the feed after ${i} scroll(s) (feedindex ${where}) — opening it.`);
      await sleep(rand(500, 1400)); // a beat before clicking, as if recognising it
      await humanClickHandle(page, link, { padX: [10, 80], padY: [4, 18] });
      await sleep(rand(2000, 3800));
      if (await onThread(page, redditPostId)) return { ok: true, via: 'browse', scrolls: i };
      ctx.log('find_target: the click did not open the thread — navigating directly.');
      break;
    }
    if (i === maxScrolls || outOfTime) {
      if (outOfTime) ctx.log(`find_target: gave up hunting after ${maxSeconds}s.`);
      break;
    }
    await humanScroll(page, { steps: rand(1, 3), distance: [400, 900] });
    await humanPause();
  }

  ctx.log(`find_target: not found within ${maxScrolls} scroll(s) — navigating directly to the thread.`);
  await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(rand(1500, 3000));
  if (!(await onThread(page, redditPostId))) throw new Error(`ABORT: could not reach the thread (${redditPostId}).`);
  return { ok: true, via: 'direct', scrolls: maxScrolls };
}

// --- read_post -----------------------------------------------------------
// Dwell as if actually reading — humanDwell drifts the page slightly and
// occasionally scrolls back up, and is hard-capped at 120s (the ≤2min rule).
export async function readPost(page, step, ctx) {
  const seconds = (step && step.params && step.params.seconds) ?? rand(25, 90);
  const limit = await readableScrollLimit(page);
  ctx.log(`read_post: reading for ~${seconds}s.`);
  const t0 = Date.now();
  await humanDwell(page, seconds, { maxSeconds: 120, maxY: limit });
  return { ok: true, seconds: Math.round((Date.now() - t0) / 1000) };
}

// --- upvoting ------------------------------------------------------------
// Vote controls, mapped live 2026-07-28:
//   POST:    <shreddit-post> #shadow-root → button[upvote][data-action-bar-action="upvote"] (32x32)
//   COMMENT: <shreddit-comment> → <shreddit-comment-action-row> #shadow-root → button[upvote]
//
// Two things make this safe:
//  1. `aria-pressed` carries the CURRENT vote state. Clicking an already-upvoted
//     button REMOVES the vote — so an unconditional click would sometimes
//     un-upvote something the account had already upvoted. Always check first.
//  2. The comment action row is LAZY: <div slot="actionRow"> is empty until a
//     faceplate-loader fills it, which happens when the comment is scrolled into
//     view. So the comment must be brought on screen before its button exists.
//
// Upvoting is decoration, never the job. These primitives NEVER throw — a missing
// button or a drifted selector logs and skips rather than failing a real post.
const UPVOTE_BTN = ['button[upvote]', 'button[data-action-bar-action="upvote"]'];

async function pressedState(btn) {
  return btn.evaluate((el) => el.getAttribute('aria-pressed')).catch(() => null);
}

export async function upvotePost(page, step, ctx) {
  try {
    const post = await deepQueryHandle(page, ['shreddit-post'], { visibleOnly: false });
    if (!post) {
      ctx.log('upvote_post: no post element — skipping.');
      return { ok: true, skipped: true };
    }
    const btn = await deepQueryWithin(post, UPVOTE_BTN);
    if (!btn) {
      ctx.log('upvote_post: no upvote button found — skipping.');
      return { ok: true, skipped: true };
    }
    if ((await pressedState(btn)) === 'true') {
      ctx.log('upvote_post: already upvoted — leaving it alone (clicking again would remove the vote).');
      return { ok: true, skipped: true, reason: 'already-upvoted' };
    }
    if (ctx.dryRun) {
      ctx.log('upvote_post: DRY_RUN — would upvote the post, not clicking.');
      return { ok: true, dryRun: true };
    }
    await humanClickHandle(page, btn, { padX: [8, 24], padY: [8, 24] });
    await sleep(rand(700, 1800));
    const now = await pressedState(btn);
    ctx.log(`upvote_post: ${now === 'true' ? 'upvoted.' : `click did not register (aria-pressed=${now}) — moving on.`}`);
    return { ok: true, upvoted: now === 'true' };
  } catch (e) {
    ctx.log(`upvote_post: skipped (${e.message}).`);
    return { ok: true, skipped: true };
  }
}

// Pick a comment that is ALREADY well-upvoted — piling onto a popular comment is
// unremarkable, whereas being the lone upvoter on a dead comment is a pattern.
// Top-level comments only (they carry the visible scores), score at or above the
// median of the candidates, then a random pick from the top few.
async function pickPopularComment(page, minScore, topN) {
  const chosen = await page.evaluate(
    (min, n) => {
      const all = [...document.querySelectorAll('shreddit-comment')]
        .filter((c) => (c.getAttribute('depth') || '0') === '0')
        .map((c) => ({ id: c.getAttribute('thingid'), score: parseInt(c.getAttribute('score') || '0', 10) }))
        .filter((c) => c.id && Number.isFinite(c.score) && c.score >= min);
      if (!all.length) return null;
      const sorted = all.sort((a, b) => b.score - a.score);
      const median = sorted[Math.floor(sorted.length / 2)].score;
      const strong = sorted.filter((c) => c.score >= median).slice(0, n);
      if (!strong.length) return null;
      const winner = strong[Math.floor(Math.random() * strong.length)];
      return { ...winner, candidates: strong.length, topScore: sorted[0].score };
    },
    minScore,
    topN
  );
  return chosen;
}

export async function upvoteComment(page, step, ctx) {
  const p = (step && step.params) || {};
  const minScore = p.minScore ?? 2;
  const topN = p.topN ?? 3;
  try {
    const pickInfo = await pickPopularComment(page, minScore, topN);
    if (!pickInfo) {
      ctx.log(`upvote_comment: no comment scoring ${minScore}+ to upvote — skipping.`);
      return { ok: true, skipped: true };
    }
    const comment = await deepQueryHandle(page, [`shreddit-comment[thingid="${pickInfo.id}"]`], { visibleOnly: false });
    if (!comment) {
      ctx.log('upvote_comment: chosen comment vanished — skipping.');
      return { ok: true, skipped: true };
    }
    // The action row only renders once the comment is on screen.
    await humanScrollToElement(page, comment);
    await sleep(rand(800, 2000));

    let btn = null;
    for (let i = 0; i < 3 && !btn; i++) {
      btn = await deepQueryWithin(comment, UPVOTE_BTN);
      if (!btn) await sleep(rand(600, 1200));
    }
    if (!btn) {
      ctx.log('upvote_comment: action row never loaded — skipping.');
      return { ok: true, skipped: true };
    }
    if ((await pressedState(btn)) === 'true') {
      ctx.log(`upvote_comment: ${pickInfo.id} already upvoted — leaving it alone.`);
      return { ok: true, skipped: true, reason: 'already-upvoted' };
    }
    ctx.log(
      `upvote_comment: chose ${pickInfo.id} (score ${pickInfo.score}, from ${pickInfo.candidates} well-upvoted candidate(s), top was ${pickInfo.topScore}).`
    );
    if (ctx.dryRun) {
      ctx.log('upvote_comment: DRY_RUN — would upvote it, not clicking.');
      return { ok: true, dryRun: true };
    }
    await humanClickHandle(page, btn, { padX: [8, 24], padY: [8, 24] });
    await sleep(rand(700, 1800));
    const now = await pressedState(btn);
    ctx.log(`upvote_comment: ${now === 'true' ? 'upvoted.' : `click did not register (aria-pressed=${now}) — moving on.`}`);
    return { ok: true, upvoted: now === 'true' };
  } catch (e) {
    ctx.log(`upvote_comment: skipped (${e.message}).`);
    return { ok: true, skipped: true };
  }
}

// --- skim_comments -------------------------------------------------------
// Scroll down into the comment tree, read a few, then leave the caller to scroll
// back up (the composer click does that gradually). Not every visitor reads the
// comments, so the plan only includes this step sometimes.
// Reads a BOUNDED NUMBER OF COMMENTS, not "scroll for N seconds".
//
// Blind pixel-scrolling had two problems on real threads: on a big thread it just
// kept going, and on any thread it eventually bottomed out in Reddit's empty
// footer and sat there. Now it walks to comment #1, #2, … #N — so it stops where
// a reader would, and can never scroll past the end of the content.
//
// `comments` is rolled in the PLAN (1-13), not here, so the itinerary can be shown
// read-only before it runs. A thread with fewer comments than that just gets read
// in full — min(wanted, available).
export async function skimComments(page, step, ctx) {
  const p = (step && step.params) || {};
  const wanted = p.comments ?? rand(1, 13);
  const seconds = p.seconds ?? rand(15, 50);

  const tree = await waitForDeepVisible(page, ['shreddit-comment-tree', 'shreddit-comment'], 10000);
  if (!tree) {
    ctx.log('skim_comments: no comment tree on this thread — skipping.');
    return { ok: true, skipped: true };
  }
  const available = await page
    .evaluate(() => document.querySelectorAll('shreddit-comment[depth="0"]').length || document.querySelectorAll('shreddit-comment').length)
    .catch(() => 0);
  if (!available) {
    ctx.log('skim_comments: no comments to read — skipping.');
    return { ok: true, skipped: true };
  }

  const toRead = Math.max(1, Math.min(wanted, available));
  const limit = await readableScrollLimit(page);
  // Spread the reading budget across the comments, with a sane floor per comment.
  const perComment = Math.max(1.5, seconds / toRead);
  ctx.log(`skim_comments: reading ${toRead} of ${available} top-level comment(s), ~${seconds}s total.`);

  let read = 0;
  for (let i = 0; i < toRead; i++) {
    // Index-based, not :nth-of-type — comments nest, so an nth-of-type selector
    // counts replies as siblings and picks the wrong one.
    const target = await page
      .evaluateHandle((n) => document.querySelectorAll('shreddit-comment[depth="0"]')[n] || null, i)
      .then((h) => h.asElement())
      .catch(() => null);
    if (!target) break;
    await humanScrollToElement(page, target);
    read++;
    await humanDwell(page, perComment, { maxSeconds: 25, jitterPct: 35, maxY: limit });
  }
  ctx.log(`skim_comments: read ${read} comment(s), stopped short of the page bottom (limit y=${Math.round(limit)}).`);
  return { ok: true, read, available };
}
