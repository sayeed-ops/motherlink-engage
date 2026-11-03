// Is this community safe to join? Read from its own page, on the account's own
// visit, just before the Join click.
//
// Two kinds of "no". HARD: private, quarantined or adult — never joined by any
// account. SOFT: outside the commenting limits (under 50k and at least 1,000
// weekly visitors, fewer than 3 moderators, no add-ons such as installed apps or
// app and bot accounts among the moderators). A soft no only matters where the
// account will comment: a big community is fine to join and browse quietly.
// For a community the account will comment in, anything unreadable is not a
// pass either: no join, and a sample of the page goes back to Engage.
//
// READ BY VISIBLE TEXT. Reddit's sidebar is custom elements and shadow roots
// whose markup changes; the words a person reads ("weekly visitors",
// "Moderators", "Installed apps") change far less often.

export const COMMUNITY_LIMITS = { maxWeeklyVisitors: 50_000, minWeeklyVisitors: 1_000, maxModerators: 2 };

/** App and bot accounts that moderate. Any of these counts as an add-on. */
const KNOWN_APP_ACCOUNTS = new Set([
  'automoderator',
  'ban-purge',
  'bot-bouncer',
  'queue-pruner',
  'modqueue-pruner',
  'modrelayhq',
  'trendingtattler',
  'suspended-remove',
]);

/** "12.3K" → 12300, "1,234" → 1234, "1.2M" → 1200000. */
export function parseCount(s) {
  const m = String(s ?? '').trim().match(/^([\d.,]+)\s*([kKmM])?$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = m[2] ? (m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000) : 1;
  return Math.round(n * mult);
}

/** Weekly visitors from the page's visible text, whichever side the label is on. */
export function weeklyVisitorsFrom(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  const after = t.match(/([\d][\d.,]*\s*[kKmM]?)\s*weekly visitors/i);
  const before = t.match(/weekly visitors\s*:?\s*([\d][\d.,]*\s*[kKmM]?)/i);
  return parseCount((after || before)?.[1]);
}

export function isAppAccount(name) {
  const n = String(name ?? '').toLowerCase().replace(/^u\//, '');
  return KNOWN_APP_ACCOUNTS.has(n) || /bot$/.test(n) || n.endsWith('-app');
}

/**
 * The verdict from what was read: 'passed', 'rejected' (hard or soft) or
 * 'unreadable'. Whether it blocks a join is `blocksJoin`'s call.
 */
export function judgeCommunity(facts, limits = COMMUNITY_LIMITS) {
  const f = facts || {};
  const mods = Array.isArray(f.moderators) ? f.moderators : null;
  const apps = [...new Set([...(f.apps || []), ...(mods || []).filter(isAppAccount)])];
  const weekly = typeof f.weeklyVisitors === 'number' ? f.weeklyVisitors : null;
  const base = { weeklyVisitors: weekly, moderators: mods ? mods.length : null, apps };
  if (f.private) return { ...base, status: 'rejected', hard: true, reason: 'private community' };
  if (f.quarantined) return { ...base, status: 'rejected', hard: true, reason: 'quarantined' };
  if (f.adult) return { ...base, status: 'rejected', hard: true, reason: 'adult (NSFW) community' };
  if (apps.length) return { ...base, status: 'rejected', hard: false, reason: `add-ons installed: ${apps.join(', ')}` };
  if (weekly === null) return { ...base, status: 'unreadable', hard: false, reason: 'could not read weekly visitors' };
  if (weekly > limits.maxWeeklyVisitors) return { ...base, status: 'rejected', hard: false, reason: `${weekly.toLocaleString('en-US')} weekly visitors (over ${limits.maxWeeklyVisitors.toLocaleString('en-US')})` };
  if (weekly < limits.minWeeklyVisitors) return { ...base, status: 'rejected', hard: false, reason: `${weekly.toLocaleString('en-US')} weekly visitors (under ${limits.minWeeklyVisitors.toLocaleString('en-US')})` };
  if (mods === null) return { ...base, status: 'unreadable', hard: false, reason: 'could not read the moderators' };
  if (mods.length > limits.maxModerators) return { ...base, status: 'rejected', hard: false, reason: `${mods.length} moderators (limit ${limits.maxModerators})` };
  return { ...base, status: 'passed', hard: false, reason: '' };
}

/** Read the facts off the open community page. Never throws. */
export async function readCommunityFacts(page) {
  return page
    .evaluate(() => {
      // Every element, through shadow roots.
      const all = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          all.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      const textOf = (el) => (el.innerText || el.textContent || '').trim();
      const leafText = all
        .filter((el) => !el.children.length || el.shadowRoot)
        .map(textOf)
        .filter(Boolean)
        .join('\n');
      const visible = `${document.body ? document.body.innerText : ''}\n${leafText}`.slice(0, 60_000);

      const heading = (re) => all.find((el) => el.children.length === 0 && re.test(textOf(el)));
      // From a heading, climb until the block holds what we are after.
      const blockFrom = (el, test) => {
        let n = el;
        for (let i = 0; i < 6 && n; i++) {
          n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
          if (n && test(n)) return n;
        }
        return null;
      };
      const deepAll = (root, sel) => {
        const out = [...root.querySelectorAll(sel)];
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...deepAll(el.shadowRoot, sel));
        return out;
      };

      let moderators = null;
      const modHead = heading(/^moderators$/i);
      if (modHead) {
        const block = blockFrom(modHead, (n) => deepAll(n, 'a[href*="/user/"]').length > 0);
        if (block) {
          moderators = [
            ...new Set(
              deepAll(block, 'a[href*="/user/"]')
                .map((a) => (a.getAttribute('href') || '').match(/\/user\/([^/?#]+)/i)?.[1] || '')
                .filter(Boolean)
                .map((s) => s.toLowerCase()),
            ),
          ];
        }
      }

      let apps = [];
      const appHead = heading(/^installed apps$/i);
      if (appHead) {
        const block = blockFrom(appHead, (n) => textOf(n).split('\n').filter((l) => l.trim()).length > 1);
        if (block) apps = textOf(block).split('\n').map((l) => l.trim()).filter((l) => l && !/^installed apps$/i.test(l));
      }

      return {
        visible,
        moderators,
        apps,
        private: /this community is private|is a private community|restricted to approved members/i.test(visible),
        quarantined: /this community is quarantined|quarantined community/i.test(visible),
        adult: /you must be 18|mature content|community is marked as nsfw|over 18 only/i.test(visible),
      };
    })
    .then((r) => ({
      weeklyVisitors: weeklyVisitorsFrom(r.visible),
      moderators: r.moderators,
      apps: r.apps,
      private: r.private,
      quarantined: r.quarantined,
      adult: r.adult,
      // Kept only for an unreadable verdict, so the reader can be tuned.
      sample: r.visible.replace(/\s+/g, ' ').slice(0, 190),
    }))
    .catch((e) => ({ weeklyVisitors: null, moderators: null, apps: [], sample: `read failed: ${e.message}`.slice(0, 190) }));
}

/** A hard no always blocks; anything short of a pass blocks a community the
 *  account will comment in. */
export function blocksJoin(verdict, strict) {
  if (verdict.hard) return true;
  return strict && verdict.status !== 'passed';
}
