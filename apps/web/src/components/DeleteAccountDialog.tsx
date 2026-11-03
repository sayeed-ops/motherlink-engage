'use client';

import { useEffect, useState } from 'react';
import { apiFetch, apiGet, ApiError } from '@/lib/api';
import { flagOf, placeOf, type AccountProxyIp, type PoolEntry } from '@/modules/accounts/proxyPool';

// Deleting an account asks what happens to its IP: back on the list as free,
// or disposed so nobody is ever given it again. Without a proxy there is
// nothing to decide, and it is a plain confirmation.

export default function DeleteAccountDialog({
  accountId,
  label,
  account,
  onClose,
  onDeleted,
}: {
  accountId: string;
  label: string;
  account: Record<string, unknown>;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const key = typeof account.proxyKey === 'string' ? account.proxyKey : '';
  const ip = (account.proxyIp as AccountProxyIp | undefined) ?? null;
  const [choice, setChoice] = useState<'free' | 'dispose'>('dispose');
  const [others, setOthers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Other accounts on the same IP keep it whatever is chosen here.
  useEffect(() => {
    if (!key) return;
    let on = true;
    apiGet<{ entries: PoolEntry[] }>('/api/proxies')
      .then((r) => {
        const entry = r.entries.find((e) => e.key === key);
        if (on && entry) setOthers(entry.usedBy.filter((u) => u.accountId !== accountId).map((u) => u.label));
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [key, accountId]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/accounts/${accountId}${key ? `?proxy=${choice}` : ''}`, { method: 'DELETE' });
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the account.');
      setBusy(false);
    }
  }

  return (
    <>
      <div className="scrim" onClick={busy ? undefined : onClose} style={{ zIndex: 60 }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${label}`}
        className="card stack"
        style={{ position: 'fixed', zIndex: 61, top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(460px, calc(100vw - 32px))' }}
      >
        <h3 style={{ margin: 0 }}>Delete &ldquo;{label}&rdquo;?</h3>
        <p className="text-dim small" style={{ margin: 0 }}>
          Posted replies stay where they were posted. Only the account is removed from Engage.
        </p>

        {key && (
          <div className="stack bordered">
            <strong className="small">
              What should happen to its IP?
              {ip && (
                <span className="text-dim" style={{ fontWeight: 400 }}>
                  {' '}
                  {flagOf(ip.country)} {placeOf(ip)} · {ip.ip}
                </span>
              )}
            </strong>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', fontSize: '0.875rem' }}>
              <input type="radio" name="ip" checked={choice === 'dispose'} onChange={() => setChoice('dispose')} style={{ marginTop: 3, flex: 'none' }} />
              <span>
                <strong style={{ fontSize: 'inherit' }}>Mark it disposed</strong>
                <span className="text-dim small" style={{ display: 'block' }}>
                  Never offered again. Right when the account was banned or flagged.
                </span>
              </span>
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', fontSize: '0.875rem' }}>
              <input type="radio" name="ip" checked={choice === 'free'} onChange={() => setChoice('free')} style={{ marginTop: 3, flex: 'none' }} />
              <span>
                <strong style={{ fontSize: 'inherit' }}>Make it available</strong>
                <span className="text-dim small" style={{ display: 'block' }}>
                  Back on the list as free, for a new account.
                </span>
              </span>
            </label>
            {others.length > 0 && (
              <p className="text-warning small" style={{ margin: 0 }}>
                {others.join(', ')} also {others.length === 1 ? 'uses' : 'use'} this IP and will keep it.
                {choice === 'dispose' ? ' Disposing marks it disposed for them too.' : ' It stays used until they are gone.'}
              </p>
            )}
          </div>
        )}

        {error && <p className="text-error small" style={{ margin: 0 }}>{error}</p>}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger btn-sm" onClick={() => void remove()} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </div>
    </>
  );
}
