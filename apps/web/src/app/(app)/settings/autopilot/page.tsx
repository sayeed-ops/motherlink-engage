'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/context/AuthContext';
import { DEFAULT_AUTOPILOT, type AutopilotSettings, type AutopilotStage } from '@/modules/reddit/autopilot';

// The warm-up autopilot's numbers, team-wide: the stage ladder, sessions a day,
// waking hours, how often a day is skipped. Every account on autopilot follows
// them from its next planned day. Switching an account on or off is on its own
// Warm-up → Autopilot tab.

interface TickResult {
  accountId: string;
  label: string;
  outcome: string;
  detail: string;
}

export default function AutopilotSettingsPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';
  const [saved, setSaved] = useState<AutopilotSettings | null>(null);
  const [form, setForm] = useState<AutopilotSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [results, setResults] = useState<TickResult[] | null>(null);

  useEffect(() => {
    apiGet<AutopilotSettings>('/api/autopilot/settings')
      .then((s) => {
        setSaved(s);
        setForm(s);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the settings.'));
  }, []);

  if (!form || !saved) return <p className="text-dim small">{error ?? 'Loading…'}</p>;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  const setStage = (i: number, patch: Partial<AutopilotStage>) =>
    setForm({ ...form, stages: form.stages.map((s, k) => (k === i ? { ...s, ...patch } : s)) });

  async function save(next = form) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const s = await apiPost<AutopilotSettings>('/api/autopilot/settings', next);
      setSaved(s);
      setForm(s);
      setNote('Saved. Accounts on autopilot use these from their next planned day.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function planNow() {
    setBusy(true);
    setError(null);
    try {
      setResults((await apiPost<{ results: TickResult[] }>('/api/autopilot/plan', {})).results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the planner.');
    } finally {
      setBusy(false);
    }
  }

  const n = (v: string) => (v === '' ? 0 : Number(v));

  return (
    <>
      <PageHeader
        title="Autopilot"
        description="How every account on autopilot warms up by itself, day by day. Switch an account on from its Warm-up → Autopilot tab."
        crumbs={[{ label: 'Settings' }, { label: 'Autopilot' }]}
      />
      <div className="sections">
        {!isAdmin && (
          <div className="card">
            <p className="text-dim small">Read-only — these numbers change every account at once, so they are for owners and admins.</p>
          </div>
        )}

        <section className="card">
          <div className="card-head">
            <h3>Stages</h3>
          </div>
          <p className="text-dim small">
            An account moves up by calendar day since its warm-up began. Sessions a day is a range; each day picks a
            number in it. &ldquo;Joins&rdquo; lets sessions join the communities tagged Follow. Comments come with the
            next step of the autopilot.
          </p>
          <table className="table small">
            <thead>
              <tr>
                <th>Stage</th>
                <th>From day</th>
                <th>Sessions a day</th>
                <th>Joins</th>
              </tr>
            </thead>
            <tbody>
              {form.stages.map((s, i) => (
                <tr key={i}>
                  <td>
                    <input value={s.name} disabled={!isAdmin} onChange={(e) => setStage(i, { name: e.target.value })} style={{ width: 140 }} />
                  </td>
                  <td>
                    <input type="number" min={1} value={s.fromDay} disabled={!isAdmin || i === 0} onChange={(e) => setStage(i, { fromDay: n(e.target.value) })} style={{ width: 70 }} />
                  </td>
                  <td>
                    <input type="number" min={0} max={8} value={s.sessionsMin} disabled={!isAdmin} onChange={(e) => setStage(i, { sessionsMin: n(e.target.value) })} style={{ width: 60 }} />
                    {' – '}
                    <input type="number" min={0} max={8} value={s.sessionsMax} disabled={!isAdmin} onChange={(e) => setStage(i, { sessionsMax: n(e.target.value) })} style={{ width: 60 }} />
                  </td>
                  <td>
                    <input type="checkbox" checked={s.follow} disabled={!isAdmin} onChange={(e) => setStage(i, { follow: e.target.checked })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>The day</h3>
          </div>
          <div className="grid-form">
            <label className="field">
              <span>Waking hours start</span>
              <input type="time" value={form.wakeStart} disabled={!isAdmin} onChange={(e) => setForm({ ...form, wakeStart: e.target.value })} />
            </label>
            <label className="field">
              <span>Waking hours end</span>
              <input type="time" value={form.wakeEnd} disabled={!isAdmin} onChange={(e) => setForm({ ...form, wakeEnd: e.target.value })} />
            </label>
            <label className="field">
              <span>Days off (% of days with no warm-up)</span>
              <input
                type="number"
                min={0}
                max={90}
                value={Math.round(form.skipDayChance * 100)}
                disabled={!isAdmin}
                onChange={(e) => setForm({ ...form, skipDayChance: n(e.target.value) / 100 })}
              />
            </label>
            <label className="field">
              <span>Joining session (% of days, when allowed)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={Math.round(form.followSessionChance * 100)}
                disabled={!isAdmin}
                onChange={(e) => setForm({ ...form, followSessionChance: n(e.target.value) / 100 })}
              />
            </label>
            <label className="field">
              <span>Default time zone</span>
              <input value={form.defaultTimezone} disabled={!isAdmin} onChange={(e) => setForm({ ...form, defaultTimezone: e.target.value })} placeholder="Europe/London" />
            </label>
          </div>
          <div className="grid-form" style={{ marginTop: 12 }}>
            <label className="field">
              <span>Short session = under (minutes)</span>
              <input
                type="number"
                min={1}
                max={10}
                value={form.shortSessionMinutes}
                disabled={!isAdmin}
                onChange={(e) => setForm({ ...form, shortSessionMinutes: n(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>After this many short sessions in a row, plan a longer one (0 = off)</span>
              <input
                type="number"
                min={0}
                max={10}
                value={form.shortStreakMax}
                disabled={!isAdmin}
                onChange={(e) => setForm({ ...form, shortStreakMax: n(e.target.value) })}
              />
            </label>
          </div>
          <p className="text-dim small">
            Short sessions are normal — people open Reddit, scroll once and leave. A run of nothing but short ones is
            not, so after that many in a row the next session is re-rolled until it is longer.
          </p>
          <p className="text-dim small">
            Waking hours are in each account&apos;s own time zone — set it on the account&apos;s Autopilot tab to match its
            proxy; until then it uses the default. Sessions are at least 75 minutes apart and never in the next 10.
          </p>
        </section>

        {error && <p className="text-error small">{error}</p>}
        {note && <p className="text-dim small">{note}</p>}

        {isAdmin && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={() => save()} disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            {dirty && (
              <button className="btn btn-ghost btn-sm" onClick={() => setForm(saved)} disabled={busy}>
                Discard changes
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setForm(DEFAULT_AUTOPILOT)} disabled={busy}>
              Back to the defaults
            </button>
          </div>
        )}

        {isAdmin && (
          <section className="card">
            <div className="card-head">
              <h3>Plan now</h3>
              <button className="btn btn-secondary btn-sm" onClick={planNow} disabled={busy}>
                Plan now
              </button>
            </div>
            <p className="text-dim small">
              Plans today for every account on autopilot whose day is due. The live site does this by itself every few
              minutes; on a local dev server this button is the only trigger.
            </p>
            {results && results.length === 0 && <p className="text-dim small">No account is on autopilot.</p>}
            {results && results.length > 0 && (
              <ul className="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {results.map((r) => (
                  <li key={r.accountId}>
                    <strong>{r.label}</strong> — {r.outcome === 'not-due' ? 'nothing to plan yet' : r.outcome}
                    {r.detail ? `: ${r.detail}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </>
  );
}
