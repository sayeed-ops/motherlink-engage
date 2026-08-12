// Layer B — warm-up-only browse primitives.
//
// Kept OUT of browse.mjs on purpose: that file is on the posting critical path,
// and a warm-up bug must not be able to break a reply. Everything here follows
// the DECORATION contract, not the load-bearing one:
//
//   NEVER throw. A warm-up step that cannot complete returns
//   { ok: true, skipped: true, reason } and the session carries on.
//
// That matters more here than in posting. A posting plan that loses its way
// should fail loudly — the alternative is commenting from the wrong page. A
// warm-up session has nothing to get wrong; the worst case is a shorter browse.
// And because a failed job has no retry and no resume (see index.mjs), an ABORT
// in a warm-up would throw away the whole session over a missing button.
//
// The composer's anchored-segment rule is the other half of this: every segment
// starts with an absolute navigation, so a step that skips here can derail at
// most the rest of its own leg.

import {
  rand,
  sleep,
  humanPause,
  humanScroll,
  humanScrollToElement,
  humanClickHandle,
  waitForDeepVisible,
} from './helpers.mjs';

/** Are we on a comments page? The one check that separates "a post" from "a card
 *  in a feed" — see the note on upvotePost in browse.mjs. */
export async function onThreadPage(page) {
  return page.evaluate(() => location.pathname.includes('/comments/')).catch(() => false);
}

// --- open_feed -------------------------------------------------------------
// The nav rail down the left of new reddit: Home, Popular, News, Explore, All.
//
// Previously the composer faked Popular and News as `open_subreddit` with the
// names 'popular' and 'news'. That is wrong for News in particular: the nav tab
// is a curated topic feed at /news/, NOT r/news the subreddit. Different page,
// different content, and only one of them is what a person clicking the tab sees.
//
// UNLIKE the other warm-up primitives this one does NOT soft-skip. It is an
// ANCHOR — the composer relies on every segment starting from a known surface,
// so failing to land would leave the following relative steps adrift. Instead it
// degrades to the home feed, the same shape as searchSubreddit's route fallback.
const FEEDS = {
  home: 'https://www.reddit.com/',
  popular: 'https://www.reddit.com/r/popular/',
  all: 'https://www.reddit.com/r/all/',
  news: 'https://www.reddit.com/news/',
  explore: 'https://www.reddit.com/explore/',
};

export async function openFeed(page, step, ctx) {
  const p = (step && step.params) || {};
  const want = FEEDS[p.feed] ? p.feed : 'home';
  const bursts = p.bursts ?? rand(1, 4);

  const land = async (url) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return !!(await waitForDeepVisible(page, ['shreddit-post', 'shreddit-feed'], 10000));
  };

  let feed = want;
  let ok = await land(FEEDS[want]).catch(() => false);
  if (!ok && want !== 'home') {
    // The adventurous tabs (news, explore) are the least certain URLs here. A
    // miss must not strand the segment, so fall back rather than skip.
    ctx.log(`open_feed: "${want}" did not show a feed — falling back to home.`);
    feed = 'home';
    ok = await land(FEEDS.home).catch(() => false);
  }

  await humanPause();
  for (let i = 0; i < bursts; i++) {
    await humanScroll(page, { steps: rand(2, 5), distance: [250, 700] });
    await humanPause();
  }
  ctx.log(`open_feed: ${feed} — ${bursts} scroll burst(s).`);
  return { ok: true, via: feed, bursts };
}

// --- open_post_subreddit ---------------------------------------------------
// From the post you are reading, click through to the community it is in.
//
// This is the move that makes a session stop looking like a machine. Without it
// the ONLY way out of a post is back to a top-level feed, so every walk reads
// home → post → home → post. A person who reads something interesting often goes
// and looks at where it came from, scrolls that community for a bit, and wanders
// off from there.
//
// Relative, not an anchor: if the link is not there it soft-skips and the next
// anchor re-establishes position.
export async function openPostSubreddit(page, _step, ctx) {
  try {
    if (!(await onThreadPage(page))) {
      ctx.log('open_post_subreddit: not on a post — skipping.');
      return { ok: true, skipped: true, reason: 'not-on-thread' };
    }

    // The community link in the post header. Match the href shape rather than a
    // class: new reddit's classes churn, /r/<name>/ does not.
    const link = await page
      .$('shreddit-post a[href^="/r/"], shreddit-post-header a[href^="/r/"], a[data-testid="subreddit-name"]')
      .catch(() => null);
    if (!link) {
      ctx.log('open_post_subreddit: no community link on this post — skipping.');
      return { ok: true, skipped: true, reason: 'no-community-link' };
    }

    const href = await link.evaluate((el) => el.getAttribute('href')).catch(() => '');
    await humanScrollToElement(page, link).catch(() => {});
    await sleep(rand(500, 1500)); // a beat — noticing where this came from

    const clicked = await humanClickHandle(page, link, { padX: [6, 30], padY: [4, 12] });
    if (!clicked.ok) {
      ctx.log('open_post_subreddit: click did not land — skipping.');
      return { ok: true, skipped: true, reason: 'click-missed' };
    }
    await sleep(rand(1800, 3600));

    const landed = await page.evaluate(() => /^\/r\/[^/]+\/?$/.test(location.pathname)).catch(() => false);
    if (!landed) {
      ctx.log('open_post_subreddit: did not land on a community feed — skipping.');
      return { ok: true, skipped: true, reason: 'did-not-land' };
    }

    const sub = (href || '').split('/').filter(Boolean)[1] || '';
    ctx.log(`open_post_subreddit: followed the post through to r/${sub}.`);
    return { ok: true, via: sub || 'community' };
  } catch (e) {
    ctx.log(`open_post_subreddit: skipped (${e.message}).`);
    return { ok: true, skipped: true, reason: String(e.message || e).slice(0, 120) };
  }
}

