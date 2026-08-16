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

import {
  paceWindow,
  rankDiscovered,
  screenDiscovered,
  type DiscoveredPost,
  type RedditDiscovery,
} from '../reader/discovery';
import type { PostSummary, RedditReader, ThreadSnapshot } from '../reader/types';
import { botTellPressure, historyEntryOf, type CommentHistoryEntry } from './botTell';
import { chosenCandidate, buildCriticPrompt, parseCriticVerdict } from './critic';
import type { DraftGap, DraftRejection, DraftRoom, DraftThread, SkipStage } from './drafts';
import { buildGenerationPrompt, parseCandidates } from './generate';
import { buildGapPrompt, parseGapAnalysis, proceedRefusal, shouldProceed } from './gaps';
import { runGates, screenCandidates, screenBeforeGeneration, type GateContext } from './gates';
import { NO_KNOBS, shouldExplore, weightedOrder, type LearnedKnobs } from './learn';
import { profileRoom, targetLength, countWords } from './roomProfile';
import {
  DEFAULT_LIMITS,
  judgeCandidate,
  screenListing,
  type SelectLimits,
  type SubBaseline,
} from './select';
import type { CommentKarmaSettings, CommunityKeywords } from './settings';

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
  /** Reddit's own feeds. Required for `discovery: 'feed'`; absent falls back to
   *  search, so a missing implementation degrades rather than throws. */
  discovery?: RedditDiscovery;
  /** Call a model and return its parsed JSON. Throws on transport, credential
   *  or JSON failures — the caller turns that into an 'error' record, because a
   *  fault must never be filed alongside the deliberate skips. */
  ask(input: AskInput): Promise<unknown>;
  nowMs: number;
  /** Injected so a scan is reproducible under test. Never called during a
   *  render — this only ever runs server-side, inside a request. */
  random?: () => number;
}

export interface ScanInput {
  settings: CommentKarmaSettings;
  /** Where to look and what to search for — build it with commentPairs(), which
   *  falls back to the account's keyword pool. Search is the only way in:
   *  Crawlzo has no listing endpoint and its `query` is required, so an account
   *  with no keywords anywhere cannot look at all. See docs/CRAWLZO-API.md. */
  pairs: CommunityKeywords[];
  /** This account's recent comments, newest anywhere in the array. */
  history: CommentHistoryEntry[];
  /** Per-subreddit pace baselines, when we have them. Missing is normal and
   *  must not reject everything. */
  baselines?: Record<string, SubBaseline>;
  limits?: SelectLimits;
  /** What the outcomes have taught us. Absent (or unfitted) means the priors
   *  stand, which is the correct state until roughly twenty comments have been
   *  measured — see ./learn.ts. */
  learned?: LearnedKnobs;
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
  /** This scan deliberately took a thread the scorer rejected. Recorded because
   *  these are the only UNBIASED samples the learning loop gets: every other
   *  outcome is for a thread the rules already liked, so the rules could be
   *  refined forever without ever being discovered to be wrong. */
  exploratory: boolean;
  /** What happened, in order. The only record of a scan that produced nothing,
   *  and the same argument as the approach trace on a warm-up job: the plan is
   *  intent, the trace is what actually happened. */
  trace: string[];
}

/** How many searches one scan may pay for before giving up. */
const MAX_SEARCHES = 2;

/**
 * The rejections an exploring scan is allowed to overrule.
 *
 * These three are PREDICTIONS of low yield, and predictions are the thing
 * exploration exists to test. Everything else in RejectReason is a fact about
 * the post — it is an image, it is locked, it is quarantined, the score is
 * hidden — and no amount of curiosity makes commenting there a good idea. A
 * "sometimes ignore the rules" switch that could reach those would be a way to
 * get an account banned on purpose.
 */
