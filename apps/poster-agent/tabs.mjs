// Which browser tab a job works in.
//
// ════════════════════════════════════════════════════════════════════════════
// NEVER THE FIRST TAB. A TAB FOR THIS SITE, OR A NEW ONE.
//
// Every browser function used to take `pages[0]` and navigate it — whatever it
// was. One AdsPower profile can be signed in to Reddit AND the Shopify
// Community, and an operator keeps tabs open in it; a Reddit job was replacing
// the Shopify tab, and the other way round. Now a job asks for a tab FOR ITS
// PLATFORM, in this order:
//
//   1. the tab this agent used last time, for this profile and platform —
//      remembered by the browser's own target id, which survives navigation and
//      (in .agent-tabs.json) an agent restart, for as long as the profile stays
//      open;
//   2. an open tab already on the platform's site;
//   3. a new tab.
//
// ⚠️ A TAB WITH UNSENT TEXT IS NEVER TAKEN. The agent answers "leave page?"
// prompts automatically (a dry run leaves the composer dirty), so navigating a
// tab where a PERSON was halfway through typing a reply would silently throw
// their text away. Such a tab is skipped, even when it is the remembered one.
//
// A tab on any other site is never touched.
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLATFORM_HOSTS = {
  reddit: /(^|\.)reddit\.com$/i,
  shopify: /^community\.shopify\.com$/i,
};

/** Is this URL on the platform's site? */
export function onPlatform(url, platform) {
  const re = PLATFORM_HOSTS[platform];
  if (!re) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && re.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * The choice, with no browser. `tabs` is `[{ id, url, dirty }]` in the browser's
 * order; `rememberedId` the tab used last time (or null).
 *
 * Returns `{ id, reason }` — reason 'remembered' | 'platform-tab' — or
 * `{ id: null, reason: 'new' }` when a new tab must be opened.
 */
export function pickTab(tabs, rememberedId, platform) {
  const usable = (t) => !t.dirty;
  const remembered = rememberedId ? tabs.find((t) => t.id === rememberedId) : null;
  // The remembered tab must still be on this site — a person may have taken it
  // somewhere else since, and then it is theirs.
  if (remembered && usable(remembered) && onPlatform(remembered.url, platform)) return { id: remembered.id, reason: 'remembered' };
  const onSite = tabs.find((t) => usable(t) && onPlatform(t.url, platform));
  if (onSite) return { id: onSite.id, reason: 'platform-tab' };
  return { id: null, reason: 'new' };
}

// ---------------------------------------------------------------------------
// Memory: profile + platform → target id, on disk so a restart keeps it.
// ---------------------------------------------------------------------------

const MEMORY_FILE = join(dirname(fileURLToPath(import.meta.url)), '.agent-tabs.json');

function readMemory() {
  try {
    const m = JSON.parse(readFileSync(MEMORY_FILE, 'utf8'));
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

function remember(profileId, platform, id) {
  const m = readMemory();
  m[`${profileId}:${platform}`] = id;
  try {
    // Write-then-rename: two jobs finishing together must not leave half a file.
    const tmp = `${MEMORY_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(m, null, 2));
    renameSync(tmp, MEMORY_FILE);
  } catch {
    /* memory is a convenience — the site match still finds the tab next time */
  }
}

const targetIdOf = (page) => {
  const t = page.target();
  return t?._targetId ?? t?._getTargetInfo?.()?.targetId ?? null;
};

/** Does the page have text somebody has not sent — a reply box with content? */
async function isDirty(page) {
  const probe = page
    .evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // Deep: Reddit's composer lives inside shadow roots.
      const all = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('textarea, [contenteditable="true"], *')) {
          if (el.shadowRoot) walk(el.shadowRoot);
          if (el.matches('textarea, [contenteditable="true"]')) all.push(el);
        }
      };
      walk(document);
      return all.some((el) => {
        if (!visible(el)) return false;
        const text = el.tagName === 'TEXTAREA' ? el.value : el.textContent;
        return String(text || '').trim().length > 0;
      });
    })
    .catch(() => false);
  // A tab that will not answer in 3s (backgrounded, hung) is not worth waiting on.
  return Promise.race([probe, new Promise((r) => setTimeout(() => r(false), 3000))]);
}

/**
 * The tab this job works in, brought to the front.
 *
 * `profileId` + `platform` key the memory. Logs which tab it took and why, so a
 * tab being taken is never a mystery in the log.
 */
export async function openTaskTab(browser, { profileId, platform, log = () => {} }) {
  const pages = await browser.pages();
  const tabs = [];
  for (const page of pages) {
    const url = page.url();
    // Only a tab on the platform's site can be chosen, so only those are probed.
    const dirty = onPlatform(url, platform) ? await isDirty(page) : false;
    tabs.push({ id: targetIdOf(page), url, dirty, page });
  }
  const memory = readMemory();
  const choice = pickTab(tabs, memory[`${profileId}:${platform}`] ?? null, platform);

  let page;
  if (choice.id) {
    page = tabs.find((t) => t.id === choice.id).page;
  } else {
    page = await browser.newPage();
  }
  const skippedDirty = tabs.filter((t) => t.dirty).length;
  const id = targetIdOf(page);
  if (id) remember(profileId, platform, id);
  await page.bringToFront().catch(() => {});
  log(
    `tab: ${choice.reason === 'new' ? 'opened a new tab' : choice.reason === 'remembered' ? 'reusing the agent’s own tab' : 'reusing an open tab on the site'} for ${platform}` +
      (skippedDirty ? ` (skipped ${skippedDirty} with unsent text)` : '') +
      '.',
  );
  return page;
}
