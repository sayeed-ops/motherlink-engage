'use client';

import { useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { apiPost, ApiError } from '@/lib/api';
import { TRUST_LEVEL_LABEL, trustLevelNote, type ForumStats } from '@/modules/shopify/forumUser';

// A Shopify Community account's dashboard: its public standing on the forum and
// what that means for posting. The Reddit dashboard (karma, subscriptions, warm-up)
// has no meaning here, so this replaces it rather than sitting beside it.

const ago = (ms: number | null) => {
  if (!ms) return 'never';
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};

export default function ShopifyAccountPanel({
  accountId,
  account,
  canManage,
}: {
  accountId: string;
  account: Record<string, unknown>;
  canManage: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stats = (account.forumStats as ForumStats | undefined) ?? null;
  const username = String(account.username || '');

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/accounts/${accountId}/forum-stats`, {});
      // The account doc is live-subscribed by the page; the new stats arrive on their own.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read the forum.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sections">
      <section className="card">
        <div className="card-head">
          <h3>Forum standing</h3>
          {canManage && (
            <button className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={busy || !username}>
              <RefreshCw size={13} /> {busy ? 'Reading…' : 'Refresh from the forum'}
            </button>
          )}
        </div>

        {error && <p className="text-error small">{error}</p>}

        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="badge badge-no-dot">
            {stats?.trustLevel != null ? `Trust level ${stats.trustLevel} · ${TRUST_LEVEL_LABEL[stats.trustLevel] ?? ''}` : 'Trust level not read'}
          </span>
          {stats?.joinedAtMs && <span className="badge badge-no-dot">joined {new Date(stats.joinedAtMs).toLocaleDateString()}</span>}
          {stats?.timeReadSec != null && <span className="badge badge-no-dot">{Math.round(stats.timeReadSec / 3600)}h read</span>}
          {stats?.badgeCount != null && <span className="badge badge-no-dot">{stats.badgeCount} badges</span>}
        </div>
        <p className="text-dim small" style={{ marginTop: 8 }}>
          {trustLevelNote(stats?.trustLevel ?? null)} Last read {ago(stats?.fetchedAtMs ?? null)}.
        </p>
        {username && (
          <a className="small" href={`https://community.shopify.com/u/${encodeURIComponent(username)}/summary`} target="_blank" rel="noopener noreferrer">
            @{username} on the community <ExternalLink size={11} aria-hidden />
          </a>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Posting rails</h3>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="badge badge-no-dot">{String(account.dailyCap ?? 0)} replies / 24h</span>
          <span className="badge badge-no-dot">{String(account.minIntervalMinutes ?? 0)}m between replies</span>
          <span className="badge badge-no-dot">profile: {String(account.adsPowerProfileId || 'none')}</span>
        </div>
        <p className="text-dim small" style={{ marginTop: 8 }}>
          Replies are queued from a thread&apos;s approved draft on the project&apos;s Shopify Community page. The agent
          checks these rails again at the moment it picks the job up.
        </p>
      </section>
    </div>
  );
}
