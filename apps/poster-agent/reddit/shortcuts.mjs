// Ways to a community or a post that are NOT search.
//
//   enter_subreddit    Recent in the left sidebar · the joined Communities list
//                      · a post from the community in the home feed
//   open_recent_post   Recent Posts, beside the home feed
//
// These are ADDITIONS to the search flow, not replacements for it. Every one
// of them ends, when the thing it wanted is not there, in exactly the steps the
// account would have taken before this file existed: search_subreddit, and for
// a post, scroll_feed and find_target. The trace records the route that
// actually landed, with `plannedVia` saying what the plan had aimed at.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THIS DOES NOT CONTRADICT search.mjs
//
// search.mjs refuses to click a community in the sidebar, and says so at
// length: with the suggestion list open, "is there a link to r/<name> on this
// page" found the sidebar's, clicked it, and logged a successful search. The
// fault there was the LIE — a sidebar click recorded as a search. Here the
// sidebar click is the plan, is confined to the one list it names, and is
// recorded as what it is.
//
// The markup was read off a live page on 2026-10-13 (docs/REDDIT-DOM.md):
//
//   reddit-sidebar-nav#left-sidebar            pinned, scrolls by itself
//     ├─ summary[aria-controls="RECENT"]
//     │    div#RECENT › li › a[href="/r/<Name>/"]            visited
//     └─ summary[aria-controls="communities_section"]
//          left-nav-communities-controller (shadow root)
//            left-nav-community-item › a[href="/r/<name>/"]  joined
//
//   div#right-sidebar-container                pinned, scrolls by itself
//     └─ recent-posts › div[slot="posts"] … a[href="/r/<sub>/comments/<id>/…"]
//
// Both panels are taller than the screen, so the entry wanted is often below
// the panel's own fold — see humanScrollPaneTo in helpers.mjs.
// ════════════════════════════════════════════════════════════════════════════

import {
  rand,
  sleep,
  humanPause,
  humanScroll,
  humanClickHandle,
  humanScrollPaneTo,
  elementRect,
  deepQueryHandle,
  deepQueryWithin,
  deepQueryCommunityLink,
  waitForDeepVisible,
  withTimeout,
} from './helpers.mjs';
import { subredditFromUrl, searchSubreddit, scrollFeed, findTarget, finishSearch } from './browse.mjs';

const LEFT_NAV = ['reddit-sidebar-nav', '#left-sidebar'];
const RIGHT_RAIL = ['#right-sidebar-container'];

/** The two sidebar lists: where a link must sit, and the control that folds it. */
const SIDEBAR_LIST = {
  recent: { within: ['#RECENT'], toggle: 'summary[aria-controls="RECENT"]', name: 'Recent' },
  joined: {
    within: ['left-nav-communities-controller'],
    toggle: 'summary[aria-controls="communities_section"]',
    name: 'the Communities list',
  },
};

const onSub = (page, sub) =>
  page.evaluate((s) => location.pathname.toLowerCase().startsWith(`/r/${s.toLowerCase()}`), sub).catch(() => false);

const onThread = (page, redditPostId) =>
  page.evaluate((id) => location.pathname.includes(`/comments/${id}`), redditPostId).catch(() => false);

const onHome = (page) => page.evaluate(() => location.pathname === '/').catch(() => false);

const hasBox = async (handle) => {
  const r = await elementRect(handle);
  return !!r && r.w > 4 && r.h > 4;
};

/** Back to the home feed the way it is done from anywhere on Reddit: the logo.
 *  Opening the address is the fallback, as it is everywhere else. */
async function goHome(page, ctx) {
  if (await onHome(page)) return true;
  const logo = await waitForDeepVisible(page, ['a#reddit-logo'], 5000);
  if (logo) {
    await humanClickHandle(page, logo, { padX: [8, 50], padY: [4, 16], scroll: false });
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(rand(1200, 2600));
    if (await onHome(page)) return true;
  }
  ctx.log('home: the logo did not lead to the home feed — opening it directly.');
  await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(rand(1200, 2600));
  return onHome(page);
}

// --- the sidebar lists -------------------------------------------------------

/** Click r/<subreddit> in one of the left sidebar's lists. Returns whether the
 *  account landed there; never navigates by address. */
