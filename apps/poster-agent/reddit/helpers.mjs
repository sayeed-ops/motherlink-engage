// Shared low-level primitives for driving NEW reddit (Shreddit) like a human.
//
// Layer B/C helpers — used by every interaction primitive (posting AND, later,
// warm-up). Deliberately small and dependency-free (just the Puppeteer `page`).
// Keep ALL timing/humanization here so behaviour is consistent across actions.

export const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Apply ± jitterPct to a base value (seconds or ms — unit-agnostic). */
export function jitter(base, jitterPct) {
  if (!jitterPct) return base;
  const delta = base * (jitterPct / 100);
  return Math.max(0, base + (Math.random() * 2 - 1) * delta);
}

/** Dwell for `seconds` (± jitter), with occasional tiny scrolls so the page looks
 *  alive rather than frozen. Capped by maxSeconds (default 120 = the ≤2min rule). */
export async function humanDwell(page, seconds, { jitterPct = 25, maxSeconds = 120 } = {}) {
  const total = Math.min(maxSeconds, jitter(seconds, jitterPct)) * 1000;
  const start = Date.now();
  while (Date.now() - start < total) {
    await sleep(rand(1200, 3200));
    if (Math.random() < 0.6) {
      await page.evaluate((dy) => window.scrollBy(0, dy), rand(60, 260)).catch(() => {});
    }
    // occasionally scroll back up a touch, as a real reader re-reads
    if (Math.random() < 0.12) {
      await page.evaluate(() => window.scrollBy(0, -120)).catch(() => {});
    }
  }
}

/** Human-ish scroll: a few increments with pauses. */
export async function humanScroll(page, { steps = rand(3, 7), distance = [200, 600] } = {}) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate((dy) => window.scrollBy(0, dy), rand(distance[0], distance[1])).catch(() => {});
    await sleep(rand(500, 1600));
  }
}

/** Type into the currently-focused element (works for contenteditable, unlike
 *  page.type which targets input/textarea .value). Focus the target first. */
export async function humanTypeFocused(page, text) {
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: rand(30, 120) });
    if (Math.random() < 0.04) await sleep(rand(250, 800)); // think pause
  }
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

/** Run `fn` but reject if it exceeds `ms`. Used by the executor for per-step
 *  timeouts so a wedged interaction fails the job instead of hanging forever. */
export function withTimeout(promise, ms, label = 'step') {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
