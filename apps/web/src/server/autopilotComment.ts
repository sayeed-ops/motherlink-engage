import 'server-only';

import { adminDb } from './admin';
import { callModel, LlmError } from '@/server/llm';
import { resolveModelForRun } from '@/server/llm/resolve';
import { getWarmupModel } from './agentControl';
import { allRecords, enqueueApprovedComment, fileScan, recentHistory } from './commentKarma';
import { accountPlatform } from '@/modules/accounts/platform';
import { accountCommentSettings } from '@/modules/forum/reply/settings';
import { CrawlzoError, createCrawlzoReader } from '@/modules/reddit/reader/crawlzo';
import { createRssDiscovery } from '@/modules/reddit/reader/rssDiscovery';
import { commentPairs } from '@/modules/reddit/commentKarma/pairs';
import { joinedCommunities } from '@/modules/reddit/joined';
import { normalizeCommunityList, normalizeKeywordList } from '@/modules/reddit/subreddits';
import { seenThreadIds } from '@/modules/forum/reply/drafts';
import { toDraftThread, type ScanOutcome } from '@/modules/forum/reply/pipeline';
import { paceWindow, rankDiscovered, screenDiscovered } from '@/modules/forum/reader/discovery';
import { judgeCandidate } from '@/modules/forum/reply/select';
import { profileRoom, targetLength, capLength } from '@/modules/forum/reply/roomProfile';
import { botTellPressure } from '@/modules/forum/reply/botTell';
import { buildGapPrompt, parseGapAnalysis, shouldProceed, type GapAnalysis } from '@/modules/forum/reply/gaps';
import { buildGenerationPrompt, parseCandidates } from '@/modules/forum/reply/generate';
import { screenBeforeGeneration, screenCandidates } from '@/modules/forum/reply/gates';
import { buildPickPrompt, parsePick, type PickOption } from '@/modules/forum/reply/autopilotPick';
import type { ThreadSnapshot } from '@/modules/forum/reader/types';

// The autopilot's comment: find five threads, write for each, post the best one.
//
// AUTOPILOT ONLY. "Look for a comment" on the Comment karma tab is untouched —
// one thread, the critic's choice, a person approves (server/commentKarma.ts).
// This is the flow the operator tried on the comment-trial page and approved
// (2026-10-26):
//
//   reader lane — every Comment community's feed at once (residential proxy,
//     free, not Crawlzo); free filters (age window, seen before, another of our
//     accounts already in it); then Crawlzo reads STRICTLY ONE AT A TIME until
//     WANT_THREADS threads from different communities pass every thread check.
//   writer lane — the AI on one thread at a time, starting as soon as the reader
//     hands one over, while the reader fetches the next: the gap, three
//     versions, the free checks. No per-thread critic.
//   final pick — one AI call sees every surviving version, each with its own
//     post and top replies, and chooses exactly one (./autopilotPick.ts).
//
// The account's own comment settings apply throughout, testing switches
// included (operator's choice). The chosen comment is filed and queued through
// enqueueApprovedComment like any approved comment — every rail still applies,
// plus the autopilot's one-account-per-thread check. The other threads are
// filed as skipped records, so no scan reads them again.
//
// TIME. This runs inside the 5-minute wake-check, which Vercel cuts off at 60 s.
// A trial run took ~55 s, so the run is budgeted: no new Crawlzo read after
// READ_UNTIL_MS, no new thread written after WRITE_UNTIL_MS, and the pick works
// with what is ready. A run cut off anyway leaves its slot "running" and the
// next check marks it failed (server/autopilot.ts).

export const WANT_THREADS = 5;
const MAX_READS = 15;
const READ_UNTIL_MS = 30_000;
const WRITE_UNTIL_MS = 42_000;
/** A pick needs a choice to make. */
const MIN_OPTIONS = 2;

const AUTOPILOT_ACTOR = { uid: 'autopilot', mayUseSharedKeys: true };

