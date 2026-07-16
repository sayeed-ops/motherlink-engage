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
  const accountRef = (id) => db.collection('accounts').doc(id);
  const draftRef = (projectId, draftId) => db.collection('projects').doc(projectId).collection('drafts').doc(draftId);
  const itemRef = (projectId, itemId) => db.collection('projects').doc(projectId).collection('items').doc(itemId);

  return {
    accountRef,

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

    async failJob(ref, error) {
      await ref.update({
        status: 'failed',
        error: String(error).slice(0, 500),
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

    /** On a real post: job → posted, draft → posted (+ attribution), item →
     *  drafted, account counters advanced — atomically. */
    async writeSuccess(ref, job, account, permalink) {
      const nowMs = Date.now();
      const link = permalink || job.threadUrl;
      const batch = db.batch();
      batch.update(ref, {
        status: 'posted',
        permalink: link,
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
