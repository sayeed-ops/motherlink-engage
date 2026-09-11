// What the Shopify screens receive from the API. Mirrors the server's stored
// shapes; built from the PURE modules' types so nothing server-only is
// reachable from a browser bundle.

import type { Assessment, ThreadCounts } from '@/modules/shopify/assess';
import type { ThreadDigest } from '@/modules/shopify/digest';
import type { ReplyMode } from '@/modules/shopify/modes';

export interface Evidence {
  postNumber: number;
  username: string;
  quote: string;
  likeCount: number;
  isAcceptedAnswer: boolean;
}

export interface AssessmentVersion {
  assessment: Assessment;
  comment: string | null;
  matchedSourceIds: string[];
  brandSupported: boolean;
  counts: ThreadCounts;
  promptVersion: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  assessedAtMs: number;
}

export interface StoredAssessment {
  topicId: number;
  title: string;
  categoryId: number;
  url: string;
  askedBy: string;
  questionQuote: string;
  current: AssessmentVersion;
  history: AssessmentVersion[];
  digest: ThreadDigest | null;
  digestAtMs: number | null;
  evidence: Evidence[];
  postsSeen: number | null;
  postsTotal: number | null;
  truncated: boolean;
  updatedAtMs: number;
}

export interface Draft {
  draftId: string;
  topicId: number;
  mode: ReplyMode;
  text: string;
  words: number;
  angle: string;
  betterBecause: string;
  usedSourceIds: string[];
  forbiddenHits: string[];
  status: 'pending' | 'approved' | 'rejected';
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAtMs: number;
}

export const age = (ms: number | null): string => {
  if (ms === null) return 'no date';
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
};

/** "1,240 in · 310 out" — shown small beside a run, so the cost of an
 *  analysis or a draft is something anyone can see rather than estimate. */
export const tokens = (u: { inputTokens: number; outputTokens: number } | null): string =>
  u ? `${u.inputTokens.toLocaleString()} in · ${u.outputTokens.toLocaleString()} out tokens` : '';