export interface AutopilotCommentResult {
  status: 'queued' | 'nothing' | 'refused' | 'dry-run';
  detail: string;
  draftId?: string;
  jobId?: string;
  stats: { ms: number; crawlzoReads: number; aiCalls: number; threads: number; options: number };
}

function shuffle<T>(a: T[], random: () => number): T[] {
  return a
    .map((x) => [random(), x] as const)
    .sort((p, q) => p[0] - q[0])
    .map((p) => p[1]);
}

/** `dryRun`: everything up to the pick, then stop — nothing filed, nothing
 *  queued. For checking the whole flow against real services. */
export async function runAutopilotComment(
  accountId: string,
  opts: { dryRun?: boolean; random?: () => number } = {},
): Promise<AutopilotCommentResult> {
  const random = opts.random ?? Math.random;
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  let aiCalls = 0;
  let crawlzoReads = 0;
  const stats = () => ({ ms: elapsed(), crawlzoReads, aiCalls, threads: options.length, options: options.reduce((n, o) => n + o.versions.length, 0) });
  const options: (PickOption & { gap: GapAnalysis; gapRefused: boolean; room: ScanOutcome['room']; trace: string[] })[] = [];

  const accSnap = await adminDb().collection('accounts').doc(accountId).get();
  const account = (accSnap.data() ?? {}) as Record<string, unknown>;
  if (accountPlatform(account) !== 'reddit') throw new Error('Comment karma is a Reddit routine.');
  const settings = accountCommentSettings(account.commentKarma);
  const pairs = commentPairs(normalizeCommunityList(account.warmupCommunities), normalizeKeywordList(account.warmupKeywords), joinedCommunities(account));
  if (!pairs.length) return { status: 'nothing', detail: 'No joined community is tagged Comment.', stats: stats() };

  const history = await recentHistory(accountId);
  const records = await allRecords(accountId);
  const seen = new Set([...seenThreadIds(records, Date.now())].map((id) => id.replace(/^t3_/i, '')));
  const pressure = botTellPressure(history);

  // The account's own rhythm, as the manual scan asks it — unless the testing
  // switch says to ignore it. Too much commenting overall stops the run; being
  // over-used in one community only drops that community.
  let usable = pairs;
  if (!settings.relax.ignoreBotTell) {
    const base = { length: { min: 0, max: 0, target: 0 }, profile: profileRoom([]), comments: [], history, bannedTerms: settings.bannedTerms };
    const verdicts = pairs.map((p) => ({ p, gate: screenBeforeGeneration({ ...base, subreddit: p.subreddit }, Date.now()) }));
    const stop = verdicts.find((v) => !v.gate.ok && v.gate.failures.some((f) => f.code !== 'sub-monotony'));
    if (stop) return { status: 'nothing', detail: stop.gate.failures.map((f) => f.detail).join('; '), stats: stats() };
    usable = verdicts.filter((v) => v.gate.ok).map((v) => v.p);
    if (!usable.length) return { status: 'nothing', detail: 'Every Comment community was over-used lately.', stats: stats() };
  }

  const model = await resolveModelForRun(AUTOPILOT_ACTOR, null, await getWarmupModel(), { requireJson: true });
  // A temporary failure (rate limit, provider error) is retried twice with a
  // growing wait; anything else fails at once.
  async function ask(input: { system: string; user: string; temperature: number; maxTokens: number }): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        aiCalls += 1;
        const { content } = await callModel(model, { ...input, json: true });
        return JSON.parse(content);
      } catch (e) {
        // The client wraps every provider answer as a 502 and quotes its code:
        // "returned 429" (rate limit) or a 5xx is worth waiting out; "returned
        // 401/400" (bad key, bad request) is not.
        const code = e instanceof LlmError ? Number(/returned (\d{3})/.exec(e.message)?.[1] ?? 0) : -1;
        const transient = code === 0 || code === 429 || code >= 500;
        if (!transient || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      }
    }
  }
  const discovery = createRssDiscovery();
  const reader = createCrawlzoReader();

  // ---- lane 1: the reader ----
  const queue: ThreadSnapshot[] = [];
  let readerDone = false;
  let wake: (() => void) | null = null;
  const handOver = (t: ThreadSnapshot) => {
    queue.push(t);
    wake?.();
  };

  async function readerLane() {
    try {
      const nowMs = Date.now();
      const limits = settings.limits;
      const perCommunity = (
        await Promise.all(
          shuffle(usable, random).map(async (p) => {
            const feed = settings.feeds[Math.floor(random() * settings.feeds.length)] ?? 'rising';
            const list = await discovery.list(p.subreddit, feed, 25).catch(() => []);
            const accountWindow = { minAgeMinutes: limits.minAgeMinutes, maxAgeHours: limits.maxAgeHours };
            const window = settings.adaptWindow ? paceWindow(list, accountWindow, nowMs) : { ...accountWindow, medianAgeHours: 0 };
            const inRange = rankDiscovered(list.filter((post) => !screenDiscovered(post, nowMs, window)));
            return {
              subreddit: p.subreddit,
              posts: inRange.filter((post) => !seen.has(post.redditPostId.replace(/^t3_/i, ''))),
              limits: { ...limits, minAgeMinutes: window.minAgeMinutes, maxAgeHours: window.maxAgeHours },
            };
          }),
        )
      ).filter((c) => c.posts.length);

      // Round-robin, one thread per community.
      const order: { c: (typeof perCommunity)[number]; id: string }[] = [];
      for (let i = 0; i < 25; i += 1) for (const c of perCommunity) if (c.posts[i]) order.push({ c, id: c.posts[i].redditPostId });
      const used = new Set<string>();
      let accepted = 0;
      for (const { c, id } of order) {
        if (accepted >= WANT_THREADS || crawlzoReads >= MAX_READS || elapsed() > READ_UNTIL_MS) break;
        if (used.has(c.subreddit)) continue;
        // Free: another of our accounts already in this thread?
        const same = await adminDb().collection('jobs').where('redditPostId', '==', id.replace(/^t3_/i, '')).get();
        if (same.docs.some((d) => d.get('accountId') !== accountId && !['failed', 'cancelled'].includes(String(d.get('status'))))) continue;
        crawlzoReads += 1;
        let thread: ThreadSnapshot | null;
        try {
          thread = await reader.getThread(id);
        } catch (e) {
          // A passing failure skips this thread; a hard one (bad key, no credit)
          // ends reading — the writer still finishes what it was given.
          if (e instanceof CrawlzoError && e.retryable) continue;
          throw e;
        }
        if (!thread) continue;
        const verdict = judgeCandidate({ post: thread.post, comments: thread.comments, baseline: null, nowMs: Date.now(), limits: c.limits });
        if (!verdict.ok) continue;
        used.add(c.subreddit);
        accepted += 1;
        handOver(thread);
      }
    } finally {
      readerDone = true;
      wake?.();
    }
  }

  // ---- lane 2: the writer ----
  async function writerLane() {
    for (;;) {
      if (!queue.length) {
        if (readerDone) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
        continue;
      }
      const thread = queue.shift() as ThreadSnapshot;
      if (elapsed() > WRITE_UNTIL_MS) continue; // out of time: leave the pick enough room
      try {
        const profile = profileRoom(thread.comments);
        const length = capLength(targetLength(profile), pressure.lengthCeiling);
        const gap = parseGapAnalysis(await ask({ ...buildGapPrompt(thread, profile), temperature: 0.2, maxTokens: 600 }));
        const gapRefused = !gap || !shouldProceed(gap);
        if (gapRefused && !settings.relax.ignoreGap) continue;
        const effectiveGap: GapAnalysis = gap?.angle
          ? gap
          : {
              posterWant: gap?.posterWant ?? 'opinions',
              delivered: gap?.delivered ?? '',
              gapState: gap?.gapState ?? 'absent',
              angle: 'say something ordinary that a person reading this thread might say',
              targetCommentId: null,
              confidence: gap?.confidence ?? 0,
            };
        const candidates = parseCandidates(
          await ask({
            ...buildGenerationPrompt(thread, profile, effectiveGap, settings.persona, length, { avoidOpenings: pressure.avoidOpenings }),
            temperature: 0.95,
            maxTokens: 900,
          }),
        );
        const ctx = { length, profile, comments: thread.comments, subreddit: thread.post.subreddit, history, bannedTerms: settings.bannedTerms };
        const { survivors } = screenCandidates(candidates.map((c) => c.text), ctx, { ignoreBotTell: settings.relax.ignoreBotTell });
        if (!survivors.length) continue;
        options.push({
          thread,
          versions: survivors.map((s) => s.text),
          gap: effectiveGap,
          gapRefused,
          room: { sampleSize: profile.sampleSize, medianWinnerWords: profile.medianWinnerWords, min: length.min, max: length.max, target: length.target },
          trace: [`autopilot: wrote ${candidates.length}, ${survivors.length} passed the checks`],
        });
      } catch {
        // One thread failing (the AI unavailable after retries, an answer that
        // would not parse) never stops the others; the pick uses what is left.
      }
    }
  }

  await Promise.all([readerLane(), writerLane()]);
  if (options.length < MIN_OPTIONS) {
    return { status: 'nothing', detail: `Only ${options.length} thread(s) gave a usable comment — at least ${MIN_OPTIONS} are needed to choose from.`, stats: stats() };
  }

  // ---- the final pick ----
  const pick = parsePick(await ask({ ...buildPickPrompt(options, settings.persona), temperature: 0.1, maxTokens: 600 }), options);
  if (!pick) return { status: 'nothing', detail: 'The final pick did not name one of the options.', stats: stats() };
  if (opts.dryRun) {
    const o = options[pick.option];
    return { status: 'dry-run', detail: `r/${o.thread.post.subreddit} — ${o.versions[pick.version]} — WHY: ${pick.reason}`, stats: stats() };
  }

  // File every thread, so none is read again: the chosen one as approved by the
  // autopilot, the others as skipped with the reason.
  const record = (o: (typeof options)[number], text: string, produced: boolean, reason: string): ScanOutcome => ({
    produced,
    skipStage: produced ? null : 'critic',
    skipReason: reason,
    thread: toDraftThread(o.thread),
    text,
    words: text.trim().split(/\s+/).filter(Boolean).length,
    gap: { posterWant: o.gap.posterWant, gapState: o.gap.gapState, angle: o.gap.angle, targetCommentId: o.gap.targetCommentId, confidence: o.gap.confidence },
    room: o.room,
    criticReason: produced ? pick.reason : '',
    rejected: [],
    relaxed: o.gapRefused,
    exploratory: false,
    trace: [...o.trace, produced ? `autopilot pick: ${pick.reason}` : 'autopilot pick: another thread was chosen'],
  });
  let draftId = '';
  for (let i = 0; i < options.length; i += 1) {
    const o = options[i];
    if (i === pick.option) {
      draftId = await fileScan(accountId, settings, 'Autopilot', record(o, o.versions[pick.version], true, ''), true);
    } else {
      await fileScan(accountId, settings, 'Autopilot', record(o, o.versions[0], false, 'The autopilot posted a comment in another thread.'));
    }
  }

  const enqueue = await enqueueApprovedComment(accountId, draftId, { uid: AUTOPILOT_ACTOR.uid, name: 'Autopilot', autopilot: true });
  const chosen = options[pick.option].thread.post;
  return enqueue.queued
    ? { status: 'queued', detail: `r/${chosen.subreddit} — chosen from ${options.length} threads`, draftId, jobId: enqueue.jobId ?? '', stats: stats() }
    : { status: 'refused', detail: enqueue.reason || 'Not queued.', draftId, stats: stats() };
}
