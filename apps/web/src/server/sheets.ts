import 'server-only';

// The Google Sheet side of a project: its settings, a read-only access check,
// and the row payload frozen onto a job when a reply is queued.
//
// ⚠️ NOTHING HERE WRITES TO A SHEET. The agent does that, after the comment is
// up — apps/poster-agent/sheets.mjs. What this file produces is the row's
// CONTENT, decided at enqueue time from the analysis the draft was written
// from, and stored on the job. See modules/sheets/row.ts for why it is frozen
// then rather than rebuilt afterwards.
//
// The check below is deliberately read-only (one GET of the spreadsheet's
// title and tab names). It answers the only question the project page needs —
// "can this service account reach the file you pasted?" — without touching a
// document the operator owns. The tab and the header row are created by the
// agent on its first real write.

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, loadServiceAccount } from './admin';
import { GoogleAuth } from 'google-auth-library';
import {
  EMPTY_SHEET_CONFIG,
  readSheetConfig,
  sheetRefusal,
  type SheetConfig,
} from '@/modules/sheets/config';
import { boundPayload, describeReddit, describeShopify, type SheetRowPayload } from '@/modules/sheets/row';
import { isBrandOpportunity } from '@/modules/reddit/opportunity';
import type { RedditOpportunityAnalysis } from '@/modules/reddit/types';
import type { Assessment } from '@/modules/shopify/assess';
import type { ReplyMode } from '@/modules/shopify/reply';
import { fetchTopicRaw } from '@/modules/shopify/reader';
import { openingPost, parseDiscussion } from '@/modules/shopify/discussion';

const db = () => adminDb();
const project = (projectId: string) => db().collection('projects').doc(projectId);

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/** The address an operator has to share their sheet with. */
export function sheetServiceAccountEmail(): string {
  return loadServiceAccount().client_email;
}

export async function getSheetConfig(projectId: string): Promise<SheetConfig> {
  const snap = await project(projectId).get();
  if (!snap.exists) return EMPTY_SHEET_CONFIG;
  return readSheetConfig((snap.data() as Record<string, unknown>).sheet);
}

/**
 * Save the operator's settings.
 *
 * ⚠️ `nextMention`, `lastWrittenAtMs` and `lastError` are NOT settable here —
 * they are the agent's running record, and a save from the project page must
 * not reset the counter and start handing out Mention IDs that already exist
 * in the sheet. Changing the prefix is how you restart numbering, and it
 * restarts it under a new stem.
 */
