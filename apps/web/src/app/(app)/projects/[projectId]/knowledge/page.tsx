'use client';

import { use, useCallback, useEffect, useState } from 'react';
import {
  Download,
  RefreshCw,
  Trash2,
  ExternalLink,
  Check,
  X,
  AlertTriangle,
  Quote,
  ClipboardPaste,
  ShieldAlert,
  Radar,
  EyeOff,
  Clock,
  Undo2,
  MessagesSquare,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import ArrayInput from '@/components/reddit/ArrayInput';
import { apiGet, apiPost, apiPatch, apiFetch, ApiError } from '@/lib/api';
import {
  ASSET_KINDS,
  ASSET_KIND_LABEL,
  CLAIM_STATUS_LABEL,
  TEXT_SOURCE_LABEL,
  type AssetKind,
  type AssetProposal,
  type ClaimStatus,
  type Discovery,
  type DiscoveryStatus,
  type TextSource,
} from '@/modules/knowledge/types';

// The client asset library.
//
// NOT the same thing as Reddit → Knowledge, which holds free-text `sources`.
// A source is what a person typed; an asset is a page we have READ, with the
// exact sentences that back every fact in it. The difference matters exactly
// once: when a reply names the client and states something, it may only state a
// fact from here.
//
// THE SCREEN IS A REVIEW QUEUE, NOT A FORM. Importing does not save. The model
// proposes, this page shows what it proposed AND what it tried to claim without
// support, and a person presses Add. That order is the whole safeguard — an
// unreviewed library is worse than no library, because the system speaks from it
// with confidence.

interface Readiness {
  usable: boolean;
  citable: boolean;
  reason: string;
  assertableCount: number;
}

interface Asset {
  assetId: string;
  title: string;
  kind: AssetKind;
  purpose: string;
  problems: string[];
  triggers: string[];
  exclusions: string[];
  sourceUrl: string;
  status: 'draft' | 'active' | 'retired';
  proposedBy: 'model' | 'human';
  model: string;
  sourceChangedAt: string | null;
  lastCrawledAt: string | null;
  textSource: TextSource;
  attestedByName: string | null;
  fetchFailure: string | null;
  readiness: Readiness;
}

interface Claim {
  claimId: string;
  assetId: string;
  text: string;
  quote: string;
  status: ClaimStatus;
  expiresAt: string;
}

interface IngestResult {
  textSource: TextSource;
  page: { url: string; title: string; hash: string; chars: number };
  proposal: AssetProposal;
  rejected: { claim: { text: string; quote: string }; reason: string }[];
  model: string;
  promptVersion: string;
  fetchFailure?: string | null;
}

/** What the server said when it could not read the page, and whether a person
 *  is allowed to supply it instead. `canPaste` is the server's call, never the
 *  browser's — a private address must not be paste-able however the UI feels. */
interface FetchRefusal {
  message: string;
  code: string;
  canPaste: boolean;
}

const STATUS_BADGE: Record<ClaimStatus, string> = {
  live: 'badge badge-success',
  expiring: 'badge badge-warning',
  expired: 'badge badge-error',
  stale: 'badge badge-error',
};

export default function KnowledgePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Import
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<IngestResult | null>(null);
  // The proposal is editable before it is saved — the model is a first draft,
  // and the fields most worth fixing (exclusions especially) are the ones it is
  // worst at.
  const [edit, setEdit] = useState<AssetProposal | null>(null);
  const [keptClaims, setKeptClaims] = useState<boolean[]>([]);

  // The manual route. `refusal` is only ever set from a server response, so the
  // paste box cannot be opened for a URL the server would refuse outright.
  const [refusal, setRefusal] = useState<FetchRefusal | null>(null);
  const [pasted, setPasted] = useState('');

  const [sweep, setSweep] = useState<string | null>(null);

  // Source discovery. `pending` is the discovery being promoted, carried so the
  // proposal panel can mark it added on save and so a blocked page can fall
  // through to the paste box with its URL already in place.
  const [domains, setDomains] = useState<string[]>([]);
  const [discoveries, setDiscoveries] = useState<Discovery[] | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ assets: Asset[]; claims: Claim[] }>(
        `/api/projects/${projectId}/knowledge/assets`,
      );
      setAssets(data.assets);
      setClaims(data.claims);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the library.');
      setAssets([]);
    }
  }, [projectId]);

  const loadDiscoveries = useCallback(async () => {
    try {
      const data = await apiGet<{ discoveries: Discovery[] }>(
        `/api/projects/${projectId}/knowledge/discoveries`,
      );
      setDiscoveries(data.discoveries);
    } catch {
      setDiscoveries([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    void loadDiscoveries();
  }, [load, loadDiscoveries]);

  function accept(res: IngestResult) {
    setResult(res);
    setEdit(res.proposal);
    setKeptClaims(res.proposal.claims.map(() => true));
    setRefusal(null);
    setPasted('');
  }

  async function ingest() {
    setBusy(true);
    setError(null);
    setResult(null);
    setRefusal(null);
    try {
      accept(
        await apiPost<IngestResult>(`/api/projects/${projectId}/knowledge/ingest`, { url: url.trim() }),
      );
    } catch (err) {
      // A refusal is not a dead end when a person can see the page themselves.
      // The offer is made only when the SERVER says it may be — see canPaste.
      const body = err instanceof ApiError ? (err.body as Partial<FetchRefusal> | undefined) : undefined;
      const message = err instanceof ApiError ? err.message : 'That page could not be read.';
      if (body?.canPaste) {
        setRefusal({ message, code: String(body.code ?? 'unknown'), canPaste: true });
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function ingestPasted() {
    setBusy(true);
    setError(null);
    try {
      accept(
        await apiPost<IngestResult>(`/api/projects/${projectId}/knowledge/paste`, {
          url: url.trim(),
          text: pasted,
          fetchFailure: refusal?.code ?? null,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That text could not be read.');
    } finally {
      setBusy(false);
    }
  }

  async function discover() {
    setBusy(true);
    setError(null);
    setSweep(null);
    try {
      const res = await apiPost<{ run: { seen: number; candidates: number; notes: string[] }; written: number }>(
        `/api/projects/${projectId}/knowledge/discover`,
        { domains },
      );
      setSweep(
        `Looked at ${res.run.seen.toLocaleString()} URL${res.run.seen === 1 ? '' : 's'} — ` +
          `${res.written} new candidate${res.written === 1 ? '' : 's'} to review.` +
          (res.run.notes.length ? ` ${res.run.notes.join(' ')}` : ''),
      );
      await loadDiscoveries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Discovery could not run.');
    } finally {
      setBusy(false);
    }
  }

  async function decide(discoveryId: string, status: DiscoveryStatus) {
    setBusy(true);
    try {
      await apiPatch(`/api/projects/${projectId}/knowledge/discoveries/${discoveryId}`, { status });
      await loadDiscoveries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That decision could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  /** Add: read the page for real. Discovery guessed; this is the step that
   *  actually verifies, and it is allowed to fail — a blocked page falls through
   *  to the paste box rather than being quietly promoted on a guess. */
  async function addFromDiscovery(d: Discovery) {
    setUrl(d.url);
    setPending(d.discoveryId);
    setBusy(true);
    setError(null);
    setResult(null);
    setRefusal(null);
    try {
      accept(await apiPost<IngestResult>(`/api/projects/${projectId}/knowledge/ingest`, { url: d.url }));
    } catch (err) {
      const payload = err instanceof ApiError ? (err.body as Partial<FetchRefusal> | undefined) : undefined;
      const message = err instanceof ApiError ? err.message : 'That page could not be read.';
      if (payload?.canPaste) {
        setRefusal({ message, code: String(payload.code ?? 'unknown'), canPaste: true });
      } else {
        setError(message);
        setPending(null);
      }
    } finally {
      setBusy(false);
    }
  }

  /** Keep a blocked page as a to-do rather than losing it. No text, no claims,
   *  and readiness refuses to make it usable — it is a reminder with a URL. */
  async function keepUnverified() {
    if (!pending || !url.trim()) return;
    const d = discoveries?.find((x) => x.discoveryId === pending);
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/knowledge/assets`, {
        title: d?.usefulFor ? d.usefulFor.slice(0, 80) : url.trim(),
        kind: d?.kind ?? 'guide',
        purpose: d?.usefulFor
          ? `Discovered page, not yet read. Appears to cover: ${d.usefulFor}`
          : 'Discovered page, not yet read.',
        sourceUrl: url.trim(),
        textSource: 'unverified',
        fetchFailure: refusal?.code ?? null,
        discoveryId: pending,
        claims: [],
      });
      setRefusal(null);
      setPending(null);
      setUrl('');
      setPasted('');
      await Promise.all([load(), loadDiscoveries()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that page.');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!edit || !result) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/knowledge/assets`, {
        ...edit,
        claims: edit.claims.filter((_, i) => keptClaims[i]),
        sourceUrl: result.page.url,
        sourceHash: result.page.hash,
        proposedBy: 'model',
        model: result.model,
        promptVersion: result.promptVersion,
        // The provenance travels with the save. For a pasted asset the text goes
        // too — it is the only copy that will ever exist, since nobody can
        // re-fetch the page.
        textSource: result.textSource,
        pageText: result.textSource === 'pasted' ? pasted : undefined,
        fetchFailure: result.fetchFailure ?? null,
        discoveryId: pending ?? undefined,
        activate: true,
      });
      setResult(null);
      setEdit(null);
      setUrl('');
      setPasted('');
      setRefusal(null);
      setPending(null);
      await Promise.all([load(), loadDiscoveries()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that asset.');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(assetId: string, status: Asset['status']) {
    setBusy(true);
    try {
      await apiPatch(`/api/projects/${projectId}/knowledge/assets/${assetId}`, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update that asset.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(assetId: string, title: string) {
    if (!confirm(`Delete "${title}" and every claim taken from it?`)) return;
    setBusy(true);
    try {
      await apiFetch(`/api/projects/${projectId}/knowledge/assets/${assetId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that asset.');
    } finally {
      setBusy(false);
    }
  }

  async function recrawl() {
    setBusy(true);
    setSweep(null);
    try {
      const res = await apiPost<{
        checked: unknown[];
        changed: number;
        unreadable: number;
        manual: { assetId: string; title: string }[];
      }>(`/api/projects/${projectId}/knowledge/recrawl`, {});
      setSweep(
        `Checked ${res.checked.length} page${res.checked.length === 1 ? '' : 's'} — ` +
          `${res.changed} changed, ${res.unreadable} unreadable.` +
          (res.manual.length
            ? ` ${res.manual.length} can only be checked by hand: ${res.manual.map((m) => m.title).join(', ')}.`
            : ''),
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The re-check could not run.');
    } finally {
      setBusy(false);
    }
  }

  const claimsFor = (assetId: string) => claims.filter((c) => c.assetId === assetId);

  return (
    <>
      <PageHeader
        title="Asset library"
        description="What this client can credibly speak to, and the exact sentences that back every fact."
        crumbs={[
          { label: 'Projects', href: '/projects' },
          { label: 'Project', href: `/projects/${projectId}` },
          { label: 'Asset library' },
        ]}
        action={
          <div className="row">
            <a href={`/projects/${projectId}/knowledge/interview`} className="btn btn-primary btn-sm">
              <MessagesSquare size={14} /> Client interview
            </a>
            <button className="btn btn-secondary btn-sm" onClick={recrawl} disabled={busy || !assets?.length}>
              <RefreshCw size={14} /> Re-check pages
            </button>
          </div>
        }
      />

      {error && <div className="alert alert-error">{error}</div>}
      {sweep && <div className="alert alert-info">{sweep}</div>}

      {/* ── Import ─────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-head">
          <h2>Read a page</h2>
          <p className="text-muted small">
            A help article, a product page, a guide — anything on the client&apos;s own site. Nothing is saved
            until you press Add.
          </p>
        </div>

        <div className="input-group">
          <input
            type="url"
            placeholder="https://help.example.com/articles/cashout"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && url.trim() && !busy) void ingest();
            }}
            disabled={busy}
          />
          <button className="btn btn-primary" onClick={() => void ingest()} disabled={busy || !url.trim()}>
            <Download size={14} /> Read it
          </button>
        </div>

        {/* The manual route. Offered only when the SERVER said a person may
            supply the page — a refused address never gets here. */}
        {refusal && (
          <div className="alert alert-warning">
            <strong>{refusal.message}</strong>
            <p className="small">
              Nothing here retries or works around that refusal. If you can open the page in your own browser,
              paste what it says below and it will be read the same way — same extraction, same quote checking,
              same approval. The asset will record that <em>you</em> supplied the text rather than claiming we
              read it.
            </p>
          </div>
        )}

        {refusal && (
          <div className="field">
            <label className="label">
              <ClipboardPaste size={13} aria-hidden /> Paste the page content
            </label>
            <textarea
              rows={10}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="Select the article in your browser, copy it, and paste it here. Page source works too."
              disabled={busy}
            />
            <p className="text-dim small">
              Attaching to <span className="text-mono">{url.trim()}</span> · {pasted.length.toLocaleString()}{' '}
              characters
            </p>
            <div className="row">
              <button
                className="btn btn-primary"
                onClick={() => void ingestPasted()}
                disabled={busy || pasted.trim().length < 200}
              >
                <ClipboardPaste size={14} /> Read what I pasted
              </button>
              {pending && (
                <button className="btn btn-secondary" onClick={() => void keepUnverified()} disabled={busy}>
                  <Clock size={14} /> Keep as a to-do instead
                </button>
              )}
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setRefusal(null);
                  setPasted('');
                  setPending(null);
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── The proposal ───────────────────────────────────────────────── */}
      {edit && result && (
        <div className="card">
          <div className="card-head">
            <h2>Proposed from {result.page.title || result.page.url}</h2>
            <p className="text-muted small">
              {result.page.chars.toLocaleString()} characters read · {result.model}. Fix anything that is wrong
              before adding it — especially the exclusions.
            </p>
          </div>

          {result.textSource === 'pasted' && (
            <div className="alert alert-warning">
              <ShieldAlert size={14} aria-hidden />{' '}
              <strong>You are vouching for this text.</strong>
              <p className="small">
                The server could not read this page, so it cannot check that what you pasted is what the page
                says — only that the claims below are supported by the text you gave it. Saving records your
                name against it permanently, and the asset will always show as supplied by hand.
              </p>
            </div>
          )}

          <div className="field">
            <label className="label">Title</label>
            <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          </div>

          <div className="field">
            <label className="label">Kind</label>
            <select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as AssetKind })}>
              {ASSET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ASSET_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="label">Purpose</label>
            <textarea
              rows={2}
              value={edit.purpose}
              onChange={(e) => setEdit({ ...edit, purpose: e.target.value })}
            />
          </div>

          <div className="field">
            <label className="label">Problems it solves</label>
            <ArrayInput
              value={edit.problems}
              onChange={(problems) => setEdit({ ...edit, problems })}
              placeholder="in the words a bettor would use"
            />
          </div>

          <div className="field">
            <label className="label">Triggers</label>
            <ArrayInput
              value={edit.triggers}
              onChange={(triggers) => setEdit({ ...edit, triggers })}
              placeholder="phrases that mean this page is relevant"
            />
          </div>

          <div className="field">
            <label className="label">
              Not relevant when <span className="text-warning">— the field that stops us over-reaching</span>
            </label>
            <ArrayInput
              value={edit.exclusions}
              onChange={(exclusions) => setEdit({ ...edit, exclusions })}
              placeholder="discussions this must never be matched to"
            />
            <p className="text-dim small">
              Any one of these appearing in a thread removes this asset from consideration outright. Worth being
              generous here.
            </p>
          </div>

          <div className="field">
            <label className="label">
              Claims {edit.claims.length > 0 && <span className="text-dim">— untick anything you would not stand behind</span>}
            </label>
            {edit.claims.length === 0 ? (
              <p className="text-muted small">
                Nothing on this page could be quoted as a checkable fact. That is normal for a landing page — the
                asset is still worth adding, it simply cannot be cited.
              </p>
            ) : (
              <ul className="list">
                {edit.claims.map((claim, i) => (
                  <li key={i} className="list-row">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={keptClaims[i] ?? false}
                        onChange={(e) => {
                          const next = [...keptClaims];
                          next[i] = e.target.checked;
                          setKeptClaims(next);
                        }}
                      />
                      <span>
                        <strong>{claim.text}</strong>
                        <span className="de-reason-text text-muted small">
                          <Quote size={11} aria-hidden /> {claim.quote}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {result.rejected.length > 0 && (
            <div className="field">
              <label className="label text-warning">
                <AlertTriangle size={13} aria-hidden /> Dropped before you saw them ({result.rejected.length})
              </label>
              <p className="text-dim small">
                The model proposed these and could not point at a sentence on the page that supports them. They
                are not available to add — shown so you can see how far it reached.
              </p>
              <ul className="list">
                {result.rejected.map((r, i) => (
                  <li key={i} className="list-row">
                    <span className="text-muted">{r.claim.text}</span>
                    <span className="badge badge-error badge-no-dot">{r.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="row">
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !edit.title.trim()}>
              <Check size={14} /> Add to the library
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setResult(null);
                setEdit(null);
              }}
              disabled={busy}
            >
              <X size={14} /> Discard
            </button>
          </div>
        </div>
      )}

      {/* ── Source discovery ───────────────────────────────────────────── */}
      <div className="card">
        <div className="card-head">
          <h2>Find pages automatically</h2>
          <p className="text-muted small">
            Reads the client&apos;s sitemap and follows a few links to build a list of candidates. It guesses
            what each page is probably for from its URL and how it is linked — <strong>it does not read
            them</strong>. Nothing here becomes citable until a page is actually verified.
          </p>
        </div>

        <div className="field">
          <label className="label">Approved domains</label>
          <ArrayInput value={domains} onChange={setDomains} placeholder="stake.com" />
          <p className="text-dim small">
            Only these hosts and their subdomains are visited, and robots.txt is obeyed on each.
          </p>
        </div>

        <div className="row">
          <button className="btn btn-primary" onClick={() => void discover()} disabled={busy || !domains.length}>
            <Radar size={14} /> Discover pages
          </button>
          {!!discoveries?.length && (
            <button className="btn btn-ghost btn-sm" onClick={() => setShowDecided((v) => !v)}>
              {showDecided ? 'Hide decided' : 'Show decided'}
            </button>
          )}
        </div>

        {discoveries !== null && discoveries.length > 0 && (
          <ul className="list">
            {discoveries
              .filter((d) => (showDecided ? true : d.status === 'new' || d.status === 'review'))
              .map((d) => (
                <li className="list-row" key={d.discoveryId}>
                  <div>
                    <div className="row">
                      <strong>{d.usefulFor || 'No summary — the classifier could not place this one'}</strong>
                      {d.status === 'review' && <span className="badge badge-warning">Kept for later</span>}
                      {d.status === 'added' && <span className="badge badge-success">Added</span>}
                      {d.status === 'ignored' && <span className="badge">Ignored</span>}
                      {!d.worthReading && d.status === 'new' && (
                        <span className="badge" title="The classifier thought this was not worth a page read">
                          low value
                        </span>
                      )}
                    </div>
                    <div className="text-dim small">
                      <a href={d.url} target="_blank" rel="noreferrer" className="strong-link">
                        {d.url} <ExternalLink size={10} aria-hidden />
                      </a>
                      {' · '}
                      {ASSET_KIND_LABEL[d.kind]} · {d.confidence}% sure from the URL
                      {d.anchors.length > 0 && ` · linked as "${d.anchors[0]}"`}
                    </div>
                  </div>

                  {d.status === 'added' ? (
                    <span className="text-dim small">in the library</span>
                  ) : (
                    <div className="row">
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => void addFromDiscovery(d)}
                        disabled={busy}
                        title="Read this page properly and propose an asset from it"
                      >
                        <Download size={13} /> Add
                      </button>
                      {d.status !== 'review' && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => void decide(d.discoveryId, 'review')}
                          disabled={busy}
                        >
                          <Clock size={13} /> Later
                        </button>
                      )}
                      {d.status === 'ignored' ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => void decide(d.discoveryId, 'new')}
                          disabled={busy}
                        >
                          <Undo2 size={13} /> Undo
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => void decide(d.discoveryId, 'ignored')}
                          disabled={busy}
                        >
                          <EyeOff size={13} /> Ignore
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
          </ul>
        )}

        {discoveries !== null && discoveries.length === 0 && (
          <p className="text-muted small">
            Nothing found yet. Add the client&apos;s domains above and run it.
          </p>
        )}
      </div>

      {/* ── The library ────────────────────────────────────────────────── */}
      {assets === null ? (
        <div className="loading-container">
          <div className="spinner" />
        </div>
      ) : assets.length === 0 ? (
        <div className="empty">
          <h3>No assets yet</h3>
          <p className="text-muted">
            Read a page from the client&apos;s site above. Until there is something here, the system has nothing
            it can attribute to them — replies can still be useful, but none of them can name the client and
            state a fact.
          </p>
        </div>
      ) : (
        <div className="stack">
          {assets.map((asset) => {
            const mine = claimsFor(asset.assetId);
            return (
              <div className="card" key={asset.assetId}>
                <div className="card-head">
                  <div className="page-head-row">
                    <h3>{asset.title}</h3>
                    <div className="row">
                      {asset.status === 'draft' && <span className="badge badge-warning">Not confirmed</span>}
                      {asset.status === 'retired' && <span className="badge">Retired</span>}
                      {asset.sourceChangedAt && <span className="badge badge-error">Source changed</span>}
                      {asset.textSource === 'pasted' && (
                        <span className="badge badge-info" title={TEXT_SOURCE_LABEL.pasted}>
                          Supplied by hand
                        </span>
                      )}
                      {asset.textSource === 'unverified' && (
                        <span className="badge badge-warning" title={TEXT_SOURCE_LABEL.unverified}>
                          Not read yet
                        </span>
                      )}
                      {asset.readiness.citable && <span className="badge badge-success">Citable</span>}
                      {asset.readiness.usable && !asset.readiness.citable && (
                        <span className="badge badge-info">Usable, not citable</span>
                      )}
                    </div>
                  </div>
                  <p className="text-muted small">
                    {ASSET_KIND_LABEL[asset.kind]} ·{' '}
                    <a href={asset.sourceUrl} target="_blank" rel="noreferrer" className="strong-link">
                      source <ExternalLink size={11} aria-hidden />
                    </a>
                    {asset.textSource === 'pasted' && (
                      <>
                        {' '}
                        · text supplied by {asset.attestedByName ?? 'a team member'}
                        {asset.fetchFailure ? ` (the server was ${asset.fetchFailure})` : ''} — it cannot be
                        re-checked automatically
                      </>
                    )}
                  </p>
                </div>

                <p>{asset.purpose}</p>

                {!asset.readiness.usable && asset.readiness.reason && (
                  <div className="alert alert-warning">{asset.readiness.reason}</div>
                )}

                {asset.exclusions.length > 0 && (
                  <p className="small">
                    <span className="text-dim">Never for:</span>{' '}
                    {asset.exclusions.map((e) => (
                      <span className="chip" key={e}>
                        {e}
                      </span>
                    ))}
                  </p>
                )}

                {mine.length > 0 && (
                  <ul className="list">
                    {mine.map((claim) => (
                      <li className="list-row" key={claim.claimId}>
                        <span>
                          {claim.text}
                          <span className="de-reason-text text-dim small">
                            <Quote size={11} aria-hidden /> {claim.quote}
                          </span>
                        </span>
                        <span className={STATUS_BADGE[claim.status]}>{CLAIM_STATUS_LABEL[claim.status]}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="row">
                  {asset.textSource === 'unverified' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setUrl(asset.sourceUrl);
                        setRefusal({
                          message: 'This page has never been read.',
                          code: asset.fetchFailure ?? 'unknown',
                          canPaste: true,
                        });
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      disabled={busy}
                    >
                      <ClipboardPaste size={13} /> Supply its content
                    </button>
                  )}
                  {asset.textSource !== 'unverified' && (asset.status !== 'active' || asset.sourceChangedAt) ? (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => void setStatus(asset.assetId, 'active')}
                      disabled={busy}
                    >
                      <Check size={13} /> {asset.sourceChangedAt ? 'I have re-read it' : 'Confirm'}
                    </button>
                  ) : (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => void setStatus(asset.assetId, 'retired')}
                      disabled={busy}
                    >
                      Retire
                    </button>
                  )}
                  <button
                    className="btn btn-ghost btn-sm text-error"
                    onClick={() => void remove(asset.assetId, asset.title)}
                    disabled={busy}
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
