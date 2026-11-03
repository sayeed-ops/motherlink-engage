'use client';

import { useState } from 'react';
import { Check, ExternalLink, Sparkles, UserRound } from 'lucide-react';
import ArrayInput from '@/components/reddit/ArrayInput';
import { apiPost, ApiError } from '@/lib/api';
import {
  COMMUNITY_LIMITS,
  parsePersona,
  type CommunitySuggestion,
  type Persona,
} from '@/modules/reddit/communityFinder';

// Find communities for one account: approve a persona, review what the AI
// suggests for that whole person, and apply the ones you keep. Applied
// communities are Browse + Follow and wait for their check, which the account
// runs on its own visit before it joins.

const KIND_LABEL: Record<CommunitySuggestion['kind'], string> = {
  close: 'close to them',
  interest: 'interest',
  general: 'general',
};

const EMPTY: Persona = { summary: '', ageRange: '', occupation: '', location: '', interests: [], avoid: [] };

export default function CommunityFinder({
  accountId,
  account,
  onApplied,
}: {
  accountId: string;
  account: Record<string, unknown>;
  onApplied: () => void;
}) {
  const saved = parsePersona(account.persona);
  const [draft, setDraft] = useState<Persona | null>(null);
  const [hint, setHint] = useState('');
  const [suggestions, setSuggestions] = useState<(CommunitySuggestion & { keep: boolean; comment: boolean })[] | null>(null);
  const [busy, setBusy] = useState<'persona' | 'save' | 'suggest' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const url = `/api/accounts/${accountId}/warmup/finder`;
  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiError ? err.message : fallback);

  async function makePersona() {
    setBusy('persona');
    setError(null);
    try {
      setDraft((await apiPost<{ persona: Persona }>(url, { action: 'persona', hint })).persona);
    } catch (err) {
      fail(err, 'Could not create a persona.');
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!draft) return;
    setBusy('save');
    setError(null);
    try {
      await apiPost(url, { action: 'save-persona', persona: draft });
      setDraft(null);
      setSuggestions(null);
    } catch (err) {
      fail(err, 'Could not save the persona.');
    } finally {
      setBusy(null);
    }
  }

  async function suggest() {
    setBusy('suggest');
    setError(null);
    setNote(null);
    try {
      const r = await apiPost<{ suggestions: CommunitySuggestion[] }>(url, { action: 'suggest' });
      // Comments start off everywhere: allowing them is a deliberate choice.
      setSuggestions(r.suggestions.map((s) => ({ ...s, keep: true, comment: false })));
    } catch (err) {
      fail(err, 'Could not find communities.');
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    const picks = (suggestions ?? []).filter((s) => s.keep).map((s) => ({ name: s.name, keywords: s.keywords, comment: s.comment }));
    if (!picks.length) return;
    setBusy('apply');
    setError(null);
    try {
      const r = await apiPost<{ added: number; updated: number; full: string[] }>(url, { action: 'apply', picks });
      setSuggestions(null);
      setNote(
        `Added ${r.added}${r.updated ? `, updated ${r.updated}` : ''}. Each is checked on the account's first visit before it joins.` +
          (r.full.length ? ` The list is full, so ${r.full.map((n) => `r/${n}`).join(', ')} did not fit.` : ''),
      );
      onApplied();
    } catch (err) {
      fail(err, 'Could not add those communities.');
    } finally {
      setBusy(null);
    }
  }

  const editing = draft ?? null;
  const set = (patch: Partial<Persona>) => setDraft((d) => ({ ...(d ?? EMPTY), ...patch }));
  const kept = (suggestions ?? []).filter((s) => s.keep).length;

  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <Sparkles size={15} style={{ verticalAlign: '-2px' }} /> Find communities
        </h3>
      </div>
      <p className="text-dim small" style={{ marginTop: 0 }}>
        Communities that fit this account as a whole person, not only its niche. Any size is fine to join and browse.
        Comments are off unless you allow them, and a community you allow comments in must pass the check on the
        account&rsquo;s visit: {COMMUNITY_LIMITS.minWeeklyVisitors.toLocaleString()}–
        {COMMUNITY_LIMITS.maxWeeklyVisitors.toLocaleString()} weekly visitors, fewer than {COMMUNITY_LIMITS.maxModerators + 1}{' '}
        moderators, and no add-ons.
      </p>

      {/* 1. The persona */}
      {editing ? (
        <div className="stack bordered">
          <strong className="small">
            <UserRound size={13} style={{ verticalAlign: '-2px' }} /> Persona — edit anything, then approve
          </strong>
          <label className="field">
            <span>Who they are</span>
            <textarea rows={3} value={editing.summary} onChange={(e) => set({ summary: e.target.value })} />
          </label>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: 1, minWidth: 140 }}>
              <span>Age</span>
              <input value={editing.ageRange} onChange={(e) => set({ ageRange: e.target.value })} />
            </label>
            <label className="field" style={{ flex: 2, minWidth: 200 }}>
              <span>Job</span>
              <input value={editing.occupation} onChange={(e) => set({ occupation: e.target.value })} />
            </label>
            <label className="field" style={{ flex: 2, minWidth: 200 }}>
              <span>Lives in</span>
              <input value={editing.location} onChange={(e) => set({ location: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Interests</span>
            <ArrayInput value={editing.interests} onChange={(v) => set({ interests: v })} placeholder="hiking, baking…" />
          </label>
          <label className="field">
            <span>Never into</span>
            <ArrayInput value={editing.avoid} onChange={(v) => set({ avoid: v })} placeholder="gambling, politics…" />
          </label>
          <div className="row">
            <button className="btn btn-primary btn-sm" onClick={() => void approve()} disabled={busy !== null}>
              <Check size={13} /> {busy === 'save' ? 'Saving…' : 'Approve persona'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void makePersona()} disabled={busy !== null}>
              {busy === 'persona' ? 'Writing…' : 'Try another'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setDraft(null)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </div>
      ) : saved ? (
        <div className="stack bordered">
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <strong className="small">
              <UserRound size={13} style={{ verticalAlign: '-2px' }} /> {saved.occupation}, {saved.ageRange}, {saved.location}
            </strong>
            <button className="btn btn-ghost btn-sm" onClick={() => setDraft(saved)} disabled={busy !== null}>
              Edit persona
            </button>
          </div>
          <p className="small" style={{ margin: 0 }}>{saved.summary}</p>
          <p className="text-dim small" style={{ margin: 0 }}>
            Into {saved.interests.join(', ')}.{saved.avoid.length ? ` Never into ${saved.avoid.join(', ')}.` : ''}
          </p>
        </div>
      ) : (
        <div className="stack bordered">
          <p className="small" style={{ margin: 0 }}>
            Start with a persona: the AI invents an ordinary person for this account, living where its IP is.
          </p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="Optional guidance, e.g. works in UX, has a dog"
              style={{ flex: 1, minWidth: 240 }}
            />
            <button className="btn btn-primary btn-sm" onClick={() => void makePersona()} disabled={busy !== null}>
              {busy === 'persona' ? 'Writing…' : 'Create a persona'}
            </button>
          </div>
        </div>
      )}

      {/* 2. Suggestions */}
      {saved && !editing && !suggestions && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary btn-sm" onClick={() => void suggest()} disabled={busy !== null}>
            <Sparkles size={13} /> {busy === 'suggest' ? 'Finding…' : 'Find communities'}
          </button>
        </div>
      )}

      {suggestions && (
        <div className="stack" style={{ marginTop: 12 }}>
          <p className="text-dim small" style={{ margin: 0 }}>
            Open any you are unsure of. Before allowing comments in one, check it has under{' '}
            {COMMUNITY_LIMITS.maxWeeklyVisitors.toLocaleString()} weekly visitors, at most {COMMUNITY_LIMITS.maxModerators}{' '}
            moderators and no installed apps. The account checks again on its visit and will not join one that fails.
          </p>
          {suggestions.map((s, i) => (
            <div key={s.name} className="bordered" style={{ padding: '8px 12px', opacity: s.keep ? 1 : 0.5 }}>
              <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={s.keep}
                  onChange={(e) => setSuggestions((all) => all!.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))}
                />
                {/* A link inside the label opens the page without ticking the box. */}
                <a
                  href={`https://www.reddit.com/r/${s.name}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="strong-link small"
                  title="Open the community to check its weekly visitors, moderators and installed apps"
                >
                  r/{s.name} <ExternalLink size={11} style={{ verticalAlign: '-1px' }} />
                </a>
                <span className="badge badge-no-dot">{KIND_LABEL[s.kind]}</span>
                <span className="text-dim small">{s.why}</span>
              </label>
              {s.keep && (
                <label
                  className="small"
                  style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, paddingLeft: 26, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={s.comment}
                    onChange={(e) => setSuggestions((all) => all!.map((x, j) => (j === i ? { ...x, comment: e.target.checked } : x)))}
                  />
                  Allow comments
                  <span className="text-dim">{s.comment ? '· must pass the check before joining' : '· join and browse only'}</span>
                </label>
              )}
              {s.keep && (
                <div style={{ marginTop: 6, paddingLeft: 26 }}>
                  <ArrayInput
                    value={s.keywords}
                    onChange={(v) => setSuggestions((all) => all!.map((x, j) => (j === i ? { ...x, keywords: v.slice(0, 3) } : x)))}
                    placeholder="keywords that would bring it up in search"
                  />
                </div>
              )}
            </div>
          ))}
          <div className="row">
            <button className="btn btn-primary btn-sm" onClick={() => void apply()} disabled={busy !== null || !kept}>
              {busy === 'apply' ? 'Applying…' : `Apply ${kept}`}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void suggest()} disabled={busy !== null}>
              {busy === 'suggest' ? 'Finding…' : 'Suggest others'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSuggestions(null)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-error small" style={{ margin: '8px 0 0' }}>{error}</p>}
      {note && <p className="small" style={{ margin: '8px 0 0', color: 'var(--success, #16a34a)' }}>{note}</p>}
    </section>
  );
}
