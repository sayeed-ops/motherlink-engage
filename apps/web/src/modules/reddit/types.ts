// ============================================================
// Reddit Visibility — Type Definitions
// ============================================================

export type RedditProjectStatus = 'active' | 'archived';

export interface RedditProject {
  projectId: string;
  name: string;
  websiteUrl: string;
  companyDescription: string;
  targetCustomer: string;
  productService: string;
  targetSubreddits: string[];
  keywords: string[];
  brandMentionStyle: string;
  forbiddenPhrases: string[];
  status: RedditProjectStatus;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

export type RedditPostProcessingStatus =
  | 'fetched'
  | 'analyzed'
  | 'drafted'
  | 'skipped'
  | 'archived';

export interface RedditPost {
  postId: string; // composite "<projectId>_<redditPostId>"
  projectId: string;
  redditPostId: string;
  subreddit: string;
  title: string;
  body: string;
  author: string;
  url: string;
  permalink: string;
  isSelfPost: boolean;
  score: number;
  numComments: number;
  createdAtReddit: Date;
  fetchedAt: Date;
  processingStatus: RedditPostProcessingStatus;
  // When true, this post survives the purge that runs on every new fetch.
  // Older posts may not have the field at all — treat missing as false.
  isFavorite?: boolean;
}

export interface NormalizedRedditPost {
  redditPostId: string;
  subreddit: string;
  title: string;
  body: string;
  author: string;
  url: string;
  permalink: string;
  isSelfPost: boolean;
  score: number;
  numComments: number;
  createdAtRedditMs: number;
}

export type AnalysisDecision = 'reply' | 'maybe' | 'skip';
export type AnalysisRisk = 'low' | 'medium' | 'high';
export type AnalysisMention = 'yes' | 'soft' | 'no';

export interface RedditOpportunityAnalysis {
  analysisId: string;
  postId: string;
  projectId: string;
  decision: AnalysisDecision;
  score: number; // 1-100
  reason: string;
  relevantSourceIds: string[];
  riskLevel: AnalysisRisk;
  mentionRecommendation: AnalysisMention;
  suggestedAngle: string;
  // Account-warming axis, independent of brand fit: how good a pure-value /
  // karma reply opportunity this is (even when the brand decision is "skip").
  // Optional so analyses created before this field still load.
  growthScore?: number; // 1-100
  growthAngle?: string; // brand-free angle for a value reply
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  createdBy: string;
  createdAt: Date;
}

export type DraftStatus = 'draft' | 'posted' | 'rejected';

export interface RedditDraft {
  draftId: string;
  postId: string;
  projectId: string;
  analysisId: string;
  body: string;
  status: DraftStatus;
  reviewerNotes: string;
  revisionOf: string | null;
  // The pristine first AI generation, stamped once at creation and never
  // overwritten. `body` is the working/edited copy; this is kept so an edit can
  // always be trained against what the model actually wrote. Optional for
  // back-compat with drafts created before edit-training existed.
  aiOriginalBody?: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  // Set when a draft is posted *through the tool* (vs "Mark posted" by hand).
  // All optional so drafts created before posting existed still load.
  postedByAccountId?: string;
  postedPermalink?: string; // Reddit permalink of the live comment (or dry-run note)
  postedAt?: Date;
}

// ============================================================
// Draft feedback — the edit/reject training signal.
//
// Every substantive edit or rejection by a `drafts.train` holder becomes one
// append-only record: the before/after text, WHY it changed (structured tags +
// free reason), and the context the model had when it wrote the draft. This is
// the dataset a later step exports to Obsidian and mines for prompt/few-shot
// improvements. Stored under `projects/{id}/draftFeedback/{id}`; written
// server-side only.
// ============================================================

/** Structured reason categories — filterable training signal, paired with free
 *  text. Kept small on purpose; extend as real patterns emerge. */
export const DRAFT_REASON_TAGS = [
  'too_salesy',
  'wrong_tone',
  'factual_fix',
  'formatting',
  'too_long',
  'too_short',
  'more_specific',
  'added_disclosure',
  'subreddit_fit',
  'off_brand',
  'other',
] as const;

export type DraftReasonTag = (typeof DRAFT_REASON_TAGS)[number];

/** Human labels for the reason tags. */
export const DRAFT_REASON_LABELS: Record<DraftReasonTag, string> = {
  too_salesy: 'Too salesy',
  wrong_tone: 'Wrong tone',
  factual_fix: 'Factual fix',
  formatting: 'Formatting',
  too_long: 'Too long',
  too_short: 'Too short',
  more_specific: 'More specific',
  added_disclosure: 'Added disclosure',
  subreddit_fit: 'Subreddit fit',
  off_brand: 'Off-brand',
  other: 'Other',
};

export type DraftFeedbackKind = 'edit' | 'reject';

export interface RedditDraftFeedback {
  feedbackId: string;
  projectId: string;
  draftId: string;
  itemId: string;
  analysisId: string;
  kind: DraftFeedbackKind;
  // Content of the change.
  originalBody: string; // text before this change (for an edit) / the draft (for a reject)
  editedBody: string | null; // the new text (edit) / null (reject)
  reasonTags: DraftReasonTag[];
  reasonText: string;
  // Context the model had when it wrote the draft — the other half of a good
  // training example.
  subreddit: string;
  suggestedAngle: string;
  model: string;
  promptVersion: string;
  // Provenance. trainingApproved is always true here (only drafts.train holders
  // produce these), but stored explicitly so a later export can filter without
  // re-deriving it.
  trainingApproved: boolean;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
}

// ============================================================
// Reddit Accounts — the identities the tool can post FROM.
//
// No credentials are stored. The login lives in the account's AdsPower browser
// profile; the local agent opens that profile (by `adsPowerProfileId`) to post.
// `username` is used only to verify the right account is open before posting.
// ============================================================

export type RedditAccountStatus =
  | 'active' // healthy, available to post
  | 'warming' // still building karma/trust — keep volume low
  | 'flagged' // a posted comment went missing (possible shadowban) — review
  | 'banned'; // dead, do not use

// ------------------------------------------------------------
// Account stats — Reddit-side truth, captured IN-SESSION by the agent.
//
// Deliberately narrow: only the facts we CANNOT derive from our own data.
// Everything we generate (posts made, where, success/fail, warm-up actions) is
// already ours in `jobs`/`drafts` — see server/accountActivity.ts. This snapshot
// is the part that lives on Reddit's side: karma, subscriptions, account age.
//
// It is NEVER pulled by a central crawler over the rotating read proxy — that
// would manufacture a "these 50 accounts move together" signature. Instead the
// poster agent, already logged in as the account in its own AdsPower profile on
// its own sticky IP, reads the account's own JSON endpoints in-session (a request
// indistinguishable from the user glancing at their own profile). Some of these
// (subscriptions) are ONLY visible to the logged-in account, so a crawler could
// not obtain them at all.
// ------------------------------------------------------------

export interface AccountStats {
  linkKarma: number;
  commentKarma: number;
  totalKarma: number;
  /** Count of subscribed subreddits (self-only visibility). -1 if not captured. */
  subscriptions: number;
  /** Reddit's own account-creation time, epoch ms. 0 if unknown. */
  redditCreatedAtMs: number;
  /** When the agent captured this, epoch ms. */
  capturedAtMs: number;
  /** Where it came from — always the in-session agent for now. */
  source: 'agent-session';
}

/** One point in an account's karma/subscription history. Append-only, stored at
 *  `accounts/{id}/statSnapshots/{id}`. Small; drives the trend + delta-since-baseline. */
export interface AccountStatSnapshot extends AccountStats {
  snapshotId: string;
}

export interface RedditAccount {
  accountId: string;
  label: string; // human label shown in the picker, e.g. "Growth – budgetlee"
  username: string; // reddit handle — the agent verifies the open profile against it
  status: RedditAccountStatus;
  // Safety rails (behavioral). Enforced in the UI before posting.
  dailyCap: number; // max posts per rolling 24h window
  minIntervalMinutes: number; // min gap between two posts from this account
  // The AdsPower (SunBrowser) profile id this account is logged into. The local
  // agent opens this profile to post. Empty until the account is wired to a
  // browser profile.
  adsPowerProfileId: string;
  // Rolling-window counters, updated after each successful post.
  postCountToday: number;
  postCountResetAt: Date; // start of the current 24h window
  lastPostAt: Date | null;
  karma: number; // manual fallback / legacy; `stats.totalKarma` is the captured truth
  notes: string;
  // Captured Reddit-side stats (see AccountStats). Absent until the agent has
  // opened this profile at least once.
  stats?: AccountStats;
  /** First-ever capture, frozen — the baseline for "is it improving since we
   *  registered it here". `createdAt` is the "registered here" anchor. */
  statsBaseline?: AccountStats;
  /** Set by the "Update data" button; the agent captures next time it opens this
   *  profile and clears it. Opportunistic — no crawler is dispatched. */
  statsRefreshRequestedAt?: Date | null;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Post jobs — the queue between the app and the LOCAL agent that drives
// AdsPower. The app enqueues a job when you click Post; the agent (running on
// your Mac, alongside AdsPower) claims it, opens the account's browser profile,
// verifies it's the right account + thread, types the reply, and submits.
// Fields are denormalized so the agent has everything without extra reads.
// ============================================================

export type RedditPostJobStatus =
  | 'queued' // waiting for the agent
  | 'posting' // claimed by the agent, in flight
  | 'posted' // success
  | 'completed' // a warm-up session finished — it posted NOTHING, so not 'posted'
  | 'failed'; // gave up / aborted (see error)

/** What a queued job asks the agent to do. Absent on every job written before
 *  warm-up existed, which the agent reads as 'post'. */
export type RedditJobKind = 'post' | 'warmup';

export interface RedditPostJob {
  jobId: string;
  projectId: string;
  postId: string; // reddit_posts doc id (composite)
  draftId: string; // reddit_drafts doc id
  redditPostId: string; // bare reddit id → used to verify the thread
  subreddit: string;
  threadUrl: string; // full reddit thread URL to navigate to
  accountId: string; // reddit_accounts doc id
  adsPowerProfileId: string; // AdsPower profile to open
  expectedUsername: string; // agent aborts if the logged-in user != this
  body: string; // the reply text to type
  status: RedditPostJobStatus;
  attempts: number;
  permalink?: string; // on success, if captured
  error?: string; // on failure/abort
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
  claimedAt?: Date;
  completedAt?: Date;
}

// Heartbeat written by the local agent each poll, so the app can show whether
// the agent is running. Single doc: reddit_agent_status/agent.
export interface RedditAgentStatus {
  lastSeenAt: Date;
  dryRun: boolean;
  queued: number;
  postedSession: number;
  pid?: number;
}

export type RedditSourceType = 'url' | 'pasted_text';

export interface RedditSource {
  sourceId: string;
  projectId: string;
  type: RedditSourceType;
  title: string;
  url: string | null;
  rawContent: string;
  summary: string;
  keyPoints: string[];
  answerAngles: string[];
  relatedProblems: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
