// One scan: from "which community" to either a comment or a reason there isn't
// one.
//
// PURE, by dependency injection. It takes a RedditReader and an `ask` function
// and returns a plain outcome — no Firestore, no fetch, no clock of its own, no
// 'server-only'. server/commentKarma.ts is the thin part that supplies a Crawlzo
// reader, a resolved model credential and a document to write. The whole
// sequence is therefore testable against the fixture reader and a scripted
// model, which matters because this is where every earlier phase finally has to
// agree with the others.
//
// THE ORDER IS THE COST MODEL. Read it as a funnel that spends progressively:
//
//   free      pick a community the account is not over-using
//   free      the account's own timing
//   1 call    search (billed)
//   free      screenListing over the results
//   n calls   read threads until one survives judgeCandidate (billed, early exit)
//   free      profile the room, derive the length band
//   1 model   the gap: is there anything worth saying
//   1 model   write three
//   free      gate all three
//   1 model   the critic: pick one, or none
//   free      gate the chosen one again
//
// Every stage can end the scan, and most scans end early. That is the design
// working, not a fault — see SkipStage in ./drafts.ts.

import type { PostSummary, RedditReader, ThreadSnapshot } from '../reader/types';
import { botTellPressure, historyEntryOf, type CommentHistoryEntry } from './botTell';
import { chosenCandidate, buildCriticPrompt, parseCriticVerdict } from './critic';
import type { DraftGap, DraftRejection, DraftRoom, DraftThread, SkipStage } from './drafts';
import { buildGenerationPrompt, parseCandidates } from './generate';
import { buildGapPrompt, parseGapAnalysis, shouldProceed } from './gaps';
import { runGates, screenCandidates, screenBeforeGeneration, type GateContext } from './gates';
import { profileRoom, targetLength, countWords } from './roomProfile';
import {
  DEFAULT_LIMITS,
  judgeCandidate,
  screenListing,
  type SelectLimits,
  type SubBaseline,
} from './select';
import type { CommentKarmaSettings } from './settings';

export interface AskInput {
  system: string;
  user: string;
  /** Low for judgement, high for writing. Variety is wanted in exactly one
   *  place, and a critic that answers differently on the same input twice is
   *  not a check. */
  temperature: number;
  maxTokens: number;
}

export interface ScanDeps {
  reader: RedditReader;
  /** Call a model and return its parsed JSON. Throws on transport, credential
   *  or JSON failures — the caller turns that into an 'error' record, because a
   *  fault must never be filed alongside the deliberate skips. */
  ask(input: AskInput): Promise<unknown>;
  nowMs: number;
  /** Injected so a scan is reproducible under test. Never called during a
   *  render — this only ever runs server-side, inside a request. */
  random?: () => number;
}

export interface CommunityKeywords {
  subreddit: string;
  keywords: string[];
}

export interface ScanInput {
  settings: CommentKarmaSettings;
  /** The Comment-tagged communities and their keywords, from the Communities
   *  tab. Search is the only way in — Crawlzo has no listing endpoint and its
   *  `query` is required — so an account with no keywords cannot look anywhere.
   *  See docs/CRAWLZO-API.md. */
  pairs: CommunityKeywords[];
  /** This account's recent comments, newest anywhere in the array. */
  history: CommentHistoryEntry[];
  /** Per-subreddit pace baselines, when we have them. Missing is normal and
   *  must not reject everything. */
  baselines?: Record<string, SubBaseline>;
  limits?: SelectLimits;
}

export interface ScanOutcome {
  produced: boolean;
  skipStage: SkipStage | null;
  skipReason: string;
  thread: DraftThread | null;
  text: string | null;
  words: number;
  gap: DraftGap | null;
  room: DraftRoom | null;
  criticReason: string;
  rejected: DraftRejection[];
  /** What happened, in order. The only record of a scan that produced nothing,
   *  and the same argument as the approach trace on a warm-up job: the plan is
   *  intent, the trace is what actually happened. */
  trace: string[];
}

/** How many searches one scan may pay for before giving up. */
const MAX_SEARCHES = 2;

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pick<T>(items: T[], random: () => number): T | undefined {
  return items.length ? items[Math.floor(random() * items.length)] : undefined;
}

