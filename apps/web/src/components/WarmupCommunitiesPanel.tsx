'use client';

import { useMemo, useState } from 'react';
import { Plus, X, FolderSync, Save, UserPlus, Dices, PlayCircle, Ban } from 'lucide-react';
import { apiPut, apiPost, ApiError } from '@/lib/api';
import { useProjects } from '@/lib/useProjects';
import ArrayInput from '@/components/reddit/ArrayInput';
import WarmupLoopView from './WarmupLoopView';
import {
  composeWarmupSession,
  joinChanceForSession,
  type FollowPolicy,
  type WarmupPolicy,
} from '@/modules/reddit/warmupWalk';
import {
  COMMUNITY_ROLES,
  COMMUNITY_ROLE_LABEL,
  COMMUNITY_ROLE_HELP,
  MAX_WARMUP_COMMUNITIES,
  communitiesForRole,
  keywordsByCommunity,
  normalizeSubredditName,
  type WarmupCommunity,
  type WarmupCommunityRole,
} from '@/modules/reddit/subreddits';

// COMMUNITIES — which subreddits this account touches, what each is for, and how
// it accumulates them.
//
// These used to be two tabs and that was wrong: you chose what to follow in one
// place and tuned how following happens in another, with no way to see the effect
// of either on the other. They are one decision.
//
// ONE TAGGED LIST, NOT FOUR. Each row is a subreddit plus what it is FOR, so the
// same machinery does generic karma farming or client-niche commenting; the
// difference is a tag rather than a code path.
//
// JOINING IS A BUDGET SPENT INSIDE THE BROWSING WALK, never a session of its own —
// a person does not open Reddit in order to follow something. The account has to
// arrive in the community and actually look at it first. That is what makes
// "8 joins and 1 browse in a day" unrepresentable rather than merely unlikely.

const errText = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;

