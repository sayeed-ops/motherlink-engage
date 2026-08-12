// Reading the posting agent's heartbeat doc (agents/agent) into something a chip
// can render. Shared by AgentControls (Accounts page) and SidebarAgentControl so
// the two can never drift apart.
//
// WHY THIS EXISTS — the "1 queued and nothing happens" bug:
//
// The agent's loop is single-threaded. It claims the oldest queued job, then
// BLOCKS inside processJob() while the browser automation runs. With the
// humanized approach plan (browse → find the post → read → skim → type) that is
// legitimately 4-7 minutes. Two things went wrong during that window:
//
//   1. `queued` was counted BEFORE the claim, so it still included the job being
//      worked on. Clicking Post showed "1 queued" and it stayed at 1 for minutes.
//   2. Nothing wrote a heartbeat while the job ran, so lastSeenAt went stale and
//      the chip flipped to OFFLINE mid-post — while the agent was working fine.
//
// The agent now excludes the running job from `queued`, publishes a `current`
// map describing it, and beats on a timer inside the job (see the heartbeat
// ticker in apps/poster-agent/index.mjs). This module just renders that.

/** What the agent is doing right now. Absent on the heartbeat doc when idle —
 *  the agent deletes the field rather than leaving a stale one. */
export interface AgentCurrentJob {
  jobId: string;
  subreddit: string;
  expectedUsername: string;
  startedAtMs: number;
  /** Coarse phase: 'starting' | 'opening profile' | 'posting…' | 'reading account stats'. */
  stage: string;
}

export interface AgentStatus {
  online: boolean;
  /** True when the agent is mid-job. Distinct from queued > 0, which is work
   *  nobody has picked up yet. */
  busy: boolean;
  /** Jobs still WAITING — the in-flight one is not counted. Saturates at 19
   *  (the agent reads a limit(20) page), so treat a large value as "many". */
  queued: number;
  current: AgentCurrentJob | null;
  /** One short phrase for a status chip. */
  activity: string;
}

/** The agent stamps agents/agent every ~5s (including while posting). Older than
 *  this and we call it offline. */
export const ONLINE_WINDOW_MS = 20_000;

const toMs = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** "45s" / "6m" — how long the current job has been running. */
function elapsed(startedAtMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - startedAtMs) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

function readCurrent(raw: unknown): AgentCurrentJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (!str(c.jobId)) return null;
  return {
    jobId: str(c.jobId),
    subreddit: str(c.subreddit),
    expectedUsername: str(c.expectedUsername),
    startedAtMs: num(c.startedAtMs),
    stage: str(c.stage) || 'working',
  };
}

export function readAgentStatus(
  agent: Record<string, unknown> | null | undefined,
  nowMs: number,
): AgentStatus {
  const seen = toMs(agent?.lastSeenAt);
  // nowMs is 0 on the very first render, before the caller's clock effect has
  // ticked. Treat that as "don't know yet" — i.e. offline — rather than letting
  // 0 - seen sail under the window and claim the agent is up.
  const online = nowMs > 0 && seen > 0 && nowMs - seen < ONLINE_WINDOW_MS;
  const queued = num(agent?.queued);
  // Only trust `current` from a live agent — a stale doc describes a job whose
  // process is gone (the agent clears the field on its next start).
  const current = online ? readCurrent(agent?.current) : null;

  let activity: string;
  if (!online) {
    activity = 'offline';
  } else if (current) {
    const where = current.subreddit ? ` r/${current.subreddit}` : '';
    const stage = current.stage === 'posting' ? `posting${where}` : current.stage;
    const age = current.startedAtMs ? ` · ${elapsed(current.startedAtMs, nowMs)}` : '';
    const rest = queued > 0 ? ` · ${queued} waiting` : '';
    activity = `${stage}${age}${rest}`;
  } else if (queued > 0) {
    activity = `${queued} queued`;
  } else {
    activity = 'idle';
  }

  return { online, busy: !!current, queued, current, activity };
}