function toDraftThread(snapshot: ThreadSnapshot): DraftThread {
  const { post } = snapshot;
  return {
    redditPostId: post.redditPostId,
    subreddit: post.subreddit,
    title: post.title,
    permalink: post.permalink,
    threadUrl: post.permalink.startsWith('http')
      ? post.permalink
      : `https://www.reddit.com${post.permalink.startsWith('/') ? '' : '/'}${post.permalink}`,
    postCreatedAtMs: post.createdAtMs,
    score: post.score,
    numComments: post.numComments,
    fetchedAtMs: snapshot.fetchedAtMs,
  };
}

function stop(
  trace: string[],
  skipStage: SkipStage,
  skipReason: string,
  extra: Partial<ScanOutcome> = {},
): ScanOutcome {
  trace.push(`stop: ${skipStage} — ${skipReason}`);
  return {
    produced: false,
    skipStage,
    skipReason,
    thread: null,
    text: null,
    words: 0,
    gap: null,
    room: null,
    criticReason: '',
    rejected: [],
    trace,
    ...extra,
  };
}

/**
 * Run one scan.
 *
 * Never throws for a judgement — a scan that decides not to comment returns an
 * outcome saying so. It DOES propagate a fault from the reader or the model,
 * because "Crawlzo is unauthorised" is not the same fact as "no thread was worth
 * entering", and filing one as the other would make an outage look like the
 * gates doing their job.
 */
