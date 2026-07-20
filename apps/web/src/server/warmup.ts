import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { callDeepSeek } from '@/modules/reddit/deepseek';
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
export async function designWarmupPlan(days: number, ctx: WarmupComposeContext): Promise<{ plan: WarmupPlan; ai: boolean }> {
  const n = Math.max(1, Math.min(60, Math.round(days) || 1));
  try {
    const { system, user } = buildPrompt(n, ctx);
    const { content } = await callDeepSeek({ system, user, temperature: 0.85, maxTokens: 1800, json: true });
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