export async function saveSheetConfig(
  projectId: string,
  patch: Pick<SheetConfig, 'enabled' | 'spreadsheetId' | 'tabName' | 'mentionPrefix' | 'includeGrowth'>,
): Promise<SheetConfig> {
  const current = await getSheetConfig(projectId);
  // A different spreadsheet is a different numbering space, so the counter goes
  // back to 1. Staying on the same file keeps it.
  const movedFile = current.spreadsheetId !== patch.spreadsheetId;
  const next: SheetConfig = {
    ...current,
    ...patch,
    nextMention: movedFile ? 1 : current.nextMention,
    lastError: movedFile ? null : current.lastError,
  };
  await project(projectId).set(
    { sheet: next, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return next;
}

/** Put every failed row back in the queue, for after a share is fixed. */
export async function retryFailedSheetRows(projectId: string): Promise<number> {
  const snap = await db()
    .collection('jobs')
    .where('projectId', '==', projectId)
    .where('sheetStatus', '==', 'failed')
    .get();
  if (snap.empty) return 0;
  const batch = db().batch();
  for (const d of snap.docs) batch.update(d.ref, { sheetStatus: 'pending', sheetAttempts: 0 });
  await batch.commit();
  await project(projectId).set({ sheet: { lastError: null } }, { merge: true });
  return snap.size;
}

export interface SheetAccess {
  title: string;
  tabs: string[];
  /** Whether the configured tab is already there. The agent makes it if not. */
  tabExists: boolean;
}

/**
 * Can this service account open that spreadsheet?
 *
 * The raw failure is a 403 reading "The caller does not have permission",
 * which is true and tells nobody that the fix is to share one file with one
 * address. Every message below names the action.
 */
export async function checkSheetAccess(spreadsheetId: string, tabName: string): Promise<SheetAccess> {
  const key = loadServiceAccount();
  const auth = new GoogleAuth({ credentials: key, scopes: [SHEETS_SCOPE] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId,
  )}?fields=properties.title,sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token.token ?? ''}` } });
  const text = await res.text();

  if (!res.ok) {
    let detail = '';
    try {
      detail = String(JSON.parse(text)?.error?.message ?? '');
    } catch {
      detail = text.slice(0, 200);
    }
    if (res.status === 403 && /API has not been used|disabled/i.test(detail)) {
      throw new Error(
        `The Google Sheets API is not enabled on the "${key.project_id}" Google Cloud project. Enable it in the Cloud console, then check again.`,
      );
    }
    if (res.status === 403) {
      throw new Error(
        `That sheet is not shared with ${key.client_email}. Open it in Google Sheets → Share → paste that address → give it Editor, then check again.`,
      );
    }
    if (res.status === 404) {
      throw new Error('No spreadsheet with that id. Check the link — the file may have been deleted or moved.');
    }
    throw new Error(`Google could not open that sheet (${res.status})${detail ? `: ${detail}` : ''}.`);
  }

  const doc = JSON.parse(text) as {
    properties?: { title?: string };
    sheets?: { properties?: { title?: string } }[];
  };
  const tabs = (doc.sheets ?? []).map((s) => String(s.properties?.title ?? '')).filter(Boolean);
  return { title: String(doc.properties?.title ?? ''), tabs, tabExists: tabs.includes(tabName) };
}

// ---------------------------------------------------------------------------
// The row payload, frozen onto the job
// ---------------------------------------------------------------------------

/**
 * The Reddit row, or null when this project does not log to a sheet.
 *
 * Reddit keeps the post's body, so the last two columns cost nothing extra.
 * The analysis is read by id from the draft — the one the reply was written
 * from, not the newest one on the post.
 */
export async function redditSheetPayload(input: {
  projectId: string;
  subreddit: string;
  postTitle: string;
  postBody: string;
  analysisId: string;
  body: string;
  cfg: SheetConfig;
}): Promise<SheetRowPayload | null> {
  if (sheetRefusal(input.cfg)) return null;

  let description = '';
  // Brand or growth, from the SAME rule the screen's "Brand opportunities" tab
  // and the draft route use — a sheet that disagreed with the app about what
  // counts as a brand reply would be worse than no filter at all.
  //
  // An analysis we cannot read reads as GROWTH: a reply is only a brand mention
  // when something says so, and guessing the other way would put a row a client
  // sees into a brand-mentions-only sheet on no evidence.
  let kind: 'brand' | 'growth' = 'growth';
  if (input.analysisId) {
    const snap = await project(input.projectId).collection('analyses').doc(input.analysisId).get();
    if (snap.exists) {
      const analysis = snap.data() as RedditOpportunityAnalysis;
      description = describeReddit(analysis);
      kind = isBrandOpportunity(analysis) ? 'brand' : 'growth';
    }
  }

  return boundPayload({
    platform: 'reddit',
    kind,
    postType: 'Comment',
    board: input.subreddit ? `r/${input.subreddit}` : '',
    contentDescription: description,
    originalTitle: input.postTitle,
    originalBody: input.postBody,
    commentText: input.body,
  });
}

/**
 * The Shopify Community row, or null when this project does not log to a sheet.
 *
 * The opening post's full text is not in Firestore — the module stores the
 * analysis and a 400-character quote, never bodies. So it is re-read from the
 * forum here, which is free and needs no AI. BEST EFFORT: a forum that is slow
 * or down must not stop a reviewed reply from being queued, so a failed read
 * falls back to the quote the analysis kept, and then to the board listing's
 * own excerpt.
 */
export async function shopifySheetPayload(input: {
  projectId: string;
  topicId: number;
  topicSlug: string;
  board: string;
  title: string;
  mode: string;
  body: string;
  /** The listing's preview of the first post — the last fallback. */
  excerpt: string;
  cfg: SheetConfig;
}): Promise<SheetRowPayload | null> {
  if (sheetRefusal(input.cfg)) return null;

  const snap = await project(input.projectId).collection('shopifyAssessments').doc(String(input.topicId)).get();
  const stored = (snap.data() ?? {}) as {
    questionQuote?: string;
    current?: { assessment?: Assessment };
  };
  const assessment = stored.current?.assessment;
  const mode = (['open', 'growth', 'brand'] as const).includes(input.mode as ReplyMode)
    ? (input.mode as ReplyMode)
    : 'open';

  let originalBody = '';
  try {
    const discussion = parseDiscussion(await fetchTopicRaw(input.topicId, input.topicSlug));
    originalBody = discussion ? (openingPost(discussion)?.text ?? '') : '';
  } catch {
    originalBody = '';
  }
  if (!originalBody) originalBody = stored.questionQuote || input.excerpt || '';

  return boundPayload({
    platform: 'shopify',
    // Only Brand mode names the client. Open and Growth both do not, and the
    // sheet does not tell them apart — the only question it asks is whether the
    // client was named.
    kind: mode === 'brand' ? 'brand' : 'growth',
    postType: 'Comment',
    board: input.board,
    contentDescription: assessment ? describeShopify(assessment, mode) : '',
    originalTitle: input.title,
    originalBody,
    commentText: input.body,
  });
}
