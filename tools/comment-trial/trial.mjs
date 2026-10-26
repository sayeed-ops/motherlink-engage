// The proposed autopilot comment flow, as one function — for the comment-trial
// page. READ-ONLY: nothing is written to Engage's database (no draft, no "seen"
// mark, no job), nothing is posted. It reads the account and its records, the
// community feeds (residential proxy), threads (Crawlzo), and calls the AI.
//
// The flow:
//   reader lane — every feed at once (proxy, free); free filters (age window,
//     seen before, another of our accounts in it); then Crawlzo reads ONE AT A
//     TIME until 5 threads from 5 different communities pass every thread check.
//   writer lane — the AI on one thread at a time, starting as soon as the reader
//     hands one over: the gap, then 3 versions, then the free checks.
//   final pick — one AI call sees every surviving version with its own post and
//     top replies, and picks the single one to post.

import { adminDb } from '../../apps/web/src/server/admin.ts';
import { callModel, LlmError } from '../../apps/web/src/server/llm/index.ts';
import { resolveModelForRun } from '../../apps/web/src/server/llm/resolve.ts';
import { getWarmupModel } from '../../apps/web/src/server/agentControl.ts';
import { createCrawlzoReader } from '../../apps/web/src/modules/reddit/reader/crawlzo.ts';
import { createRssDiscovery } from '../../apps/web/src/modules/reddit/reader/rssDiscovery.ts';
import { accountCommentSettings } from '../../apps/web/src/modules/forum/reply/settings.ts';
import { commentPairs } from '../../apps/web/src/modules/reddit/commentKarma/pairs.ts';
import { joinedCommunities } from '../../apps/web/src/modules/reddit/joined.ts';
import { normalizeCommunityList, normalizeKeywordList } from '../../apps/web/src/modules/reddit/subreddits.ts';
import { normalizeDraft, seenThreadIds } from '../../apps/web/src/modules/forum/reply/drafts.ts';
import { historyFromPosted } from '../../apps/web/src/modules/forum/reply/pipeline.ts';
import { paceWindow, rankDiscovered, screenDiscovered } from '../../apps/web/src/modules/forum/reader/discovery.ts';
import { judgeCandidate } from '../../apps/web/src/modules/forum/reply/select.ts';
import { profileRoom, targetLength, capLength } from '../../apps/web/src/modules/forum/reply/roomProfile.ts';
import { botTellPressure } from '../../apps/web/src/modules/forum/reply/botTell.ts';
import { buildGapPrompt, parseGapAnalysis, shouldProceed } from '../../apps/web/src/modules/forum/reply/gaps.ts';
import { buildGenerationPrompt, parseCandidates } from '../../apps/web/src/modules/forum/reply/generate.ts';
import { screenCandidates } from '../../apps/web/src/modules/forum/reply/gates.ts';

export const WANT_THREADS = 5;
export const MAX_READS = 15;

