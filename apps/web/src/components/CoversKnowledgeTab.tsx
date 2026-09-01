'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  MessagesSquare,
  Puzzle,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { apiGet, apiFetch, ApiError } from '@/lib/api';

// Covers knowledge — the audience, the client, and the match between them.
//
// ════════════════════════════════════════════════════════════════════════════
// THE SCREEN IS THE EXPLANATION
//
// It reads top to bottom as the thing it does:
//
//   1. what this forum's audience needs        (measured from real posts)
//   2. what this client can offer              (researched against those needs)
//   3. which needs are actually covered        (computed, not claimed)
//
// Somebody who has never seen the tool should be able to follow that without
// being told about assets, claims, triggers or retrieval. Those words appear
// nowhere on this screen.
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ AN UNVERIFIED CANDIDATE MUST BE IMPOSSIBLE TO MISTAKE FOR KNOWLEDGE. A
// search-enabled model proposing a capability is a LEAD; it can shape a reply
// and can never be the evidence behind a stated fact. The badge is loud for that
// reason, and approving one does not make it citable.

interface Need {
  needId: string;
  title: string;
  whatPeopleWant: string;
  phrases: string[];
  valueAreas: string[];
  posts: number;
  threads: number;
  sections: string[];
  examples: string[];
}

interface ConversationMap {
  needs: Need[];
  postsAnalysed: number;
  postsMappable: number;
  sections: string[];
  threads: number;
  clustersFound: number;
  builtAtMs: number;
}

interface Candidate {
  assetId: string;
  title: string;
  purpose: string;
  problems: string[];
  triggers: string[];
  exclusions: string[];
  sourceUrl: string;
  status: 'draft' | 'active' | 'retired';
  coversNeeds: string[];
  confidence: 'high' | 'medium' | 'low';
  notes: string;
  facts: { text: string; quote: string; sourceUrl: string }[];
  verificationState: 'verified' | 'unverified';
}

interface ResearchView {
  brief: string;
  clientName: string;
  clientDomain: string;
  projectName: string;
  /** Nothing better than the workspace label was available. */
  identityGuessed: boolean;
  needs: number;
  needsMap: boolean;
  candidates: Candidate[];
  needsCovered: string[];
  needsTotal: number;
}

