import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { applySuggestions } from './communityFinder';
import { normalizePack, variantForAccount, type CommunityPack, type PackCommunity } from '@/modules/reddit/communityPacks';

const packs = () => adminDb().collection('communityPacks');

export async function listPacks(): Promise<CommunityPack[]> {
  const snap = await packs().get();
  return snap.docs
    .map((d) => normalizePack(d.id, d.data()))
    .filter((p): p is CommunityPack => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Create (no id) or replace a pack. */
export async function savePack(pack: { id?: string; name: string; communities: PackCommunity[] }, savedBy: string): Promise<CommunityPack> {
  const ref = pack.id ? packs().doc(pack.id) : packs().doc();
  await ref.set({ name: pack.name, communities: pack.communities, updatedAt: FieldValue.serverTimestamp(), updatedBy: savedBy });
  return { id: ref.id, name: pack.name, communities: pack.communities };
}

export async function deletePack(id: string): Promise<void> {
  await packs().doc(id).delete();
}

export interface PackApplyResult {
  accountId: string;
  added: number;
  updated: number;
  full: string[];
  error?: string;
}

/** Add the chosen communities to each account, each account getting its own
 *  keyword picks and order. One account failing does not stop the others. */
export async function applyPack(accountIds: string[], communities: PackCommunity[], savedBy: string): Promise<PackApplyResult[]> {
  const out: PackApplyResult[] = [];
  for (const accountId of accountIds) {
    try {
      const r = await applySuggestions(accountId, variantForAccount(communities), savedBy);
      out.push({ accountId, ...r });
    } catch (err) {
      out.push({ accountId, added: 0, updated: 0, full: [], error: err instanceof Error ? err.message : 'Failed.' });
    }
  }
  return out;
}
