// Poster agent — Firestore logic, Engage schema. No browser, no side effects.
//
// This is the half of the agent that changed in the port from ML Studio: the
// collection paths. Everything is keyed off the job (which carries projectId),
// so it maps cleanly onto Engage's nested model:
//
//   ML Studio (flat)            Engage (nested / renamed)
//   reddit_agent_status/agent   agents/agent
//   reddit_post_jobs            jobs
//   reddit_accounts             accounts
//   reddit_drafts/{id}          projects/{projectId}/drafts/{id}
//   reddit_posts/{postId}       projects/{projectId}/items/{postId}   (postId == itemId)
//
// db / FieldValue / Timestamp are injected so this module has no dependency on a
// firebase-admin instance and can be exercised by the self-test.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Same rails as the app's accountPostGate, evaluated on the agent's fresh read
 *  of the account. `hard` blocks kill the job; a soft block (interval) defers. */
export function gate(account, nowMs) {
  const resetMs = account.postCountResetAt?.toMillis?.() ?? 0;
  const windowExpired = !resetMs || nowMs - resetMs >= DAY_MS;
  const usedToday = windowExpired ? 0 : account.postCountToday || 0;
  const remaining = Math.max(0, (account.dailyCap || 0) - usedToday);
  const lastMs = account.lastPostAt?.toMillis?.() ?? 0;
  const intervalMs = (account.minIntervalMinutes || 0) * 60 * 1000;
  if (account.status === 'banned') return { ok: false, hard: true, reason: 'Account banned.' };
  if (account.status === 'flagged') return { ok: false, hard: true, reason: 'Account flagged.' };
  if (remaining <= 0) return { ok: false, hard: true, reason: `Daily cap reached (${account.dailyCap}).` };
  if (lastMs && nowMs - lastMs < intervalMs)
    return { ok: false, hard: false, reason: `Min interval not elapsed (${account.minIntervalMinutes}m).` };
  return { ok: true };
}

