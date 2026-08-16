// Shared low-level primitives for driving NEW reddit (Shreddit) like a human.
//
// Layer B/C helpers — used by every interaction primitive (posting AND, later,
// warm-up). Deliberately small and dependency-free (just the Puppeteer `page`).
// Keep ALL timing/humanization here so behaviour is consistent across actions.

export const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fisher-Yates, returning a new array.
 *
 *  Used for the ORDER OF RECOVERY when a search route fails. The route the plan
 *  aimed at is randomised at compose time, but the fallbacks used to run in a
 *  fixed sequence (typeahead → communities → posts, always), so every recovery
 *  in the system took the identical path. Recoveries are rare individually and
 *  perfectly repeatable in aggregate, which is exactly the kind of regularity
 *  the rest of this design spends effort removing. */
export const shuffled = (list) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// --- the human pause -----------------------------------------------------
// ONE knob for "how long does a person hesitate before doing the next thing":
// between steps, between scroll bursts, before clicking something they spotted.
// Operator-set range (default 0-13s). Deliberately wide — regular delays are a
// tell, and the occasional near-zero pause reads as someone already decided.
//
// NOT used between individual scroll increments inside a burst: nobody waits 13
// seconds between two flicks of the wheel. Those stay sub-second (see humanScroll)
// — a "burst" is one continuous scroll, the pause comes after it.
// SKEWED, not uniform. A flat 0..max draw sounds human but isn't: it makes the
// TYPICAL pause a middling ~6.5s (at max=13), because 11-13s is as likely as
// 0-2s. That both drags — ~21 pauses per run — and is its own kind of regularity.
// Real hesitation is mostly short, with an occasional genuine distraction.
// Bands are fractions of the max, so the shape survives retuning the knob:
//   55% → 0-15%   of max  (0.0-2.0s at 13)  already decided, just acting
//   30% → 15-46%  of max  (2.0-6.0s)        a beat
//   15% → 46-100% of max  (6.0-13s)         something caught the eye
// Mean lands ~3.2s at max=13; the full range is still reachable, just uncommon.
export const PAUSE_MAX_SEC = Number(process.env.HUMAN_PAUSE_MAX_SEC || 13);
export function pauseMs() {
  const max = PAUSE_MAX_SEC * 1000;
  const r = Math.random();
  if (r < 0.55) return rand(0, max * 0.15);
  if (r < 0.85) return rand(max * 0.15, max * 0.46);
  return rand(max * 0.46, max);
}
export const pauseSec = () => pauseMs() / 1000;
export const humanPause = () => sleep(pauseMs());

/** Apply ± jitterPct to a base value (seconds or ms — unit-agnostic). */
export function jitter(base, jitterPct) {
  if (!jitterPct) return base;
  const delta = base * (jitterPct / 100);
  return Math.max(0, base + (Math.random() * 2 - 1) * delta);
}

/** How far down it is still worth scrolling — the bottom of the last comment (or
 *  the post, on a thread with none), kept a little short of the true page bottom.
 *
 *  WHY: Reddit's thread pages carry a few hundred px of empty footer below the
 *  last comment. Blind pixel scrolling rides straight into it and parks there, so
 *  every session ends with the viewport sitting in dead space — a tell, and one
 *  the operator spotted. Returns an absolute scrollY.
 *
 *  THREAD PAGES ONLY. Do not apply this to a feed: an infinite feed only loads
 *  more posts when you approach the bottom of what's rendered, so clamping there
 *  would stop the hunt from ever reaching new posts. */
export async function readableScrollLimit(page) {
  return page
    .evaluate(() => {
      const bottomOfLast = (sel) => {
        const els = document.querySelectorAll(sel);
        const last = els[els.length - 1];
        return last ? last.getBoundingClientRect().bottom + window.scrollY : 0;
      };
      const contentBottom = bottomOfLast('shreddit-comment') || bottomOfLast('shreddit-post') || document.documentElement.scrollHeight;
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      // Leave the last item ON screen, and never quite touch the page bottom.
      return Math.max(0, Math.min(contentBottom - window.innerHeight * 0.6, maxScroll - 40));
    })
    .catch(() => Number.MAX_SAFE_INTEGER);
}

