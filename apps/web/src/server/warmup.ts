import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { callModel, envDeepSeekModel } from '@/server/llm';
import { resolveModelForRun, type RunActor } from '@/server/llm/resolve';
import { getWarmupModel } from './agentControl';
import {
  communitiesForRole,
  normalizeCommunityList,
  normalizeKeywordList,
  type WarmupCommunity,
} from '@/modules/reddit/subreddits';
import type { WarmupPolicy } from '@/modules/reddit/warmupWalk';
import {
  composeWarmupPlan,
  instantiatePackage,
  fillPlanParams,
  WARMUP_PACKAGES,
  PHASE_LABEL_LIST,
  type WarmupPlan,
  type WarmupDay,
  type WarmupPackageId,
  type WarmupComposeContext,
  type WarmupGroup,
  type WarmupAction,
} from '@/modules/reddit/warmup';

// Warm-up plan persistence + AI design.
//
// The plan is stored as a field on the account doc (`accounts/{id}.warmupPlan`),
// not a subcollection: it's small (tens of KB) and behavioural config, so it
// rides the existing client accounts subscription and needs no new rule. Writes
// are server-only (rules: accounts are `allow write: if false`) and gated on
// `accounts.manage` at the route.

const accounts = () => adminDb().collection('accounts');

export async function saveWarmupPlan(accountId: string, plan: WarmupPlan, savedBy: string): Promise<void> {
  await accounts()
    .doc(accountId)
    .update({
      warmupPlan: plan,
      warmupUpdatedAt: FieldValue.serverTimestamp(),
      warmupUpdatedBy: savedBy,
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/** Persist the account's community list.
 *
 *  Same storage argument as the plan above: a field on the account doc, small,
 *  behavioural config, rides the existing client accounts subscription, needs no
 *  rules change (accounts are `allow write: if false`; writes are server-only).
 *
 *  `warmupSubreddits` is written ALONGSIDE it, holding the browse-tagged names.
 *  That field is what the walk composer and the run route already read, and it
 *  had no writer at all until now — which is why every session to date could
 *  only ever enter via Home. Keeping it in sync here means the loop picks the
 *  list up with no change to its own code, and anything still reading the old
 *  field keeps working. */
export async function saveWarmupCommunities(
  accountId: string,
  communities: WarmupCommunity[],
  keywords: string[],
  savedBy: string,
): Promise<void> {
  await accounts()
    .doc(accountId)
    .update({
      warmupCommunities: communities,
      warmupKeywords: keywords,
      warmupSubreddits: communitiesForRole(communities, 'browse'),
      warmupCommunitiesUpdatedAt: FieldValue.serverTimestamp(),
      warmupCommunitiesUpdatedBy: savedBy,
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/**
 * Cancel any in-flight warm-up session for one account.
 *
 * WHY THIS EXISTS. A warm-up job left in `posting` — because the agent was
 * restarted mid-run, which is exactly what happens after a code change — blocks
 * every future session for that account behind "a warm-up session is already
 * queued". The agent's stale reclaim does eventually clear it, but the operator
 * is stuck until then with no way to say "that one is dead, let it go".
 *
 * Scoped to `kind: 'warmup'` on purpose: a queued REPLY must never be cancellable
 * from the warm-up screen. Posting has its own cancel path, gated on
 * `drafts.publish`, and the two should not be reachable from each other.
 *
 * Cancelling a job the agent is genuinely mid-way through does not stop the
 * browser — nothing can, the agent has no channel back. The session simply
 * finishes browsing and its write-back lands on an already-terminal job. Harmless
 * for a warm-up, which posts nothing.
 */
export async function cancelWarmupJobs(
  accountId: string,
): Promise<{ cancelled: number; wasRunning: boolean }> {
  const snap = await adminDb()
    .collection('jobs')
    .where('accountId', '==', accountId)
    .where('status', 'in', ['queued', 'posting'])
    .limit(20)
    .get();

  let cancelled = 0;
  let wasRunning = false;
  for (const doc of snap.docs) {
    const d = doc.data() as { kind?: string; status?: string };
    if (d.kind !== 'warmup') continue; // never touch a queued reply
    if (d.status === 'posting') wasRunning = true;
    await doc.ref.update({
      status: 'cancelled',
      error: 'Cancelled by an operator.',
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    cancelled += 1;
  }
  return { cancelled, wasRunning };
}

/** Persist the behavioural policy (ramp + follow pace + walk weights).
 *
 *  This field is read by the run route AND mirrored by the preview panels, which
 *  is what keeps "the session you looked at is the session that runs" true: both
 *  sides must compose from the same base, or the same seed would produce
 *  different plans and the guarantee would break silently. */
export async function saveWarmupPolicy(
  accountId: string,
  policy: Partial<WarmupPolicy>,
  savedBy: string,
): Promise<void> {
  await accounts()
    .doc(accountId)
    .update({
      warmupPolicy: policy,
      warmupPolicyUpdatedAt: FieldValue.serverTimestamp(),
      warmupPolicyUpdatedBy: savedBy,
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/** The saved list + keyword pool, normalised. Empty for an account with none. */
export async function getWarmupCommunities(
  accountId: string,
): Promise<{ communities: WarmupCommunity[]; keywords: string[] }> {
  const snap = await accounts().doc(accountId).get();
  const d = snap.exists ? snap.data() : undefined;
  return {
    communities: normalizeCommunityList(d?.warmupCommunities),
    keywords: normalizeKeywordList(d?.warmupKeywords),
  };
}

export async function clearWarmupPlan(accountId: string): Promise<void> {
  await accounts()
    .doc(accountId)
    .update({
      warmupPlan: FieldValue.delete(),
      warmupUpdatedAt: FieldValue.delete(),
      warmupUpdatedBy: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
}

// --- AI design ---------------------------------------------------------------

interface AiDay {
  day?: number;
  theme?: string;
  packages?: string[];
}

const PACKAGE_IDS = Object.keys(WARMUP_PACKAGES) as WarmupPackageId[];

function buildPrompt(days: number, ctx: WarmupComposeContext): { system: string; user: string } {
  const system =
    'You design realistic, human-like Reddit account "warm-up" schedules. A warm-up ages a fresh ' +
    'account by gradually building an ordinary lurker footprint before it ever posts: it should ' +
    'START light (just browsing/reading) and RAMP UP over days to joining subreddits and light ' +
    'engagement (upvotes, follows). Vary the days so it never looks scripted. ' +
    'You may only compose days from these named packages:\n' +
    PACKAGE_IDS.map((id) => `- ${id}: ${WARMUP_PACKAGES[id].description}`).join('\n') +
    '\nReturn ONLY JSON of the form: {"days":[{"day":1,"theme":"short label","packages":["casual_browse","quick_peek"]}]}. ' +
    'Each day has 1–6 packages. Early days lean on quick_peek/casual_browse; later days add ' +
    'discover_and_join, keyword_hunt, sub_catchup and light_engage.';

  const ctxLine = [
    ctx.keywords?.length ? `Target keywords: ${ctx.keywords.join(', ')}.` : '',
    ctx.subreddits?.length ? `Relevant subreddits: ${ctx.subreddits.join(', ')}.` : '',
    ctx.persona ? `Account persona/notes: ${ctx.persona}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const user = `Design a ${days}-day warm-up.${ctxLine ? ' ' + ctxLine : ''}`;
  return { system, user };
}

/** Expand an AI day-skeleton into a concrete, validated plan. */
function expandAiDays(aiDays: AiDay[], days: number, ctx: WarmupComposeContext): WarmupPlan | null {
  const out: WarmupDay[] = [];
  for (let i = 0; i < Math.min(days, aiDays.length); i++) {
    const d = aiDays[i] ?? {};
    const ids = (Array.isArray(d.packages) ? d.packages : [])
      .filter((p): p is WarmupPackageId => (PACKAGE_IDS as string[]).includes(p))
      .slice(0, 6);
    if (ids.length === 0) return null; // skeleton unusable → caller falls back

    const actions: WarmupAction[] = [];
    const groups: WarmupGroup[] = [];
    ids.forEach((id, idx) => {
      const { actions: pkgActions, group } = instantiatePackage(id);
      groups.push(group);
      // Long between-session gap after every package but the last of the day.
      pkgActions[pkgActions.length - 1].gapAfterSec = idx < ids.length - 1 ? randSessionGap() : 0;
      actions.push(...pkgActions);
    });

    out.push({
      day: i + 1,
      label: typeof d.theme === 'string' && d.theme.trim() ? d.theme.trim().slice(0, 80) : PHASE_LABEL_LIST[Math.min(2, Math.floor((i / Math.max(1, days - 1)) * 3))],
      actions,
      groups,
    });
  }
  if (out.length < days) return null; // AI returned too few days → fall back
  return fillPlanParams({ version: 1, source: 'ai', days: out }, ctx);
}

function randSessionGap(): number {
  return (45 + Math.floor(Math.random() * 255)) * 60;
}

/**
 * Design a warm-up plan. Tries DeepSeek for a human-authored day skeleton, then
 * expands it into concrete, bounded actions from the package library — so the AI
 * shapes the schedule but can never emit an invalid action. Falls back to the
 * deterministic composer if DeepSeek is unconfigured, errors, or returns junk.
 */
export async function designWarmupPlan(
  days: number,
  ctx: WarmupComposeContext,
  /** Whose key to spend, and whether they may spend the org's. Optional so the
   *  deterministic path still works for any caller that has no user context;
   *  omitting it falls back to the platform key. Build one with runActor(caller). */
  actor?: RunActor,
): Promise<{ plan: WarmupPlan; ai: boolean }> {
  const n = Math.max(1, Math.min(60, Math.round(days) || 1));
  try {
    const { system, user } = buildPrompt(n, ctx);
    // Warm-up is account-scoped, so there is no project config to read — it
    // resolves the caller's own key if they have one, else the platform key.
    // Any failure here (no key, bad JSON, network) lands in the catch below and
    // the deterministic composer takes over, which is why this needs no
    // ModelUnavailableError branch of its own.
    const model = actor
      ? await resolveModelForRun(actor, null, await getWarmupModel(), { requireJson: true })
      : envDeepSeekModel();
    const { content } = await callModel(model, { system, user, temperature: 0.85, maxTokens: 1800, json: true });
    const parsed = JSON.parse(content) as { days?: AiDay[] };
    if (Array.isArray(parsed.days) && parsed.days.length) {
      const plan = expandAiDays(parsed.days, n, ctx);
      if (plan) return { plan, ai: true };
    }
  } catch {
    // Any failure (no key, network, bad JSON, too-short skeleton) → deterministic.
  }
  return { plan: composeWarmupPlan(n, ctx), ai: false };
}
