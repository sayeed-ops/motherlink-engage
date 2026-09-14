// Posting a reply on the Shopify Community — the decisions, with no browser.
//
// PURE. post.mjs drives the page; this file decides the route through the
// forum, what counts as "the text we typed is the text we meant", and how to
// read what Discourse said when it refused. Tested in
// tests/unit/posterAgentShopify.test.mjs.
//
// ════════════════════════════════════════════════════════════════════════════
// THE SITE IS DISCOURSE, AND THAT DECIDES MOST OF THIS
//
// Read live on 2026-09-13 (Discourse 2026.9.0):
//   - a board lists threads as `a.raw-topic-link[href="/t/{slug}/{id}"]`;
//   - a post is `article#post_{n}[data-post-id][data-user-id]`;
//   - the page's own app answers "who is signed in":
//       Discourse.__container__.lookup('service:current-user') → null when not;
//   - the composer is `#reply-control`, and its text is ALSO held by the
//     composer service (`service:composer` → model.reply), which is what makes
//     "did we type what we meant" checkable without scraping an editor;
//   - min_post_length is 20.
//
// The editor may be the classic markdown TEXTAREA or the rich (ProseMirror)
// editor — it is a per-user preference — and a paragraph break differs between
// them: two Enters in the textarea (markdown needs a blank line), one in the
// rich editor. So the comparison below ignores whitespace and markup entirely
// and compares only the words.
// ════════════════════════════════════════════════════════════════════════════

export const SHOPIFY_ORIGIN = 'https://community.shopify.com';

/** Discourse refuses a post shorter than this (site setting, read live). */
export const MIN_POST_LENGTH = 20;

const int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The thread's own URL, from the job. Refuses anything that is not a topic on
 *  this site — the agent must never be pointed somewhere else by a job. */
export function topicUrl(job) {
  const id = int(job?.topicId);
  if (!id) throw new Error('ABORT: the job has no topic id.');
  const slug = String(job?.topicSlug || '').replace(/[^a-z0-9-]/gi, '');
  return `${SHOPIFY_ORIGIN}/t/${slug || 'topic'}/${id}`;
}

/** The board the thread lives on, for the approach. Null when the job does not
 *  carry one — the approach then starts from the thread itself. */
export function boardUrl(job) {
  const id = int(job?.categoryId);
  const slug = String(job?.categorySlug || '').replace(/[^a-z0-9-]/gi, '');
  return id && slug ? `${SHOPIFY_ORIGIN}/c/${slug}/${id}` : null;
}

/** A post's permalink. */
export function permalinkFor(job, postNumber) {
  const n = int(postNumber);
  return n ? `${topicUrl(job)}/${n}` : topicUrl(job);
}

/** Is this URL the job's thread? Compared by topic id — a slug can change. */
export function isTopicUrl(url, job) {
  const id = int(job?.topicId);
  const m = String(url || '').match(/^https:\/\/community\.shopify\.com\/t\/(?:[^/]+\/)?(\d+)(?:[/?#]|$)/);
  return !!id && !!m && Number(m[1]) === id;
}

/**
 * The route a person takes to a reply, with the randomness injected so a test
 * can pin it.
 *
 * Board → find the thread in the listing (or go straight to it when it is not
 * on the first screens, as a person following a bookmark would) → read it for a
 * while, proportional to how long it is → reply.
 */
export function composeShopifyPlan(job, rand = (min, max) => Math.floor(min + Math.random() * (max - min))) {
  const board = boardUrl(job);
  const words = String(job?.body || '').split(/\s+/).filter(Boolean).length;
  const steps = [];
  if (board) {
    steps.push({ type: 'open_board', url: board, bursts: rand(1, 4) });
    steps.push({ type: 'find_topic', maxScrolls: rand(3, 7) });
  }
  steps.push({ type: 'open_topic', url: topicUrl(job) });
  steps.push({ type: 'read_topic', seconds: rand(25, 70) });
  // A person rereads before sending, longer for a longer reply.
  steps.push({ type: 'reply', reviewSeconds: Math.min(20, 3 + Math.round(words / 25) + rand(0, 4)) });
  return steps;
}

/**
 * The words of a text, for "did the editor end up with what we meant".
 *
 * Lowercased letters and digits only. Markdown escaping, smart quotes, the
 * rich editor turning a blank line into a paragraph, a trailing newline — none
 * of those change the words, and all of them would fail an exact comparison of
 * text that is, to a reader, identical.
 */
export function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Does what the composer holds match what we meant to type? */
export function typedMatches(intended, actual) {
  return wordsOf(intended).length > 0 && wordsOf(intended) === wordsOf(actual);
}

/**
 * Discourse's refusal → a message for the job, marked as whether retrying the
 * same text later could work.
 *
 * `retryable` false means the text or the account has to change first — a
 * post a moderator would have to approve, one too similar to another, one from
 * an account the forum does not yet trust with links.
 */
export function classifyRefusal(message) {
  const m = String(message || '').replace(/\s+/g, ' ').trim();
  const rules = [
    [/too similar|identical|already posted|duplicate/i, 'The forum refused it as too similar to a post it already has.', false],
    [/new users? can only|new user|trust level|can't post links|cannot post links|links? in posts/i, "The forum's new-account limits refused it (links or reply count). The account needs more standing first.", false],
    [/too short|at least \d+ characters|body is too short/i, 'The forum refused it as too short.', false],
    [/wait|slow down|rate limit|too many|in \d+ (seconds|minutes)/i, 'The forum rate-limited the account. Try again later.', true],
    [/approv|moderat|queued for review|pending review/i, 'The forum accepted it for moderator review — it is not visible yet.', false],
    [/closed|archived|locked|not allowed to reply|can't reply|cannot reply/i, 'The thread no longer accepts replies.', false],
  ];
  for (const [re, text, retryable] of rules) if (re.test(m)) return { reason: `${text} ("${m.slice(0, 160)}")`, retryable };
  return { reason: m ? `The forum refused the post: "${m.slice(0, 200)}"` : 'The forum refused the post without saying why.', retryable: false };
}