/** scrollBy that refuses to go past `maxY` (absolute scrollY). */
async function scrollByBounded(page, dy, maxY) {
  const lim = Number.isFinite(maxY) ? maxY : Number.MAX_SAFE_INTEGER;
  await page
    .evaluate(
      (d, l) => {
        const target = d > 0 ? Math.min(window.scrollY + d, l) : window.scrollY + d;
        window.scrollBy(0, target - window.scrollY);
      },
      dy,
      lim
    )
    .catch(() => {});
}

/** Dwell for `seconds` (± jitter), with occasional tiny scrolls so the page looks
 *  alive rather than frozen. Capped by maxSeconds (default 120 = the ≤2min rule).
 *  Pass maxY (see readableScrollLimit) on thread pages so the drift stops at the
 *  end of the content instead of bottoming out in the footer. */
export async function humanDwell(page, seconds, { jitterPct = 25, maxSeconds = 120, maxY = null } = {}) {
  const total = Math.min(maxSeconds, jitter(seconds, jitterPct)) * 1000;
  const start = Date.now();
  while (Date.now() - start < total) {
    await sleep(rand(1200, 3200));
    if (Math.random() < 0.6) {
      await scrollByBounded(page, rand(60, 260), maxY);
    }
    // occasionally scroll back up a touch, as a real reader re-reads
    if (Math.random() < 0.12) {
      await scrollByBounded(page, -120, maxY);
    }
  }
}

/** Human-ish scroll: a few increments with pauses. Pass maxY on thread pages to
 *  stop at the end of the readable content (see readableScrollLimit). */
export async function humanScroll(page, { steps = rand(3, 7), distance = [200, 600], maxY = null } = {}) {
  for (let i = 0; i < steps; i++) {
    await scrollByBounded(page, rand(distance[0], distance[1]), maxY);
    await sleep(rand(500, 1600));
  }
}

/** Scroll an element into view the way a person does — in a few paced increments
 *  rather than the instant jump scrollIntoView() gives. Anything more than a few
 *  screens away gets one jump to close the distance first (nobody hand-scrolls
 *  7000px), then settles gradually. Used by every human click. */
export async function humanScrollToElement(page, handle, { target = 0.45, tolerance = 120 } = {}) {
  const delta = async () =>
    handle
      .evaluate((el, frac) => {
        const r = el.getBoundingClientRect();
        return r.top - window.innerHeight * frac;
      }, target)
      .catch(() => 0);

  let d = await delta();
  if (Math.abs(d) > 2400) {
    await handle.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await sleep(rand(300, 700));
    d = await delta();
  }
  for (let i = 0; i < 10 && Math.abs(d) > tolerance; i++) {
    const stepPx = Math.sign(d) * Math.min(Math.abs(d), rand(180, 520));
    await page.evaluate((dy) => window.scrollBy(0, dy), stepPx).catch(() => {});
    await sleep(rand(220, 620));
    d = await delta();
  }
}

/** Type into the currently-focused element, human-paced.
 *
 *  Newlines are NOT typed as characters: in a rich (Lexical) editor a blank line
 *  between paragraphs is one Enter (new block), and a single newline inside a
 *  paragraph is Shift+Enter (soft break). Typing "\n\n" literally would leave an
 *  extra empty paragraph. */
