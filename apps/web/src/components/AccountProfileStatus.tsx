'use client';

import { useState } from 'react';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/context/AuthContext';
import ProfileFields, { EMPTY_PROFILE_FIELDS, type ProfileFieldValues } from './ProfileFields';

// On an account card: how its AdsPower profile is coming along, a way to set one
// up when it has none (after a refusal, or an older account), and — for the
// owner — the stored comment.

export interface Provisioning {
  state: 'creating' | 'failed' | 'done' | '';
  error: string;
}

export function readProvisioning(raw: unknown): Provisioning {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const state = p.state === 'creating' || p.state === 'failed' || p.state === 'done' ? p.state : '';
  return { state, error: typeof p.error === 'string' ? p.error : '' };
}

export default function AccountProfileStatus({
  accountId,
  label,
  hasProfile,
  hasComment,
  provisioning,
}: {
  accountId: string;
  label: string;
  hasProfile: boolean;
  hasComment: boolean;
  provisioning: Provisioning;
}) {
  const { profile } = useAuth();
  const isOwner = profile?.role === 'owner';
  const canProvision = isOwner || profile?.role === 'admin';
  const [setup, setSetup] = useState(false);
  const [fields, setFields] = useState<ProfileFieldValues>(EMPTY_PROFILE_FIELDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/accounts/${accountId}/profile`, { profile: { ...fields, name: fields.name.trim() || label } });
      setSetup(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not queue the profile.');
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    setError(null);
    try {
      const r = await apiGet<{ comment: string }>(`/api/accounts/${accountId}/comment`);
      setComment(r.comment || '(empty)');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the comment.');
    }
  }

  const needsProfile = !hasProfile && provisioning.state !== 'creating';

  return (
    <div className="stack" style={{ gap: 6, marginBottom: 8 }}>
      {provisioning.state === 'creating' && (
        <p className="text-warning small" style={{ margin: 0 }}>
          Creating the AdsPower profile on the server — this wakes it if it is asleep (a few minutes).
        </p>
      )}
      {provisioning.state === 'failed' && !hasProfile && (
        <p className="text-error small" style={{ margin: 0 }}>{provisioning.error || 'Creating the AdsPower profile failed.'}</p>
      )}

      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {canProvision && needsProfile && !setup && (
          <button className="btn btn-secondary btn-sm" onClick={() => setSetup(true)}>
            {provisioning.state === 'failed' ? 'Try again' : 'Set up AdsPower profile'}
          </button>
        )}
        {isOwner && hasComment && comment === null && (
          <button className="btn btn-ghost btn-sm" onClick={reveal}>
            Show comment
          </button>
        )}
        {comment !== null && (
          <button className="btn btn-ghost btn-sm" onClick={() => setComment(null)}>
            Hide comment
          </button>
        )}
      </div>

      {comment !== null && (
        <pre className="bordered small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
          {comment}
        </pre>
      )}

      {setup && (
        <div className="bordered stack" style={{ gap: 10 }}>
          <ProfileFields value={fields} onChange={setFields} namePlaceholder={label} />
          <p className="text-dim small" style={{ margin: 0 }}>
            The account&apos;s stored comment, if any, goes into the AdsPower remark.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={create} disabled={busy || !fields.proxy.trim()}>
              {busy ? 'Queueing…' : 'Create profile'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSetup(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-error small" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
