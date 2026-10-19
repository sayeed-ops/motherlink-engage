'use client';

import { useState } from 'react';
import { ShieldAlert, ExternalLink } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { humanCheckOf } from '@/modules/accounts/humanCheck';

// The account's "prove you are human" stop, where nobody can miss it.
//
// Shown at the top of every page for the account while a check is OPEN. Says
// what happened and what to do, and holds the only button that lets anything
// run from the account again. After it is marked solved, one quiet line says
// who did and when.

const KIND_LABEL: Record<string, string> = {
  post: 'posting a reply',
  comment: 'posting a karma comment',
  warmup: 'a warm-up session',
};

export default function HumanCheckBanner({
  accountId,
  account,
  canManage,
}: {
  accountId: string;
  account: Record<string, unknown> | null;
  canManage: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = humanCheckOf(account);
  if (!check) return null;

  if (check.status !== 'open') {
    if (!check.resolvedAtMs) return null;
    return (
      <p className="text-dim small" style={{ margin: '0 0 12px' }}>
        A human check on {new Date(check.detectedAtMs).toLocaleString()} was marked solved
        {check.resolvedByName ? ` by ${check.resolvedByName}` : ''} on {new Date(check.resolvedAtMs).toLocaleString()}.
      </p>
    );
  }

  async function resolve() {
    if (!confirm('Have you solved the check in this account’s browser? Automation for this account starts again once you confirm.')) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/accounts/${accountId}/human-check`, { method: 'POST' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark it solved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hc-banner" role="alert">
      <ShieldAlert size={20} className="hc-icon" />
      <div className="hc-body">
        <strong>Reddit asked this account to prove it is human. All automation for it is stopped.</strong>
        <p>
          It happened during {KIND_LABEL[check.kind] ?? 'a job'} on {new Date(check.detectedAtMs).toLocaleString()} (
          {check.reason}
          {check.text ? `: “${check.text}”` : ''}). The job was halted and the account&rsquo;s AdsPower browser was
          left open on the check. Replies, karma comments and warm-ups for this account are refused until it is
          marked solved.
        </p>
        <p>
          <strong>To fix:</strong> open this account&rsquo;s profile in AdsPower, solve the check by hand, then
          press the button.
          {check.url && (
            <>
              {' '}
              It was on{' '}
              <a href={check.url} target="_blank" rel="noreferrer">
                this page <ExternalLink size={11} style={{ verticalAlign: '-1px' }} />
              </a>{' '}
              (open it in the account&rsquo;s own browser, not this one).
            </>
          )}
        </p>
        {error && <p className="text-error">{error}</p>}
      </div>
      {canManage && (
        <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void resolve()}>
          {busy ? 'Saving…' : 'I’ve solved it'}
        </button>
      )}
    </div>
  );
}