export async function humanTypeFocused(page, text) {
  const paragraphs = String(text).split(/\n{2,}/);
  for (let p = 0; p < paragraphs.length; p++) {
    if (p > 0) {
      await page.keyboard.press('Enter');
      await sleep(rand(200, 500));
    }
    const lines = paragraphs[p].split('\n');
    for (let l = 0; l < lines.length; l++) {
      if (l > 0) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        await sleep(rand(120, 300));
      }
      for (const ch of lines[l]) {
        await page.keyboard.type(ch, { delay: rand(35, 110) });
        if (Math.random() < 0.04) await sleep(rand(250, 800)); // occasional think pause
      }
    }
  }
}

/** Exact, drop-free insertion into the focused editor via CDP `Input.insertText`
 *  (Lexical-safe — it arrives as a real beforeinput/insertText). Used as the
 *  REPAIR path when human typing lost characters, never as the default (it isn't
 *  keystroke-shaped). Paragraph breaks are still real Enter presses. */
export async function insertTextFocused(page, text) {
  const cdp = await page.target().createCDPSession();
  try {
    const paragraphs = String(text).split(/\n{2,}/);
    for (let p = 0; p < paragraphs.length; p++) {
      if (p > 0) {
        await page.keyboard.press('Enter');
        await sleep(rand(120, 260));
      }
      const lines = paragraphs[p].split('\n');
      for (let l = 0; l < lines.length; l++) {
        if (l > 0) {
          await page.keyboard.down('Shift');
          await page.keyboard.press('Enter');
          await page.keyboard.up('Shift');
          await sleep(rand(80, 180));
        }
        if (lines[l]) await cdp.send('Input.insertText', { text: lines[l] });
      }
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Empty an editor we're about to type into. Cmd/Ctrl+A over CDP is unreliable on
 *  macOS (the browser edit command never fires), so select the content with the
 *  Selection API (or setSelectionRange for a textarea) and let a real Backspace
 *  do the deletion — that path Lexical handles correctly. */
export async function clearEditor(page, handle) {
  await handle
    .evaluate((el) => {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.focus();
        el.setSelectionRange(0, el.value.length);
        return;
      }
      el.focus();
      const sel = (el.getRootNode().getSelection ? el.getRootNode() : window).getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    })
    .catch(() => {});
  await sleep(rand(120, 280));
  await page.keyboard.press('Backspace');
  await sleep(rand(150, 350));
}

/** Wait for an element that may live inside OPEN shadow roots. Puppeteer pierces
 *  open shadow DOM with the `>>>` deep combinator in $/waitForSelector. Returns
 *  the handle, or null on timeout. Closed roots won't match — callers fall back. */
export async function waitForDeep(page, selector, timeout = 15000) {
  try {
    return await page.waitForSelector(selector, { visible: true, timeout });
  } catch {
    return null;
  }
}

/** First matching handle across the given deep selectors, or null. */
export async function queryFirst(page, selectors) {
  for (const sel of selectors) {
    const h = await page.$(sel).catch(() => null);
    if (h) return h;
  }
  return null;
}

/** Find an element by BFS-walking ALL open shadow roots from document down,
 *  returning the first match for any of `selectors` as an ElementHandle (or null).
 *  Robust for Shreddit's faceplate web components (e.g. the comment <textarea> is
 *  nested inside open shadow roots). Only OPEN roots are traversable — a closed
 *  root would need a CDP fallback, but the composer's root is open (verified live).
 *
 *  VISIBILITY MATTERS, and is the default. Shreddit renders DUPLICATE, never-laid-out
 *  copies of components (the thread page carries a second, 0x0 "Join the conversation"
 *  textarea under a stray faceplate-tracker chain). A plain first-match BFS returns
 *  that decoy, and every downstream geometry call then fails — this is exactly what
 *  wedged the composer. Pass { visibleOnly: false } only when a hidden match is fine. */
export async function deepQueryHandle(page, selectors, { visibleOnly = true } = {}) {
  const handle = await page.evaluateHandle(
    (sels, mustBeVisible) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 4 || r.height <= 4) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
      };
      const queue = [document];
      const seen = new Set();
      while (queue.length) {
        const root = queue.shift();
        for (const sel of sels) {
          for (const el of root.querySelectorAll(sel)) {
            if (!mustBeVisible || isVisible(el)) return el;
          }
        }
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot && !seen.has(node.shadowRoot)) {
            seen.add(node.shadowRoot);
            queue.push(node.shadowRoot);
          }
        }
      }
      return null;
    },
    selectors,
    visibleOnly
  );
  const el = handle.asElement();
  if (!el) {
    await handle.dispose().catch(() => {});
    return null;
  }
  return el;
}

