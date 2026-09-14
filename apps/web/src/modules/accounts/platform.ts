// Which platform a posting account belongs to.
//
// PURE — used by the accounts pages, the server routes and the pickers alike.
//
// ════════════════════════════════════════════════════════════════════════════
// ONE ACCOUNTS COLLECTION, A PLATFORM FIELD — AND ABSENT MEANS REDDIT
//
// Every account written before Shopify existed has no `platform`, and every one
// of them is a Reddit identity. So a missing field reads as 'reddit', and there
// is no migration to run or forget. The field is set at creation and never
// changed afterwards: a Reddit identity's counters, warm-up history and karma
// mean nothing on a merchant forum, and "change platform" would silently carry
// them across.
//
// The two platforms can share an AdsPower profile — one browser signed in to
// both sites. That is safe: the agent locks by profile and by exit IP, so two
// jobs on the same browser never run at once, whichever platform they are for.
// ════════════════════════════════════════════════════════════════════════════

export const ACCOUNT_PLATFORMS = ['reddit', 'shopify'] as const;
export type AccountPlatform = (typeof ACCOUNT_PLATFORMS)[number];

export const PLATFORM_LABEL: Record<AccountPlatform, string> = {
  reddit: 'Reddit',
  shopify: 'Shopify Community',
};

// Takes any object: account docs arrive as Record<string, unknown>, and a weak
// `{ platform?: unknown }` parameter type refuses those outright.
export const accountPlatform = (account: object | null | undefined): AccountPlatform =>
  (account as { platform?: unknown } | null | undefined)?.platform === 'shopify' ? 'shopify' : 'reddit';

export const isAccountPlatform = (v: unknown): v is AccountPlatform =>
  typeof v === 'string' && (ACCOUNT_PLATFORMS as readonly string[]).includes(v);

/** How a handle is written on the platform, for display. */
export const handleOf = (platform: AccountPlatform, username: string): string =>
  username ? (platform === 'shopify' ? `@${username}` : `u/${username}`) : '';

/**
 * A username as typed → as the platform knows it.
 *
 * Reddit: drops a leading `u/` or `/u/`. Shopify Community: drops a leading `@`
 * and accepts a pasted profile URL (`community.shopify.com/u/name/...`) — the
 * handle is what the agent compares against the signed-in user, so a stray
 * prefix would fail every post as "signed in as the wrong account".
 */
export function cleanUsername(raw: unknown, platform: AccountPlatform): string {
  let s = String(raw ?? '').trim();
  if (platform === 'shopify') {
    const url = s.match(/community\.shopify\.com\/u\/([^/?#\s]+)/i);
    if (url) s = decodeURIComponent(url[1]);
    return s.replace(/^@+/, '').trim();
  }
  return s.replace(/^\/?u\//i, '').trim();
}