export async function scanForComment(deps: ScanDeps, input: ScanInput): Promise<ScanOutcome> {
  const random = deps.random ?? Math.random;
  const limits = input.limits ?? DEFAULT_LIMITS;
  const trace: string[] = [];

  const usable = input.pairs.filter((p) => p.subreddit.trim() && p.keywords.length);
  if (!usable.length) {
    return stop(trace, 'search', 'No Comment-tagged community has a keyword to search for.');
  }

  // --- the account's own rhythm, before anything is paid for ----------------
  // Sub-monotony depends on where we are going, so it is asked per community:
  // "this account has been in r/x eight times running" is a reason to go
  // elsewhere, not a reason to stop. Cadence and clock are about the account
  // itself and end the scan wherever it was headed.
  const baseCtx: Omit<GateContext, 'subreddit'> = {
    length: { min: 0, max: 0, target: 0 },
    profile: profileRoom([]),
    comments: [],
    history: input.history,
    bannedTerms: input.settings.bannedTerms,
  };

  let chosen: CommunityKeywords | null = null;
  let timingReason = '';
  for (const candidate of shuffle(usable, random)) {
    const gate = screenBeforeGeneration({ ...baseCtx, subreddit: candidate.subreddit }, deps.nowMs);
    if (gate.ok) {
      chosen = candidate;
      break;
    }
    timingReason = gate.failures.map((f) => f.detail).join('; ');
    if (gate.failures.some((f) => f.code !== 'sub-monotony')) {
      return stop(trace, 'timing', timingReason);
    }
    trace.push(`skipped r/${candidate.subreddit}: ${timingReason}`);
  }
  if (!chosen) return stop(trace, 'timing', timingReason || 'Every community was over-used.');

  // --- search (billed) ------------------------------------------------------
  const pressure = botTellPressure(input.history);
  const found: PostSummary[] = [];
  const tried: string[] = [];
  for (let i = 0; i < MAX_SEARCHES && !found.length; i++) {
    const keyword = pick(
      chosen.keywords.filter((k) => !tried.includes(k)),
      random,
    );
    if (!keyword) break;
    tried.push(keyword);
    trace.push(`search r/${chosen.subreddit} "${keyword}"`);
    const posts = await deps.reader.search(chosen.subreddit, keyword, { sort: 'new', time: 'day', limit: 25 });
    trace.push(`  ${posts.length} result(s)`);
    found.push(...posts);
  }
  if (!found.length) {
    return stop(trace, 'search', `Nothing recent in r/${chosen.subreddit} for ${tried.join(', ') || 'any keyword'}.`);
  }

  // --- the free screen ------------------------------------------------------
  const baseline = input.baselines?.[chosen.subreddit] ?? null;
  const rejects = new Map<string, number>();
  const survivors: PostSummary[] = [];
  for (const post of found) {
    const reason = screenListing(post, deps.nowMs, baseline, limits);
    if (reason) {
      rejects.set(reason, (rejects.get(reason) ?? 0) + 1);
      continue;
    }
    survivors.push(post);
  }
  trace.push(`screen: ${survivors.length} of ${found.length} survived`);
  if (!survivors.length) {
    const summary = [...rejects.entries()].map(([r, n]) => `${r}×${n}`).join(', ');
    return stop(trace, 'screen', `All ${found.length} posts were rejected on listing data (${summary}).`);
  }

  // Rank on what the listing can tell us — the paid reads then start with the
  // most promising rather than the first.
  const ranked = survivors
    .map((post) => {
      const ageHours = Math.max((deps.nowMs - post.createdAtMs) / 3_600_000, 0.25);
      return { post, rough: post.score / ageHours / Math.max(1, post.numComments) };
    })
    .sort((a, b) => b.rough - a.rough)
    .map((r) => r.post);

  // --- read threads until one is worth entering (billed, early exit) --------
  // Early exit rather than reading them all and picking the best: the listing
  // screen has already ordered them, and every extra read is another charge —
  // including a 404 for a post deleted since the search.
  let snapshot: ThreadSnapshot | null = null;
  const judgeRejects: string[] = [];
  for (const post of ranked.slice(0, input.settings.maxThreadsPerScan)) {
    const thread = await deps.reader.getThread(post.redditPostId);
    if (!thread) {
      judgeRejects.push('gone');
      trace.push(`read ${post.redditPostId}: gone since the search`);
      continue;
    }
    const verdict = judgeCandidate({
      post: thread.post,
      comments: thread.comments,
      baseline,
      nowMs: deps.nowMs,
      limits,
    });
    trace.push(
      `read ${post.redditPostId}: ${verdict.ok ? `ok (score ${verdict.score.toFixed(2)})` : `rejected — ${verdict.reason}`}`,
    );
    if (verdict.ok) {
      snapshot = thread;
      break;
    }
    judgeRejects.push(verdict.reason ?? 'unknown');
  }
  if (!snapshot) {
    return stop(trace, 'judge', `Read ${judgeRejects.length} thread(s), none worth entering (${judgeRejects.join(', ')}).`);
  }

  const draftThread = toDraftThread(snapshot);

  // --- the room, measured ---------------------------------------------------
  const profile = profileRoom(snapshot.comments);
  const band = targetLength(profile);
  // The bot-tell gate narrows the band when this account's recent comments are
  // too alike. Narrowing BEFORE generation is cheaper than rejecting after, and
  // it is the mechanism that makes the account occasionally brief on purpose.
  const length = pressure.lengthCeiling
    ? { ...band, max: Math.min(band.max, pressure.lengthCeiling), target: Math.min(band.target, pressure.lengthCeiling) }
    : band;
  const room: DraftRoom = {
    sampleSize: profile.sampleSize,
    medianWinnerWords: profile.medianWinnerWords,
    min: length.min,
    max: length.max,
    target: length.target,
  };
  trace.push(`room: ${profile.sampleSize} winners, ${profile.medianWinnerWords} words median, band ${length.min}–${length.max}`);

  const ctx: GateContext = {
    length,
    profile,
    comments: snapshot.comments,
    subreddit: draftThread.subreddit,
    history: input.history,
    bannedTerms: input.settings.bannedTerms,
  };

  // --- the gap (model) ------------------------------------------------------
  const gapPrompt = buildGapPrompt(snapshot, profile);
  const gap = parseGapAnalysis(
    // Low temperature: this is a judgement, and a judgement that varies run to
    // run is not one.
    await deps.ask({ ...gapPrompt, temperature: 0.2, maxTokens: 600 }),
  );
  if (!gap || !shouldProceed(gap)) {
    trace.push(`gap: ${gap ? `${gap.gapState} (confidence ${gap.confidence})` : 'unparseable'}`);
    return stop(trace, 'gap', gap ? `Gap state "${gap.gapState}" — nothing worth adding.` : 'The gap analysis was unusable.', {
      thread: draftThread,
      room,
      gap: gap
        ? {
            posterWant: gap.posterWant,
            gapState: gap.gapState,
            angle: gap.angle,
            targetCommentId: gap.targetCommentId,
            confidence: gap.confidence,
          }
        : null,
    });
  }
  const draftGap: DraftGap = {
    posterWant: gap.posterWant,
    gapState: gap.gapState,
    angle: gap.angle,
    targetCommentId: gap.targetCommentId,
    confidence: gap.confidence,
  };
  trace.push(`gap: ${gap.posterWant} / ${gap.gapState} — ${gap.angle}`);

  // --- write three (model) --------------------------------------------------
  const genPrompt = buildGenerationPrompt(snapshot, profile, gap, input.settings.persona, length, {
    avoidOpenings: pressure.avoidOpenings,
  });
  const candidates = parseCandidates(
    // High temperature: this is the ONE place variety is wanted. Three attempts
    // at one temperature setting is three paraphrases.
    await deps.ask({ ...genPrompt, temperature: 0.95, maxTokens: 900 }),
  );
  trace.push(`wrote ${candidates.length} candidate(s)`);
  if (!candidates.length) {
    return stop(trace, 'generate', 'The model returned nothing usable.', { thread: draftThread, room, gap: draftGap });
  }

  // --- gate all of them (free) ---------------------------------------------
  const { survivors: passed, rejected } = screenCandidates(
    candidates.map((c) => c.text),
    ctx,
  );
  const rejectedRecords: DraftRejection[] = rejected.map((r) => ({ text: r.text, failures: r.failures }));
  trace.push(`gates: ${passed.length} of ${candidates.length} could be posted`);
  if (!passed.length) {
    return stop(trace, 'gates', 'Every candidate failed a check.', {
      thread: draftThread,
      room,
      gap: draftGap,
      rejected: rejectedRecords,
    });
  }

  // --- the critic (model) ---------------------------------------------------
  const survivorCandidates = passed.map((s) => ({ text: s.text, words: countWords(s.text) }));
  const verdict = parseCriticVerdict(
    await deps.ask({
      ...buildCriticPrompt(survivorCandidates, snapshot, gap, profile),
      temperature: 0.1,
      maxTokens: 400,
    }),
    survivorCandidates.length,
  );
  const winner = chosenCandidate(verdict, survivorCandidates);
  if (!winner) {
    trace.push(`critic: none — ${verdict.reason || 'no reason given'}`);
    return stop(trace, 'critic', verdict.reason || 'The critic chose none of them.', {
      thread: draftThread,
      room,
      gap: draftGap,
      criticReason: verdict.reason,
      rejected: rejectedRecords,
    });
  }

  // --- the last check -------------------------------------------------------
  // It passed these minutes ago as one of `passed`, so this is expected to be a
  // formality. It is here because the alternative is trusting an index through
  // three transformations, and the cost of being wrong is a comment that
  // skipped a gate.
  const final = runGates(winner.text, ctx);
  if (!final.ok) {
    trace.push('final gates: failed');
    return stop(trace, 'final-gates', final.failures.map((f) => `${f.code}: ${f.detail}`).join('; '), {
      thread: draftThread,
      room,
      gap: draftGap,
      criticReason: verdict.reason,
      rejected: [...rejectedRecords, { text: winner.text, failures: final.failures }],
    });
  }

  trace.push(`chose a ${winner.words}-word comment — ${verdict.reason}`);
  return {
    produced: true,
    skipStage: null,
    skipReason: '',
    thread: draftThread,
    text: winner.text,
    words: winner.words,
    gap: draftGap,
    room,
    criticReason: verdict.reason,
    rejected: rejectedRecords,
    trace,
  };
}

/** Build the history the gates need from records this account has posted.
 *
 *  Exported here rather than in ./botTell.ts because it is about our storage
 *  shape, not about the gate — and the gate must stay usable against a history
 *  that comes from somewhere else entirely (a profile scrape, say). */
export function historyFromPosted(
  posted: { text: string | null; subreddit: string; postedAtMs: number }[],
): CommentHistoryEntry[] {
  return posted
    .filter((p) => !!p.text?.trim())
    .map((p) => historyEntryOf(p.text as string, p.subreddit, p.postedAtMs));
}