/** deepQueryHandle scoped to ONE element's subtree (including its open shadow
 *  roots). Needed whenever "the button belonging to THIS thing" matters — e.g.
 *  the upvote button of a specific comment, where a page-wide query would happily
 *  return some other comment's. */
export async function deepQueryWithin(handle, selectors, { visibleOnly = true } = {}) {
  const found = await handle.evaluateHandle(
    (host, sels, mustBeVisible) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 4 || r.height <= 4) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
      };
      // Seed with the host AND its own shadow root: Element.querySelectorAll only
      // searches light descendants, so a host whose button lives in its OWN shadow
      // root (exactly how shreddit-post holds its vote buttons) would be missed.
      const queue = [host];
      const seen = new Set();
      if (host.shadowRoot) {
        seen.add(host.shadowRoot);
        queue.push(host.shadowRoot);
      }
      while (queue.length) {
        const root = queue.shift();
        for (const sel of sels) {
          for (const el of root.querySelectorAll(sel)) {
            if (!mustBeVisible || isVisible(el)) return el;
          }
        }
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot && !seen.has(node.shadowRoot)) {
            seen.add(node.shadowRoot);
            queue.push(node.shadowRoot);
          }
        }
      }
      return null;
    },
    selectors,
    visibleOnly
  );
  const el = found.asElement();
  if (!el) {
    await found.dispose().catch(() => {});
    return null;
  }
  return el;
}