/** Rolling-window counter advance, mirroring the app so UI and agent agree. */
export function nextCounters(account, nowMs, Timestamp, FieldValue) {
  const resetMs = account.postCountResetAt?.toMillis?.() ?? 0;
  const windowExpired = !resetMs || nowMs - resetMs >= DAY_MS;
  return {
    postCountToday: (windowExpired ? 0 : account.postCountToday || 0) + 1,
    postCountResetAt: windowExpired ? Timestamp.fromMillis(nowMs) : account.postCountResetAt,
    lastPostAt: Timestamp.fromMillis(nowMs),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export function createStore({ db, FieldValue, Timestamp }) {
  const jobs = () => db.collection('jobs');
  const agentDoc = () => db.collection('agents').doc('agent');
  const controlDoc = () => db.collection('agents').doc('control');
  const accountRef = (id) => db.collection('accounts').doc(id);
  const draftRef = (projectId, draftId) => db.collection('projects').doc(projectId).collection('drafts').doc(draftId);
  const itemRef = (projectId, itemId) => db.collection('projects').doc(projectId).collection('items').doc(itemId);

  return {
    accountRef,

    /** Live dry-run switch, set from the web UI (agents/control.dryRun). Returns
     *  the boolean when set, or null when the operator hasn't chosen — the caller
     *  then falls back to the env default. Read every poll so a UI toggle takes
     *  effect within one poll interval, no restart. */
    async readDryRunOverride() {
      try {
        const snap = await controlDoc().get();
        const v = snap.exists ? snap.data().dryRun : undefined;
        return typeof v === 'boolean' ? v : null;
      } catch {
        return null; // never let a control-read failure change posting behaviour
      }
    },

    /** Live posting-surface switch (agents/control.postSurface = 'old' | 'new').
     *  Re-read every poll so it can flip without a restart, exactly like dryRun.
     *  Returns the value when validly set, else null (caller falls back to env).
     *  While new reddit is being proven, the env default stays 'old' — the whole
     *  point of the flag is instant rollback if the new path misbehaves. */
    async readSurfaceOverride() {
      try {
        const snap = await controlDoc().get();
        const v = snap.exists ? snap.data().postSurface : undefined;
        return v === 'old' || v === 'new' ? v : null;
      } catch {
        return null; // never let a control-read failure change posting behaviour
      }
    },

    /** Seed the control doc once so the UI has a value to toggle. create() fails
     *  if it already exists, so an operator's earlier choice is never clobbered. */
    async ensureControl(defaultDryRun) {
      try {
        await controlDoc().create({
          dryRun: defaultDryRun,
          updatedBy: 'agent',
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch {
        /* already exists (or transient) — leave the operator's value alone */
      }
    },

    /** Un-stick jobs orphaned in 'posting' — claimed by an agent that died (or was
     *  Ctrl+C'd) mid-post before it could write success/fail. Older than staleMs
     *  ⇒ mark 'failed', NOT 're-queued'. Auto-requeue would double-post any job
     *  that had actually submitted before the crash (success wasn't recorded, but
     *  the comment went up). So we surface it as failed and let the operator check
     *  Reddit and Post again from the UI. Returns the number cleared. */
    async reclaimStalePosting(staleMs, nowMs) {
      const snap = await jobs().where('status', '==', 'posting').limit(20).get();
      let cleared = 0;
      for (const d of snap.docs) {
        const claimedMs = d.data().claimedAt?.toMillis?.() ?? 0;
        if (claimedMs && nowMs - claimedMs < staleMs) continue;
        const ok = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(d.ref);
          if (!fresh.exists || fresh.data().status !== 'posting') return false;
          const cMs = fresh.data().claimedAt?.toMillis?.() ?? 0;
          if (cMs && nowMs - cMs < staleMs) return false;
          tx.update(d.ref, {
            status: 'failed',
            error: 'Agent stopped mid-post — outcome unknown. Check Reddit before using Post again (it may already be up).',
            completedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return true;
        });
        if (ok) cleared += 1;
      }
      return cleared;
    },

    /** Heartbeat so the app's Accounts page shows the agent online. */
    async heartbeat({ dryRun, queued, postedSession, pid }) {
      try {
        await agentDoc().set(
          { lastSeenAt: FieldValue.serverTimestamp(), dryRun, queued, postedSession, pid },
          { merge: true },
        );
      } catch {
        // non-fatal — a heartbeat failure must never stop posting
      }
    },

    /** Claim the oldest queued job in a transaction (so two pollers can't grab
     *  the same one). Returns { ref, size }. */
    async claimOldestQueued() {
      const snap = await jobs().where('status', '==', 'queued').limit(20).get();
      const size = snap.size;
      if (snap.empty) return { ref: null, size };
      const docs = snap.docs.sort(
        (a, b) => (a.data().createdAt?.toMillis?.() ?? 0) - (b.data().createdAt?.toMillis?.() ?? 0),
      );
      for (const d of docs) {
        const claimed = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(d.ref);
          if (!fresh.exists || fresh.data().status !== 'queued') return false;
          tx.update(d.ref, {
            status: 'posting',
            claimedAt: FieldValue.serverTimestamp(),
            attempts: (fresh.data().attempts || 0) + 1,
            updatedAt: FieldValue.serverTimestamp(),
          });
          return true;
        });
        if (claimed) return { ref: d.ref, size };
      }
      return { ref: null, size };
    },

    async failJob(ref, error, approachTrace) {
      await ref.update({
        status: 'failed',
        error: String(error).slice(0, 500),
        // How far the approach got before it broke — kept alongside the plan so a
        // failed job shows the intended route AND where reality diverged.
        ...(Array.isArray(approachTrace) && approachTrace.length ? { approachTrace } : {}),
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    },

    /** Put a job back to queued (interval not elapsed) so it re-checks next poll
     *  against live account settings. */
    async deferJob(ref) {
      await ref.update({
        status: 'queued',
        claimedAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    },

    /** Persist a Reddit-side stats snapshot captured IN-SESSION (karma,
     *  subscriptions, account age) on the account's own profile/IP. Writes the
     *  latest onto the account doc, seeds the frozen baseline on first capture,
     *  clears any pending refresh request, and appends an immutable history point
     *  under accounts/{id}/statSnapshots. `snap` is the plain-number AccountStats
     *  the browser read; `capturedAtMs` is stamped here if absent. Never throws
     *  into the posting path — the caller wraps it and treats failure as non-fatal. */
    async writeAccountStats(accountId, snap, nowMs) {
      const capturedAtMs = snap.capturedAtMs || nowMs;
      const stats = {
        linkKarma: Number(snap.linkKarma) || 0,
        commentKarma: Number(snap.commentKarma) || 0,
        totalKarma: Number(snap.totalKarma) || 0,
        subscriptions: Number.isFinite(snap.subscriptions) ? snap.subscriptions : -1,
        redditCreatedAtMs: Number(snap.redditCreatedAtMs) || 0,
        capturedAtMs,
        source: 'agent-session',
      };
      const ref = accountRef(accountId);
      const cur = await ref.get();
      if (!cur.exists) return;
      const update = {
        stats,
        statsRefreshRequestedAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!cur.data().statsBaseline) update.statsBaseline = stats; // freeze first-ever capture
      await ref.update(update);
      // Append-only history point (id = capture time for natural ordering).
      await ref.collection('statSnapshots').doc(String(capturedAtMs)).set({ snapshotId: String(capturedAtMs), ...stats });
    },

    /** On a real post: job → posted, draft → posted (+ attribution), item →
     *  drafted, account counters advanced — atomically. */
    async writeSuccess(ref, job, account, permalink, approachTrace) {
      const nowMs = Date.now();
      const link = permalink || job.threadUrl;
      const batch = db.batch();
      batch.update(ref, {
        status: 'posted',
        permalink: link,
        // The approach this reply was actually posted through, kept permanently
        // next to the plan. A posted comment then carries its whole history:
        // what was intended, and what really happened.
        ...(Array.isArray(approachTrace) && approachTrace.length ? { approachTrace } : {}),
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.update(draftRef(job.projectId, job.draftId), {
        status: 'posted',
        postedByAccountId: job.accountId,
        postedPermalink: link,
        postedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.update(itemRef(job.projectId, job.postId), { processingStatus: 'drafted' });
      batch.update(accountRef(job.accountId), nextCounters(account, nowMs, Timestamp, FieldValue));
      await batch.commit();
    },
  };
}
