// The agent's decisions about WHAT may run and WHEN — pure, no Firestore, no
// browser, no clock of its own. agent-core.mjs stores them; index.mjs acts on
// them; tests/unit/posterAgentScheduler.test.mjs holds them to account.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
//
// The agent used to run ONE job at a time, and several of its safety properties
// were true only because of that:
//
//   - "one job per account" held because there was only one job, full stop;
//   - the daily cap held because nobody else could read the counter between
//     this job's read and its write, minutes later;
//   - "two accounts never act from the same IP at once" was not enforced at all
//     — it was a rule in docs/AGENT.md about how profiles are set up.
//
// Running jobs in parallel removes the accident that made those true, so each
// becomes an explicit LOCK taken in the same transaction as the claim. A job
// holds a set of keys — its account, its AdsPower profile, the IP it exits
// through — and no two running jobs may share a key.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/**
 * `.env` DRY_RUN → the default when the control doc has not said.
 *
 * ⚠️ ONLY AN EXPLICIT "0" MEANS LIVE. It used to be the other way round —
 * `DRY_RUN=1` meant dry and ANYTHING ELSE, including a missing line, meant
 * posting for real. A forgotten line in a copied .env should rehearse, not post.
 */
export function envDryRunDefault(raw) {
  return String(raw ?? '').trim() !== '0';
}

/**
 * Is this platform in dry run right now?
 *
 * `control` is `{ ok: true, data }` for a successful read of agents/control, or
 * `{ ok: false }` when the read FAILED.
 *
 * ⚠️ A FAILED READ IS DRY RUN. The previous version returned null on any error
 * and the caller then fell back to the env default — which, with DRY_RUN unset,
 * was LIVE. A transient Firestore error flipped a dry-running agent to posting
 * for real, and the 2026-09-01 logs show it toggling every poll with nobody
 * touching anything. Not knowing is not permission.
 *
 * Reddit keeps its existing switch, `dryRun`. Any other platform is dry unless
 * `dryRunByPlatform[platform]` is EXPLICITLY false: a platform whose posting code
 * is new must not inherit Reddit's "live" just because Reddit is live.
 */
export function resolveDryRun(control, platform, envDefault) {
  if (!control || control.ok !== true) return true;
  const data = control.data || {};
  if (!platform || platform === 'reddit') {
    return typeof data.dryRun === 'boolean' ? data.dryRun : envDefault;
  }
  const byPlatform = data.dryRunByPlatform;
  return !(byPlatform && typeof byPlatform === 'object' && byPlatform[platform] === false);
}

// ---------------------------------------------------------------------------
// What is due, and in what order
// ---------------------------------------------------------------------------

// Platforms this agent has posting code for. The web app only queues a Shopify
// job when the running agent's heartbeat lists 'shopify' (see
// apps/web/src/modules/shopify/posting.ts).
export const PLATFORMS = ['reddit', 'shopify'];
export const jobPlatform = (job) => (job && typeof job.platform === 'string' && job.platform) || 'reddit';

/** Replies first — a person is waiting on an answer. Then karma comments,
 *  which are short. Warm-up browses last: never urgent, and up to 20 minutes. */
export const KIND_ORDER = { post: 0, comment: 1, warmup: 2 };
export const jobKind = (job) => (job?.kind === 'warmup' ? 'warmup' : job?.kind === 'comment' ? 'comment' : 'post');

const millis = (v) => (typeof v === 'number' ? v : v?.toMillis?.() ?? 0);

/** A job with `notBeforeMs` in the future waits. Absent means "as soon as possible". */
export function isDue(job, nowMs) {
  const nb = Number(job?.notBeforeMs);
  return !(Number.isFinite(nb) && nb > nowMs);
}

/**
 * Queued jobs → the ones due now, in the order to try them.
 *
 * Kind first, then when it became due (its `notBeforeMs`, else when it was
 * created). So a reply scheduled for 14:00 goes before a warm-up queued at
 * 13:55 once both are due, and two replies go in the order they fell due.
 */
export function orderCandidates(docs, nowMs) {
  const dueAt = (j) => (Number(j.notBeforeMs) > 0 ? Number(j.notBeforeMs) : millis(j.createdAt));
  return docs
    .filter((d) => isDue(d.data, nowMs))
    .sort((a, b) => KIND_ORDER[jobKind(a.data)] - KIND_ORDER[jobKind(b.data)] || dueAt(a.data) - dueAt(b.data));
}

/** The earliest `notBeforeMs` still in the future among queued jobs, or null. */
export function nextDueAtMs(docs, nowMs) {
  const later = docs.map((d) => Number(d.data?.notBeforeMs)).filter((nb) => Number.isFinite(nb) && nb > nowMs);
  return later.length ? Math.min(...later) : null;
}

