'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Users, Trash2, Pencil, X, KeyRound } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { apiPost, apiPatch, apiFetch, ApiError } from '@/lib/api';
import { subscribe, subscribeDoc, q, agentStatusPath } from '@/lib/data';
import { accountPostGate } from '@/modules/reddit/accountGate';
import { useAuth } from '@/lib/context/AuthContext';
import type { RedditAccountStatus } from '@/modules/reddit/types';

// Posting identities — the Reddit accounts the tool can post FROM.
//
// No credentials are stored: the login lives in the account's AdsPower browser
// profile on the posting Mac, opened by `adsPowerProfileId`; `username` is only
// the wrong-account safeguard. This page manages that mapping plus each
// account's behavioural rails (daily cap, min interval, status).
//
// Reads go straight to Firestore (accounts carry no secrets, so any signed-in
// user may read them); every write goes through a server route gated on
// accounts.manage. The posting queue and the local agent that drains it are NOT
// built yet — publishing moves last, after parity sign-off — so this is
// identity + rails management only.

const STATUSES: RedditAccountStatus[] = ['active', 'warming', 'flagged', 'banned'];
const STATUS_BADGE: Record<RedditAccountStatus, string> = {
  active: 'badge-success',
  warming: 'badge-warning',
  flagged: 'badge-warning',
  banned: 'badge',
};

interface Account {
  accountId: string;
  label: string;
  username: string;
  adsPowerProfileId: string;
  status: RedditAccountStatus;
  dailyCap: number;
  minIntervalMinutes: number;
  karma: number;
  notes: string;
  postCountToday: number;
  postCountResetAtMs: number;
  lastPostAtMs: number;
}

interface FormState {
  label: string;
  username: string;
  adsPowerProfileId: string;
  status: RedditAccountStatus;
  dailyCap: number;
  minIntervalMinutes: number;
  karma: number;
  notes: string;
}

const EMPTY_FORM: FormState = {
  label: '',
  username: '',
  adsPowerProfileId: '',
  status: 'warming',
  dailyCap: 5,
  minIntervalMinutes: 45,
  karma: 0,
  notes: '',
};

const ms = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