/**
 * The link to ONE named community, matched case-INSENSITIVELY.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A CSS SELECTOR ANY MORE.
 *
 * Both search paths used to look the community up with an exact attribute match:
 *
 *     `a[href="/r/${sub}/"]`                                          // WRONG
 *
 * CSS attribute selectors compare values CASE-SENSITIVELY — `href` is not one of
 * the attributes HTML folds — while normalizeSubredditName() lowercases every
 * name we store. Reddit's markup carries the community's canonical display
 * casing. So for r/MiddleClassFinance the page holds `/r/MiddleClassFinance/`,
 * we searched for `/r/middleclassfinance/`, and the selector could not match on
 * ANY surface: not the typeahead, not the Communities tab, not the posts
 * results. All three routes failed and the step fell through to a direct visit.
 *
 * Seen live 2026-08-15: 121 seconds burned on three doomed routes, then
 * `search_subreddit: no search route landed — falling back to a direct visit`,
 * on a community that was plainly visible in all three surfaces. The tell was
 * in the history all along — every community ever reached through a search route
 * (passive_income, howearnmoneyonline) is all-lowercase, and the mixed-case ones
 * (NatureAwws) were only ever reached by open_post_subreddit, which prefix-
 * matches `/r/` and never touches the name.
 *
 * The cost was not just time. A discovery leg that degrades to openSubreddit
 * types the community's URL — the exact teleport footprint the warm-up design
 * exists to eliminate — while the plan and the trace both still say "via the
 * header search".
 *
 * WHAT IS DELIBERATELY *NOT* WIDENED. The name is still compared as a WHOLE
 * SEGMENT, so a results page for "personalfinance" cannot land on
 * r/UKPersonalFinance — that guarantee was the reason for the exact match and it
 * is preserved intact. Only the casing folds. The path must also be the
 * community ROOT (`/r/<name>` or `/r/<name>/`) and never a permalink beneath it,
 * or route 3 would click a post from the community instead of the community
 * itself and land on a thread while the composer believed it was on a feed.
 * Query strings and fragments are ignored: community identity lives entirely in
 * the path, so a tracking param cannot change which community a click reaches.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function deepQueryCommunityLink(page, subreddit, { visibleOnly = true } = {}) {
  const handle = await page.evaluateHandle(
    (wantedRaw, mustBeVisible) => {
      const wanted = String(wantedRaw || '').toLowerCase();
      if (!wanted) return null;
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 4 || r.height <= 4) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
      };
      /** Is this anchor the ROOT of the community we want? */
      const isTarget = (a) => {
        const raw = a.getAttribute('href');
        if (!raw) return false;
        let path;
        try {
          // Resolves relative and absolute alike, and drops ?query / #hash.
          path = new URL(raw, location.origin).pathname;
        } catch {
          return false;
        }
        const parts = path.split('/').filter(Boolean);
        // Exactly ['r', '<name>'] — never a permalink below the community.
        return parts.length === 2 && parts[0].toLowerCase() === 'r' && parts[1].toLowerCase() === wanted;
      };
      /** Does this href carry a filter? `/r/ynab/?f=flair_name:"New to YNAB"` is
       *  a link to the RIGHT community showing a NARROWED feed. Still the right
       *  place, so it is an acceptable last resort — but a plain link to the
       *  community is strictly better, and on a post page the flair link is
       *  often the first one in document order. Preferred, not required. */
      const isFiltered = (a) => {
        try {
          return !!new URL(a.getAttribute('href'), location.origin).search;
        } catch {
          return true;
        }
      };

      let fallback = null;
      const queue = [document];
      const seen = new Set();
      while (queue.length) {
        const root = queue.shift();
        for (const a of root.querySelectorAll('a[href]')) {
          if (!isTarget(a) || (mustBeVisible && !isVisible(a))) continue;
          if (!isFiltered(a)) return a;
          if (!fallback) fallback = a;
        }
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot && !seen.has(node.shadowRoot)) {
            seen.add(node.shadowRoot);
            queue.push(node.shadowRoot);
          }
        }
      }
      return fallback;
    },
    subreddit,
    visibleOnly
  );
  const el = handle.asElement();
  if (!el) {
    await handle.dispose().catch(() => {});
    return null;
  }
  return el;
}

/** deepQueryCommunityLink, polled — the search surfaces populate asynchronously,
 *  exactly like the components waitForDeepVisible exists for. */
export async function waitForCommunityLink(page, subreddit, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await deepQueryCommunityLink(page, subreddit);
    if (h) return h;
    if (Date.now() > deadline) return null;
    await sleep(350);
  }
}

/** deepQueryHandle, but poll until something VISIBLE shows up (or timeout → null).
 *  Needed because Shreddit swaps components in on interaction (the rich editor only
 *  gets a layout box after the collapsed box is clicked). */
export async function waitForDeepVisible(page, selectors, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await deepQueryHandle(page, selectors);
    if (h) return h;
    if (Date.now() > deadline) return null;
    await sleep(350);
  }
}

/** Viewport-relative rect measured IN PAGE. Use this instead of Puppeteer's
 *  boundingBox(): CDP's box model returns null for slotted / shadow-hosted /
 *  zero-layout nodes, which is how the composer click loop ended up with
 *  "no usable boundingBox (null)" on every attempt. */
export async function elementRect(handle) {
  return handle
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })
    .catch(() => null);
}

/** Click an element the way a person would: scroll it into view, then dispatch a
 *  real mouse move + click at viewport coordinates inside its rect. Returns
 *  { ok, rect, hit, x, y } — `hit` is what actually sits at that pixel (an overlay
 *  eating the click shows up here). */
