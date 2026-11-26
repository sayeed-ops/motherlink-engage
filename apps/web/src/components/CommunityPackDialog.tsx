'use client';

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Package, Plus, Save, Trash2, X } from 'lucide-react';
import ArrayInput from '@/components/reddit/ArrayInput';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { KEYWORDS_PER_ACCOUNT, type CommunityPack, type PackCommunity } from '@/modules/reddit/communityPacks';
import { MAX_WARMUP_COMMUNITIES, normalizeSubredditName } from '@/modules/reddit/subreddits';
import { COMMUNITY_LIMITS } from '@/modules/reddit/communityFinder';

// Add a pack of subreddits to many accounts at once. Untick a subreddit to leave
// it out of this apply, untick Comments to keep it join-and-browse only. Each
// account gets its own keyword picks and order, and every subreddit waits for
// its check on the account's first visit, exactly as from the community finder.

export interface PackAccount {
  accountId: string;
  label: string;
  username: string;
  status: string;
  communityCount: number;
}

type Row = PackCommunity & { keep: boolean };
type Result = { accountId: string; added: number; updated: number; full: string[]; error?: string };

const toRows = (p: CommunityPack): Row[] => p.communities.map((c) => ({ ...c, keep: true }));

export default function CommunityPackDialog({ accounts, onClose }: { accounts: PackAccount[]; onClose: () => void }) {
  const [packs, setPacks] = useState<CommunityPack[] | null>(null);
  const [packId, setPackId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [paste, setPaste] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'save' | 'apply' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);

  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiError ? err.message : fallback);

  function open(p: CommunityPack) {
    setPackId(p.id);
    setName(p.name);
    setRows(toRows(p));
    setDirty(false);
    setCreating(false);
    setResults(null);
    setError(null);
  }

  useEffect(() => {
    apiGet<{ packs: CommunityPack[] }>('/api/community-packs')
      .then((r) => {
        setPacks(r.packs);
        if (r.packs[0]) open(r.packs[0]);
      })
      .catch((err) => fail(err, 'Could not load the packs.'));
  }, []);

  const edit = (i: number, patch: Partial<Row>, persist = true) => {
    setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    if (persist) setDirty(true);
  };

  function startNew() {
    setCreating(true);
    setPackId(null);
    setName('');
    setRows([]);
    setPaste('');
    setResults(null);
  }

  function addPasted() {
    const have = new Set(rows.map((r) => r.name));
    const names = paste
      .split(/[\s,]+/)
      .map((s) => normalizeSubredditName(s))
      .filter((n) => n && !have.has(n) && (have.add(n), true));
    if (!names.length) return;
    setRows((all) => [...all, ...names.map((n) => ({ name: n, keywords: [], comment: true, keep: true }))]);
    setPaste('');
    setDirty(true);
  }

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const r = await apiPost<{ pack: CommunityPack }>('/api/community-packs', {
        action: 'save',
        id: packId ?? undefined,
        name,
        communities: rows.map(({ name: n, keywords, comment }) => ({ name: n, keywords, comment })),
      });
      setPacks((all) => [...(all ?? []).filter((p) => p.id !== r.pack.id), r.pack].sort((a, b) => a.name.localeCompare(b.name)));
      setPackId(r.pack.id);
      setCreating(false);
      setDirty(false);
    } catch (err) {
      fail(err, 'Could not save the pack.');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!packId || !window.confirm(`Delete the pack "${name}"? Accounts keep what was already added.`)) return;
    setBusy('delete');
    try {
      await apiPost('/api/community-packs', { action: 'delete', id: packId });
      const rest = (packs ?? []).filter((p) => p.id !== packId);
      setPacks(rest);
      if (rest[0]) open(rest[0]);
      else startNew();
    } catch (err) {
      fail(err, 'Could not delete the pack.');
    } finally {
      setBusy(null);
    }
  }

  const kept = rows.filter((r) => r.keep);
  const chosen = accounts.filter((a) => picked.has(a.accountId));
  const overCap = chosen.filter((a) => a.communityCount + kept.length > MAX_WARMUP_COMMUNITIES);

  async function apply() {
    setBusy('apply');
    setError(null);
    try {
      const r = await apiPost<{ results: Result[] }>('/api/community-packs', {
        action: 'apply',
        accountIds: [...picked],
        communities: kept.map(({ name: n, keywords, comment }) => ({ name: n, keywords, comment })),
      });
      setResults(r.results);
    } catch (err) {
      fail(err, 'Could not apply the pack.');
    } finally {
      setBusy(null);
    }
  }

  const labelOf = useMemo(() => new Map(accounts.map((a) => [a.accountId, a.label])), [accounts]);
  const allPicked = accounts.length > 0 && picked.size === accounts.length;

  return (
    <>
      <div className="scrim" onClick={busy ? undefined : onClose} style={{ zIndex: 60 }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Community packs"
        className="card stack"
        style={{
          position: 'fixed',
          zIndex: 61,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(980px, calc(100vw - 32px))',
          maxHeight: 'calc(100vh - 48px)',
          overflow: 'auto',
        }}
      >
        <div className="card-head">
          <h3 style={{ margin: 0 }}>
            <Package size={15} style={{ verticalAlign: '-2px' }} /> Community packs
          </h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close" disabled={busy !== null}>
            <X size={14} />
          </button>
        </div>

        <div className="tabs-inline">
          {(packs ?? []).map((p) => (
            <button
              key={p.id}
              className={`chip-tab ${p.id === packId && !creating ? 'active' : ''}`}
              onClick={() => (!dirty || window.confirm('Discard unsaved changes to this pack?')) && open(p)}
            >
              {p.name}
              <span className="chip-count">{p.communities.length}</span>
            </button>
          ))}
          <button className={`chip-tab ${creating ? 'active' : ''}`} onClick={startNew}>
            <Plus size={12} /> New pack
          </button>
        </div>
        {packs === null && !error && <p className="text-dim small">Loading…</p>}

        {(creating || packId) && (
          <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(220px, 1fr)', gap: 16 }}>
            {/* Subreddits */}
            <div className="stack">
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="Pack name, e.g. The gambler"
                  style={{ flex: '1 1 200px' }}
                />
                <button className="btn btn-secondary btn-sm" onClick={() => void save()} disabled={busy !== null || !dirty || !name.trim() || !rows.length}>
                  <Save size={12} /> {busy === 'save' ? 'Saving…' : 'Save pack'}
                </button>
                {packId && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void remove()} disabled={busy !== null}>
                    <Trash2 size={12} /> Delete pack
                  </button>
                )}
              </div>

              <div className="row" style={{ gap: 6 }}>
                <textarea
                  rows={2}
                  style={{ flex: 1, minHeight: 56 }}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder="Paste subreddits to add: r/nba, r/nfl… (one per line or comma separated)"
                />
                <button className="btn btn-secondary btn-sm" onClick={addPasted} disabled={!paste.trim()}>
                  Add
                </button>
              </div>

              {rows.length > 0 && (
                <div className="row text-dim small" style={{ flexWrap: 'wrap', gap: 10 }}>
                  <span>
                    {kept.length} of {rows.length} ticked · {kept.filter((r) => r.comment).length} with comments
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setRows((a) => a.map((r) => ({ ...r, keep: true })))}>Tick all</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setRows((a) => a.map((r) => ({ ...r, keep: false })))}>Untick all</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setRows((a) => a.map((r) => ({ ...r, comment: false })))}>Comments off for all</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setRows((a) => a.map((r) => ({ ...r, comment: true })))}>Comments on for all</button>
                </div>
              )}

              <p className="text-dim small" style={{ margin: 0 }}>
                Unticking only affects this apply; use the bin to take a subreddit out of the pack. Each account gets{' '}
                {KEYWORDS_PER_ACCOUNT} of a subreddit&rsquo;s keywords at random. Comments only happen where the visit check
                passes ({COMMUNITY_LIMITS.minWeeklyVisitors.toLocaleString()}–{COMMUNITY_LIMITS.maxWeeklyVisitors.toLocaleString()} weekly
                visitors, at most {COMMUNITY_LIMITS.maxModerators} moderators, no add-ons); bigger ones are still joined and browsed.
              </p>

              {rows.map((r, i) => (
                <div key={r.name} className="bordered" style={{ padding: '6px 10px', opacity: r.keep ? 1 : 0.5 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input type="checkbox" checked={r.keep} onChange={(e) => edit(i, { keep: e.target.checked }, false)} aria-label={`Include r/${r.name}`} />
                    <a href={`https://www.reddit.com/r/${r.name}/`} target="_blank" rel="noopener noreferrer" className="strong-link small" style={{ minWidth: 150 }}>
                      r/{r.name} <ExternalLink size={11} style={{ verticalAlign: '-1px' }} />
                    </a>
                    <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="checkbox" checked={r.comment} onChange={(e) => edit(i, { comment: e.target.checked })} />
                      Comments
                    </label>
                    <div style={{ flex: '1 1 260px' }}>
                      <ArrayInput value={r.keywords} onChange={(v) => edit(i, { keywords: v.slice(0, 6) })} placeholder="search keywords" />
                    </div>
                    <button
                      className="btn btn-ghost btn-sm btn-icon"
                      onClick={() => {
                        setRows((all) => all.filter((_, j) => j !== i));
                        setDirty(true);
                      }}
                      aria-label={`Remove r/${r.name} from the pack`}
                      title="Remove from the pack"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Accounts */}
            <div className="stack">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong className="small">Accounts</strong>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setPicked(allPicked ? new Set() : new Set(accounts.map((a) => a.accountId)))}
                >
                  {allPicked ? 'None' : 'All'}
                </button>
              </div>
              {accounts.length === 0 && <p className="text-dim small">No Reddit accounts.</p>}
              {accounts.map((a) => (
                <label key={a.accountId} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={picked.has(a.accountId)}
                    onChange={(e) =>
                      setPicked((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(a.accountId);
                        else n.delete(a.accountId);
                        return n;
                      })
                    }
                  />
                  <span style={{ minWidth: 0 }}>
                    {a.label}
                    <span className="text-dim">
                      {' '}
                      · {a.status} · {a.communityCount} on list
                    </span>
                  </span>
                </label>
              ))}

              {overCap.length > 0 && (
                <p className="text-warning small" style={{ margin: 0 }}>
                  A list holds {MAX_WARMUP_COMMUNITIES}. {overCap.map((a) => a.label).join(', ')} will not fit every subreddit; the
                  ones that do not fit are listed after applying.
                </p>
              )}
              {dirty && <p className="text-dim small" style={{ margin: 0 }}>Applies what you see, saved or not.</p>}

              <button className="btn btn-primary btn-sm" onClick={() => void apply()} disabled={busy !== null || !kept.length || !picked.size}>
                {busy === 'apply' ? 'Applying…' : `Add ${kept.length} subreddits to ${picked.size} account${picked.size === 1 ? '' : 's'}`}
              </button>

              {results && (
                <div className="stack small">
                  {results.map((r) => (
                    <div key={r.accountId}>
                      <strong>{labelOf.get(r.accountId) ?? r.accountId}</strong>{' '}
                      {r.error ? (
                        <span className="text-error">{r.error}</span>
                      ) : (
                        <span className="text-dim">
                          added {r.added}
                          {r.updated ? `, updated ${r.updated}` : ''}
                          {r.full.length ? `; full, skipped ${r.full.map((n) => `r/${n}`).join(', ')}` : ''}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {error && <p className="text-error small" style={{ margin: 0 }}>{error}</p>}
      </div>
    </>
  );
}