export default function CoversKnowledgeTab({ projectId }: { projectId: string }) {
  const [map, setMap] = useState<ConversationMap | null>(null);
  const [research, setResearch] = useState<ResearchView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [m, r] = await Promise.all([
        apiGet<{ map: ConversationMap }>(`/api/projects/${projectId}/covers/map`),
        apiGet<ResearchView>(`/api/projects/${projectId}/covers/research`),
      ]);
      setMap(m.map);
      setResearch(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load Covers knowledge.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rebuildMap = async () => {
    setBusy('map');
    setError('');
    setNote('');
    try {
      const res = await apiFetch<{ map: ConversationMap; candidates: number }>(
        `/api/projects/${projectId}/covers/map`,
        { method: 'POST' },
      );
      setMap(res.map);
      setNote(
        `Read ${res.map.postsMappable} usable posts, found ${res.map.clustersFound} clusters, ` +
          `offered ${res.candidates} and kept ${res.map.needs.length}.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not build the map.');
    } finally {
      setBusy(null);
    }
  };

  const hasMap = Boolean(map && map.needs.length > 0);
  const hasCandidates = Boolean(research && research.candidates.length > 0);

  return (
    <div className="sections">
      {/* ⚠️ THE ORDER IS NOT OBVIOUS FROM THE PANELS ALONE. Each step is
          useless until the one before it has run, and the first version showed
          three panels with no indication of that — a reader landing here saw a
          red error under step 2 and no way to know it meant "do step 1". */}
      <section className="card">
        <div className="card-head">
          <h3>How this works</h3>
        </div>
        <ol className="small" style={{ margin: 0, paddingLeft: '1.2rem' }}>
          <li style={{ opacity: hasMap ? 0.55 : 1 }}>
            <strong>Read the forum.</strong> On the <strong>Harvest</strong> tab: pick a section, press{' '}
            <em>Harvest</em>, then <em>Triage what we hold</em>. Repeat for two or three sections so the
            map sees more than one kind of conversation. {hasMap && '✓ done'}
          </li>
          <li style={{ opacity: hasMap ? 1 : 0.55 }}>
            <strong>Build the map</strong> below — what this audience keeps asking for.
            {hasMap && ' ✓ done'}
          </li>
          <li style={{ opacity: hasMap && !hasCandidates ? 1 : 0.55 }}>
            <strong>Research the client</strong> against those needs: copy the brief, give it to a
            search-enabled assistant, paste the JSON back. {hasCandidates && ' ✓ done'}
          </li>
          <li style={{ opacity: hasCandidates ? 1 : 0.55 }}>
            <strong>Approve what is genuinely useful.</strong> Approved knowledge is what the
            Opportunities tab then matches conversations against.
          </li>
        </ol>
      </section>

      {error && <p className="text-error small">{error}</p>}
      {note && <p className="text-dim small">{note}</p>}

      <MapPanel map={map} busy={busy === 'map'} onRebuild={rebuildMap} />

      <ResearchPanel
        projectId={projectId}
        research={research}
        busy={busy}
        setBusy={setBusy}
        setError={setError}
        setNote={setNote}
        reload={load}
      />

      <CandidatesPanel
        projectId={projectId}
        research={research}
        map={map}
        reload={load}
        setError={setError}
      />

      <ResetPanel projectId={projectId} reload={load} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. The audience
// ---------------------------------------------------------------------------

function MapPanel({
  map,
  busy,
  onRebuild,
}: {
  map: ConversationMap | null;
  busy: boolean;
  onRebuild: () => void;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <MessagesSquare size={16} aria-hidden /> 2. What this forum talks about
        </h3>
        <button className="btn btn-secondary btn-sm" onClick={onRebuild} disabled={busy}>
          <RefreshCw size={13} aria-hidden /> {busy ? 'Reading…' : 'Rebuild map'}
        </button>
      </div>

      {!map || map.needs.length === 0 ? (
        <p className="text-dim small">
          {map && map.postsAnalysed > 0 ? (
            <>
              Read <strong>{map.postsMappable}</strong> usable posts of {map.postsAnalysed} analysed, and
              nothing recurs often enough yet to call a need. Harvest and triage another section — one
              board on its own rarely shows a pattern — then press <em>Rebuild map</em>.
            </>
          ) : (
            <>
              <strong>Nothing has been read yet.</strong> Go to the <strong>Harvest</strong> tab, pick a
              section, press <em>Harvest</em> and then <em>Triage what we hold</em>. Come back here and
              press <em>Rebuild map</em>. The map is built from what triage understood, so nothing can
              appear before that has run.
            </>
          )}
        </p>
      ) : (
        <>
          {/* ⚠️ THE DENOMINATORS SIT NEXT TO THE HEADLINE. "12 needs" from 30
              posts on one board is a different claim from the same number over
              300 posts across six, and a screen showing only the need count
              makes them look identical. */}
          <p className="small">
            <strong>{map.needs.length} recurring needs</strong>, from{' '}
            <strong>{map.postsMappable}</strong> posts across <strong>{map.threads}</strong> threads in{' '}
            <strong>{map.sections.length}</strong> section{map.sections.length === 1 ? '' : 's'}.
          </p>
          <p className="text-dim small">
            {map.postsAnalysed} posts analysed in total; the rest were screened out or had nothing being
            asked. {map.clustersFound} candidate clusters found, {map.needs.length} kept.
          </p>

          <ul className="list">
            {map.needs.map((n) => (
              <li key={n.needId} className="list-row" style={{ display: 'block' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{n.title}</strong>
                  <span className="badge">
                    {n.posts} post{n.posts === 1 ? '' : 's'} · {n.threads} thread
                    {n.threads === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="small" style={{ marginTop: '0.2rem' }}>
                  {n.whatPeopleWant}
                </div>
                {n.phrases.length > 0 && (
                  <div className="small text-dim" style={{ marginTop: '0.2rem' }}>
                    people say: {n.phrases.map((p) => `“${p}”`).join(', ')}
                  </div>
                )}
                {n.valueAreas.length > 0 && (
                  <div className="row small" style={{ gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
                    {n.valueAreas.map((v) => (
                      <span key={v} className="chip">
                        {v}
                      </span>
                    ))}
                  </div>
                )}
                {n.examples[0] && (
                  <div className="small text-dim" style={{ marginTop: '0.2rem' }}>
                    e.g. {n.examples[0]}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2. The client research interchange
// ---------------------------------------------------------------------------

function ResearchPanel({
  projectId,
  research,
  busy,
  setBusy,
  setError,
  setNote,
  reload,
}: {
  projectId: string;
  research: ResearchView | null;
  busy: string | null;
  setBusy: (v: string | null) => void;
  setError: (v: string) => void;
  setNote: (v: string) => void;
  reload: () => Promise<void>;
}) {
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!research) return null;

  // Uncontrolled until edited, so a reload does not stomp on typing.
  const nameValue = name ?? research.clientName;
  const domainValue = domain ?? research.clientDomain;
  const dirty = nameValue !== research.clientName || domainValue !== research.clientDomain;

  const saveIdentity = async () => {
    setBusy('identity');
    setError('');
    try {
      // Written to the Covers policy, not to the project: the project name is a
      // workspace label shared with Reddit, and renaming somebody's workspace
      // because a research brief read badly would be the wrong fix.
      await apiFetch(`/api/projects/${projectId}/covers/policy`, {
        method: 'PUT',
        body: JSON.stringify({ policy: { clientName: nameValue, clientDomain: domainValue } }),
      });
      setSaved(true);
      setName(null);
      setDomain(null);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the client details.');
    } finally {
      setBusy(null);
    }
  };

  const copyBrief = async () => {
    await navigator.clipboard.writeText(research.brief);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const importResearch = async () => {
    setBusy('import');
    setError('');
    setNote('');
    try {
      const res = await apiFetch<{
        imported: number;
        rejected: { index: number; reason: string }[];
        repaired: boolean;
        unknownNeeds: string[];
        needsCovered: number;
        needsTotal: number;
      }>(`/api/projects/${projectId}/covers/research`, {
        method: 'POST',
        body: JSON.stringify({ research: paste }),
      });

      // ⚠️ IMPORTING NOTHING IS AN ERROR, NOT A NOTE. The first version reported
      // "Imported 0 capabilities" in grey, which reads as nothing having
      // happened at all — a real paste failed on one stray quotation mark and
      // the screen gave no hint of it.
      if (res.imported === 0) {
        setError(
          res.rejected[0]?.reason ??
            'Nothing was imported. The JSON parsed but contained no usable capabilities.',
        );
        return;
      }

      setPaste('');

      const notes = [
        `Imported ${res.imported} capabilit${res.imported === 1 ? 'y' : 'ies'}, covering ` +
          `${res.needsCovered} of ${res.needsTotal} needs.`,
      ];
      if (res.repaired) {
        notes.push(
          'The JSON was not valid and had to be repaired to read it — usually a quotation mark inside ' +
            'a sentence. Worth glancing over what came in.',
        );
      }
      if (res.rejected.length) {
        notes.push(`${res.rejected.length} row(s) could not be read: ${res.rejected[0].reason}`);
      }
      if (res.unknownNeeds.length) {
        notes.push(
          `The research referred to needs this map does not have, and those links were dropped: ` +
            `${res.unknownNeeds.join(', ')}. Rebuild the map or re-copy the brief so the ids match.`,
        );
      }
      setNote(notes.join(' '));
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not import.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>3. Research the client against those needs</h3>
      </div>

      <p className="text-dim small">
        The brief turns the needs above into research objectives. Paste it into a search-enabled
        assistant, then bring the JSON back here. Nothing imported can be cited until a person verifies
        its source.
      </p>

      {/* ⚠️ THE IDENTITY IS EDITABLE HERE, BEFORE THE BRIEF IS COPIED. It used
          to be the project name, which is a workspace label — the brief went out
          saying "Client: test project", which tells an outside researcher
          nothing. The website is what actually identifies a company, so it is
          asked for first and leads the brief. */}
      <div className="grid-form" style={{ marginBottom: '0.5rem' }}>
        <div className="field">
          <label className="label">Client website — this is what identifies them</label>
          <input
            className="input"
            value={domainValue}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="https://www.example.com"
            style={{ width: '100%' }}
          />
        </div>
        <div className="field">
          <label className="label">Client name</label>
          <input
            className="input"
            value={nameValue}
            onChange={(e) => setName(e.target.value)}
            placeholder="The company's real name"
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {research.identityGuessed && !dirty && (
        <p className="text-error small">
          The brief is currently using the project name <strong>“{research.projectName}”</strong> as the
          client, because no website is set. That will mean nothing to whoever researches this — add the
          client&apos;s website above and save.
        </p>
      )}

      {(dirty || saved) && (
        <div className="row" style={{ gap: '0.5rem', marginBottom: '0.5rem' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={saveIdentity}
            disabled={busy === 'identity' || !dirty}
          >
            {busy === 'identity' ? 'Saving…' : 'Save client details'}
          </button>
          {saved && !dirty && <span className="small text-dim">Saved — the brief now uses these.</span>}
        </div>
      )}

      {research.needsMap && (
        <p className="text-dim small">
          <strong>Not ready yet.</strong> The brief is a list of questions built from the needs in step 2,
          so there is nothing to ask until the map exists. Harvest and triage a section, then build the
          map above.
        </p>
      )}

      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={copyBrief} disabled={research.needsMap}>
          <Copy size={13} aria-hidden /> {copied ? 'Copied' : 'Copy research brief'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />} Preview
        </button>
      </div>

      {open && (
        <pre
          className="small"
          style={{ whiteSpace: 'pre-wrap', maxHeight: '18rem', overflow: 'auto', marginTop: '0.5rem' }}
        >
          {research.brief}
        </pre>
      )}

      <label className="label" style={{ marginTop: '0.7rem' }}>
        Paste the research JSON
      </label>
      <textarea
        className="input"
        rows={5}
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        placeholder='{ "client": "…", "capabilities": [ … ] }'
        style={{ width: '100%', fontFamily: 'monospace' }}
      />
      <button
        className="btn btn-secondary btn-sm"
        onClick={importResearch}
        disabled={busy === 'import' || !paste.trim()}
      >
        {busy === 'import' ? 'Importing…' : 'Import research'}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 3. The match
// ---------------------------------------------------------------------------

function CandidatesPanel({
  projectId,
  research,
  map,
  reload,
  setError,
}: {
  projectId: string;
  research: ResearchView | null;
  map: ConversationMap | null;
  reload: () => Promise<void>;
  setError: (v: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!research) return null;

  const needTitle = (id: string) => map?.needs.find((n) => n.needId === id)?.title ?? id;

  const decide = async (assetId: string, status: 'active' | 'retired') => {
    setBusyId(assetId);
    setError('');
    try {
      await apiFetch(`/api/projects/${projectId}/covers/research`, {
        method: 'PATCH',
        body: JSON.stringify({ assetId, status }),
      });
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save that decision.');
    } finally {
      setBusyId(null);
    }
  };

  const pending = research.candidates.filter((c) => c.status === 'draft');
  const approved = research.candidates.filter((c) => c.status === 'active');

  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <Puzzle size={16} aria-hidden /> 4. What this client can contribute
        </h3>
      </div>

      {research.candidates.length === 0 ? (
        <p className="text-dim small">
          Nothing yet. Copy the brief above, research the client, and import the findings — or add
          knowledge by hand from the client library.
        </p>
      ) : (
        <p className="small">
          <strong>{research.candidates.length} capabilities</strong> ({approved.length} approved,{' '}
          {pending.length} awaiting review) covering{' '}
          <strong>
            {research.needsCovered.length} of {research.needsTotal}
          </strong>{' '}
          needs.
        </p>
      )}

      <ul className="list">
        {research.candidates.map((c) => (
          <li key={c.assetId} className="list-row" style={{ display: 'block' }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: '0.5rem' }}>
              <strong>{c.title}</strong>
              <div className="row" style={{ gap: '0.3rem', flexShrink: 0 }}>
                {/* Loud, and it stays loud after approval — approving says
                    "worth matching on", never "these facts may be stated". */}
                {c.verificationState === 'unverified' && (
                  <span className="badge" style={{ background: '#a33', color: '#fff' }}>
                    <AlertTriangle size={11} aria-hidden /> UNVERIFIED LEAD
                  </span>
                )}
                <span className="badge">confidence {c.confidence}</span>
                {c.status === 'active' && <span className="badge badge-success">approved</span>}
                {c.status === 'retired' && <span className="badge">rejected</span>}
              </div>
            </div>

            {c.coversNeeds.length > 0 && (
              <div className="small" style={{ marginTop: '0.25rem' }}>
                <strong>Helps with:</strong> {c.coversNeeds.map(needTitle).join(', ')}
              </div>
            )}

            <div className="small text-dim" style={{ marginTop: '0.2rem' }}>
              {c.purpose}
            </div>

            {c.triggers.length > 0 && (
              <div className="small text-dim" style={{ marginTop: '0.2rem' }}>
                relevant when people say: {c.triggers.slice(0, 6).map((t) => `“${t}”`).join(', ')}
              </div>
            )}

            {c.exclusions.length > 0 && (
              <div className="small text-dim" style={{ marginTop: '0.2rem' }}>
                not relevant to: {c.exclusions.join('; ')}
              </div>
            )}

            {c.facts.length > 0 && (
              <div className="small text-dim" style={{ marginTop: '0.2rem' }}>
                {c.facts.length} proposed fact{c.facts.length === 1 ? '' : 's'} — none citable until its
                source is verified
              </div>
            )}

            {c.sourceUrl && (
              <div className="small" style={{ marginTop: '0.2rem' }}>
                <a href={c.sourceUrl} target="_blank" rel="noreferrer">
                  source <ExternalLink size={11} aria-hidden />
                </a>
              </div>
            )}

            {c.status === 'draft' && (
              <div className="row" style={{ gap: '0.4rem', marginTop: '0.4rem' }}>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busyId === c.assetId}
                  onClick={() => decide(c.assetId, 'active')}
                >
                  <Check size={13} aria-hidden /> Approve
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busyId === c.assetId}
                  onClick={() => decide(c.assetId, 'retired')}
                >
                  <X size={13} aria-hidden /> Reject
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 4. Starting over
// ---------------------------------------------------------------------------

interface ResetPreview {
  projectName: string;
  deleting: { label: string; collection: string; count: number }[];
  preserving: { label: string; collection: string; count: number }[];
  totalDeleting: number;
}

function ResetPanel({ projectId, reload }: { projectId: string; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState({ clientKnowledge: true, pipelineOutput: true, conversationMap: false });
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState('');

  const loadPreview = useCallback(async () => {
    const q = new URLSearchParams({
      clientKnowledge: scope.clientKnowledge ? '1' : '0',
      pipelineOutput: scope.pipelineOutput ? '1' : '0',
      conversationMap: scope.conversationMap ? '1' : '0',
    });
    try {
      setPreview(await apiGet<ResetPreview>(`/api/projects/${projectId}/covers/reset?${q}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not read the preview.');
    }
  }, [projectId, scope]);

  useEffect(() => {
    if (open) void loadPreview();
  }, [open, loadPreview]);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch<{
        deleted: Record<string, number>;
        redditAfter: Record<string, number>;
      }>(`/api/projects/${projectId}/covers/reset`, {
        method: 'POST',
        body: JSON.stringify({ confirmName, scope }),
      });
      setResult(
        `Deleted ${Object.entries(res.deleted).map(([k, n]) => `${n} ${k}`).join(', ')}. ` +
          `Reddit after: ${Object.entries(res.redditAfter).map(([k, n]) => `${n} ${k}`).join(', ')}.`,
      );
      setConfirmName('');
      await reload();
      await loadPreview();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Reset failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <Trash2 size={16} aria-hidden /> Reset Covers knowledge
        </h3>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        </button>
      </div>

      {open && (
        <>
          <p className="text-dim small">
            Starts this client&apos;s Covers knowledge from zero. Harvested threads are kept — reading the
            forum costs somebody else&apos;s bandwidth and the map is rebuilt from them.{' '}
            <strong>Reddit is never touched</strong>: every delete matches <code>platform == &apos;covers&apos;</code>{' '}
            explicitly, never by exclusion.
          </p>

          <div style={{ display: 'grid', gap: '0.3rem', margin: '0.5rem 0' }}>
            {(
              [
                ['clientKnowledge', 'Client knowledge — capabilities, facts, discovered pages, interview'],
                ['pipelineOutput', 'Pipeline output — analyses, drafts, review feedback, outcomes'],
                ['conversationMap', 'Conversation map — describes the FORUM, not the client. Rebuilding it needs a re-triage.'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="row small" style={{ gap: '0.35rem' }}>
                <input
                  type="checkbox"
                  checked={scope[key]}
                  onChange={(e) => setScope((s) => ({ ...s, [key]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
          </div>

          {preview && (
            <div className="row" style={{ gap: '1.5rem', flexWrap: 'wrap' }}>
              <div>
                <div className="label">Will delete ({preview.totalDeleting})</div>
                <ul className="small">
                  {preview.deleting.map((d) => (
                    <li key={d.collection}>
                      {d.count} — {d.label}
                    </li>
                  ))}
                </ul>
              </div>
              {/* ⚠️ SHOWN BESIDE THE DELETIONS, NOT IN A FOOTNOTE. The question
                  a destructive action has to answer is "will this touch Reddit",
                  and the only convincing answer is the numbers. */}
              <div>
                <div className="label">Will keep</div>
                <ul className="small text-dim">
                  {preview.preserving.map((p) => (
                    <li key={p.collection}>
                      {p.count} — {p.label}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {error && <p className="text-error small">{error}</p>}
          {result && <p className="small text-dim">{result}</p>}

          {/* ⚠️ THE PHRASE IS SHOWN, NOT JUST ASKED FOR. The button is disabled
              until it matches, and a disabled button next to a placeholder
              reading "type the project name" leaves a reader hunting for a value
              the screen already knows. */}
          <p className="small" style={{ marginTop: '0.5rem' }}>
            To confirm, type{' '}
            <strong>
              <code>{preview?.projectName ?? '…'}</code>
            </strong>{' '}
            below. The button stays disabled until it matches exactly.
          </p>
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              className="input"
              placeholder={preview?.projectName ?? 'the project name'}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              style={{ flex: 1, minWidth: '16rem' }}
            />
            <button
              className="btn btn-secondary btn-sm"
              onClick={run}
              disabled={busy || confirmName.trim() !== (preview?.projectName ?? '')}
            >
              {busy ? 'Resetting…' : 'Reset'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