export async function humanClickHandle(page, handle, { padX = [24, 60], padY = [8, 20] } = {}) {
  await humanScrollToElement(page, handle);
  await sleep(rand(350, 750));
  const r = await elementRect(handle);
  if (!r || r.w <= 4 || r.h <= 4) return { ok: false, rect: r, hit: '' };
  const x = r.x + Math.min(rand(padX[0], padX[1]), r.w * 0.45);
  const y = r.y + Math.min(rand(padY[0], padY[1]), r.h * 0.6);
  const hit = await page
    .evaluate(
      ({ px, py }) => {
        const el = document.elementFromPoint(px, py);
        return el ? el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') : 'none';
      },
      { px: x, py: y }
    )
    .catch(() => '?');
  await page.mouse.move(x, y).catch(() => {});
  await sleep(rand(60, 160));
  await page.mouse.click(x, y, { delay: rand(45, 110) }).catch(() => {});
  return { ok: true, rect: r, hit, x, y };
}

/** The element that REALLY has focus, piercing open shadow roots.
 *  document.activeElement alone reports the shadow HOST (e.g. faceplate-textarea-input)
 *  when the caret is in a nested <textarea>, so a naive check reads as "not focused".
 *  Returns a descriptor: { chain, tag, id, contenteditable, placeholder, lexical, inComposer }. */
export async function deepActiveElement(page) {
  return page
    .evaluate(() => {
      const chain = [];
      let el = document.activeElement;
      while (el) {
        chain.push(el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''));
        const next = el.shadowRoot && el.shadowRoot.activeElement;
        if (!next || next === el) break;
        el = next;
      }
      if (!el) return { chain: ['none'], tag: '', id: '', inComposer: false };
      // climb light parents AND shadow hosts looking for the comment composer
      let node = el;
      let inComposer = false;
      for (let i = 0; i < 15 && node; i++) {
        const tag = node.tagName && node.tagName.toLowerCase();
        if (tag === 'comment-composer-host') { inComposer = true; break; }
        if (tag === 'shreddit-composer' && node.getAttribute('event-source') === 'comment_composer') { inComposer = true; break; }
        node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      }
      return {
        chain,
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        contenteditable: el.getAttribute ? el.getAttribute('contenteditable') : null,
        placeholder: el.getAttribute ? el.getAttribute('placeholder') : null,
        lexical: !!(el.hasAttribute && el.hasAttribute('data-lexical-editor')),
        inComposer,
      };
    })
    .catch(() => null);
}

/** Answer browser dialogs automatically, so nothing ever waits on a human.
 *
 *  THE ONE THAT MATTERS IS `beforeunload`: "Reload site? Changes you made may not
 *  be saved." Reddit registers it as soon as there's text in the composer, so it
 *  fires whenever we navigate away from a thread we typed into — the next job's
 *  open_home, a direct-nav fallback, or a reload after a dry run.
 *
 *  Puppeteer does NOT dismiss dialogs for you: `#onDialog` only emits the event.
 *  With no listener the dialog stays open and the tab is stuck until someone
 *  clicks it by hand — which is exactly the wedge this fixes.
 *
 *  accept() on a beforeunload means "leave the page" (the blue Reload/Leave
 *  button). Anything else — an unexpected alert or confirm — is DISMISSED
 *  instead: cancelling is the conservative answer to a prompt we didn't expect. */
