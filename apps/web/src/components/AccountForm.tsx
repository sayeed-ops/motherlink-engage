'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { apiPost, apiPatch, ApiError } from '@/lib/api';
import type { RedditAccountStatus } from '@/modules/reddit/types';
import { PLATFORM_LABEL, type AccountPlatform } from '@/modules/accounts/platform';

// The account create/edit form, shared by the Accounts grid (create) and the
// account detail page's Settings tab (edit). Owns its own save so both callers
// just hand it initial values and get a callback when it's done. Counters and
// captured stats are never touched here — only the human-set identity + rails.

const STATUSES: RedditAccountStatus[] = ['active', 'warming', 'flagged', 'banned'];

export interface AccountFormValues {
  /** Chosen on create; fixed afterwards (the server refuses a change). */
  platform: AccountPlatform;
  label: string;
  username: string;
  adsPowerProfileId: string;
  status: RedditAccountStatus;
  dailyCap: number;
  minIntervalMinutes: number;
  karma: number;
  notes: string;
}

export const EMPTY_ACCOUNT_FORM: AccountFormValues = {
  platform: 'reddit',
  label: '',
  username: '',
  adsPowerProfileId: '',
  status: 'warming',
  dailyCap: 5,
  minIntervalMinutes: 45,
  karma: 0,
  notes: '',
};

export default function AccountForm({
  mode,
  accountId,
  initial,
  onDone,
  onCancel,
}: {
  mode: 'create' | 'edit';
  accountId?: string;
  initial?: AccountFormValues;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<AccountFormValues>(initial ?? EMPTY_ACCOUNT_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shopify = form.platform === 'shopify';

  async function save() {
    if (!form.label.trim() || !form.adsPowerProfileId.trim()) {
      setError('Label and AdsPower profile ID are required.');
      return;
    }
    if (shopify && !form.username.trim()) {
      setError('A Shopify Community username is required — the agent checks it before posting.');
      return;
    }
    setBusy(true);
    setError(null);
    const payload = {
      ...(mode === 'create' ? { platform: form.platform } : {}),
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
      if (mode === 'edit' && accountId) await apiPatch(`/api/accounts/${accountId}`, payload);
      else await apiPost('/api/accounts', payload);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="grid-form">
        <label className="field">
          <span>Platform</span>
          {mode === 'create' ? (
            <select
              value={form.platform}
              onChange={(e) => setForm({ ...form, platform: e.target.value as AccountPlatform })}
            >
              <option value="reddit">{PLATFORM_LABEL.reddit}</option>
              <option value="shopify">{PLATFORM_LABEL.shopify}</option>
            </select>
          ) : (
            // Fixed after creation: a Reddit identity's counters and history mean
            // nothing on another platform.
            <input value={PLATFORM_LABEL[form.platform]} disabled />
          )}
        </label>
        <label className="field">
          <span>Label</span>
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Growth – budgetlee" />
        </label>
        <label className="field">
          <span>{shopify ? 'Shopify Community username (required)' : 'Reddit username'}</span>
          <input
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            placeholder={shopify ? 'as shown on the forum, without @' : 'budgetlee_app'}
          />
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
        {!shopify && (
          <label className="field">
            <span>Karma (manual fallback)</span>
            <input type="number" value={form.karma} onChange={(e) => setForm({ ...form, karma: Number(e.target.value) })} />
          </label>
        )}
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
        {shopify ? (
          <p className="text-dim small">
            The local agent opens this AdsPower profile, which must already be signed in to the Shopify
            Community, and checks the forum&apos;s signed-in user IS this username before it types anything.
            One profile may be signed in to Reddit as well — the agent never runs two jobs on the same
            profile or IP at once. Shopify posting has its own dry-run switch, separate from Reddit&apos;s.
          </p>
        ) : (
          <p className="text-dim small">
            Posting is done by the local agent (runs on the posting Mac next to AdsPower). It opens the
            AdsPower profile — required — and types and submits the reply. No passwords are stored here;
            the login lives in the profile. Reddit username is optional but recommended: the agent checks
            the open profile is that handle and aborts if not. Karma here is a manual fallback — once the
            agent opens this profile it captures real karma in-session (see the Dashboard).
          </p>
        )}
      </div>

      {error && <p className="text-error small">{error}</p>}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create account'}
        </button>
        {onCancel && (
          <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </>
  );
}
