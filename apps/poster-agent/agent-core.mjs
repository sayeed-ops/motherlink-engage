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
    // KIND-AWARE. A warm-up session is capped at 12 minutes by MAX_WALL_SEC, so
    // one still claimed after ~15 is certainly dead — usually because the agent
    // was restarted mid-run. Making it wait the POSTING window (20 min, sized for
    // 4-7 minute replies plus headroom) blocks every further session for that
    // account with nothing to show for the delay.
    //
    // The messages differ too, and that matters: a stranded reply might already
    // be live on Reddit and must be checked before retrying, while a stranded
    // browse posted nothing and needs no such care.
    async reclaimStalePosting(staleMs, nowMs, warmupStaleMs = staleMs) {
      const snap = await jobs().where('status', '==', 'posting').limit(20).get();
      let cleared = 0;
      for (const d of snap.docs) {
        const isWarmup = d.data().kind === 'warmup';
        const limit = isWarmup ? warmupStaleMs : staleMs;
        const claimedMs = d.data().claimedAt?.toMillis?.() ?? 0;
        if (claimedMs && nowMs - claimedMs < limit) continue;
        const ok = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(d.ref);
          if (!fresh.exists || fresh.data().status !== 'posting') return false;
          const cMs = fresh.data().claimedAt?.toMillis?.() ?? 0;
          if (cMs && nowMs - cMs < limit) return false;
          tx.update(d.ref, {
            status: 'failed',
            error: isWarmup
              ? 'Agent stopped mid-session — the browse was abandoned. Nothing was posted; just run another when you want one.'
              : 'Agent stopped mid-post — outcome unknown. Check Reddit before using Post again (it may already be up).',
            completedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return true;
        });
        if (ok) cleared += 1;
      }
      return cleared;
    },

    /** Heartbeat so the app's Accounts page shows the agent online.
     *
     *  `current` is what the agent is doing RIGHT NOW — { jobId, subreddit,
     *  expectedUsername, startedAtMs, stage } — or null/omitted when idle. The UI
     *  needs it because `queued` alone cannot distinguish "waiting for an agent"
     *  from "being worked on this very second", and a humanized job runs for
     *  minutes. Omitting it deletes the field, so idle is never stale.
     *
     *  Called on a TIMER during a job, not just once per poll — see the
     *  heartbeat ticker in index.mjs. */
    async heartbeat({ dryRun, queued, postedSession, pid, current }) {
      try {
        await agentDoc().set(
          {
            lastSeenAt: FieldValue.serverTimestamp(),
            dryRun,
            queued,
            postedSession,
            pid,
            current: current ?? FieldValue.delete(),
          },
          { merge: true },
        );
      } catch {
        // non-fatal — a heartbeat failure must never stop posting
      }
    },

    /** Claim the oldest queued job in a transaction (so two pollers can't grab
     *  the same one). Returns { ref, job, queued }.
     *
     *  `queued` is the number STILL waiting after this claim — the claimed job is
     *  excluded, because it is no longer waiting for anything, it's running. (It
     *  used to include it, which is why the UI showed a frozen "1 queued" for the
     *  whole length of a job.) `job` is the claimed doc's data, returned from
     *  inside the transaction so the caller needs no second read.
     *
     *  Caveat: the count comes from a limit(20) page, so `queued` saturates at 19
     *  once a backlog gets that deep. Fine for a UI chip; don't use it as a total. */
    async claimOldestQueued() {
      const snap = await jobs().where('status', '==', 'queued').limit(20).get();
      const size = snap.size;
      if (snap.empty) return { ref: null, job: null, queued: 0 };
      // POSTS BEFORE WARM-UPS, then oldest first.
      //
      // There is exactly one agent draining this queue and a warm-up browse can
      // legitimately run 20 minutes. Without this, one warm-up session parks
      // every queued reply behind it across every project. A reply is a person
      // waiting on an answer; a warm-up session is never urgent and loses
      // nothing by going second.
      const rank = (d) => ((d.data().kind ?? 'post') === 'warmup' ? 1 : 0);
      const docs = snap.docs.sort(
        (a, b) =>
          rank(a) - rank(b) || (a.data().createdAt?.toMillis?.() ?? 0) - (b.data().createdAt?.toMillis?.() ?? 0),
      );
      for (const d of docs) {
        const job = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(d.ref);
          if (!fresh.exists || fresh.data().status !== 'queued') return null;
          tx.update(d.ref, {
            status: 'posting',
            claimedAt: FieldValue.serverTimestamp(),
            attempts: (fresh.data().attempts || 0) + 1,
            updatedAt: FieldValue.serverTimestamp(),
          });
          return fresh.data();
        });
        if (job) return { ref: d.ref, job, queued: size - 1 };
      }
      return { ref: null, job: null, queued: size };
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

    /** Finish a warm-up session.
     *
     *  'completed', NOT 'posted'. A browse posts nothing, and calling it posted
     *  would put it in the Dashboard's "replies made" counts and lie about what
     *  the account did. It also advances NO account counters: dailyCap and
     *  minIntervalMinutes govern submitted comments, and letting a browse consume
     *  a posting slot would silently throttle real replies.
     *
     *  The run record is appended under the ACCOUNT, not the job, because the
     *  useful question later is "how have this account's sessions been going",
     *  which is per-account history — the same shape as statSnapshots. */
    async completeWarmupRun(ref, job, { trace, summary }) {
      const batch = db.batch();
      batch.update(ref, {
        status: 'completed',
        ...(Array.isArray(trace) && trace.length ? { approachTrace: trace } : {}),
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (job.accountId) {
        // THE EXPERIENCE CLOCK. The ramp reads the LOWER of two clocks: calendar
        // age, and how many sessions have actually been completed. Age alone let
        // an account left idle for a week act like a day-8 account having run
        // three sessions in its life.
        //
        // A counter rather than a count() of warmupRuns: the panel's own
        // subscription is capped at 30 rows, so counting there would silently
        // under-report past that, and an aggregate query per compose is a read
        // for a number we can just keep.
        //
        // Accounts with runs predating this field start at 0 and are therefore
        // treated as less experienced than they are. That is the SAFE direction
        // — an under-counted account is less bold than it earned, never more.
        // CONFIRMED joins only. `joined` is set from re-reading the button AFTER
        // the click, so a click that silently failed never reaches this list.
        // Recording an attempt here would be worse than recording nothing: the
        // composer skips communities it believes are already joined, so a false
        // entry means that community is never joined and nothing ever says so.
        const confirmedJoins = (Array.isArray(trace) ? trace : [])
          .filter((t) => t && t.type === 'join_subreddit' && t.joined === true && t.subreddit)
          .map((t) => String(t.subreddit));

        batch.update(accountRef(job.accountId), {
          warmupSessionsCompleted: FieldValue.increment(1),
          ...(confirmedJoins.length
            ? { followedSubreddits: FieldValue.arrayUnion(...confirmedJoins) }
            : {}),
          updatedAt: FieldValue.serverTimestamp(),
        });

        const runRef = accountRef(job.accountId).collection('warmupRuns').doc();
        batch.set(runRef, {
          runId: runRef.id,
          jobId: ref.id,
          day: job.warmupDay ?? null,
          plan: Array.isArray(job.warmupPlan) ? job.warmupPlan : [],
          trace: Array.isArray(trace) ? trace : [],
          // `summary` carries dryRun from the agent's live switch. Do NOT add a
          // job.dryRun fallback here — nothing writes that field, so it would
          // silently record every dry run as a live one.
          ...summary,
          ranAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    },

    /** Merge communities read from the account's own nav into the known-followed
     *  list. UNION ONLY — never a replacement. The parse behind it is best-effort
     *  against markup that drifts, and an incomplete read costs a wasted
     *  discovery leg (which the run-time button check turns into a no-op), while
     *  a wrong replacement would mark a community as followed that never was and
     *  it would then never be joined. */
    async mergeFollowedSubreddits(accountId, subs) {
      const clean = [...new Set((subs || []).map((s) => String(s).toLowerCase()).filter(Boolean))];
      if (!clean.length) return;
      await accountRef(accountId).update({
        followedSubreddits: FieldValue.arrayUnion(...clean),
        followedSubredditsAt: FieldValue.serverTimestamp(),
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