// The clickable headline inside a feed card. Ordered most- to least-specific;
// new Reddit slots the title link, but the markup has drifted before.
const TITLE_LINKS = ['a[slot="title"]', 'a[data-click-id="body"]', 'h3 a', 'a[href*="/comments/"]'];

/** Handles for the post cards currently in the feed's light DOM. */
async function feedCards(page) {
  return page.$$('shreddit-post').catch(() => []);
}

async function titleLinkWithin(card) {
  for (const sel of TITLE_LINKS) {
    const el = await card.$(sel).catch(() => null);
    if (el) return el;
  }
  return null;
}

// --- open_feed_post --------------------------------------------------------
// Open a post the way a browsing person does: from whatever is in front of them.
//
// This is the primitive the whole warm-up loop hangs on, and nothing existing
// covers it. find_target is the posting equivalent, but it hunts for a KNOWN
// post id — useless when the entire point is that we don't care which post it is.
//
// Picks by POSITION rather than by content: "something around the 3rd–8th card".
// The composer cannot know what will be in the feed, and a real person doesn't
// decide before they look either.
//
// Dual budget (scrolls AND wall-clock), copying find_target. With pauses of up to
// 13s a scroll count alone does not bound the runtime, and overrunning
// STEP_TIMEOUT_MS would fail the step for no reason.
export async function openFeedPost(page, step, ctx) {
  const p = (step && step.params) || {};
  const minIndex = Math.max(0, p.minIndex ?? 0);
  const maxIndex = Math.max(minIndex, p.maxIndex ?? 7);
  const maxScrolls = p.maxScrolls ?? 4;
  const maxSeconds = p.maxSeconds ?? 70;
  const deadline = Date.now() + maxSeconds * 1000;

  try {
    // If we are somehow already on a thread, this step has nothing to do.
    if (await onThreadPage(page)) {
      ctx.log('open_feed_post: already on a thread — skipping.');
      return { ok: true, skipped: true, reason: 'already-on-thread' };
    }

    await waitForDeepVisible(page, ['shreddit-post'], 12000);

    // Scroll until enough cards exist to satisfy the window, or the budget goes.
    let cards = await feedCards(page);
    for (let i = 0; i < maxScrolls && cards.length <= minIndex && Date.now() < deadline; i++) {
      await humanScroll(page, { steps: rand(1, 3), distance: [400, 900] });
      await humanPause();
      cards = await feedCards(page);
    }

    if (!cards.length) {
      ctx.log('open_feed_post: no posts in this feed — skipping.');
      return { ok: true, skipped: true, reason: 'empty-feed' };
    }

    // Clamp the window to what is actually there. A feed with 3 posts and a
    // window of 4–9 should open the last one, not give up.
    const hi = Math.min(maxIndex, cards.length - 1);
    const lo = Math.min(minIndex, hi);
    const index = rand(lo, hi + 1);
    const card = cards[index];

    const link = await titleLinkWithin(card);
    if (!link) {
      ctx.log(`open_feed_post: card ${index} has no title link — skipping.`);
      return { ok: true, skipped: true, reason: 'no-title-link' };
    }

    // Scroll it into view before clicking. Reddit renders far below the fold, so
    // a card can be in the DOM without ever having been "seen" — clicking it
    // from off-screen is a teleport, which is exactly the tell we avoid.
    await humanScrollToElement(page, link).catch(() => {});
    await sleep(rand(400, 1200)); // a beat, as if deciding

    const clicked = await humanClickHandle(page, link, { padX: [10, 80], padY: [4, 16] });
    if (!clicked.ok) {
      ctx.log('open_feed_post: click did not land — skipping.');
      return { ok: true, skipped: true, reason: 'click-missed' };
    }
    await sleep(rand(1800, 3600));

    if (!(await onThreadPage(page))) {
      ctx.log('open_feed_post: the click did not open a thread — skipping the rest of this leg.');
      return { ok: true, skipped: true, reason: 'did-not-open' };
    }

    ctx.log(`open_feed_post: opened the post at position ${index + 1} of ${cards.length}.`);
    return { ok: true, via: 'feed', scrolls: index };
  } catch (e) {
    // Decoration, never the job.
    ctx.log(`open_feed_post: skipped (${e.message}).`);
    return { ok: true, skipped: true, reason: String(e.message || e).slice(0, 120) };
  }
}
