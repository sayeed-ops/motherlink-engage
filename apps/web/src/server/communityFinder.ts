import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { callModel, LlmError } from './llm';
import { resolveModelForRun, type RunActor } from './llm/resolve';
import { getWarmupModel } from './agentControl';
import { saveWarmupCommunities } from './warmup';
import {
  buildPersonaPrompt,
  buildSuggestPrompt,
  parsePersona,
  parseSuggestions,
  PERSONA_SYSTEM,
  notForComments,
  SUGGEST_SYSTEM,
  type CommunitySuggestion,
  type Persona,
} from '@/modules/reddit/communityFinder';
import { normalizeCommunityList, normalizeKeywordList, type WarmupCommunity } from '@/modules/reddit/subreddits';
import { placeOf, type AccountProxyIp } from '@/modules/accounts/proxyPool';

// The community finder, server side: ask the model for a persona, then for
// communities that fit it, and add the approved ones to the account's list.
// The checks themselves happen on the account's own visit, in the agent.

const accounts = () => adminDb().collection('accounts');

/** The cap the community list itself enforces. */
const LIST_CAP = 40;

export class FinderError extends Error {}

/** One JSON answer from the warm-up model. A busy provider or an unreadable
 *  answer is tried twice more before giving up, like the autopilot's picker. */
async function ask(actor: RunActor, system: string, user: string, temperature: number): Promise<unknown> {
  const model = await resolveModelForRun(actor, null, await getWarmupModel(), { requireJson: true });
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const { content } = await callModel(model, { system, user, temperature, maxTokens: 2500, json: true });
      return JSON.parse(content);
    } catch (err) {
      last = err;
      const temporary = err instanceof SyntaxError || (err instanceof LlmError && (err.status === 502 || err.status === 503));
      if (!temporary) throw err;
    }
  }
  if (last instanceof LlmError) throw last;
  throw new FinderError('The model did not answer in the expected shape. Try again.');
}

async function readAccount(accountId: string): Promise<Record<string, unknown>> {
  const snap = await accounts().doc(accountId).get();
  if (!snap.exists) throw new FinderError('No such account.');
  return snap.data() as Record<string, unknown>;
}

/** A persona draft. Not saved until someone approves it. */
export async function draftPersona(accountId: string, actor: RunActor, hint: string): Promise<Persona> {
  const account = await readAccount(accountId);
  const place = placeOf((account.proxyIp as AccountProxyIp | undefined) ?? null);
  const persona = parsePersona(await ask(actor, PERSONA_SYSTEM, buildPersonaPrompt({ place, hint }), 0.9));
  if (!persona) throw new FinderError('The model did not return a usable persona. Try again.');
  return persona;
}

export async function savePersona(accountId: string, raw: unknown): Promise<Persona> {
  const persona = parsePersona(raw);
  if (!persona) throw new FinderError('A persona needs a summary and at least one interest.');
  await readAccount(accountId);
  await accounts().doc(accountId).update({ persona: { ...persona, updatedAtMs: Date.now() }, updatedAt: FieldValue.serverTimestamp() });
  return persona;
}

/** Suggestions for the saved persona, skipping what the account already has or
 *  was turned down for, and steering away from other accounts' lists. */
export async function suggestCommunities(accountId: string, actor: RunActor, count = 15): Promise<CommunitySuggestion[]> {
  const account = await readAccount(accountId);
  const persona = parsePersona(account.persona);
  if (!persona) throw new FinderError('Approve a persona first.');

  const own = normalizeCommunityList(account.warmupCommunities).map((c) => c.name);
  const exclude = [...own, ...notForComments(account.communityChecks)];
  const others = new Set<string>();
  for (const d of (await accounts().get()).docs) {
    if (d.id === accountId) continue;
    for (const c of normalizeCommunityList(d.get('warmupCommunities'))) others.add(c.name);
  }
  const raw = await ask(
    actor,
    SUGGEST_SYSTEM,
    buildSuggestPrompt({ persona, count, exclude, avoidShared: [...others].slice(0, 80) }),
    0.8,
  );
  const suggestions = parseSuggestions(raw, exclude);
  if (!suggestions.length) throw new FinderError('The model suggested nothing usable. Try again.');
  return suggestions;
}

/**
 * Add approved suggestions as Browse + Follow, plus Comment where it was allowed,
 * each waiting for its check. A community already on the list keeps its roles,
 * gains any new ones and the new keywords.
 */
export async function applySuggestions(
  accountId: string,
  picks: { name: string; keywords: string[]; comment?: boolean }[],
  savedBy: string,
): Promise<{ added: number; updated: number; full: string[] }> {
  const account = await readAccount(accountId);
  const list: WarmupCommunity[] = normalizeCommunityList(account.warmupCommunities);
  const checks = (account.communityChecks ?? {}) as Record<string, unknown>;
  const pending: Record<string, unknown> = {};
  let added = 0;
  let updated = 0;
  const full: string[] = [];

  for (const pick of picks) {
    const roles = pick.comment ? ['browse', 'follow', 'comment'] : ['browse', 'follow'];
    const [row] = normalizeCommunityList([{ name: pick.name, roles, keywords: pick.keywords }]);
    if (!row) continue;
    const existing = list.find((c) => c.name === row.name);
    if (existing) {
      const keywords = normalizeKeywordList([...(existing.keywords ?? []), ...(row.keywords ?? [])]);
      if (keywords.length) existing.keywords = keywords;
      for (const role of row.roles) if (!existing.roles.includes(role)) existing.roles.push(role);
      updated += 1;
      continue;
    }
    if (list.length >= LIST_CAP) {
      full.push(row.name);
      continue;
    }
    list.push(row);
    added += 1;
    if (!checks[row.name]) {
      pending[`communityChecks.${row.name}`] = { status: 'pending', reason: '', weeklyVisitors: null, moderators: null, apps: [], checkedAtMs: 0 };
    }
  }

  await saveWarmupCommunities(accountId, normalizeCommunityList(list), normalizeKeywordList(account.warmupKeywords), savedBy);
  if (Object.keys(pending).length) await accounts().doc(accountId).update(pending);
  return { added, updated, full };
}