async function viaSidebarList(page, subreddit, which, ctx) {
  const list = SIDEBAR_LIST[which];
  if (!(await waitForDeepVisible(page, LEFT_NAV, 6000))) {
    ctx.log(`enter_subreddit: the left sidebar is not on screen.`);
    return false;
  }
  // visibleOnly: false — a link in a folded section has no box, and a link
  // below the panel's fold is still a link. Both are dealt with below.
  const find = () => deepQueryCommunityLink(page, subreddit, { visibleOnly: false, within: list.within });
  let link = await find();
  if (!link) {
    ctx.log(`enter_subreddit: r/${subreddit} is not in ${list.name}.`);
    return false;
  }

  if (!(await hasBox(link))) {
    // The section is folded. Open THAT section — its own control, by name.
    const toggle = await deepQueryHandle(page, [list.toggle], { visibleOnly: false }).catch(() => null);
    if (!toggle || !(await hasBox(toggle))) {
      ctx.log(`enter_subreddit: ${list.name} is not showing and cannot be opened.`);
      return false;
    }
    await humanScrollPaneTo(page, toggle, LEFT_NAV);
    await humanClickHandle(page, toggle, { padX: [10, 80], padY: [8, 20], scroll: false });
    await sleep(rand(700, 1600));
    link = await find();
    if (!link || !(await hasBox(link))) {
      ctx.log(`enter_subreddit: opened ${list.name} but r/${subreddit} is still not showing.`);
      return false;
    }
  }

  if (!(await humanScrollPaneTo(page, link, LEFT_NAV))) {
    ctx.log(`enter_subreddit: could not bring r/${subreddit} into view in ${list.name}.`);
    return false;
  }
  await humanPause(); // running an eye down the list
  await humanClickHandle(page, link, { padX: [12, 90], padY: [8, 22], scroll: false });
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(rand(1500, 3000));
  return onSub(page, subreddit);
}

// --- the home feed -----------------------------------------------------------

/** The name of the community on a card from it in the feed, if one is loaded. */
async function feedCardCommunityLink(page, subreddit) {
  const cards = await page.$$('shreddit-post').catch(() => []);
  for (const card of cards) {
    const name = await card.evaluate((el) => el.getAttribute('subreddit-name') || '').catch(() => '');
    if (name.toLowerCase() !== subreddit.toLowerCase()) continue;
    const near = await card
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top < window.innerHeight * 1.5 && r.bottom > 0;
      })
      .catch(() => false);
    if (!near) continue;
    const link = await deepQueryWithin(card, ['a[data-testid="subreddit-name"]']).catch(() => null);
    if (link) return link;
  }
  return null;
}

/** Scroll the home feed for a post from the community and go through its name.
 *  Mostly a miss unless the account follows the community — and a miss is just
 *  a few scrolls of the home feed before a search, which is the old opening. */
async function viaFeed(page, subreddit, bursts, ctx) {
  if (!(await goHome(page, ctx))) return false;
  await waitForDeepVisible(page, ['shreddit-post'], 12000);
  for (let i = 0; i <= bursts; i++) {
    const link = await feedCardCommunityLink(page, subreddit);
    if (link) {
      await humanPause(); // noticing where the post is from
      await humanClickHandle(page, link, { padX: [6, 40], padY: [4, 14] });
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await sleep(rand(1500, 3000));
      if (await onSub(page, subreddit)) return true;
      ctx.log(`enter_subreddit: clicked r/${subreddit} on a post in the feed but did not land there.`);
      return false;
    }
    if (i < bursts) {
      await humanScroll(page, { steps: rand(2, 5), distance: [250, 700] });
      await humanPause();
    }
  }
  ctx.log(`enter_subreddit: nothing from r/${subreddit} came up in the home feed.`);
  return false;
}

// --- enter_subreddit ---------------------------------------------------------
// Reach the community without searching for it. `via` is which way; when that
// way does not have it, this is search_subreddit — same primitive, same
// fallbacks — and the result says so.
const ENTRY_LOG = {
  recent: 'Recent in the sidebar',
  joined: 'the Communities list in the sidebar',
  feed: 'a post in the home feed',
};

export async function enterSubreddit(page, step, ctx) {
  const p = (step && step.params) || {};
  const subreddit = p.subreddit || subredditFromUrl(ctx.threadUrl);
  if (!subreddit) throw new Error('ABORT: no subreddit to go to.');
  const sort = p.sort || 'hot';
  const via = ENTRY_LOG[p.via] ? p.via : 'recent';

  const landed = await withTimeout(
    via === 'feed' ? viaFeed(page, subreddit, p.bursts ?? rand(2, 5), ctx) : viaSidebarList(page, subreddit, via, ctx),
    90_000,
    'enter_subreddit',
  ).catch((e) => {
    ctx.log(`enter_subreddit: ${e.message}`);
    return false;
  });

  if (landed) {
    ctx.log(`enter_subreddit: reached r/${subreddit} from ${ENTRY_LOG[via]}.`);
    return finishSearch(page, subreddit, sort, via);
  }

  ctx.log(`enter_subreddit: searching for r/${subreddit} instead.`);
  const searched = await searchSubreddit(page, { params: { subreddit, sort, via: p.fallbackVia } }, ctx);
  return { ...searched, plannedVia: via };
}