const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
const trimTo = (s, n) => {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

/** Reddit accounts with somewhere to comment, for the page's dropdown. */
export async function listAccounts() {
  const snap = await adminDb().collection('accounts').get();
  return snap.docs
    .map((d) => {
      const a = d.data();
      const pairs = commentPairs(normalizeCommunityList(a.warmupCommunities), normalizeKeywordList(a.warmupKeywords), joinedCommunities(a));
      return { label: String(a.label ?? d.id), platform: a.platform ?? 'reddit', communities: pairs.length };
    })
    .filter((a) => a.platform === 'reddit')
    .sort((x, y) => y.communities - x.communities || x.label.localeCompare(y.label));
}

export function pickSystem(persona) {
  const who = persona?.situation?.trim() || persona?.topics?.length
    ? `This account is: ${persona.situation?.trim() || '(no situation given)'}${persona.topics?.length ? `; it knows about ${persona.topics.join(', ')}` : ''}${persona.neverClaims?.length ? `; it must never claim to be ${persona.neverClaims.join(', ')}` : ''}.`
    : 'This account has no stated background, job or family.';
  return `You are choosing ONE Reddit comment to post, from comments written for several different threads. You are NOT writing or editing anything.

For each thread you see the original post, its top replies, and the candidate comments written for it.

${who}

Choose the single comment that is:
1. Most relevant to ITS OWN thread — it responds to what this poster actually wrote and wants, not a generic remark that would fit anywhere.
2. Most like a real person in that community wrote it — natural, specific, the length and tone of the replies there; nothing that reads as performed helpfulness or as written by an AI.
3. The least risky — no claim it could not defend; no personal experience, job, family or expertise this account has not been given; nothing that starts an argument; no advice to someone who did not ask for it; nothing that repeats what a top reply already said.

You must choose exactly one. Do not rewrite, combine or edit.

Every candidate has a label like "3.2" (thread 3, candidate 2). Answer with that label exactly as shown.

Output STRICT JSON: {"choice": "<label, e.g. 3.2>", "reason": "<two sentences: why this one, and what made the others worse>", "ranking": ["<label>", ... best to worst, all of them]}. No prose, no markdown.`;
}

/** "3.2", "(3.2)", 3.2, or the older {thread, candidate} shape → [thread, candidate].
 *  The first answer format asked for the two numbers separately and the model
 *  wrote the thread as "3.3" — one label is what it naturally reaches for. */
export function parseChoice(raw) {
  const fromLabel = (v) => {
    const m = String(v ?? '').match(/(\d+)\s*\.\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  if (raw?.choice !== undefined) return fromLabel(raw.choice);
  // Older shape: the thread is the FIRST number of whatever it wrote ("3.3" →
  // 3), and a separate candidate number wins over anything after the dot.
  const th = Number(String(raw?.thread ?? '').match(/\d+/)?.[0]);
  const c = Number(raw?.candidate);
  if (Number.isInteger(th) && Number.isInteger(c)) return [th, c];
  return fromLabel(raw?.thread);
}

export async function runTrial(label) {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const events = [];
  const note = (lane, text) => events.push({ atMs: ms(), lane, text });
  const phases = {};

  // ---- the account, read only ----
  const accSnap = (await adminDb().collection('accounts').where('label', '==', label).get()).docs[0];
  if (!accSnap) throw new Error(`No account "${label}".`);
  const account = accSnap.data();
  const settings = accountCommentSettings(account.commentKarma);
  const pairs = commentPairs(normalizeCommunityList(account.warmupCommunities), normalizeKeywordList(account.warmupKeywords), joinedCommunities(account));
  if (!pairs.length) throw new Error(`${label} has no joined community tagged Comment.`);
  const records = (await accSnap.ref.collection('commentDrafts').orderBy('createdAtMs', 'desc').limit(200).get()).docs
    .map((d) => normalizeDraft(d.id, d.data()))
    .filter(Boolean);
  const seen = new Set([...seenThreadIds(records, Date.now())].map((id) => id.replace(/^t3_/i, '')));
  const history = historyFromPosted(
    records
      .filter((d) => d.thread && d.status === 'posted')
      .slice(0, 20)
      .map((d) => ({ text: d.text, subreddit: d.thread.subreddit, postedAtMs: d.postedAtMs ?? d.reviewedAtMs ?? d.createdAtMs })),
  );
  const pressure = botTellPressure(history);
  note('setup', `${pairs.length} joined Comment communities · ${seen.size} threads looked at before · ${history.length} posted comments in history`);

  const model = await resolveModelForRun({ uid: 'autopilot', mayUseSharedKeys: true }, null, await getWarmupModel(), { requireJson: true });
  let aiCalls = 0;
  let retries = 0;
  async function ask({ system, user, temperature, maxTokens }) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        aiCalls += 1;
        const { content } = await callModel(model, { system, user, temperature, maxTokens, json: true });
        return JSON.parse(content);
      } catch (e) {
        const transient = e instanceof LlmError && (e.status === 429 || e.status >= 500);
        if (!transient || attempt >= 2) throw e;
        retries += 1;
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
  }
  const discovery = createRssDiscovery();
  const reader = createCrawlzoReader();

  // ---- lane 1: the reader ----
  const queue = [];
  let readerDone = false;
  let wake = null;
  const push = (x) => {
    queue.push(x);
    wake?.();
  };
  const feeds = [];
  const reads = [];
  let crawlzoReads = 0;

  async function readerLane() {
    const nowMs = Date.now();
    const limits = settings.limits;
    // Free and not Crawlzo: every feed at the same time, through the proxy.
    const tFeeds = Date.now();
    const perCommunity = (
      await Promise.all(
        shuffle(pairs).map(async (p) => {
          const feed = settings.feeds[Math.floor(Math.random() * settings.feeds.length)] ?? 'rising';
          let list = [];
          try {
            list = await discovery.list(p.subreddit, feed, 25);
          } catch (e) {
            feeds.push({ subreddit: p.subreddit, feed, error: e.message });
            return null;
          }
          const accountWindow = { minAgeMinutes: limits.minAgeMinutes, maxAgeHours: limits.maxAgeHours };
          const window = settings.adaptWindow ? paceWindow(list, accountWindow, nowMs) : { ...accountWindow, medianAgeHours: 0 };
          const inRange = rankDiscovered(list.filter((post) => !screenDiscovered(post, nowMs, window)));
          const unseen = inRange.filter((post) => !seen.has(post.redditPostId.replace(/^t3_/i, '')));
          feeds.push({ subreddit: p.subreddit, feed, posts: list.length, inWindow: inRange.length, unseen: unseen.length, window: `${window.minAgeMinutes}m–${Math.round(window.maxAgeHours)}h` });
          return { subreddit: p.subreddit, posts: unseen, limits: { ...limits, minAgeMinutes: window.minAgeMinutes, maxAgeHours: window.maxAgeHours } };
        }),
      )
    ).filter(Boolean);
    phases.feedsMs = Date.now() - tFeeds;
    note('reader', `${feeds.length} feeds read at once in ${(phases.feedsMs / 1000).toFixed(1)}s (free)`);

    // Round-robin, one thread per community, Crawlzo strictly one at a time.
    const order = [];
    for (let i = 0; i < 25; i += 1) for (const c of perCommunity) if (c.posts[i]) order.push({ c, post: c.posts[i] });
    const used = new Set();
    let accepted = 0;
    for (const { c, post } of order) {
      if (accepted >= WANT_THREADS || crawlzoReads >= MAX_READS) break;
      if (used.has(c.subreddit)) continue;
      const other = (await adminDb().collection('jobs').where('redditPostId', '==', post.redditPostId).get()).docs.find(
        (d) => d.get('accountId') !== accSnap.id && !['failed', 'cancelled'].includes(d.get('status')),
      );
      if (other) {
        reads.push({ subreddit: c.subreddit, id: post.redditPostId, result: 'another of our accounts is in it (free skip)' });
        continue;
      }
      crawlzoReads += 1;
      const tRead = Date.now();
      const thread = await reader.getThread(post.redditPostId);
      if (!thread) {
        reads.push({ subreddit: c.subreddit, id: post.redditPostId, result: 'gone', ms: Date.now() - tRead });
        continue;
      }
      const verdict = judgeCandidate({ post: thread.post, comments: thread.comments, baseline: null, nowMs: Date.now(), limits: c.limits });
      reads.push({ subreddit: c.subreddit, id: post.redditPostId, title: thread.post.title, result: verdict.ok ? 'accepted' : `rejected — ${verdict.reason}`, ms: Date.now() - tRead });
      note('reader', `Crawlzo read #${crawlzoReads} r/${c.subreddit} → ${verdict.ok ? 'accepted' : verdict.reason}`);
      if (!verdict.ok) continue;
      used.add(c.subreddit);
      accepted += 1;
      push(thread);
    }
    readerDone = true;
    wake?.();
  }

  // ---- lane 2: the writer ----
  const written = [];
  async function writerLane() {
    for (;;) {
      if (!queue.length) {
        if (readerDone) return;
        await new Promise((r) => (wake = r));
        wake = null;
        continue;
      }
      const thread = queue.shift();
      const sub = thread.post.subreddit;
      const tw = Date.now();
      try {
        const profile = profileRoom(thread.comments);
        const length = capLength(targetLength(profile), pressure.lengthCeiling);
        const gap = parseGapAnalysis(await ask({ ...buildGapPrompt(thread, profile), temperature: 0.2, maxTokens: 600 }));
        const gapOk = !!gap && shouldProceed(gap);
        if (!gapOk && !settings.relax.ignoreGap) {
          written.push({ thread, gap, dropped: 'no gap worth filling', ms: Date.now() - tw });
          note('writer', `r/${sub}: no gap — dropped`);
          continue;
        }
        const effectiveGap = gap?.angle
          ? gap
          : { posterWant: gap?.posterWant ?? 'opinions', delivered: gap?.delivered ?? '', gapState: gap?.gapState ?? 'absent', angle: 'say something ordinary that a person reading this thread might say', targetCommentId: null, confidence: gap?.confidence ?? 0 };
        const candidates = parseCandidates(
          await ask({ ...buildGenerationPrompt(thread, profile, effectiveGap, settings.persona, length, { avoidOpenings: pressure.avoidOpenings }), temperature: 0.95, maxTokens: 900 }),
        );
        const ctx = { length, profile, comments: thread.comments, subreddit: sub, history, bannedTerms: settings.bannedTerms };
        const { survivors, rejected } = screenCandidates(candidates.map((c) => c.text), ctx, { ignoreBotTell: settings.relax.ignoreBotTell });
        written.push({
          thread,
          gap: effectiveGap,
          gapOk,
          room: { winners: profile.sampleSize, words: profile.medianWinnerWords, min: length.min, max: length.max },
          survivors: survivors.map((s) => s.text),
          rejected: rejected.map((r) => ({ text: r.text, why: r.failures.map((f) => f.code).join(', ') })),
          ms: Date.now() - tw,
        });
        note('writer', `r/${sub}: ${candidates.length} written, ${survivors.length} passed the checks (${((Date.now() - tw) / 1000).toFixed(1)}s)`);
      } catch (e) {
        written.push({ thread, dropped: `error: ${e.message}`, ms: Date.now() - tw });
        note('writer', `r/${sub}: failed — ${e.message}`);
      }
    }
  }

  const tLanes = Date.now();
  await Promise.all([readerLane(), writerLane()]);
  phases.lanesMs = Date.now() - tLanes;

  // ---- the final pick ----
  const options = written.filter((w) => w.survivors?.length);
  let pick = null;
  let pickError = '';
  if (options.length >= 2) {
    const user = options
      .map((w, i) =>
        [
          `=== THREAD ${i + 1} — r/${w.thread.post.subreddit} ===`,
          `TITLE: ${trimTo(w.thread.post.title, 300)}`,
          w.thread.post.body?.trim() ? `BODY: ${trimTo(w.thread.post.body, 1200)}` : 'BODY: (none — the title is the whole post)',
          'TOP REPLIES:',
          w.thread.comments.length ? w.thread.comments.slice(0, 5).map((c, k) => `[${k + 1}] score=${c.score}: ${trimTo(c.body, 300)}`).join('\n') : '(no replies yet)',
          'CANDIDATES:',
          ...w.survivors.map((t, k) => `(${i + 1}.${k + 1}) ${t}`),
        ].join('\n'),
      )
      .join('\n\n');
    const tPick = Date.now();
    try {
      const raw = await ask({ system: pickSystem(settings.persona), user: `${user}\n\nRespond with JSON only.`, temperature: 0.1, maxTokens: 600 });
      const [t, c] = parseChoice(raw) ?? [0, 0];
      const w = options[t - 1];
      if (!w || !w.survivors[c - 1]) pickError = `The picker answered ${JSON.stringify(raw?.choice ?? raw?.thread)}, which is not one of the options.`;
      else pick = { thread: t, candidate: c, reason: String(raw.reason ?? ''), ranking: Array.isArray(raw.ranking) ? raw.ranking.map(String) : [] };
    } catch (e) {
      pickError = e.message;
    }
    phases.pickMs = Date.now() - tPick;
  } else {
    pickError = `Only ${options.length} thread(s) produced a usable comment — at least 2 are needed for a pick.`;
  }

  return {
    label,
    model: `${model.provider} ${model.providerModelId ?? ''}`.trim(),
    switches: settings.relax,
    totalMs: ms(),
    phases,
    crawlzoReads,
    aiCalls,
    retries,
    feeds,
    reads,
    events,
    threads: options.map((w, i) => ({
      n: i + 1,
      subreddit: w.thread.post.subreddit,
      title: w.thread.post.title,
      // The whole thread as it was read — the full post and every top-level reply
      // (Crawlzo returns top-level only, best first) — to compare the comment to.
      body: String(w.thread.post.body ?? ''),
      author: w.thread.post.author,
      score: w.thread.post.score,
      numComments: w.thread.post.numComments,
      ageHours: Math.round(((Date.now() - w.thread.post.createdAtMs) / 3_600_000) * 10) / 10,
      url: w.thread.post.permalink ? `https://www.reddit.com${w.thread.post.permalink}` : `https://www.reddit.com/comments/${w.thread.post.redditPostId ?? ''}`,
      replies: w.thread.comments.map((c) => ({ author: c.author, score: c.score, isOp: c.isOp, replyCount: c.replyCount, body: String(c.body ?? '') })),
      /** How many of the replies the picker was shown (the top ones). */
      repliesShownToPicker: Math.min(5, w.thread.comments.length),
      gap: { wants: w.gap.posterWant, state: w.gap.gapState, angle: w.gap.angle, real: w.gapOk },
      room: w.room,
      options: w.survivors,
      rejected: w.rejected,
      ms: w.ms,
    })),
    dropped: written.filter((w) => !w.survivors?.length).map((w) => ({ subreddit: w.thread.post.subreddit, title: w.thread.post.title, why: w.dropped ?? 'every version failed the checks', rejected: w.rejected ?? [] })),
    pick,
    pickError,
  };
}