export default function WarmupCommunitiesPanel({
  accountId,
  initial,
  initialKeywords,
  followed,
  savedPolicy,
  day,
  canManage,
}: {
  accountId: string;
  initial: WarmupCommunity[];
  initialKeywords: string[];
  /** Confirmed memberships, read back from Reddit — not what we attempted. */
  followed: string[];
  savedPolicy: WarmupPolicy;
  day: number;
  canManage: boolean;
}) {
  const { projects } = useProjects();
  const [rows, setRows] = useState<WarmupCommunity[]>(initial);
  const [pool, setPool] = useState<string[]>(initialKeywords);
  const [follow, setFollow] = useState<FollowPolicy>(savedPolicy.follow);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [projectId, setProjectId] = useState('');
  // SEEDED RANDOMLY PER PAGE LOAD — do not put this back to 0. The sample
  // session sent to "Run one now" is drawn from the spread below, whose seeds
  // are `4_100_000 + i + nonce * 977`; at nonce 0 that is a fixed set, so every
  // follow roll queued from a freshly-loaded page was the SAME WALK — and the
  // same one on every account, since nothing here depends on which account it
  // is. See the longer note in WarmupLoopPanel.tsx; this is the same defect and
  // this tab is where the 2026-08-15 duplicate sessions were queued from.
  const [nonce, setNonce] = useState(() => 1 + Math.floor(Math.random() * 1_000_000));
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Compared against what is SAVED, not a flag set on every keystroke — a flag
  // still says "unsaved" after you undo your own edit.
  const listDirty = useMemo(
    () => JSON.stringify(rows) !== JSON.stringify(initial) || JSON.stringify(pool) !== JSON.stringify(initialKeywords),
    [rows, initial, pool, initialKeywords],
  );
  const paceDirty = useMemo(
    () => JSON.stringify(follow) !== JSON.stringify(savedPolicy.follow),
    [follow, savedPolicy.follow],
  );
  const dirty = listDirty || paceDirty;

  const followedSet = useMemo(() => new Set(followed), [followed]);
  const followTagged = useMemo(() => communitiesForRole(rows, 'follow').length, [rows]);

  const discoverPct = useMemo(() => {
    const { keyword_search: k, name_search: n } = follow.routeWeights;
    const total = k + n;
    return total > 0 ? Math.round((k / total) * 100) : 0;
  }, [follow.routeWeights]);

  /** Follow targets that CANNOT be discovered by topic — no keywords of their
   *  own and no global pool to fall back on. These silently degrade to a name
   *  search however high the topic-discovery setting is, which is the usual
   *  reason a run looks like it is "always searching by name". */
  const undiscoverable = useMemo(() => {
    if (pool.length) return [];
    return rows.filter((r) => r.roles.includes('follow') && !r.keywords?.length).map((r) => r.name);
  }, [rows, pool]);
  const joinTargets = useMemo(
    () => communitiesForRole(rows, 'follow').filter((s) => !followedSet.has(s)),
    [rows, followedSet],
  );

  const counts = useMemo(() => {
    const out = {} as Record<WarmupCommunityRole, number>;
    for (const role of COMMUNITY_ROLES) out[role] = rows.filter((r) => r.roles.includes(role)).length;
    return out;
  }, [rows]);

  // Mirrors the run route's composition exactly. If these drift, the same seed
  // produces two different plans and the preview stops meaning anything.
  const policy: WarmupPolicy = useMemo(
    () => ({
      ...savedPolicy,
      follow,
      subreddits: communitiesForRole(rows, 'browse'),
      searchTargets: communitiesForRole(rows, 'browse'),
      joinTargets,
      keywords: pool,
      keywordsByCommunity: keywordsByCommunity(rows),
    }),
    [savedPolicy, follow, rows, joinTargets, pool],
  );

  /** 200 sessions. A rate near 10% cannot be read off one sample. */
  const spread = useMemo(() => {
    // FOLLOW rolls. Every one attempts a join — that is what separates this
    // tab's runs from the Browsing loop's, which can never join. The spread
    // shows what a follow roll LOOKS like; it is no longer measuring a rate,
    // because the rate is now the package designer's decision.
    const sessions = Array.from({ length: 50 }, (_, i) =>
      composeWarmupSession({ day, policy, seed: 4_100_000 + i + nonce * 977, kind: 'follow' }),
    );
    const usable = sessions.filter((r) => !r.blocked);
    // Count the DISCOVERY LEGS, not every search step. `search_subreddit` is
    // also an ordinary browsing anchor, so counting raw steps would conflate
    // "how did it reach the community it means to join" with "where else did it
    // wander" — and make 100% topic discovery look like 92%.
    //
    // The leg's own route already reflects the degrade: a target with no keyword
    // available is rewritten to a name search when the intent is drawn.
    let byTopic = 0;
    let byName = 0;
    for (const s of usable) {
      for (const leg of s.joinIntent?.legs ?? []) {
        if (leg.route === 'keyword_search') byTopic++;
        else byName++;
      }
    }
    return {
      total: sessions.length,
      joining: usable.filter((r) => r.joinsPlanned.length > 0).length,
      two: usable.filter((r) => r.joinsPlanned.length === 2).length,
      byTopic,
      byName,
      blocked: sessions[0]?.blocked ?? '',
      sample: usable.find((r) => r.joinsPlanned.length > 0) ?? null,
    };
  }, [day, policy, nonce]);

  const chance = joinChanceForSession(follow, day);

  function addDraft() {
    const name = normalizeSubredditName(draft);
    if (!name) return;
    setDraft('');
    setNote(null);
    if (rows.some((r) => r.name === name)) return setError(`r/${name} is already on the list.`);
    if (rows.length >= MAX_WARMUP_COMMUNITIES) return setError(`Capped at ${MAX_WARMUP_COMMUNITIES} communities.`);
    setError(null);
    // Browse-only to start. Widening is one click; a row that arrives already
    // authorised to post is the kind of default nobody audits.
    setRows([...rows, { name, roles: ['browse'] }]);
  }

  function toggleRole(name: string, role: WarmupCommunityRole) {
    setNote(null);
    setRows(
      rows.map((r) =>
        r.name !== name
          ? r
          : {
              ...r,
              // Rebuilt through COMMUNITY_ROLES so order stays canonical however
              // roles were toggled on and off.
              roles: COMMUNITY_ROLES.filter((x) => (x === role ? !r.roles.includes(role) : r.roles.includes(x))),
            },
      ),
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const empty = rows.filter((r) => !r.roles.length).map((r) => r.name);
      const res = await apiPut<{ communities: WarmupCommunity[]; keywords: string[] }>(
        `/api/accounts/${accountId}/warmup/communities`,
        { communities: rows, keywords: pool },
      );
      if (paceDirty) await apiPut(`/api/accounts/${accountId}/warmup/policy`, { policy: { ...savedPolicy, follow } });
      setRows(res.communities);
      setPool(res.keywords);
      setNote(
        empty.length
          ? `Saved. Dropped ${empty.map((n) => `r/${n}`).join(', ')} — a community tagged for nothing is never visited.`
          : 'Saved.',
      );
    } catch (e) {
      setError(errText(e, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  }

  async function syncFromProject() {
    if (!projectId) return;
    setSyncing(true);
    setError(null);
    setNote(null);
    try {
      const res = await apiPost<{
        communities: WarmupCommunity[];
        keywords: string[];
        added: string[];
        widened: string[];
        addedKeywords: string[];
      }>(`/api/accounts/${accountId}/warmup/communities`, { projectId });
      setRows(res.communities);
      setPool(res.keywords);
      setNote(
        res.added.length || res.widened.length || res.addedKeywords.length
          ? [
              res.added.length ? `Added ${res.added.map((n) => `r/${n}`).join(', ')}` : '',
              res.widened.length ? `widened ${res.widened.map((n) => `r/${n}`).join(', ')}` : '',
              res.addedKeywords.length ? `${res.addedKeywords.length} new keyword(s)` : '',
            ]
              .filter(Boolean)
              .join(' · ')
          : 'Already in sync — nothing to add.',
      );
    } catch (e) {
      setError(errText(e, 'Could not sync from that project.'));
    } finally {
      setSyncing(false);
    }
  }

  /** Queue the session shown below — by SEED, so what runs is what is on screen.
   *
   *  Requires a clean save first. The server rebuilds the walk from the SAVED
   *  community list, so running with unsaved edits would compose from different
   *  inputs and the preview would be a different session than the one that ran. */
  async function runThisOne() {
    if (!spread.sample) return;
    setQueueing(true);
    setError(null);
    setNote(null);
    try {
      const res = await apiPost<{ jobId: string }>(`/api/accounts/${accountId}/warmup/run`, {
        kind: 'follow',
        day,
        seed: spread.sample.seed,
        follow,
      });
      setNote(`Queued this exact session (${res.jobId.slice(0, 6)}…). The agent picks it up within a poll (~5s).`);
    } catch (e) {
      setError(errText(e, 'Could not queue the session.'));
    } finally {
      setQueueing(false);
    }
  }

  /** Release a session that is queued or stuck.
   *
   *  Needed because restarting the agent mid-run leaves a job claimed forever
   *  from the app's side, and every later run is then refused. Only ever touches
   *  warm-up jobs — a queued reply is not cancellable from here. */
  async function cancelInFlight() {
    setCancelling(true);
    setError(null);
    setNote(null);
    try {
      const res = await apiPost<{ message: string }>(`/api/accounts/${accountId}/warmup/cancel`, {});
      setNote(res.message);
    } catch (e) {
      setError(errText(e, 'Could not cancel.'));
    } finally {
      setCancelling(false);
    }
  }

  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="card">
        <div className="card-head">
          <h3>Communities</h3>
          {canManage && dirty && (
            <button className="btn primary" onClick={save} disabled={saving}>
              <Save size={14} style={{ verticalAlign: '-2px' }} /> {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>

        <p className="text-dim small" style={{ marginTop: 0 }}>
          One list, tagged by what each community is <em>for</em>. Every warm-up component draws only the rows tagged
          for it, so the same machinery serves a client&rsquo;s niche or a casual karma sub — the difference is a tag.
        </p>

        {error && (
          <p className="small" style={{ color: 'var(--error, #dc2626)', marginTop: 0 }}>
            {error}
          </p>
        )}
        {note && (
          <p className="small" style={{ color: 'var(--success, #16a34a)', marginTop: 0 }}>
            {note}
          </p>
        )}

        {canManage && (
          <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <input
              value={draft}
              placeholder="budget"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addDraft();
                }
              }}
              style={{ width: 220 }}
            />
            <button className="btn" onClick={addDraft} disabled={!draft.trim()}>
              <Plus size={14} style={{ verticalAlign: '-2px' }} /> Add
            </button>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-dim small" style={{ marginTop: 0 }}>
            No communities yet. Until at least one is tagged <strong>Browse</strong>, every session can only enter via
            Home, r/popular and r/news — which is what a brand-new account genuinely looks like, but not what an account
            being warmed toward a client should look like for long.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {rows.map((row) => (
              <div key={row.name} className="bordered" style={{ padding: '8px 12px' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="small" style={{ fontWeight: 500, minWidth: 160 }}>
                    r/{row.name}
                    {followedSet.has(row.name) && (
                      <span className="badge badge-no-dot" style={{ marginLeft: 6 }}>
                        following
                      </span>
                    )}
                  </span>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', flex: 1 }}>
                    {COMMUNITY_ROLES.map((role) => {
                      const on = row.roles.includes(role);
                      return (
                        <button
                          key={role}
                          className="chip"
                          title={COMMUNITY_ROLE_HELP[role]}
                          onClick={() => canManage && toggleRole(row.name, role)}
                          disabled={!canManage}
                          style={{
                            cursor: canManage ? 'pointer' : 'default',
                            border: '1px solid var(--border)',
                            background: on ? 'var(--surface-2)' : 'none',
                            opacity: on ? 1 : 0.45,
                          }}
                        >
                          <span className="small">{COMMUNITY_ROLE_LABEL[role]}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="btn-quiet small"
                    onClick={() => setOpenRow(openRow === row.name ? null : row.name)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    {row.keywords?.length ? `${row.keywords.length} keyword(s)` : 'keywords'}
                  </button>
                  {canManage && (
                    <button
                      onClick={() => setRows(rows.filter((r) => r.name !== row.name))}
                      aria-label={`Remove r/${row.name}`}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                {openRow === row.name && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                    <p className="text-dim small" style={{ margin: '0 0 6px' }}>
                      Topics expected to surface r/{row.name} in Reddit search. This is what lets the account find it by
                      searching a subject rather than its name — and it is the <em>only</em> way the composer can know
                      one query might reach two of your communities, since it cannot see search results.
                    </p>
                    <ArrayInput
                      value={row.keywords ?? []}
                      onChange={(v) => setRows(rows.map((r) => (r.name === row.name ? { ...r, keywords: v } : r)))}
                      placeholder="budget tips, saving money…"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <p className="text-dim small" style={{ marginBottom: 0, marginTop: 12 }}>
            {COMMUNITY_ROLES.map((r) => `${counts[r]} ${COMMUNITY_ROLE_LABEL[r].toLowerCase()}`).join(' · ')} ·{' '}
            {rows.length}/{MAX_WARMUP_COMMUNITIES}
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Topics this account searches</h3>
        </div>
        <p className="text-dim small" style={{ marginTop: 0 }}>
          The fallback pool, used when a community has no keywords of its own. Searching a subreddit by name assumes the
          account already knew it existed — searching a topic is how someone actually finds one.
        </p>
        <ArrayInput value={pool} onChange={setPool} placeholder="budget tips, meal prep…" />
      </section>

      {canManage && (
        <section className="card">
          <div className="card-head">
            <h3>
              <FolderSync size={15} style={{ verticalAlign: '-2px' }} /> Sync from a project
            </h3>
          </div>
          <p className="text-dim small" style={{ marginTop: 0 }}>
            Pulls a project&rsquo;s target subreddits in as <strong>Browse + Follow</strong>, and its keywords into the
            pool above. It merges and never narrows — an account warmed for one client keeps that client&rsquo;s
            communities when it is later warmed for another, and a role you granted by hand is never taken away.
            Commenting and posting stay opt-in per community.
          </p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: 280 }}>
              <option value="">Choose a project…</option>
              {(projects ?? []).map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className="btn" onClick={syncFromProject} disabled={!projectId || syncing}>
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h3>
            <UserPlus size={15} style={{ verticalAlign: '-2px' }} /> How it joins them
          </h3>
        </div>
        <p className="text-dim small" style={{ marginTop: 0 }}>
          Joining is a budget spent <em>inside</em> a browsing session, never a session of its own — a person does not
          open Reddit in order to follow something. The account has to arrive in the community and actually look at it
          first, so this is a ceiling on intent rather than a schedule.
        </p>

        <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="small" style={{ display: 'grid', gap: 4 }}>
            Joins per week
            <input
              type="number"
              min={0}
              max={25}
              step={0.5}
              value={follow.joinsPerWeek}
              onChange={(e) => setFollow({ ...follow, joinsPerWeek: num(e.target.value, 3) })}
              style={{ width: 110 }}
            />
          </label>
          <label className="small" style={{ display: 'grid', gap: 4 }}>
            Dwell before joining (s)
            <input
              type="number"
              min={5}
              max={180}
              value={follow.minDwellSec}
              onChange={(e) => setFollow({ ...follow, minDwellSec: num(e.target.value, 25) })}
              style={{ width: 110 }}
            />
          </label>
          <label className="small" style={{ display: 'grid', gap: 4 }}>
            Read a post first (%)
            <input
              type="number"
              min={0}
              max={100}
              value={Math.round(follow.readPostFirstChance * 100)}
              onChange={(e) => setFollow({ ...follow, readPostFirstChance: num(e.target.value, 65) / 100 })}
              style={{ width: 110 }}
            />
          </label>
          {/* ONE slider, not two weights. Exposing keyword_search alone meant
              name_search stayed at its own value, so "100% topic search" still
              produced name searches and there was no way to reach either
              extreme. This sets both halves. */}
          <label className="small" style={{ display: 'grid', gap: 4 }}>
            Discover by topic (%)
            <input
              type="number"
              min={0}
              max={100}
              value={discoverPct}
              onChange={(e) => {
                const pct = Math.max(0, Math.min(100, Math.round(num(e.target.value, 80))));
                setFollow({ ...follow, routeWeights: { keyword_search: pct, name_search: 100 - pct } });
              }}
              style={{ width: 110 }}
            />
          </label>
        </div>

        <label className="small row" style={{ gap: 8, marginTop: 14, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={follow.onboardingBurst}
            onChange={(e) => setFollow({ ...follow, onboardingBurst: e.target.checked })}
          />
          <span>
            Onboarding burst — join faster for the first {follow.burstDays} days.{' '}
            <span className="text-dim">
              Normal for a genuinely new account, since Reddit&rsquo;s own signup pushes you to pick interests. Wrong
              for an aged account being repurposed.
            </span>
          </span>
        </label>

        {/* THE POOL IS FINITE and a follow roll is not interchangeable with a
            browsing one. Say so plainly here rather than letting an operator
            discover it from a run that appeared to succeed. */}
        {joinTargets.length === 0 ? (
          <div className="bordered" style={{ padding: 12, marginTop: 14, borderColor: 'var(--error, #dc2626)' }}>
            <p className="small" style={{ margin: 0, color: 'var(--error, #dc2626)' }}>
              <strong>Nothing left to join.</strong>{' '}
              {followTagged === 0
                ? 'No community on this account is tagged Follow — tag some above, or sync from a project.'
                : `This account already follows all ${followTagged} community/communities tagged Follow. Add more, or sync from a project.`}{' '}
              A following session will refuse to run rather than quietly browsing instead.
            </p>
          </div>
        ) : (
          <div className="bordered" style={{ padding: 12, marginTop: 14 }}>
            <p className="text-dim small" style={{ margin: 0 }}>
              <strong>{joinTargets.length}</strong> still to join
              {followed.length > 0 && <>, {followed.length} already followed</>}. Every following session joins one (or
              two, from a single search) — the pace below is guidance for the package designer, which decides how much
              of a day is following rather than browsing.
              <br />
              As a mix: about <strong>{(chance * 100).toFixed(0)}%</strong> of a day&rsquo;s rolls, i.e.{' '}
              {follow.joinsPerWeek} a week
              {follow.onboardingBurst && day <= follow.burstDays && <> (onboarding burst active)</>}.
            </p>
          </div>
        )}

        {/* Cross-session spacing has no enforcer until the designer exists — the
            composer used to guarantee it when joins were a per-session rate, and
            that guarantee moved out with the split. Until then, say it. */}
        {joinTargets.length > 0 && (
          <p className="text-dim small" style={{ marginTop: 10, marginBottom: 0 }}>
            Nothing paces these for you yet. Each run joins one community immediately, so spread them out by hand —
            several in an hour is a pattern no amount of in-session realism hides.
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>
            <Dices size={15} style={{ verticalAlign: '-2px' }} /> What that produces
          </h3>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setNonce((n) => n + 1)}>
              Re-roll
            </button>
            {canManage && (
              <button className="btn" onClick={cancelInFlight} disabled={cancelling} title="Release a queued or stuck session">
                <Ban size={14} style={{ verticalAlign: '-2px' }} /> {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
            {canManage && (
              <button
                className="btn primary"
                onClick={runThisOne}
                disabled={queueing || dirty || !spread.sample}
                title={
                  dirty
                    ? 'Save first — the agent composes from the saved list'
                    : !spread.sample
                      ? 'None of these 200 sessions joins anything'
                      : ''
                }
              >
                <PlayCircle size={14} style={{ verticalAlign: '-2px' }} />{' '}
                {queueing ? 'Queueing…' : 'Run a session that joins'}
              </button>
            )}
          </div>
        </div>

        <p className="text-dim small" style={{ marginTop: 0 }}>
          {spread.total} <strong>following</strong> sessions composed in your browser at day {day}. Every one of them
          sets out to join — these are not browsing sessions that happened to. The spread shows how differently they
          get there.
        </p>
        <ul style={{ margin: '0 0 12px', paddingLeft: 18 }}>
          <li className="text-dim small">
            {spread.joining} of {spread.total} reach a community and join it
            {spread.joining < spread.total && <> — the rest ran out of session before they got there</>}
          </li>
          <li className="text-dim small">{spread.two} join two, from a single search that surfaced both</li>
          <li className="text-dim small">
            reached <strong>{spread.byTopic}</strong> by searching a topic, <strong>{spread.byName}</strong> by
            searching the community name — you asked for {discoverPct}% topic
            {spread.byTopic + spread.byName > 0 && (
              <>
                {' '}
                and got{' '}
                {Math.round((spread.byTopic / (spread.byTopic + spread.byName)) * 100)}%
              </>
            )}
          </li>
        </ul>

        {/* THE GAP BETWEEN ASKED AND GOT. A follow target with no keywords has
            nothing to type, so it degrades to a name search no matter how high
            the topic setting is — which is exactly what "it only searches by
            name" looks like from outside. */}
        {undiscoverable.length > 0 && (
          <div className="bordered" style={{ padding: 12, marginBottom: 12, borderColor: 'var(--error, #dc2626)' }}>
            <p className="small" style={{ margin: 0, color: 'var(--error, #dc2626)' }}>
              <strong>
                {undiscoverable.length} community/communities tagged Follow cannot be discovered by topic
              </strong>{' '}
              — {undiscoverable.slice(0, 6).map((n) => `r/${n}`).join(', ')}
              {undiscoverable.length > 6 && ` and ${undiscoverable.length - 6} more`}. They have no keywords of their
              own and there is nothing in the topic pool, so the account can only reach them by typing the exact name —
              which assumes it already knew the community existed. Add keywords to those rows, or fill the topic pool
              above.
            </p>
          </div>
        )}

        {dirty && (
          <p className="small" style={{ color: 'var(--text-muted)', marginTop: 0 }}>
            Unsaved changes — save before running, or the agent would compose from the saved list and run a different
            session than the one below.
          </p>
        )}

        {spread.sample ? (
          <>
            <span className="eyebrow-muted">
              One that joins — this exact session is what &ldquo;Run this one now&rdquo; queues
            </span>
            <WarmupLoopView
              plan={spread.sample.plan}
              day={spread.sample.day}
              upvoteChance={spread.sample.upvoteChance}
              upvoteBudget={spread.sample.upvoteBudget}
              stoppedBy={spread.sample.stoppedBy}
            />
          </>
        ) : (
          <p className="text-dim small" style={{ marginBottom: 0 }}>
            None of these 200 sessions joined anything — expected when no community is tagged Follow, or when the pace
            is very low. Re-roll, or raise joins per week.
          </p>
        )}
      </section>
    </div>
  );
}