// --- open_recent_post --------------------------------------------------------
// Come back to a post this account opened earlier in the session: go to the
// home feed and pick it out of Recent Posts.
//
// Not there — it was never opened (the first visit broke), or enough other
// posts have been opened since to push it off the list — and this is the old
// flow from the top: search for the community, scroll, find the post. Arrival
// on the thread is guaranteed either way, exactly as find_target guarantees it.
async function viaRecentPosts(page, redditPostId, ctx) {
  if (!(await goHome(page, ctx))) return false;
  if (!(await waitForDeepVisible(page, ['recent-posts'], 8000))) {
    ctx.log('open_recent_post: no Recent Posts panel on the home feed.');
    return false;
  }
  await humanPause(); // back on the feed for a moment before looking across
  const link = await deepQueryHandle(page, [`recent-posts a[href*="/comments/${redditPostId}/"]`], { visibleOnly: false });
  if (!link || !(await hasBox(link))) {
    ctx.log('open_recent_post: the post is not in Recent Posts.');
    return false;
  }
  if (!(await humanScrollPaneTo(page, link, RIGHT_RAIL))) {
    ctx.log('open_recent_post: could not bring the post into view in Recent Posts.');
    return false;
  }
  await sleep(rand(500, 1400)); // recognising the title
  await humanClickHandle(page, link, { padX: [8, 40], padY: [4, 14], scroll: false });
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(rand(2000, 3800));
  return onThread(page, redditPostId);
}

export async function openRecentPost(page, step, ctx) {
  const p = (step && step.params) || {};
  const redditPostId = p.redditPostId || ctx.redditPostId;
  const threadUrl = p.threadUrl || ctx.threadUrl;
  const subreddit = p.subreddit || ctx.subreddit || subredditFromUrl(threadUrl);
  if (!redditPostId) throw new Error('ABORT: open_recent_post has no reddit post id.');

  // Still on it: there was no time away (the browse did not run, or broke at
  // its first step). Nothing to come back from.
  if (await onThread(page, redditPostId)) {
    ctx.log('open_recent_post: still on the post — nothing to come back to.');
    return { ok: true, via: 'already-there' };
  }

  const back = await withTimeout(viaRecentPosts(page, redditPostId, ctx), 60_000, 'open_recent_post').catch((e) => {
    ctx.log(`open_recent_post: ${e.message}`);
    return false;
  });
  if (back) {
    ctx.log('open_recent_post: came back to the post from Recent Posts.');
    return { ok: true, via: 'recent-posts' };
  }

  // THE OLD FLOW. A shorter hunt than a first arrival gets — the account has
  // already spent time here — but the same three steps in the same order.
  ctx.log('open_recent_post: finding the post the usual way.');
  if (subreddit) {
    const reached = await withTimeout(
      searchSubreddit(page, { params: { subreddit, sort: 'hot', via: p.fallbackVia } }, ctx),
      90_000,
      'search',
    ).catch((e) => {
      ctx.log(`open_recent_post: could not reach r/${subreddit} (${e.message}).`);
      return null;
    });
    if (reached) await scrollFeed(page, { params: { bursts: rand(0, 2) } }, ctx).catch(() => {});
  }
  const found = await findTarget(
    page,
    { params: { redditPostId, threadUrl, maxScrolls: rand(4, 8), maxSeconds: 60, searchTitle: true } },
    ctx,
  );
  return { ok: true, via: found.via, plannedVia: 'recent-posts', scrolls: found.scrolls };
}

// --- reading Recent ----------------------------------------------------------
/**
 * The account's RECENT list, as it stands on whatever Reddit page is open.
 *
 * Read at the end of a job — no navigation, no click, the sidebar is on every
 * page — and stored on the account so the next plan can know whether "pick it
 * out of Recent" is something this account could actually do
 * (routeHints in apps/web/src/modules/reddit/joined.ts).
 *
 * Returns null when the list is not on the page, so a page without a sidebar
 * can never wipe a good reading. RECENT IS NOT MEMBERSHIP: see the note on
 * parseSubscribedCommunities in index.mjs for what confusing the two cost.
 */
export async function readRecentCommunities(page) {
  return page
    .evaluate(() => {
      const box = document.querySelector('#RECENT');
      if (!box) return null;
      const out = [];
      for (const a of box.querySelectorAll('a[href]')) {
        const m = /^(?:https?:\/\/(?:www\.)?reddit\.com)?\/r\/([A-Za-z0-9_]+)\/?$/.exec(a.getAttribute('href') || '');
        if (m && !out.includes(m[1].toLowerCase())) out.push(m[1].toLowerCase());
      }
      return out;
    })
    .catch(() => null);
}
