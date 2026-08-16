'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { db } from '@/lib/firebase/config';
import { subscribe } from '@/lib/data';
import { apiFetch, ApiError } from '@/lib/api';
import {
  draftFreshness,
  normalizeDraft,
  SKIP_STAGE_LABEL,
  type CommentDraftRecord,
} from '@/modules/reddit/commentKarma/drafts';
import {
  normalizeCommentSettings,
  scanReadiness,
  type CommentKarmaSettings,
} from '@/modules/reddit/commentKarma/settings';

// The Comment karma tab.
//
// Two things it must be honest about, because both are easy to imply and wrong:
//
//   1. APPROVING DOES NOT POST. Phase 5 owns the enqueue, the separate comment
//      counters and the agent's kind-specific allowlist. Until that lands, an
//      approval is a decision recorded and nothing else, and the panel says so
//      rather than letting a green tick imply a comment went out.
//
//   2. A SKIP IS NOT A FAILURE. Most scans produce no comment on purpose, so
//      the list is mostly skips — and if they were hidden, twenty scans with no
//      comment would look like a broken feature instead of a working one. They
//      are rendered compactly, with the stage they stopped at.

const MAX_ROWS = 40;

interface Props {
  accountId: string;
  saved: unknown;
  /** Communities tagged Comment on the Communities tab. */
  commentCommunities: string[];
  canManage: boolean;
}