// ---------------------------------------------------------------------------
// Sleeping when idle (the cloud server only)
// ---------------------------------------------------------------------------

/** Minutes of nothing to do before the server sleeps. agents/control.idleSleepMinutes
 *  when it is a number (0 = never sleep), else 5. */
export function idleSleepMinutes(control) {
  const v = control?.ok ? Number(control.data?.idleSleepMinutes) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : 5;
}

/** Until when someone asked, from Engage, for the server to stay up (Wake now /
 *  Keep awake), in ms — so it is still on when they connect. 0 when not asked. */
export function keptAwakeUntilMs(control) {
  const v = control?.ok ? Number(control.data?.awakeUntilMs) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Should the server shut itself down now?
 *
 * Only once it has had nothing to do for `idleMinutes` in a row — and never
 * while anything could still need it: a job running or waiting (even one held
 * by a lock, which runs as soon as that frees), a job scheduled within the next
 * WAKE_LEAD_MS (sleeping then would only make it late — Engage's timer wakes the
 * server for anything further out), a "prove you are human" check a person still
 * has to solve in the open browser, someone connected to the server, or someone
 * in Engage asking it to stay up (`awakeUntilMs`). That last one does not
 * restart the idle clock: once it runs out, an idle server may sleep at once.
 *
 * `idleSinceMs` is when the agent last had any of those; the caller keeps it.
 */
export const WAKE_LEAD_MS = 10 * 60_000;
export function sleepDecision({ nowMs, idleSinceMs, idleMinutes, running, waitingDue, nextDueMs, humanCheckOpen, operatorConnected, awakeUntilMs = 0 }) {
  if (!(idleMinutes > 0)) return { sleep: false, busy: false, reason: 'sleeping is off' };
  if (awakeUntilMs > nowMs) return { sleep: false, busy: false, reason: 'kept awake from Engage' };
  if (running > 0) return { sleep: false, busy: true, reason: 'a job is running' };
  if (waitingDue > 0) return { sleep: false, busy: true, reason: 'a job is waiting' };
  if (nextDueMs != null && nextDueMs - nowMs < WAKE_LEAD_MS) return { sleep: false, busy: true, reason: 'a job is due soon' };
  if (humanCheckOpen) return { sleep: false, busy: true, reason: 'a human check is waiting for a person' };
  if (operatorConnected) return { sleep: false, busy: true, reason: 'someone is connected to the server' };
  if (nowMs - idleSinceMs < idleMinutes * 60_000) return { sleep: false, busy: false, reason: 'idle, not long enough yet' };
  return { sleep: true, busy: false, reason: `nothing to do for ${idleMinutes} min` };
}

// ---------------------------------------------------------------------------
// AdsPower responses
// ---------------------------------------------------------------------------

// Every character from U+0000 to U+001F — built from char codes so this source
// file itself contains no invisible characters.
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]+`, 'g');

/**
 * AdsPower's response body -> an object, or null.
 *
 * ADSPOWER SENDS INVALID JSON. Its profile list carries raw control characters
 * inside string values (a line break typed into a profile's notes comes back
 * unescaped) and JSON.parse rejects the whole response. Found on the posting
 * Mac on 2026-09-13, before the first live run: the IP lock reads that list, so
 * a strict parse would have left the agent claiming nothing, forever, while
 * looking healthy. The fake AdsPower in the loop test sent clean JSON, which is
 * why only the real one showed it.
 *
 * Raw control characters are never legal in JSON, so replacing them with a space
 * cannot turn valid JSON invalid; inside a string it turns a newline in a note
 * into a space, which nothing here reads.
 */
export function parseAdsPowerBody(text) {
  try {
    return JSON.parse(String(text ?? '').replace(CONTROL_CHARS, ' '));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

const shortHash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

/**
 * An AdsPower profile → the keys for the network identity it uses.
 *
 * Read from AdsPower itself (`/api/v1/user/list`), not typed into Engage, so it
 * cannot drift from what the browser actually does.
 *
 * - No proxy → the machine's own connection. Every no-proxy profile on this
 *   machine shares it, so they share one key and never run together.
 * - A proxy → its type, host, port AND USERNAME. Residential providers put many
 *   sticky sessions behind one gateway host and tell them apart by username, so
 *   host:port alone would lock unrelated accounts together, and dropping the
 *   username would be the same mistake the other way.
 * - The last IP AdsPower detected, when it reports one, as a second key — two
 *   different sticky sessions can land on the same exit IP, and that is exactly
 *   the collision this lock is for.
 *
 * Hashed: the key sits on a job document, and a proxy username is a credential.
 */
/**
 * AdsPower profiles already going out through this proxy or this exit IP —
 * "one profile per IP" (docs/AGENT.md). A proxy is the same when host, port and
 * username match (a gateway host serves many logins); an exit IP is matched
 * against the IP AdsPower last saw for each profile. Names, for the form.
 */
export function proxyUsersOf(profiles, proxy, exitIp) {
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const out = [];
  for (const prof of profiles || []) {
    const p = prof?.user_proxy_config || {};
    const viaProxy = same(p.proxy_host, proxy?.host) && same(p.proxy_port, proxy?.port) && same(p.proxy_user, proxy?.user);
    const viaIp = exitIp && same(prof?.ip, exitIp);
    if (viaProxy || viaIp) out.push(`${prof?.name || prof?.user_id} (${prof?.user_id})${viaProxy ? '' : ' — same exit IP'}`);
  }
  return out;
}

/** What Engage's form may know about AdsPower: group and profile names and ids.
 *  Never a proxy, never a remark — remarks hold logins. */
export function adsPowerInventory(profiles, groups) {
  return {
    groups: (groups || [])
      .map((g) => ({ id: String(g?.group_id ?? ''), name: String(g?.group_name ?? '') }))
      .filter((g) => g.id)
      .sort((a, b) => a.name.localeCompare(b.name)),
    profiles: (profiles || [])
      .map((p) => ({ id: String(p?.user_id ?? ''), name: String(p?.name ?? ''), group: String(p?.group_name ?? '') }))
      .filter((p) => p.id)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The exit IP and its location from ipinfo.io's JSON, or null if unreadable. */
export function readIpInfo(text) {
  try {
    const j = JSON.parse(String(text));
    if (!j || typeof j.ip !== 'string' || !j.ip) return null;
    const s = (v) => (typeof v === 'string' ? v : '');
    return { ip: j.ip, country: s(j.country), region: s(j.region), city: s(j.city), timezone: s(j.timezone), org: s(j.org) };
  } catch {
    return null;
  }
}

export function ipKeysFromAdsPower(profile, machineId) {
  const p = profile?.user_proxy_config || {};
  const soft = String(p.proxy_soft || '').toLowerCase();
  const host = String(p.proxy_host || '').trim().toLowerCase();
  const keys = [];
  if (!host || soft === 'no_proxy') {
    keys.push(`ip:direct:${shortHash(machineId)}`);
  } else {
    keys.push(
      `proxy:${shortHash([String(p.proxy_type || '').toLowerCase(), host, String(p.proxy_port || ''), String(p.proxy_user || '')].join('|'))}`,
    );
  }
  const ip = String(profile?.ip || '').trim();
  if (ip) keys.push(`ip:${shortHash(ip)}`);
  return keys;
}

/**
 * The lock keys a job holds while it runs.
 *
 * `ipKeys` null means the profile's network identity is unknown; the job still
 * holds its account and profile.
 */
export function lockKeysFor(job, ipKeys) {
  const keys = [];
  if (job?.accountId) keys.push(`account:${job.accountId}`);
  if (job?.adsPowerProfileId) keys.push(`profile:${job.adsPowerProfileId}`);
  for (const k of ipKeys || []) keys.push(k);
  return [...new Set(keys)];
}

/**
 * Does a running job still count as running?
 *
 * By its heartbeat when it has one — a job beats every few seconds, so one
 * silent for `heartbeatStaleMs` belongs to a process that is gone. A job
 * claimed by an agent from before heartbeats existed has none, and is judged
 * by its claim time against the old windows instead.
 */
export function isLive(job, nowMs, { heartbeatStaleMs, legacyStaleMs }) {
  const beat = millis(job?.heartbeatAt);
  if (beat) return nowMs - beat < heartbeatStaleMs;
  const claimed = millis(job?.claimedAt);
  return !!claimed && nowMs - claimed < legacyStaleMs;
}

/**
 * The first key a candidate shares with a live running job, or null.
 *
 * `running` is `[{ id, data, keys }]`. `keys` is the job's stored `lockKeys`, or
 * — for a job claimed by an older agent that stored none — whatever the caller
 * could derive for it. Never less than its account and profile.
 */
export function findConflict(candidateKeys, running, nowMs, windows) {
  const want = new Set(candidateKeys);
  for (const r of running) {
    if (!isLive(r.data, nowMs, windows)) continue;
    const hit = (r.keys || []).find((k) => want.has(k));
    if (hit) return { key: hit, jobId: r.id };
  }
  return null;
}
