import 'server-only';

// Queueing an approved Shopify Community reply for the local agent to post.
//
// The rules are modules/shopify/posting.ts; this file gathers what they need
// (draft, account, the agent's heartbeat, the thread and its board), writes the
// job, and reads jobs back for the screen.
//
// ⚠️ WRITING A JOB IS NOT POSTING. The agent posts — in dry run it opens the
// thread, verifies the account, types the reply and stops. Shopify's dry-run
// switch is `agents/control.dryRunByPlatform.shopify`, and anything other than
// an explicit `false` there means dry run, whatever Reddit's switch says.

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { getShopifyConfig } from './shopify';
import { getAccount } from './accounts';
import { hasActiveJobForDraft } from './jobs';
import { DEFAULT_CATEGORIES } from '@/modules/shopify/categories';
import { accountRefusal, agentRefusal, draftRefusal } from '@/modules/shopify/posting';
import { accountPlatform } from '@/modules/accounts/platform';

const db = () => adminDb();
const project = (projectId: string) => db().collection('projects').doc(projectId);

const ms = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

export class PostingRefused extends Error {}

/** An account doc → the shape the posting rules read. */
export function accountForRules(a: Record<string, unknown>) {
  return {
    ...a,
    postCountResetAtMs: ms(a.postCountResetAt),
    lastPostAtMs: ms(a.lastPostAt),
  };
}

export interface QueueInput {
  projectId: string;
  draftId: string;
  accountId: string;
  uid: string;
  name: string;
}

export async function queueShopifyPost(input: QueueInput): Promise<{ jobId: string }> {
  const draftRef = project(input.projectId).collection('shopifyDrafts').doc(input.draftId);
  const [draftSnap, account, agentSnap, config] = await Promise.all([
    draftRef.get(),
    getAccount(input.accountId),
    db().collection('agents').doc('agent').get(),
    getShopifyConfig(input.projectId),
  ]);
  if (!draftSnap.exists) throw new PostingRefused('No such draft.');
  const draft = draftSnap.data() as Record<string, unknown>;

  const refusal =
    draftRefusal(
      { status: String(draft.status ?? ''), text: String(draft.text ?? ''), forbiddenHits: (draft.forbiddenHits as string[]) ?? [] },
      config.client.forbiddenPhrases,
    ) ??
    accountRefusal(account ? accountForRules(account) : null, Date.now()) ??
    agentRefusal(agentSnap.exists ? (agentSnap.data() as Record<string, unknown>) : null);
  if (refusal) throw new PostingRefused(refusal);

  if (await hasActiveJobForDraft(input.draftId)) throw new PostingRefused('This reply is already queued.');

  const topicId = Number(draft.topicId);
  const topicSnap = await project(input.projectId).collection('shopifyTopics').doc(String(topicId)).get();
  const topic = (topicSnap.data() ?? {}) as Record<string, unknown>;
  const categoryId = Number(topic.categoryId ?? draft.categoryId) || null;
  // The board's slug, for the approach (board → thread). From this project's
  // boards, else the shipped list; absent, the agent goes straight to the thread.
  const board = [...config.categories, ...DEFAULT_CATEGORIES].find((c) => c.id === categoryId);
  const topicSlug = String(topic.slug || String(draft.url || '').split('/').at(-2) || '');

  const ref = db().collection('jobs').doc();
  await ref.set({
    jobId: ref.id,
    platform: 'shopify',
    kind: 'post',
    projectId: input.projectId,
    draftId: input.draftId,
    topicId,
    topicSlug,
    categoryId,
    categorySlug: board?.slug ?? null,
    threadUrl: String(draft.url || `https://community.shopify.com/t/${topicSlug}/${topicId}`),
    postTitle: String(draft.title || topic.title || ''),
    replyMode: String(draft.mode || ''),
    body: String(draft.text || '').trim(),
    accountId: input.accountId,
    adsPowerProfileId: String(account!.adsPowerProfileId),
    expectedUsername: String(account!.username),
    status: 'queued',
    attempts: 0,
    createdBy: input.uid,
    createdByName: input.name,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // The draft points at its latest job, so the screen can read job states with
  // one getAll rather than a query per draft.
  await draftRef.set({ postJobId: ref.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { jobId: ref.id };
}

export interface ShopifyJobView {
  jobId: string;
  draftId: string;
  status: string;
  error: string | null;
  permalink: string | null;
  accountId: string;
  username: string;
  stage: string | null;
  createdAtMs: number;
  completedAtMs: number;
}

/** The latest job for each draft that has one. */
export async function jobsForDrafts(drafts: { draftId: string; postJobId?: string | null }[]): Promise<Record<string, ShopifyJobView>> {
  const ids = drafts.filter((d) => d.postJobId).map((d) => d.postJobId as string);
  if (!ids.length) return {};
  const snaps = await db().getAll(...ids.map((id) => db().collection('jobs').doc(id)));
  const out: Record<string, ShopifyJobView> = {};
  for (const s of snaps) {
    if (!s.exists) continue;
    const j = s.data() as Record<string, unknown>;
    out[String(j.draftId)] = {
      jobId: s.id,
      draftId: String(j.draftId),
      status: String(j.status || ''),
      error: typeof j.error === 'string' ? j.error : null,
      permalink: typeof j.permalink === 'string' ? j.permalink : null,
      accountId: String(j.accountId || ''),
      username: String(j.expectedUsername || ''),
      stage: typeof j.stage === 'string' ? j.stage : null,
      createdAtMs: ms(j.createdAt),
      completedAtMs: ms(j.completedAt),
    };
  }
  return out;
}

export interface PostingAccountView {
  accountId: string;
  label: string;
  username: string;
  trustLevel: number | null;
  /** Why it cannot post right now, or null. */
  refusal: string | null;
}

export async function postingContext(): Promise<{
  accounts: PostingAccountView[];
  agentRefusal: string | null;
  dryRun: boolean;
}> {
  const [accSnap, agentSnap, controlSnap] = await Promise.all([
    db().collection('accounts').where('platform', '==', 'shopify').get(),
    db().collection('agents').doc('agent').get(),
    db().collection('agents').doc('control').get(),
  ]);
  const now = Date.now();
  const accounts = accSnap.docs
    .map((d): Record<string, unknown> & { accountId: string } => ({ ...(d.data() as Record<string, unknown>), accountId: d.id }))
    .filter((a) => accountPlatform(a) === 'shopify')
    .map((a) => ({
      accountId: a.accountId,
      label: String(a.label || ''),
      username: String(a.username || ''),
      trustLevel: ((a.forumStats as { trustLevel?: number | null } | undefined)?.trustLevel ?? null) as number | null,
      refusal: accountRefusal(accountForRules(a), now),
    }))
    .sort((x, y) => x.label.localeCompare(y.label));
  const control = (controlSnap.data() ?? {}) as { dryRunByPlatform?: Record<string, unknown> };
  return {
    accounts,
    agentRefusal: agentRefusal(agentSnap.exists ? (agentSnap.data() as Record<string, unknown>) : null),
    // Anything but an explicit false is dry run — the agent's own rule.
    dryRun: control.dryRunByPlatform?.shopify !== false,
  };
}
