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
  humanTypeFocused,
  shuffled,
  waitForDeepVisible,
  waitForCommunityLink,
  deepQueryCommunityLink,
  clearSearchScope,
} from './helpers.mjs';
import { openSubreddit } from './browse.mjs';

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
// ════════════════════════════════════════════════════════════════════════════
// REWRITTEN FROM A LIVE PROBE (2026-08-15). The previous version reported "no
// community link on this post" on real threads, and when it DID find something
// it was usually the wrong thing. Both from one line:
//
//     page.$('shreddit-post a[href^="/r/"], …')                        // WRONG
//
// Two independent faults in that selector, and the probe showed both:
//
// 1. THE REAL COMMUNITY LINKS ARE ABSOLUTE. On an r/ynab thread the post header
//    carries two links to the community — the icon ("Go to ynab", 32x32) and the
//    name ("r/ynab", 39x15) — and BOTH are `https://www.reddit.com/r/ynab/`. A
//    `^="/r/"` prefix match cannot match an absolute URL, so it saw neither.
//
// 2. WHAT IT DID MATCH WAS THE FLAIR. `shreddit-post-flair > a` points at
//    `/r/ynab/?f=flair_name:"New to YNAB"` — relative, so it matched, and it is
//    first in document order. That link goes to the right community showing a
//    FLAIR-FILTERED feed, and the old landed-check (`^/r/[^/]+/?$` on pathname,
//    which ignores the query) waved it through. So a post WITH a flair silently
//    followed through to a narrowed feed, and a post WITHOUT one — the
//    r/middleclassfinance case in the 08-15 session — found nothing at all and
//    skipped. One selector, two different wrong behaviours, neither visible.
//
// The fix does not hunt for an anchor shape at all. `shreddit-post` states its
// own community as an attribute (`subreddit-name="ynab"`, confirmed by probe),
// so we ask the post which community it belongs to and then look for a link to
// THAT — via the same helper the search routes use, which resolves relative and
// absolute alike, matches the name case-insensitively, and prefers an unfiltered
// link over the flair one.
// ════════════════════════════════════════════════════════════════════════════

/** Which community does the post on this page belong to? Read from the element's
 *  own attribute rather than parsed out of a link — the post declares it, so
 *  there is nothing to guess. Falls back to the URL, which on a thread page is
 *  `/r/<sub>/comments/…` and therefore just as authoritative. */
async function postCommunityName(page) {
  return page
    .evaluate(() => {
      const post = document.querySelector('shreddit-post');
      const attr = post && (post.getAttribute('subreddit-name') || '');
      if (attr) return attr;
      const m = location.pathname.match(/^\/r\/([^/]+)/i);
      return m ? m[1] : '';
    })
    .catch(() => '');
}

