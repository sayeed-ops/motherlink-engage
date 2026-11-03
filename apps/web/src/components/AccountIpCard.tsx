'use client';

import { useState } from 'react';
import Link from 'next/link';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { apiGet, apiPatch, apiPost, ApiError } from '@/lib/api';
import { flagOf, placeOf, type AccountProxyIp, type PoolEntry } from '@/modules/accounts/proxyPool';

// The account's proxy, under its header: flag, city, IP and network, read from
// the copy the server keeps on the account. "Update IP data" checks it again
// from the web server, so it never wakes the posting server.

const ago = (ms: number, now: number) => {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

export default function AccountIpCard({
  accountId,
  account,
  canManage,
}: {
  accountId: string;
  account: Record<string, unknown>;
  canManage: boolean;
}) {
  const ip = (account.proxyIp as AccountProxyIp | undefined) ?? null;
  const linked = typeof account.proxyKey === 'string' && account.proxyKey !== '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [entries, setEntries] = useState<PoolEntry[] | null>(null);

  async function update() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ error: string }>(`/api/accounts/${accountId}/ip`, {});
      if (r.error) setError(r.error);
      setCheckedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check the IP.');
    } finally {
      setBusy(false);
    }
  }

  async function openPicker() {
    setError(null);
    try {
      setEntries((await apiGet<{ entries: PoolEntry[] }>('/api/proxies')).entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the proxy list.');
    }
  }

  async function link(key: string) {
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/accounts/${accountId}`, { proxyKey: key });
      setEntries(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not link that proxy.');
    } finally {
      setBusy(false);
    }
  }

  const now = checkedAt || (ip?.checkedAtMs ?? 0);

  return (
    <section className="card">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="eyebrow-muted">IP</div>
          {ip ? (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <span style={{ fontSize: '1.25rem' }} title={ip.country}>
                {flagOf(ip.country)}
              </span>
              <strong>{placeOf(ip)}</strong>
              <code className="small">{ip.ip}</code>
              <span className="text-dim small">
                {ip.org} · port {ip.port}
                {ip.checkedAtMs ? ` · checked ${ago(ip.checkedAtMs, Math.max(now, ip.checkedAtMs))}` : ''}
              </span>
            </div>
          ) : (
            <p className="text-dim small" style={{ margin: '4px 0 0' }}>
              {linked ? 'Not checked yet.' : 'Not linked to a proxy on the list yet.'}
            </p>
          )}
          {ip?.changed && (
            <p className="text-warning small" style={{ margin: '6px 0 0' }}>
              <TriangleAlert size={13} style={{ verticalAlign: '-2px' }} /> This IP changed at the last check. An account
              should always come out of the same IP.
            </p>
          )}
        </div>
        {canManage && (
          <div className="row" style={{ gap: 8 }}>
            {linked && (
              <button className="btn btn-secondary btn-sm" onClick={() => void update()} disabled={busy}>
                <RefreshCw size={13} className={busy ? 'spin' : ''} /> {busy ? 'Checking…' : 'Update IP data'}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => void openPicker()} disabled={busy}>
              {linked ? 'Change proxy' : 'Link a proxy'}
            </button>
          </div>
        )}
      </div>

      {entries && (
        <div className="stack bordered" style={{ marginTop: 12 }}>
          <p className="text-dim small" style={{ margin: 0 }}>
            Choose the proxy this account&rsquo;s AdsPower profile uses. This only records it in Engage. It does not
            change AdsPower.
          </p>
          <select defaultValue="" onChange={(e) => e.target.value && void link(e.target.value)} disabled={busy}>
            <option value="" disabled>
              Choose a proxy…
            </option>
            {entries.map((e) => (
              <option key={e.key} value={e.key}>
                {e.port} · {flagOf(e.ip?.country)} {placeOf(e.ip) || 'not checked'} · {e.ip?.ip ?? ''}
                {e.disposed
                  ? ' · disposed'
                  : e.usedBy.length
                    ? ` · used by ${e.usedBy.map((u) => u.label).join(', ')}`
                    : e.note
                      ? ` · ${e.note}`
                      : ' · free'}
              </option>
            ))}
          </select>
          <div className="row" style={{ gap: 8 }}>
            {linked && (
              <button className="btn btn-ghost btn-sm" onClick={() => void link('')} disabled={busy}>
                Unlink
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setEntries(null)}>
              Cancel
            </button>
            <Link href="/accounts/proxies" className="btn btn-ghost btn-sm">
              Open the proxy list
            </Link>
          </div>
        </div>
      )}

      {error && <p className="text-error small" style={{ margin: '8px 0 0' }}>{error}</p>}
    </section>
  );
}