/**
 * Drop the subreddit scope from the header search box.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. Opening the search box while standing inside r/X silently
 * scopes the query to r/X. The box shows a `r/X ×` pill, the placeholder reads
 * "Search in r/X", and the host element carries it outright:
 *
 *   <reddit-search-large scope='{"type":"community","name":"passive_income"}'>
 *     <rpl-input-chip id="search-input-remove-filter"
 *        aria-label="Remove r/passive_income filter and expand search to all of Reddit">
 *
 * So a search meant to FIND A DIFFERENT COMMUNITY searches inside the current
 * one and cannot possibly succeed. Seen live: a warm-up searched "passive incom"
 * from within r/howearnmoneyonline, surfaced nothing, and fell back to a direct
 * visit; a later search_subreddit for r/passive_income lost its Communities-tab
 * route the same way and recovered only by luck.
 *
 * Affects POSTING as well as warm-up — searchSubreddit runs this too. It has been
 * invisible there because a posting plan always opens on Home first, where there
 * is no scope to inherit.
 *
 * Clicking the pill is what a person does, and its own aria-label says it
 * "expands search to all of Reddit". Best-effort: no scope, or an unclickable
 * pill, simply returns false and the caller carries on.
 *
 * DO NOT READ THE `scope` ATTRIBUTE TO DECIDE THIS. It is a STATIC initial
 * attribute, like `initial-query` — it still reads `passive_income` long after
 * the filter has been removed, the pill is gone from the DOM and the placeholder
 * has gone back to "Find anything". The first version of this function checked
 * it and reported failure on a clear that had actually worked. THE PILL'S
 * PRESENCE IS THE SCOPE; nothing else about it is live.
 * ════════════════════════════════════════════════════════════════════════════
 */
const SCOPE_PILL = ['#search-input-remove-filter', 'rpl-input-chip.scoped-search-pill'];

export async function clearSearchScope(page, log = () => {}) {
  const pill = await deepQueryHandle(page, SCOPE_PILL);
  if (!pill) return false; // not scoped — nothing to do

  const name = await pill
    .evaluate((el) => (el.textContent || '').trim().slice(0, 40))
    .catch(() => '');

  // CLICK THE SHADOW-ROOT <button>, NOT THE HOST. Measured live: the host sits
  // at x=722 width 154, while the real button inside starts at x=734 width 136 —
  // so a small padX from the host's left edge lands in the chip's border and
  // does nothing at all. Verified: a positional click on the host left the pill
  // in place; the same click on the inner button removes it.
  //
  // Exactly the same shape as the join control (host 70x17, button 70x32). When
  // Reddit wraps a control in a custom element, the clickable thing is inside.
  const target = (await pill.evaluateHandle((el) => (el.shadowRoot && el.shadowRoot.querySelector('button')) || el).catch(() => null)) || pill;

  await humanClickHandle(page, target, { padX: [10, 40], padY: [4, 12] });
  await sleep(rand(400, 1100));

  if (!(await deepQueryHandle(page, SCOPE_PILL))) {
    log(`search: cleared the ${name || 'community'} filter so the query covers all of Reddit.`);
    return true;
  }

  // FALLBACK: go Home. The pill does not always take a synthetic positional
  // click, and the alternative — a programmatic el.click() — dispatches an
  // UNTRUSTED event, which is precisely the kind of signal this whole system
  // exists not to emit. Reddit's front page carries no scope, so landing there
  // resets it by construction, and clicking the logo on the way to searching
  // something unrelated is an entirely ordinary thing to do.
  //
  // Every caller navigates away as part of searching anyway, so this costs a
  // page load and nothing else.
  log(`search: the ${name || 'community'} filter would not clear — going Home to drop it.`);
  await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(rand(1200, 2600));

  if (await deepQueryHandle(page, SCOPE_PILL)) {
    log('search: still scoped after going Home — the query may be narrowed.');
    return false;
  }
  return true;
}

export function autoHandleDialogs(page, log = () => {}) {
  page.on('dialog', async (dialog) => {
    const type = dialog.type();
    try {
      if (type === 'beforeunload') {
        await dialog.accept();
        log('dialog: "leave page?" — accepted automatically (the composer had unsaved text).');
      } else {
        await dialog.dismiss();
        log(`dialog: unexpected ${type} — dismissed automatically ("${String(dialog.message()).slice(0, 80)}").`);
      }
    } catch {
      /* the dialog can vanish on its own if the page navigates first */
    }
  });
}

/** Run `fn` but reject if it exceeds `ms`. Used by the executor for per-step
 *  timeouts so a wedged interaction fails the job instead of hanging forever. */
export function withTimeout(promise, ms, label = 'step') {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