export default function AccountsPage() {
  const { profile } = useAuth();
  const canManage =
    profile?.role === 'owner' ||
    profile?.role === 'admin' ||
    !!profile?.globalPermissions?.includes('accounts.manage');

  const [raw, setRaw] = useState<Record<string, unknown>[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tick so the gate's time-based states (interval, rolling window) and the
  // agent chip's freshness re-evaluate.
  const [now, setNow] = useState(0);
  const [agent, setAgent] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10000);
    const unsub = subscribe<Record<string, unknown>>(q.accounts(), setRaw, (e) => setError(e.message));
    const unsubAgent = subscribeDoc<Record<string, unknown>>(agentStatusPath, setAgent);
    return () => {
      clearInterval(t);
      unsub();
      unsubAgent();
    };
  }, []);

  // Online = heartbeat within 20s (the agent polls every ~5s). No agent is wired
  // to Engage yet, so this reads offline until one is running.
  const agentSeenMs =
    agent?.lastSeenAt && typeof agent.lastSeenAt === 'object' && 'toMillis' in agent.lastSeenAt
      ? (agent.lastSeenAt as { toMillis(): number }).toMillis()
      : 0;
  const agentOnline = agentSeenMs > 0 && (now || Date.now()) - agentSeenMs < 20000;

  const accounts = useMemo<Account[] | null>(() => {
    if (raw === null) return null;
    return raw
      .map((a) => ({
        accountId: a.id as string,
        label: (a.label as string) ?? '',
        username: (a.username as string) ?? '',
        adsPowerProfileId: (a.adsPowerProfileId as string) ?? '',
        status: (a.status as RedditAccountStatus) ?? 'warming',
        dailyCap: (a.dailyCap as number) ?? 0,
        minIntervalMinutes: (a.minIntervalMinutes as number) ?? 0,
        karma: (a.karma as number) ?? 0,
        notes: (a.notes as string) ?? '',
        postCountToday: (a.postCountToday as number) ?? 0,
        postCountResetAtMs: ms(a.postCountResetAt),
        lastPostAtMs: ms(a.lastPostAt),
      }))
      .sort((x, y) => x.label.localeCompare(y.label));
  }, [raw]);

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setShowForm(true);
  }

  function openEdit(a: Account) {
    setEditingId(a.accountId);
    setForm({
      label: a.label,
      username: a.username,
      adsPowerProfileId: a.adsPowerProfileId,
      status: a.status,
      dailyCap: a.dailyCap,
      minIntervalMinutes: a.minIntervalMinutes,
      karma: a.karma,
      notes: a.notes,
    });
    setError(null);
    setShowForm(true);
  }

  async function save() {
    if (!form.label.trim() || !form.adsPowerProfileId.trim()) {
      setError('Label and AdsPower profile ID are required.');
      return;
    }
    setBusy(true);
    setError(null);
    const payload = {
      label: form.label.trim(),
      username: form.username.trim(),
      adsPowerProfileId: form.adsPowerProfileId.trim(),
      status: form.status,
      dailyCap: Number(form.dailyCap) || 1,
      minIntervalMinutes: Number(form.minIntervalMinutes) || 0,
      karma: Number(form.karma) || 0,
      notes: form.notes.trim(),
    };
    try {
      if (editingId) await apiPatch(`/api/accounts/${editingId}`, payload);
      else await apiPost('/api/accounts', payload);
      setShowForm(false);
      setForm(EMPTY_FORM);
      setEditingId(null);
      // The subscription reflects the change; no reload.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the account.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: Account) {
    if (!confirm(`Delete account "${a.label}"? This does not delete any posted replies.`)) return;
    setError(null);
    try {
      await apiFetch(`/api/accounts/${a.accountId}`, { method: 'DELETE' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the account.');
    }
  }

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Reddit identities the tool can post from. Each posts through its own AdsPower profile on its own sticky IP — no passwords are stored here."
        action={
          canManage && !showForm ? (
            <button className="btn btn-primary btn-sm" onClick={openCreate}>
              <Plus size={14} /> Add account
            </button>
          ) : undefined
        }
      />

      <div className="sections">
        <div className="agent-chip">
          <span className={`dot ${agentOnline ? 'on' : 'off'}`} />
          {agentOnline ? (
            <span className="small">
              <strong>Posting agent online</strong>
              <span className="text-dim">
                {' '}
                · {String(agent?.queued ?? 0)} queued · {String(agent?.postedSession ?? 0)} posted this
                session{agent?.dryRun ? ' · DRY-RUN' : ''}
              </span>
            </span>
          ) : (
            <span className="small">
              <strong className="text-error">Posting agent offline</strong>
              <span className="text-dim"> · queued replies wait until the local agent is running</span>
            </span>
          )}
        </div>

        {error && !showForm && <p className="text-error small">{error}</p>}

        {showForm && (
          <section className="card">
            <div className="card-head">
              <h3>{editingId ? 'Edit account' : 'New account'}</h3>
              <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setShowForm(false)} aria-label="Close">
                <X size={14} />
              </button>
            </div>

            <div className="grid-form">
              <label className="field">
                <span>Label</span>
                <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Growth – budgetlee" />
              </label>
              <label className="field">
                <span>Reddit username</span>
                <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="budgetlee_app" />
              </label>
              <label className="field">
                <span>AdsPower profile ID</span>
                <input value={form.adsPowerProfileId} onChange={(e) => setForm({ ...form, adsPowerProfileId: e.target.value })} placeholder="e.g. k1abcd23" />
              </label>
              <label className="field">
                <span>Status</span>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as RedditAccountStatus })}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Daily cap (posts / 24h)</span>
                <input type="number" min={1} value={form.dailyCap} onChange={(e) => setForm({ ...form, dailyCap: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Min interval (minutes)</span>
                <input type="number" min={0} value={form.minIntervalMinutes} onChange={(e) => setForm({ ...form, minIntervalMinutes: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Karma (manual)</span>
                <input type="number" value={form.karma} onChange={(e) => setForm({ ...form, karma: Number(e.target.value) })} />
              </label>
            </div>

            <label className="field" style={{ maxWidth: 640, marginTop: 14 }}>
              <span>Notes</span>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Followed subs, persona, anything to remember." />
            </label>

            <div className="bordered stack" style={{ marginTop: 14 }}>
              <div className="row">
                <KeyRound size={13} className="text-faint" />
                <strong className="small">How posting works for this account</strong>
              </div>
              <p className="text-dim small">
                Posting is done by the local agent (runs on the posting Mac next to AdsPower). It opens
                the AdsPower profile — required — and types and submits the reply. No passwords are stored
                here; the login lives in the profile. Reddit username is optional but recommended: the
                agent checks the open profile is that handle and aborts if not. The queue and agent are
                not built yet — this manages the identity and its rails only.
              </p>
            </div>

            {error && <p className="text-error small">{error}</p>}

            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : editingId ? 'Save changes' : 'Create account'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </section>
        )}

        {accounts === null && <p className="text-dim small">Loading…</p>}

        {accounts && accounts.length === 0 && !showForm && (
          <div className="card">
            <div className="empty">
              <Users size={20} className="text-faint" />
              <p>No accounts yet.</p>
              <p className="text-dim small">
                {canManage
                  ? "Add the Reddit accounts you'll post value and brand replies from."
                  : 'No posting identities have been added.'}
              </p>
            </div>
          </div>
        )}

        {accounts && accounts.length > 0 && (
          <div className="account-grid">
            {accounts.map((a) => {
              const gate = accountPostGate(a, now || Date.now());
              return (
                <article key={a.accountId} className="card">
                  <div className="card-head">
                    <div style={{ minWidth: 0 }}>
                      <strong>{a.label}</strong>
                      {a.username && <div className="text-dim small">u/{a.username}</div>}
                    </div>
                    <span className={`badge ${STATUS_BADGE[a.status]}`}>{a.status}</span>
                  </div>

                  <div className="row" style={{ flexWrap: 'wrap', gap: 6, margin: '4px 0 12px' }}>
                    <span className="badge badge-no-dot">
                      {gate.remainingToday}/{a.dailyCap} left today
                    </span>
                    <span className="badge badge-no-dot">{a.minIntervalMinutes}m gap</span>
                    <span className="badge badge-no-dot">{a.karma} karma</span>
                    <span className="badge badge-no-dot">
                      {a.adsPowerProfileId ? `profile: ${a.adsPowerProfileId}` : 'no profile id'}
                    </span>
                  </div>

                  {!gate.ok && <p className="text-warning small">{gate.reason}</p>}
                  {a.lastPostAtMs > 0 && (
                    <p className="text-faint small">Last post: {new Date(a.lastPostAtMs).toLocaleString()}</p>
                  )}
                  {a.notes && <p className="text-muted small clamp">{a.notes}</p>}

                  {canManage && (
                    <div className="row" style={{ marginTop: 12 }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(a)}>
                        <Pencil size={12} /> Edit
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => remove(a)}>
                        <Trash2 size={12} /> Delete
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