export async function openPostSubreddit(page, _step, ctx) {
  try {
    if (!(await onThreadPage(page))) {
      ctx.log('open_post_subreddit: not on a post — skipping.');
      return { ok: true, skipped: true, reason: 'not-on-thread' };
    }

    const sub = await postCommunityName(page);
    if (!sub) {
      ctx.log('open_post_subreddit: the post does not name its community — skipping.');
      return { ok: true, skipped: true, reason: 'no-community-name' };
    }

    const link = await deepQueryCommunityLink(page, sub);
    if (!link) {
      ctx.log(`open_post_subreddit: no clickable link to r/${sub} on this post — skipping.`);
      return { ok: true, skipped: true, reason: 'no-community-link', subreddit: sub };
    }

    await humanScrollToElement(page, link).catch(() => {});
    await sleep(rand(500, 1500)); // a beat — noticing where this came from

    const clicked = await humanClickHandle(page, link, { padX: [6, 30], padY: [4, 12] });
    if (!clicked.ok) {
      ctx.log(`open_post_subreddit: click did not land on the r/${sub} link — skipping.`);
      return { ok: true, skipped: true, reason: 'click-missed', subreddit: sub };
    }
    await sleep(rand(1800, 3600));

    // Assert we reached THE community, not merely A community. The old check
    // accepted any `/r/<something>/`, so a click that drifted onto one of the
    // recommended communities in the sidebar would have passed — the same shape
    // as the join button that carried ten communities on one page.
    const landed = await onSub(page, sub);
    if (!landed) {
      const where = await page.evaluate(() => location.pathname).catch(() => '?');
      ctx.log(`open_post_subreddit: did not land on r/${sub} (at ${where}) — skipping.`);
      return { ok: true, skipped: true, reason: 'did-not-land', subreddit: sub };
    }

    ctx.log(`open_post_subreddit: followed the post through to r/${sub}.`);
    return { ok: true, via: 'post-header', subreddit: sub };
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

// --- search_keyword --------------------------------------------------------
// Reach a community by searching a TOPIC rather than its name.
//
// This is how people actually find communities: you search "budget tips", and
// r/budget turns up — in the typeahead, on the Communities tab, or as the source
// of a post in the results. Searching a subreddit by name assumes you already
// knew it existed, which for a warm-up account is precisely the thing it is
// supposed to be establishing.
//
// Degrades in the same shape as searchSubreddit's routes: the rolled surface
// first, then the other two, then — because a topic search genuinely may not
// surface a given community at all — a fall back to searching it BY NAME. Only
// if that fails too does the step skip.

const onSub = (page, sub) =>
  page
    .evaluate((s) => location.pathname.toLowerCase().startsWith(`/r/${s.toLowerCase()}`), sub)
    .catch(() => false);

// The EXACT community link. Same reasoning as browse.mjs: a results page for
// "personalfinance" lists r/UKPersonalFinance first, so a loose match lands on
// the wrong community — and joining the wrong community is not recoverable by a
// later step the way a wrong browse would be.
//
// waitForCommunityLink (helpers.mjs) keeps that whole-segment guarantee and
// fixes what it used to be: three exact CSS attribute selectors, which compare
// CASE-SENSITIVELY against names we store lowercased. A mixed-case community
// could not be matched on any search surface, so every discovery leg quietly
// degraded to the name fallback — i.e. typing the community's URL, which is the
// teleport this file exists to avoid. See the note on the helper.

const searchUrl = (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`;

async function typeQuery(page, query) {
  // A keyword search is ALWAYS trying to reach somewhere other than here, so an
  // inherited r/<sub> scope guarantees it fails. Seen live: "passive incom"
  // searched from inside r/howearnmoneyonline surfaced nothing, because it was
  // searching within that community the whole time.
  await clearSearchScope(page).catch(() => {});
  const box = await waitForDeepVisible(page, ['textarea[name="q"]', 'input[name="q"]'], 8000);
  if (!box) return false;
  const c = await humanClickHandle(page, box, { padX: [20, 60], padY: [6, 14] });
  if (!c.ok) return false;
  await sleep(rand(300, 900));
  await humanTypeFocused(page, query);
  return true;
}

/** Click the community out of the typeahead dropdown, without pressing Enter. */
async function kwTypeahead(page, keyword, sub) {
  if (!(await typeQuery(page, keyword))) return false;
  await sleep(rand(900, 2000));
  const entry = await waitForCommunityLink(page, sub, 6000);
  if (!entry) return false;
  await humanPause();
  await humanClickHandle(page, entry, { padX: [10, 60], padY: [4, 16] });
  await sleep(rand(1800, 3200));
  return onSub(page, sub);
}

/** Search, switch to the Communities tab, pick it there. */
async function kwCommunitiesTab(page, keyword, sub) {
  if (!(await typeQuery(page, keyword))) return false;
  await humanPause();
  await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(rand(1800, 3200));

  const tab = await waitForDeepVisible(page, ['a[href*="type=communities"]'], 8000);
  if (tab) {
    await humanPause();
    await humanClickHandle(page, tab, { padX: [8, 40], padY: [6, 16] });
    await sleep(rand(1800, 3200));
  }
  const entry = await waitForCommunityLink(page, sub, 8000);
  if (!entry) return false;
  await humanPause();
  await humanClickHandle(page, entry, { padX: [10, 60], padY: [4, 16] });
  await sleep(rand(1800, 3200));
  return onSub(page, sub);
}

/** Search, spot a post from that community in the results, go through it. */
async function kwPostResult(page, keyword, sub) {
  if (!(await typeQuery(page, keyword))) return false;
  await humanPause();
  await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(rand(1800, 3200));

  await humanScroll(page, { steps: rand(1, 3), distance: [300, 700] });
  await humanPause(); // scanning the results
  const entry = await waitForCommunityLink(page, sub, 8000);
  if (!entry) return false;
  await humanScrollToElement(page, entry).catch(() => {});
  await humanClickHandle(page, entry, { padX: [10, 40], padY: [6, 16] });
  await sleep(rand(1800, 3200));
  return onSub(page, sub);
}

const KW_ROUTES = { typeahead: kwTypeahead, communities_tab: kwCommunitiesTab, post_result: kwPostResult };

export async function searchKeyword(page, step, ctx) {
  const p = (step && step.params) || {};
  const keyword = String(p.keyword || '').trim();
  const sub = String(p.subreddit || '').trim();
  if (!keyword || !sub) {
    ctx.log('search_keyword: no keyword or target community — skipping.');
    return { ok: true, skipped: true, reason: 'missing-params' };
  }

  try {
    // RETURNING means going back to results we already had, rather than retyping
    // the identical query — which is what a person does, and what the composer
    // plans for a second community found in the same search. The results URL is
    // stable, so this is the same page the back button would give.
    if (p.returning) {
      await page.goto(searchUrl(keyword), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(rand(1500, 3000));
      await humanPause();
      const entry = await waitForCommunityLink(page, sub, 8000);
      if (entry) {
        await humanScrollToElement(page, entry).catch(() => {});
        await humanClickHandle(page, entry, { padX: [10, 50], padY: [4, 16] });
        await sleep(rand(1800, 3200));
        if (await onSub(page, sub)) {
          ctx.log(`search_keyword: back to the "${keyword}" results, opened r/${sub}.`);
          return { ok: true, via: 'results-return', subreddit: sub };
        }
      }
      ctx.log(`search_keyword: r/${sub} was not in the "${keyword}" results any more — searching it by name.`);
    } else {
      const first = KW_ROUTES[p.via] ? p.via : 'typeahead';
      // Planned route first, recovery routes in a RANDOM order — see the note on
      // the same loop in browse.mjs.
      const order = [first, ...shuffled(Object.keys(KW_ROUTES).filter((r) => r !== first))];

      for (const route of order) {
        const landed = await KW_ROUTES[route](page, keyword, sub).catch(() => false);
        if (landed) {
          if (route !== first) ctx.log(`search_keyword: "${first}" did not surface it — recovered via "${route}".`);
          ctx.log(`search_keyword: found r/${sub} by searching "${keyword}" (${route}).`);
          await waitForDeepVisible(page, ['shreddit-post'], 12000);
          // plannedVia only when this was a recovery, so the trace distinguishes
          // "went the way it meant to" from "the intended surface failed".
          return { ok: true, via: route, subreddit: sub, ...(route === first ? {} : { plannedVia: first }) };
        }
        // Clean slate before the next route.
        await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(rand(800, 1800));
      }
      ctx.log(
        `search_keyword: "${keyword}" did not surface r/${sub} on any tab (tried ${order.join(', ')}) — going there directly instead.`,
      );
    }

    // CHANGE OF COURSE. The topic search did not turn it up, so go to the
    // community directly.
    //
    // BE HONEST ABOUT WHAT THIS IS. It used to log "searching it by name
    // instead" while calling openSubreddit, which is a page.goto — a direct
    // navigation, not a search. That is a TELEPORT, precisely the footprint
    // search_keyword exists to avoid, and the log said the opposite.
    //
    // The teleport is kept rather than replaced with a real name search because
    // the three keyword routes have already cost ~2 minutes by this point (118s
    // measured live on 2026-08-16) and a name search would add ~40s more against
    // a 300s step timeout. But it is now `via: 'name-fallback'` with plannedVia
    // set, so the trace says plainly that this leg did not discover anything —
    // see the note in WARMUP-COMMENT-KARMA/WARMUP-FOLLOWING on why a keyword
    // pairing that never lands is worth fixing at the source instead.
    const byName = await openSubreddit(page, { params: { subreddit: sub, sort: 'hot' } }, ctx).catch(() => null);
    if (byName && (await onSub(page, sub))) {
      // Let the arrival SETTLE before handing back. Without this the next step
      // started while a navigation was still in flight and died with "Execution
      // context was destroyed" — seen live, and it derailed the three steps that
      // followed until the next anchor recovered. Cheap insurance: this route is
      // only reached after a search that has already bounced the page around.
      await waitForDeepVisible(page, ['shreddit-post'], 12000).catch(() => {});
      await sleep(rand(800, 1800));
      return { ok: true, via: 'name-fallback', subreddit: sub, plannedVia: String(p.via || 'typeahead') };
    }

    ctx.log(`search_keyword: could not reach r/${sub} at all — skipping the rest of this leg.`);
    return { ok: true, skipped: true, reason: 'not-reached' };
  } catch (e) {
    ctx.log(`search_keyword: skipped (${e.message}).`);
    return { ok: true, skipped: true, reason: String(e.message || e).slice(0, 120) };
  }
}

// --- join_subreddit --------------------------------------------------------
// Join the community we are standing in.
//
// ════════════════════════════════════════════════════════════════════════════
// THE BUTTON TOGGLES. On new reddit the same control reads "Join" or "Joined"
// depending on state, so clicking it on a community the account ALREADY follows
// LEAVES that community. A warm-up whose job is to accumulate memberships would
// be quietly destroying them, and nothing downstream would show it — the account
// would simply never accumulate.
//
// So this reads the state first and FAILS CLOSED: if the state cannot be
// determined with confidence, it does not click. An unverifiable read is treated
// as "already joined", never as "safe to click" — the same discipline the karma
// parse had to learn, where a guess wrote a 1 over a real 3,892.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// WRITTEN FROM A LIVE PROBE, not from guesswork. The first version was authored
// against markup nobody had looked at and returned 'unknown' on the first real
// page — the same mistake the karma parse made. What the page actually carries:
//
//   <shreddit-join-button
//      name="passive_income"          <- WHICH community this button is for
//      prefixed-name="r/passive_income"
//      subreddit-id="t5_2v763"
//      subscribe-label="Join"         <- what the button reads when NOT joined
//      unsubscribe-label="Joined">    <- and when joined
//     #shadow-root
//       <button class="... join-btn ...">Join</button>   <- the live state
//
// Two things follow, and the first one is a latent disaster:
//
// 1. A POST PAGE CARRIES A JOIN BUTTON FOR EVERY RECOMMENDED COMMUNITY. The probe
//    found TEN on one r/passive_income thread — the post's own, plus nine
//    recommendations (beermoney, sidehustle, dropship, …) carrying
//    `class="invisible group-hover:visible"` but a non-zero box, so a
//    visibility-filtered first-match query does NOT exclude them. Taking the
//    first match would eventually have joined a community nobody chose. Exactly
//    the shape of the upvote_post bug that would have upvoted a random feed card.
//    So the control is looked up BY `name`, never by document order.
//
// 2. There is no `is-subscribed` attribute. The element instead declares BOTH
//    labels, and the shadow button shows the live one — so the element describes
//    how to read itself, which survives label changes and localisation in a way
//    a hardcoded /joined/ regex would not.
// ════════════════════════════════════════════════════════════════════════════

/** The join control for ONE named community. Never a first match.
 *
 *  MUST PIERCE SHADOW ROOTS. The post's own join button sits inside one, while
 *  the nine recommended-community buttons sit in the light DOM — so a plain
 *  `document.querySelectorAll('shreddit-join-button')` returns every community
 *  EXCEPT the one being joined. Verified live: light-DOM-only found
 *  beermoney, sidehustle, findapath, WorkOnline, Flipping, Affiliatemarketing,
 *  dropship, Blogging, DropshippingVenture — and missed passive_income.
 *
 *  Third time this codebase has been bitten by shadow DOM (the composer decoy
 *  textarea, the focus check, now this). */
async function findJoinControl(page, sub) {
  const handle = await page
    .evaluateHandle((name) => {
      const wanted = String(name).toLowerCase();
      const found = [];
      const walk = (root, depth) => {
        if (depth > 8 || found.length) return;
        for (const el of root.querySelectorAll('*')) {
          if (el.tagName.toLowerCase() === 'shreddit-join-button' && (el.getAttribute('name') || '').toLowerCase() === wanted) {
            found.push(el);
            return;
          }
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        }
      };
      walk(document, 0);
      return found[0] || null;
    }, sub)
    .catch(() => null);
  if (!handle) return null;
  const found = await handle.evaluate((el) => !!el).catch(() => false);
  if (!found) {
    await handle.dispose().catch(() => {});
    return null;
  }
  return handle;
}

/** Read subscription state WITHOUT clicking anything.
 *  Returns 'joined' | 'not-joined' | 'unknown'. */
async function readJoinState(host) {
  return host
    .evaluate((el) => {
      // The element's own vocabulary, not ours.
      const sub = (el.getAttribute('subscribe-label') || 'Join').trim().toLowerCase();
      const unsub = (el.getAttribute('unsubscribe-label') || 'Joined').trim().toLowerCase();
      const btn = el.shadowRoot && el.shadowRoot.querySelector('button');
      const text = ((btn && btn.textContent) || '').trim().toLowerCase();
      if (!text) return 'unknown';
      // Compared for EQUALITY, not with a prefix or a substring: "joined"
      // contains "join", and getting that backwards is the click that unfollows.
      if (text === unsub) return 'joined';
      if (text === sub) return 'not-joined';
      return 'unknown';
    })
    .catch(() => 'unknown');
}

/** The clickable <button> inside the shadow root — the host itself is only 17px
 *  tall and is not what a person clicks. */
async function joinClickTarget(host) {
  const inner = await host.evaluateHandle((el) => (el.shadowRoot && el.shadowRoot.querySelector('button')) || el).catch(() => null);
  return inner || host;
}

export async function joinSubreddit(page, step, ctx) {
  const p = (step && step.params) || {};
  const sub = String(p.subreddit || '').trim();
  if (!sub) return { ok: true, skipped: true, reason: 'no-subreddit' };

  try {
    // Must be standing in the right place. A join fired from the wrong page
    // would join whatever community that page belongs to.
    const here = await page
      .evaluate(() => location.pathname.toLowerCase())
      .catch(() => '');
    if (!here.startsWith(`/r/${sub.toLowerCase()}`)) {
      ctx.log(`join_subreddit: not on r/${sub} (at ${here || 'unknown'}) — skipping.`);
      return { ok: true, skipped: true, reason: 'wrong-page' };
    }

    // Looked up by name. The page carries a join button for every recommended
    // community, so document order would eventually pick the wrong one.
    const host = await findJoinControl(page, sub);
    if (!host) {
      ctx.log(`join_subreddit: no join control for r/${sub} on this page — skipping.`);
      return { ok: true, skipped: true, reason: 'no-button' };
    }

    const state = await readJoinState(host);
    if (state !== 'not-joined') {
      // 'joined' and 'unknown' both land here, deliberately.
      ctx.log(
        state === 'joined'
          ? `join_subreddit: already following r/${sub} — leaving it alone.`
          : `join_subreddit: could not read the button state on r/${sub} — NOT clicking (a wrong click would unfollow).`,
      );
      return { ok: true, skipped: true, reason: state === 'joined' ? 'already-joined' : 'state-unknown', subreddit: sub };
    }

    if (ctx.dryRun) {
      ctx.log(`join_subreddit: [DRY RUN] would join r/${sub}.`);
      return { ok: true, skipped: true, dryRun: true, reason: 'dry-run', subreddit: sub };
    }

    // Click the shadow-root <button>, not the 17px-tall host.
    const target = await joinClickTarget(host);
    await humanScrollToElement(page, target).catch(() => {});
    await sleep(rand(600, 1800)); // a beat before committing
    const clicked = await humanClickHandle(page, target, { padX: [8, 30], padY: [4, 12] });
    if (!clicked.ok) {
      ctx.log(`join_subreddit: click did not land on r/${sub} — skipping.`);
      return { ok: true, skipped: true, reason: 'click-missed', subreddit: sub };
    }
    await sleep(rand(1200, 2600));

    // Confirm from the element itself rather than assuming the click worked.
    // "Attempted" and "joined" are different facts, and only the second one
    // should reach the dashboard — a false membership means the composer skips
    // that community forever and nothing ever says so.
    const after = await readJoinState(host);
    if (after === 'joined') {
      ctx.log(`join_subreddit: joined r/${sub}.`);
      return { ok: true, joined: true, subreddit: sub };
    }
    ctx.log(`join_subreddit: clicked Join on r/${sub} but the button did not confirm — recording as unconfirmed.`);
    return { ok: true, skipped: true, reason: 'unconfirmed', subreddit: sub };
  } catch (e) {
    ctx.log(`join_subreddit: skipped (${e.message}).`);
    return { ok: true, skipped: true, reason: String(e.message || e).slice(0, 120) };
  }
}