const SOFT_REJECTS = new Set(['not-rising', 'crowded', 'unbeatable']);

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
    exploratory: false,
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

  // Feed mode needs a community and nothing else — that is the point of it.
  // Requiring keywords here would keep the old constraint alive one layer up
  // from where it was removed, which is exactly how a "fixed" limitation comes
  // back.
  const feedMode = input.settings.discovery === 'feed' && !!deps.discovery;
  const usable = input.pairs.filter((p) => p.subreddit.trim() && (feedMode || p.keywords.length));
  if (!usable.length) {
    return stop(
      trace,
      'search',
      feedMode
        ? 'No community is tagged Comment, so there is nowhere to look.'
        : 'No Comment-tagged community has a keyword to search for.',
    );
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

  const learned = input.learned ?? NO_KNOBS;
  // Weighted rather than uniform: a community whose comments have been scoring
  // gets scanned more often. Weight is a multiplier on the chance of going
  // FIRST, never a filter — a room that had a bad week must keep appearing, or
  // the ledger freezes on its first impression and the account quietly abandons
  // a community on the evidence of two comments.
  const ordered = weightedOrder(usable, (p) => learned.communityWeights[p.subreddit] ?? 1, random);

  let chosen: CommunityKeywords | null = null;
  let timingReason = '';
  for (const candidate of ordered) {
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

  const pressure = botTellPressure(input.history);
  const useFeed = feedMode;

  // --- discovery ------------------------------------------------------------
  // Two ways in, and they are NOT equivalent:
  //
  //   feed   — the community's own rising/hot ordering. Free, needs no keyword,
  //            and finds the thread that is taking off right now for reasons
  //            nobody typed into a settings box. Screens on age only, so more
  //            of the paid reads below turn out to be rejects.
  //   search — Crawlzo, one billed call, full metadata, so the free screen
  //            discards most candidates before anything else is paid for. Blind
  //            to anything no keyword covers.
  const found: PostSummary[] = [];
  let discovered: DiscoveredPost[] = [];
  // The limits the paid read is judged against. In feed mode with adaptWindow
  // on, the age half is replaced by this community's measured pace; everything
  // else — crowding, the top-comment ceiling, the ratio — is untouched.
  let effective = limits;

  if (useFeed) {
    const feed = pick(input.settings.feeds, random) ?? 'rising';
    trace.push(`feed r/${chosen.subreddit} /${feed}`);
    const seen = await (deps.discovery as RedditDiscovery).list(chosen.subreddit, feed, 25);
    trace.push(`  ${seen.length} post(s) in the feed`);

    // Measured from the feed already in hand, free. One window cannot serve a
    // community posting every twenty seconds and one posting twice a day.
    const accountWindow = { minAgeMinutes: limits.minAgeMinutes, maxAgeHours: limits.maxAgeHours };
    const window = input.settings.adaptWindow ? paceWindow(seen, accountWindow, deps.nowMs) : { ...accountWindow, medianAgeHours: 0 };
    if (input.settings.adaptWindow && window.medianAgeHours) {
      trace.push(
        `pace: median post here is ${window.medianAgeHours}h old → window ${window.minAgeMinutes}m–${Math.round(window.maxAgeHours)}h`,
      );
    }
    // The judge must agree with the screen, or a thread let through on the
    // measured window would be rejected moments later on the configured one.
    effective = { ...limits, minAgeMinutes: window.minAgeMinutes, maxAgeHours: window.maxAgeHours };

    const ageRejects = new Map<string, number>();
    for (const post of seen) {
      // Age is the ONLY thing free feed data may decide. Everything else the
      // listing screen checks needs numbers RSS does not have, and guessing any
      // of them from a title would be a fabricated measurement.
      const reason = screenDiscovered(post, deps.nowMs, window);
      if (reason) {
        ageRejects.set(reason, (ageRejects.get(reason) ?? 0) + 1);
        continue;
      }
      discovered.push(post);
    }
    discovered = rankDiscovered(discovered);
    trace.push(`age window: ${discovered.length} of ${seen.length} in range`);

    if (!discovered.length) {
      const summary = [...ageRejects.entries()].map(([r, n]) => `${r}×${n}`).join(', ');
      return stop(
        trace,
        'search',
        `Nothing in r/${chosen.subreddit}'s ${feed} feed is inside the ${window.minAgeMinutes}m–${Math.round(window.maxAgeHours)}h window (${summary || 'empty feed'}).`,
      );
    }
  } else {
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
      return stop(
        trace,
        'search',
        `Nothing recent in r/${chosen.subreddit} for ${tried.join(', ') || 'any keyword'}.`,
      );
    }
  }

  // --- the free screen ------------------------------------------------------
  const baseline = input.baselines?.[chosen.subreddit] ?? null;
  // In feed mode there is nothing to screen for free beyond the age window that
  // has already run — the paid read below is what supplies every other number,
  // and judgeCandidate applies the full listing screen to it there.
  // Decided ONCE, before the screen, so the whole scan is either exploring or
  // not. Deciding per-post would make "exploratory" meaningless on the record.
  const exploring = shouldExplore(learned.exploreRate, random);
  if (exploring) trace.push('exploring: this scan may take a thread the scorer rejected');

  const rejects = new Map<string, number>();
  const survivors: PostSummary[] = [];
  const softRejects: PostSummary[] = [];
  for (const post of found) {
    const reason = screenListing(post, deps.nowMs, baseline, limits);
    if (reason) {
      rejects.set(reason, (rejects.get(reason) ?? 0) + 1);
      // Kept only when this scan is exploring, and only for the three
      // rejections that are predictions rather than facts about the post.
      if (exploring && SOFT_REJECTS.has(reason)) softRejects.push(post);
      continue;
    }
    survivors.push(post);
  }
  if (!useFeed) {
    trace.push(`screen: ${survivors.length} of ${found.length} survived`);
    if (!survivors.length && !softRejects.length) {
      const summary = [...rejects.entries()].map(([r, n]) => `${r}×${n}`).join(', ');
      return stop(trace, 'screen', `All ${found.length} posts were rejected on listing data (${summary}).`);
    }
  }

  // Rank on what the listing can tell us — the paid reads then start with the
  // most promising rather than the first.
  // The read list, as bare ids. In search mode it is ranked on real metrics; in
  // feed mode it is already ranked by rankDiscovered on the only two things a
  // feed knows — freshness inside the window, and whether the title invites an
  // answer.
  const readList: string[] = useFeed
    ? discovered.map((p) => p.redditPostId)
    : [...survivors, ...softRejects]
        .map((post) => {
          const ageHours = Math.max((deps.nowMs - post.createdAtMs) / 3_600_000, 0.25);
          return { post, rough: post.score / ageHours / Math.max(1, post.numComments) };
        })
        .sort((a, b) => b.rough - a.rough)
        .map((r) => r.post.redditPostId);

  // --- read threads until one is worth entering (billed, early exit) --------
  // Early exit rather than reading them all and picking the best: the listing
  // screen has already ordered them, and every extra read is another charge —
  // including a 404 for a post deleted since the search.
  let snapshot: ThreadSnapshot | null = null;
  let tookExploratory = false;
  const judgeRejects: string[] = [];
  for (const redditPostId of readList.slice(0, input.settings.maxThreadsPerScan)) {
    const thread = await deps.reader.getThread(redditPostId);
    if (!thread) {
      // A post that vanished between the listing and the read. Crawlzo BILLS for
      // this (NOT_FOUND is billable, per the vendor docs), so it is never
      // retried — it is counted and the scan moves on.
      judgeRejects.push('gone');
      trace.push(`read ${redditPostId}: gone since the listing`);
      continue;
    }
    const verdict = judgeCandidate({
      post: thread.post,
      comments: thread.comments,
      baseline,
      nowMs: deps.nowMs,
      limits: effective,
    });
    trace.push(
      `read ${redditPostId}: ${verdict.ok ? `ok (score ${verdict.score.toFixed(2)})` : `rejected — ${verdict.reason}`}`,
    );
    if (verdict.ok) {
      snapshot = thread;
      break;
    }
    // Exploring overrules a PREDICTION of low yield, never a fact about the
    // post — see SOFT_REJECTS.
    if (exploring && verdict.reason && SOFT_REJECTS.has(verdict.reason)) {
      trace.push(`  taking it anyway (exploring past "${verdict.reason}")`);
      snapshot = thread;
      tookExploratory = true;
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
  // A gap state whose comments have not been paying off has to clear a higher
  // bar. Demanding more certainty rather than banning the move: "said badly"
  // under-performing means we are picking bad targets, not that saying
  // something better is a bad idea.
  const floor = gap ? (learned.gapConfidenceFloor[gap.gapState] ?? 0) : 0;
  if (gap && floor && gap.confidence < floor) {
    trace.push(`gap: ${gap.gapState} at ${gap.confidence}, below the learned floor of ${floor}`);
    return stop(trace, 'gap', `"${gap.gapState}" needs ${floor} confidence for this account and had ${gap.confidence}.`, {
      thread: draftThread,
      room,
      exploratory: tookExploratory,
      gap: {
        posterWant: gap.posterWant,
        gapState: gap.gapState,
        angle: gap.angle,
        targetCommentId: gap.targetCommentId,
        confidence: gap.confidence,
      },
    });
  }

  if (!gap || !shouldProceed(gap)) {
    trace.push(`gap: ${gap ? `${gap.gapState} (confidence ${gap.confidence})` : 'unparseable'}`);
    // Say WHICH bar it failed, not "nothing worth adding" — those are different
    // facts and only one of them is about the thread.
    return stop(trace, 'gap', proceedRefusal(gap) ?? 'No gap.', {
      thread: draftThread,
      room,
      exploratory: tookExploratory,
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
    return stop(trace, 'generate', 'The model returned nothing usable.', {
      thread: draftThread,
      room,
      gap: draftGap,
      exploratory: tookExploratory,
    });
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
      exploratory: tookExploratory,
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
      exploratory: tookExploratory,
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
      exploratory: tookExploratory,
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
    exploratory: tookExploratory,
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
