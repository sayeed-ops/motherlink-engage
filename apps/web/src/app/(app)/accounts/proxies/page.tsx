'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Copy, Plus, RefreshCw, Terminal, Trash2, TriangleAlert, X } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { apiFetch, apiGet, apiPost, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/context/AuthContext';
import {
  COPY_TYPE_LABEL,
  COPY_TYPES,
  flagOf,
  placeOf,
  statusOf,
  type CopyType,
  type PoolEntry,
  type PoolStatus,
} from '@/modules/accounts/proxyPool';

// The proxy list: every proxy we pay for, where it comes out, and who uses it.
//
// "Used" is detected: an Engage account linked to the entry, or any AdsPower
// profile on it. A note covers a proxy used somewhere neither can see. Copy
// hands over the full proxy, which is the only time a password leaves the server.

type Filter = 'all' | PoolStatus;
type Formats = Record<CopyType, { url: string; curl: string }>;

const COPY_KEY = 'motherlink-engage:proxies:copy-as';

const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

export default function ProxiesPage() {
  const { profile } = useAuth();
  const canManage =
    profile?.role === 'owner' || profile?.role === 'admin' || !!profile?.globalPermissions?.includes('accounts.manage');

  const [entries, setEntries] = useState<PoolEntry[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copyAs, setCopyAs] = useState<CopyType>('https');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(COPY_KEY) as CopyType | null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved && COPY_TYPES.includes(saved)) setCopyAs(saved);
    } catch {}
  }, []);

  function chooseCopyAs(t: CopyType) {
    setCopyAs(t);
    try {
      localStorage.setItem(COPY_KEY, t);
    } catch {}
  }

  const load = useCallback(async () => {
    try {
      setEntries((await apiGet<{ entries: PoolEntry[] }>('/api/proxies')).entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the proxy list.');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function check(keys: string[]) {
    for (const key of keys) {
      setBusy(`check:${key}`);
      await apiPost(`/api/proxies/${encodeURIComponent(key)}`, { action: 'check' }).catch(() => {});
    }
    setBusy(null);
    await load();
  }

  async function add() {
    setBusy('add');
    setError(null);
    setNote(null);
    try {
      const r = await apiPost<{ added: number; updated: number; keys: string[]; errors: { line: number; error: string }[] }>(
        '/api/proxies',
        { text },
      );
      setText('');
      setAdding(false);
      setNote(
        `Added ${r.added}, updated ${r.updated}.` +
          (r.errors.length ? ` Skipped line${r.errors.length === 1 ? '' : 's'} ${r.errors.map((e) => e.line).join(', ')}.` : '') +
          ' Checking their IPs…',
      );
      await load();
      await check(r.keys);
      setNote(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add those proxies.');
      setBusy(null);
    }
  }

  async function copy(e: PoolEntry, what: 'url' | 'curl') {
    setError(null);
    try {
      const r = await apiPost<{ formats: Formats }>(`/api/proxies/${encodeURIComponent(e.key)}`, { action: 'reveal' });
      await navigator.clipboard.writeText(r.formats[copyAs][what]);
      setCopied(`${what}:${e.key}`);
      setTimeout(() => setCopied(null), 1600);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not copy that proxy.');
    }
  }

  async function editNote(e: PoolEntry) {
    const next = prompt(
      'Who uses this proxy outside Engage and AdsPower? Leave empty to clear the note.',
      e.note,
    );
    if (next === null) return;
    setBusy(`note:${e.key}`);
    try {
      await apiPost(`/api/proxies/${encodeURIComponent(e.key)}`, { action: 'note', note: next });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that note.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(e: PoolEntry) {
    if (!confirm(`Take port ${e.port} off the list?`)) return;
    try {
      await apiFetch(`/api/proxies/${encodeURIComponent(e.key)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that proxy.');
    }
  }

  const count = (s: Filter) => (entries ?? []).filter((e) => s === 'all' || statusOf(e) === s).length;
  const shown = (entries ?? []).filter((e) => filter === 'all' || statusOf(e) === filter);

  async function dispose(e: PoolEntry, disposed: boolean) {
    const why = disposed ? prompt('Why is this IP disposed? For example: Wasim 3 banned.', '') : '';
    if (why === null) return;
    setBusy(`dispose:${e.key}`);
    try {
      await apiPost(`/api/proxies/${encodeURIComponent(e.key)}`, { action: 'dispose', disposed, note: why });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that proxy.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Proxies"
        description="Every proxy, where it comes out, and which account uses it. Copy one from here when setting up an account."
        crumbs={[{ label: 'Accounts', href: '/accounts' }, { label: 'Proxies' }]}
        action={
          canManage ? (
            <div className="row">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => void check((entries ?? []).map((e) => e.key))}
                disabled={!!busy || !entries?.length}
              >
                <RefreshCw size={14} /> Check all IPs
              </button>
              {!adding && (
                <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
                  <Plus size={14} /> Add proxies
                </button>
              )}
            </div>
          ) : undefined
        }
      />

      <div className="sections">
        {adding && (
          <section className="card">
            <div className="card-head">
              <h3>Add proxies</h3>
              <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setAdding(false)} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            <p className="text-dim small">
              One per line, as the provider gives them: <code>https://user:pass@host:port</code>,{' '}
              <code>host:port:user:pass</code> or a curl line. Adding one that is already on the list just updates it.
              Passwords are stored encrypted.
            </p>
            <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoComplete="off" />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={() => void add()} disabled={!text.trim() || busy === 'add'}>
                {busy === 'add' ? 'Adding…' : 'Add and check IPs'}
              </button>
            </div>
          </section>
        )}

        {error && <p className="text-error small">{error}</p>}
        {note && <p className="text-dim small">{note}</p>}

        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="tabs-inline">
            {(['all', 'free', 'used', 'disposed'] as Filter[]).map((f) => (
              <button key={f} className={`chip-tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'free' ? 'Free' : f === 'used' ? 'Used' : 'Disposed'}
                <span className="chip-count">{count(f)}</span>
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="text-dim small">Copy as</span>
            <div className="tabs-inline">
              {COPY_TYPES.map((t) => (
                <button key={t} className={`chip-tab ${copyAs === t ? 'active' : ''}`} onClick={() => chooseCopyAs(t)}>
                  {COPY_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {entries === null && <p className="text-dim small">Loading…</p>}
        {entries?.length === 0 && (
          <div className="card">
            <div className="empty">
              <p>No proxies yet.</p>
              <p className="text-dim small">Add the list your provider gave you.</p>
            </div>
          </div>
        )}

        {shown.length > 0 && (
          <div className="card table-container" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Port</th>
                  <th>Location</th>
                  <th>IP</th>
                  <th>Used by</th>
                  <th>Checked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.key} style={e.disposed ? { opacity: 0.6 } : undefined}>
                    <td>
                      <strong>{e.port}</strong>
                      <div className="text-faint small">{e.host}</div>
                    </td>
                    <td>
                      {e.ip ? (
                        <>
                          <span style={{ fontSize: '1.1rem', marginRight: 6 }} title={e.ip.country}>
                            {flagOf(e.ip.country)}
                          </span>
                          {placeOf(e.ip)}
                          <div className="text-faint small">{e.ip.org}</div>
                        </>
                      ) : (
                        <span className="text-dim small">Not checked</span>
                      )}
                    </td>
                    <td>
                      <code className="small">{e.ip?.ip ?? '—'}</code>
                      {e.previousIp && (
                        <div className="text-warning small" title={`Changed ${ago(e.ipChangedAtMs)}`}>
                          <TriangleAlert size={12} style={{ verticalAlign: '-2px' }} /> was {e.previousIp}
                        </div>
                      )}
                    </td>
                    <td>
                      {e.usedBy.map((u) => (
                        <div key={u.accountId}>
                          <Link href={`/accounts/${u.accountId}`} className="strong-link">
                            {u.label}
                          </Link>
                        </div>
                      ))}
                      {e.profiles.map((p) => (
                        <div key={p.id} className="small" title="An AdsPower profile with no Engage account">
                          {p.name} <span className="text-faint">· AdsPower only</span>
                        </div>
                      ))}
                      {e.note && <div className="text-dim small">{e.note}</div>}
                      {e.disposed ? (
                        <div>
                          <span className="badge badge-error">disposed</span>
                          {e.disposedNote && <div className="text-dim small">{e.disposedNote}</div>}
                        </div>
                      ) : (
                        statusOf(e) === 'free' && <span className="badge badge-success">free</span>
                      )}
                      {canManage && (
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '0 4px' }}
                          onClick={() => void editNote(e)}
                          disabled={busy === `note:${e.key}`}
                          title="Only for a proxy used outside Engage and AdsPower"
                        >
                          {e.note ? 'Edit note' : 'Add note'}
                        </button>
                      )}
                    </td>
                    <td className="small">
                      {busy === `check:${e.key}` ? (
                        <span className="text-dim">Checking…</span>
                      ) : e.checkError ? (
                        <span className="text-error">{e.checkError}</span>
                      ) : e.checkedAtMs ? (
                        <span className="text-dim">{ago(e.checkedAtMs)}</span>
                      ) : (
                        <span className="text-dim">never</span>
                      )}
                    </td>
                    <td>
                      {canManage && (
                        <div className="row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => void copy(e, 'url')} title={`Copy the proxy as ${COPY_TYPE_LABEL[copyAs]}`}>
                            {copied === `url:${e.key}` ? <Check size={13} /> : <Copy size={13} />} Copy
                          </button>
                          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => void copy(e, 'curl')} title={`Copy a ${COPY_TYPE_LABEL[copyAs]} curl that shows its IP`}>
                            {copied === `curl:${e.key}` ? <Check size={13} /> : <Terminal size={13} />}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm btn-icon"
                            onClick={() => void check([e.key])}
                            disabled={!!busy}
                            title="Check its IP again"
                          >
                            <RefreshCw size={13} />
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => void dispose(e, !e.disposed)}
                            disabled={busy === `dispose:${e.key}`}
                            title={e.disposed ? 'Offer this IP again' : 'Never offer this IP again'}
                          >
                            {e.disposed ? 'Make available' : 'Dispose'}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm btn-icon"
                            onClick={() => void remove(e)}
                            disabled={e.usedBy.length > 0}
                            title={e.usedBy.length ? 'In use by an account' : 'Take it off the list'}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-dim small">
          Used is detected: a port is used when an Engage account or any AdsPower profile is on it. Add a note only for a
          proxy used somewhere else. A port gives the same IP whichever protocol you copy. IPs are checked from
          Engage&rsquo;s web server, never the posting server, and re-checked once a day.
        </p>
      </div>
    </>
  );
}
