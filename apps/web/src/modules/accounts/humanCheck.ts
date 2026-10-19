// "Prove you are human" — the one stop the agent never gets past by itself.
//
// When Reddit asks an account to prove it is human, the agent halts the job,
// leaves the browser open on the check and records it on the account as an
// OPEN check (flagHumanCheck in apps/poster-agent/agent-core.mjs). From then
// on nothing runs from that account — the agent refuses every job for it, and
// every path in the web app that queues one refuses here first — until a
// person has solved it in the browser and marked it solved on the account
// page.
//
// PURE — the account page, the routes and the tests all read it.

export interface HumanCheck {
  status: 'open' | 'resolved';
  reason: string;
  text: string;
  url: string;
  jobId: string;
  kind: string;
  detectedAtMs: number;
  resolvedAtMs: number | null;
  resolvedBy: string | null;
  resolvedByName: string;
}

/** The account's latest human check, or null if it has never had one. */
export function humanCheckOf(account: Record<string, unknown> | null | undefined): HumanCheck | null {
  const raw = account?.humanCheck as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    status: raw.status === 'open' ? 'open' : 'resolved',
    reason: str(raw.reason),
    text: str(raw.text),
    url: str(raw.url),
    jobId: str(raw.jobId),
    kind: str(raw.kind),
    detectedAtMs: num(raw.detectedAtMs) ?? 0,
    resolvedAtMs: num(raw.resolvedAtMs),
    resolvedBy: typeof raw.resolvedBy === 'string' ? raw.resolvedBy : null,
    resolvedByName: str(raw.resolvedByName),
  };
}

/** Why nothing may be queued for this account, or null when it may. */
export function humanCheckRefusal(account: Record<string, unknown> | null | undefined): string | null {
  const check = humanCheckOf(account);
  if (!check || check.status !== 'open') return null;
  return 'This account has an unsolved “prove you are human” check. Nothing will run from it until someone solves it in the account’s browser and marks it solved on the account page.';
}