function words(list: string[]): string {
  return list.join(', ');
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function CommentKarmaPanel({ accountId, saved, commentCommunities, canManage }: Props) {
  const [settings, setSettings] = useState<CommentKarmaSettings>(() => normalizeCommentSettings(saved));
  const [rows, setRows] = useState<CommentDraftRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  // Read once into state rather than during render: a clock read in a render
  // body is impure, and staleness would then change under any re-render.
  const [nowMs] = useState(() => Date.now());

  useEffect(() => {
    const q = query(
      collection(db, 'accounts', accountId, 'commentDrafts'),
      orderBy('createdAtMs', 'desc'),
      limit(MAX_ROWS),
    );
    return subscribe<Record<string, unknown> & { id: string }>(
      q,
      (docs) => {
        setRows(docs.map((d) => normalizeDraft(d.id, d)).filter((d): d is CommentDraftRecord => !!d));
        setLoaded(true);
      },
      (err) => {
        setError(err.message);
        setLoaded(true);
      },
    );
  }, [accountId]);

  const readiness = useMemo(() => scanReadiness(settings, commentCommunities), [settings, commentCommunities]);
  const pending = rows.filter((r) => r.status === 'pending');

  async function save(patch: Partial<CommentKarmaSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ settings: CommentKarmaSettings }>(
        `/api/accounts/${accountId}/comment-karma/settings`,
        { method: 'PUT', body: JSON.stringify({ settings: next }) },
      );
      // Take the server's normalised copy back, so a clamped number shows the
      // value that was actually stored rather than the one that was typed.
      setSettings(res.settings);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      setSettings(normalizeCommentSettings(saved));
    }
  }

  async function scan() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ outcome: { produced: boolean; skipReason: string }; autoApproved: boolean }>(
        `/api/accounts/${accountId}/comment-karma/scan`,
        { method: 'POST' },
      );
      setNotice(
        res.outcome.produced
          ? res.autoApproved
            ? 'Wrote a comment and approved it automatically. Nothing is posted yet — that is Phase 5.'
            : 'Wrote a comment. It is waiting for you below.'
          : `No comment this time — ${res.outcome.skipReason}`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The scan could not run.');
    } finally {
      setBusy(false);
    }
  }

  async function review(draftId: string, action: 'approve' | 'reject') {
    setError(null);
    try {
      await apiFetch(`/api/accounts/${accountId}/comment-karma/drafts/${draftId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, note: note[draftId] ?? '' }),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that.');
    }
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h3>Comment karma</h3>
        </div>
        <p className="text-dim small">
          Low-stakes, ordinary comments that build a comment history worth having, placed in the communities
          tagged <strong>Comment</strong>. It looks for a <em>gap</em> — what a thread wants and has not got —
          and copies its length and register from the comments already winning there.{' '}
          <strong>Most scans produce nothing, and that is the design:</strong> a system that always finds
          something to say posts filler, and filler is what gets an account spotted.
        </p>
        <p className="text-dim small">
          <strong>Nothing here posts.</strong> Approving marks a comment as the one to use; queueing it for the
          agent is the next piece of work.
        </p>

        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="small">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={!canManage}
              onChange={(e) => void save({ enabled: e.target.checked })}
            />{' '}
            Enabled for this account
          </label>
          <label className="small">
            <input
              type="checkbox"
              checked={settings.autoPost}
              disabled={!canManage || !settings.enabled}
              onChange={(e) => void save({ autoPost: e.target.checked })}
            />{' '}
            Approve automatically (no review)
          </label>
        </div>
        <p className="text-dim small">
          Auto and reviewed run the <em>same</em> pipeline and the same checks — the switch only decides who
          says yes at the end.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Who this account is</h3>
        </div>
        <p className="text-dim small">
          Fixed, not regenerated per comment. Only claim what this person could actually know — a persona that
          never overclaims can never be caught out.
        </p>
        <label className="field">
          <span>Situation</span>
          <textarea
            rows={2}
            defaultValue={settings.persona.situation}
            disabled={!canManage}
            placeholder="renting in Manchester, works shifts, into cycling"
            onBlur={(e) => void save({ persona: { ...settings.persona, situation: e.target.value } })}
          />
        </label>
        <label className="field">
          <span>Knows about (comma separated)</span>
          <input
            defaultValue={words(settings.persona.topics)}
            disabled={!canManage}
            placeholder="budgeting, renting, cycling"
            onBlur={(e) => void save({ persona: { ...settings.persona, topics: parseList(e.target.value) } })}
          />
        </label>
        <label className="field">
          <span>Must never claim to be</span>
          <input
            defaultValue={words(settings.persona.neverClaims)}
            disabled={!canManage}
            placeholder="a doctor, a lawyer, a parent"
            onBlur={(e) =>
              void save({ persona: { ...settings.persona, neverClaims: parseList(e.target.value) } })
            }
          />
        </label>
        <label className="field">
          <span>Never mention (brands, clients, domains)</span>
          <input
            defaultValue={words(settings.bannedTerms)}
            disabled={!canManage}
            onBlur={(e) => void save({ bannedTerms: parseList(e.target.value) })}
          />
          <span className="text-dim small">
            This account carries no narrative. A brand mention here is the whole reason comment karma and the
            growth pipeline share no code.
          </span>
        </label>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Rails</h3>
        </div>
        <p className="text-dim small">
          Separate from the account&rsquo;s posting cap on purpose — spending the posting budget on warm-up
          comments would starve the thing the account exists for.
        </p>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="field" style={{ maxWidth: 160 }}>
            <span>Comments per day</span>
            <input
              type="number"
              min={1}
              max={20}
              defaultValue={settings.dailyCap}
              disabled={!canManage}
              onBlur={(e) => void save({ dailyCap: Number(e.target.value) })}
            />
          </label>
          <label className="field" style={{ maxWidth: 180 }}>
            <span>Minimum gap (minutes)</span>
            <input
              type="number"
              min={15}
              max={1440}
              defaultValue={settings.minIntervalMinutes}
              disabled={!canManage}
              onBlur={(e) => void save({ minIntervalMinutes: Number(e.target.value) })}
            />
          </label>
          <label className="field" style={{ maxWidth: 200 }}>
            <span>Threads read per scan</span>
            <input
              type="number"
              min={1}
              max={8}
              defaultValue={settings.maxThreadsPerScan}
              disabled={!canManage}
              onBlur={(e) => void save({ maxThreadsPerScan: Number(e.target.value) })}
            />
            <span className="text-dim small">Every read is a billed call, including one for a deleted post.</span>
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Scans</h3>
          <button className="btn primary" disabled={!canManage || busy || !readiness.ok} onClick={() => void scan()}>
            <Search size={14} style={{ verticalAlign: '-2px' }} /> {busy ? 'Looking…' : 'Look for a comment'}
          </button>
        </div>
        {!readiness.ok && <p className="text-dim small">{readiness.reason}</p>}
        {error && <p className="text-error small">{error}</p>}
        {notice && <p className="small">{notice}</p>}
        {pending.length > 0 && (
          <p className="small">
            <strong>{pending.length}</strong> waiting for you.
          </p>
        )}

        {!loaded ? (
          <p className="text-dim small">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-dim small">
            Nothing yet. Each scan searches one Comment-tagged community, reads up to{' '}
            {settings.maxThreadsPerScan} thread(s) in full, and either writes one comment or records why it
            did not.
          </p>
        ) : (
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {rows.map((row) => {
              const fresh = draftFreshness(row.thread, nowMs);
              const isOpen = !!open[row.draftId];
              return (
                <li key={row.draftId} className="bordered" style={{ padding: 12, marginTop: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span className="small">
                      <button
                        className="btn-quiet small"
                        onClick={() => setOpen((o) => ({ ...o, [row.draftId]: !isOpen }))}
                        aria-label={isOpen ? 'Collapse' : 'Expand'}
                      >
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>{' '}
                      {row.thread ? (
                        <a href={row.thread.threadUrl} target="_blank" rel="noreferrer">
                          r/{row.thread.subreddit} — {row.thread.title.slice(0, 80)}
                        </a>
                      ) : (
                        <span className="text-dim">no thread</span>
                      )}
                    </span>
                    <span className="badge badge-no-dot">{row.status}</span>
                  </div>

                  {row.text ? (
                    <>
                      <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>{row.text}</p>
                      <p className="text-dim small">
                        {row.words} words{row.room ? ` · this room runs ${row.room.medianWinnerWords}` : ''}
                        {row.gap ? ` · they want ${row.gap.posterWant} · gap: ${row.gap.gapState}` : ''}
                        {row.autoApproved ? ' · approved automatically' : ''}
                      </p>
                      {fresh.stale && (
                        <p className="text-error small">
                          The thread is {Math.round(fresh.threadAgeHours)}h old — past the window this comment
                          was written for. Posting it now lands below the fold.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-dim small" style={{ margin: '8px 0' }}>
                      {row.skipStage ? SKIP_STAGE_LABEL[row.skipStage] : 'Skipped'} — {row.skipReason}
                    </p>
                  )}

                  {row.status === 'pending' && canManage && (
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <input
                        className="small"
                        placeholder="Why? (kept as training data)"
                        value={note[row.draftId] ?? ''}
                        onChange={(e) => setNote((n) => ({ ...n, [row.draftId]: e.target.value }))}
                        style={{ flex: 1, minWidth: 200 }}
                      />
                      <button className="btn primary" onClick={() => void review(row.draftId, 'approve')}>
                        <Check size={14} style={{ verticalAlign: '-2px' }} /> Approve
                      </button>
                      <button className="btn" onClick={() => void review(row.draftId, 'reject')}>
                        <X size={14} style={{ verticalAlign: '-2px' }} /> Reject
                      </button>
                    </div>
                  )}

                  {row.reviewNote && <p className="text-dim small">Note: {row.reviewNote}</p>}

                  {isOpen && (
                    <div className="small" style={{ marginTop: 8 }}>
                      {row.gap && (
                        <p className="text-dim">
                          <strong>Gap:</strong> {row.gap.angle} (confidence {row.gap.confidence})
                        </p>
                      )}
                      {row.criticReason && (
                        <p className="text-dim">
                          <strong>Critic:</strong> {row.criticReason}
                        </p>
                      )}
                      {row.trace.length > 0 && (
                        <>
                          <p className="text-dim">
                            <strong>What it did:</strong>
                          </p>
                          <ul className="text-dim">
                            {row.trace.map((t, i) => (
                              <li key={i}>{t}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {row.rejected.length > 0 && (
                        <>
                          <p className="text-dim">
                            <strong>Written and refused:</strong>
                          </p>
                          <ul className="text-dim">
                            {row.rejected.map((r, i) => (
                              <li key={i}>
                                “{r.text.slice(0, 140)}” — {r.failures.map((f) => f.code).join(', ')}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
