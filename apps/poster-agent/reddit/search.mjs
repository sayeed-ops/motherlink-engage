// Finding a community through Reddit's search — one search, typed once.
//
// Shared by search_subreddit (the query is the community's own name) and
// search_keyword (the query is a topic that should surface it).
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT THIS REPLACES, AND THE BUG THAT FORCED IT
//
// There used to be three separate "routes" — the suggestions, the Communities
// tab, a post in the results — and when one failed the agent went back to Home
// and RETYPED the identical query for the next. Up to three retypes, about two
// minutes, then a visit by URL. Nobody searches like that.
//
// Worse, none of the routes looked where it claimed to. Each asked "is there a
// visible link to r/<name> anywhere on this page", and with the suggestion list
// open the page behind it is full of them: the left sidebar's Recent and
// Communities lists, every post in the feed, the right sidebar. So when the
// suggestions did not offer the community, the agent found one of THOSE, scrolled
// the page behind the open suggestion list to reach it, clicked it, and logged
// `found r/sportsbook by searching "…" (typeahead)`. Seen live 2026-10-03, with
// a five-word sentence that could never have produced a suggestion.
//
// Now it is one continuous search, the way a person does it:
//
//   type the query → glance at the suggestions → if it is not there, press Enter
//   → look down the results → if it is not there, open the Communities tab
//
// and every look is confined to the surface it is looking at. The containers
// below were read off a live page on 2026-10-03 (see docs/REDDIT-DOM.md).
// ════════════════════════════════════════════════════════════════════════════

import {
  rand,
  sleep,
  humanPause,
  humanScroll,
  humanClickHandle,
  humanTypeFocused,
  waitForDeepVisible,
  waitForCommunityLink,
  deepQueryCommunityLink,
  clearSearchScope,
} from './helpers.mjs';

/** Where a community link has to sit to count as "found on this surface". A link
 *  qualifies only with one of these as an ancestor (through shadow roots). */
export const SEARCH_SCOPE = {
  // The suggestion list under the search box.
  typeahead: ['#search-dropdown-results-container', '#reddit-typeahead-results-partial-container', '[data-testid="search-sdui-typeahead-suggestion"]'],
  // The results page: a post's own community, or the "Communities" panel that
  // sits beside the results. Both are things a person scanning results clicks.
  results: ['[data-testid="search-sdui-post"]', '[data-testid="search-post-unit"]', '[data-testid="search-results-sidebar"]'],
  // The Communities tab's list.
  communities: ['[data-testid="search-community"]'],
};

const onSub = (page, sub) =>
  page
    .evaluate((s) => location.pathname.toLowerCase().startsWith(`/r/${s.toLowerCase()}`), sub)
    .catch(() => false);

/** A sentence does not produce a community suggestion — suggestions match
 *  community NAMES. Waiting six seconds for one is waiting for nothing. */
export function isSentence(query) {
  return String(query || '').trim().split(/\s+/).length >= 4;
}

/**
 * Search for `query` and arrive at r/<subreddit>.
 *
 * `start` is the surface the plan expects to find it on:
 *   'typeahead'    the whole chain: suggestions, then results, then the tab
 *   'results'      do not wait on the suggestions; press Enter and look
 *   'communities'  press Enter and go to the Communities tab
 *
 * Returns the surface it was actually found on — 'typeahead' | 'results' |
 * 'communities' — or null when this search did not reach it. Never navigates by
 * URL: what to do when a search fails is the caller's decision.
 */
export async function findCommunityBySearch(page, query, subreddit, { start = 'typeahead', log = () => {} } = {}) {
  // Drop any inherited r/<sub> scope first: searching from inside a community
  // silently narrows the query to that community.
  await clearSearchScope(page).catch(() => {});
  const box = await waitForDeepVisible(page, ['textarea[name="q"]', 'input[name="q"]'], 8000);
  if (!box) return null;
  const c = await humanClickHandle(page, box, { padX: [20, 60], padY: [6, 14] });
  if (!c.ok) return null;
  await sleep(rand(300, 900));
  // Replace whatever an earlier search left in the box.
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod);
  await page.keyboard.press('KeyA');
  await page.keyboard.up(mod);
  await sleep(rand(120, 320));
  await humanTypeFocused(page, query);

  // --- 1. the suggestions ---------------------------------------------------
  if (start === 'typeahead') {
    const wait = isSentence(query) ? 1400 : 5000;
    await sleep(rand(700, 1300)); // suggestions populate
    const entry = await waitForCommunityLink(page, subreddit, wait, { within: SEARCH_SCOPE.typeahead });
    if (entry) {
      await humanPause(); // reading the suggestions
      // NEVER SCROLL HERE. The suggestion is already on screen, and the only
      // thing a scroll can move is the page behind the open list.
      await humanClickHandle(page, entry, { padX: [10, 60], padY: [4, 16], scroll: false });
      await sleep(rand(1800, 3200));
      if (await onSub(page, subreddit)) return 'typeahead';
      log(`search: clicked the suggestion for r/${subreddit} but did not land there — carrying on to the results.`);
    }
  }

  // --- 2. the results -------------------------------------------------------
  await humanPause();
  await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(rand(1800, 3200));
  if (await onSub(page, subreddit)) return 'results'; // Enter went straight there

  if (start !== 'communities') {
    // Look down the page a little, the way results get scanned. The page is the
    // right thing to scroll now — the suggestion list is gone.
    for (let i = 0; i < 3; i++) {
      const entry = await deepQueryCommunityLink(page, subreddit, { within: SEARCH_SCOPE.results });
      if (entry) {
        await humanPause();
        await humanClickHandle(page, entry, { padX: [10, 40], padY: [6, 16] });
        await sleep(rand(1800, 3200));
        if (await onSub(page, subreddit)) return 'results';
        break;
      }
      if (i < 2) {
        await humanScroll(page, { steps: rand(1, 3), distance: [300, 700] });
        await humanPause();
      }
    }
  }

  // --- 3. the Communities tab ----------------------------------------------
  const tab = await waitForDeepVisible(page, ['a[href*="type=communities"]'], 8000);
  if (!tab) return null;
  await humanPause(); // glancing at the tabs
  await humanClickHandle(page, tab, { padX: [8, 40], padY: [6, 16] });
  await sleep(rand(1800, 3200));
  const entry = await waitForCommunityLink(page, subreddit, 8000, { within: SEARCH_SCOPE.communities });
  if (!entry) return null;
  await humanPause();
  await humanClickHandle(page, entry, { padX: [10, 60], padY: [4, 16] });
  await sleep(rand(1800, 3200));
  return (await onSub(page, subreddit)) ? 'communities' : null;
}
