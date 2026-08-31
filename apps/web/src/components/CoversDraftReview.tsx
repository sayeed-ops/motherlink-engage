'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { apiGet, apiFetch } from '@/lib/api';
import { VARIANT_LABEL, type VariantKind } from '@/modules/covers/variants';
import {
  DIMENSIONS,
  DIMENSION_ASKS,
  DIMENSION_LABEL,
  isInverted,
  type Recommendation,
  type ScoreDimension,
} from '@/modules/covers/score';
import { DROP_STAGE_LABEL, type DropStage } from '@/modules/covers/selectVariant';
import { COVERS_DRAFT_STATUS_LABEL, type CoversDraftStatus } from '@/modules/covers/draft';
import { INTENT_LABEL, type PostIntent } from '@/modules/covers/intent';

// The phase-4 review queue.
//
// ════════════════════════════════════════════════════════════════════════════
// THERE IS NO POST BUTTON, AND THERE IS NOTHING BEHIND ONE
//
// "Approve" records that a person read the draft and agreed with it. The text is
// copied to the clipboard and posted by hand. No job is queued because no Covers
// job kind exists — see modules/covers/draft.ts. When phase 6 adds one, a button
// gets added here deliberately, next to this comment.
// ════════════════════════════════════════════════════════════════════════════
//
// ════════════════════════════════════════════════════════════════════════════
// EVERY STATED FACT IS SHOWN WITH THE CLAIM AND THE PAGE BEHIND IT
//
// The reviewer's question is not "is this well written" — the scores answer that
// badly enough already. It is "why does this system believe this sentence is
// safe to say in public, under a regulated client's name". So the evidence
// travels with the draft: the sentence, the claim that backs it, the source URL,
// one click away. A reviewer approving a factual assertion on the system's word
// is the exact act the whole claim ledger exists to prevent, and a review screen
// that hides the evidence reintroduces it at the last step.
// ════════════════════════════════════════════════════════════════════════════

interface ClaimEvidence {
  claimId: string;
  text: string;
  sourceUrl: string;
  assetId: string;
  assetTitle: string;
  supports: string;
  live: boolean;
}

interface WrittenVariant {
  kind: VariantKind;
  text: string;
  words: number;
  claimIds: string[];
  scores: Record<ScoreDimension, number> | null;
  recommendation: Recommendation | null;
  why: string;
  compliancePassed: boolean;
  complianceFailures: { code: string; detail: string }[];
  evidence: ClaimEvidence[];
  assertions: { sentence: string; backedBy: string | null }[];
  disclosure: { required: boolean; wording: string; why: string };
}

interface DroppedVariant {
  kind: VariantKind;
  stage: DropStage;
  reasons: string[];
  floorFailures?: { dimension: ScoreDimension; score: number; floor: number; detail: string }[];
}

interface DraftRow {
  draftId: string;
  runId: string;
  context: {
    itemId: string;
    postId: string;
    section: string;
    sectionName: string;
    threadTitle: string;
    threadUrl: string;
    postAuthor: string;
    postBody: string;
    postCreatedAtMs: number | null;
    intent: PostIntent | null;
    problem: string;
    matchedAssets: { assetId: string; title: string; triggers: string[] }[];
    opportunityScore: number;
  };
  variants: WrittenVariant[];
  dropped: DroppedVariant[];
  selected: VariantKind | 'NONE';
  selectionReason: string;
  criticCalled: boolean;
  status: CoversDraftStatus;
  decidedByName: string | null;
  decisionReason: string;
  model: string;
}

export default function CoversDraftReview({
  projectId,
  section,
  refreshKey,
}: {
  projectId: string;
  section?: string;
  refreshKey?: number;
}) {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDeclined, setShowDeclined] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (section) params.set('section', section);
      const res = await apiGet<{ drafts: DraftRow[] }>(
        `/api/projects/${projectId}/covers/drafts?${params.toString()}`,
      );
      setDrafts(res.drafts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load drafts.');
    } finally {
      setLoading(false);
    }
  }, [projectId, section]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const decide = async (draftId: string, status: 'approved' | 'rejected', reason: string) => {
    await apiFetch(`/api/projects/${projectId}/covers/drafts`, {
      method: 'PATCH',
      body: JSON.stringify({ draftId, status, reason }),
    });
    await load();
  };

  // Declined attempts are shown by default and can be hidden, never the other
  // way round. NONE is the normal outcome, and a queue that opens on the
  // successes teaches an operator to read a working funnel as a broken one.
  const visible = showDeclined ? drafts : drafts.filter((d) => d.selected !== 'NONE');

  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <FileText size={16} aria-hidden /> Drafts for review
          <span className="badge" style={{ marginLeft: '0.5rem' }}>{drafts.length}</span>
        </h3>
        <label className="row small" style={{ gap: '0.35rem' }}>
          <input
            type="checkbox"
            checked={showDeclined}
            onChange={(e) => setShowDeclined(e.target.checked)}
          />
          show the ones it declined
        </label>
      </div>

      <p className="text-dim small">
        Nothing here can post. Approving records that you read it and agreed — you copy the text and
        post it yourself. <strong>NONE is the normal answer</strong>, and every decline is listed with the
        stage it stopped at.
      </p>

      {error && <p className="text-error small">{error}</p>}
      {loading && <p className="text-dim small">Loading…</p>}
      {!loading && visible.length === 0 && (
        <p className="text-dim small">No drafts yet. Run generation over a triage run.</p>
      )}

      <div style={{ display: 'grid', gap: '1rem' }}>
        {visible.map((d) => (
          <DraftCard key={d.draftId} draft={d} onDecide={decide} />
        ))}
      </div>
    </section>
  );
}

function DraftCard({
  draft,
  onDecide,
}: {
  draft: DraftRow;
  onDecide: (draftId: string, status: 'approved' | 'rejected', reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(draft.selected !== 'NONE');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const chosen = draft.variants.find((v) => v.kind === draft.selected) ?? null;

  return (
    <div className="card" style={{ borderLeft: chosen ? '3px solid var(--accent, #4a9)' : undefined }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: '1rem' }}>
        <div style={{ minWidth: 0 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          </button>
          <strong>{draft.context.threadTitle}</strong>
          <div className="text-dim small">
            {draft.context.sectionName} · {draft.context.postAuthor} ·{' '}
            {draft.context.intent ? INTENT_LABEL[draft.context.intent] : 'intent unknown'} · opportunity{' '}
            {draft.context.opportunityScore}
            {draft.context.threadUrl && (
              <>
                {' · '}
                <a href={draft.context.threadUrl} target="_blank" rel="noreferrer">
                  thread <ExternalLink size={11} aria-hidden />
                </a>
              </>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: '0.4rem', flexShrink: 0 }}>
          <span className={`badge ${draft.selected === 'NONE' ? '' : 'badge-success'}`}>
            {draft.selected === 'NONE' ? 'NONE' : VARIANT_LABEL[draft.selected]}
          </span>
          <span className="badge">{COVERS_DRAFT_STATUS_LABEL[draft.status]}</span>
        </div>
      </div>

      {open && (
        <>
          {/* What was asked, in the writer's own terms — the fastest way to see
              a misread before reading a word of the reply. */}
          <div className="small" style={{ marginTop: '0.6rem' }}>
            <div className="text-dim">The post:</div>
            <blockquote style={{ margin: '0.2rem 0', paddingLeft: '0.6rem', borderLeft: '2px solid #8884' }}>
              {draft.context.postBody.slice(0, 700)}
              {draft.context.postBody.length > 700 ? '…' : ''}
            </blockquote>
            <div className="text-dim">Read as: {draft.context.problem}</div>
            {draft.context.matchedAssets.length > 0 && (
              <div className="text-dim" style={{ marginTop: '0.2rem' }}>
                matched:{' '}
                {draft.context.matchedAssets
                  .map((a) => `${a.title}${a.triggers.length ? ` (on "${a.triggers[0]}")` : ''}`)
                  .join(', ')}
              </div>
            )}
          </div>

          {/* The decision, and whether it cost a model call. */}
          <div className="small" style={{ marginTop: '0.6rem' }}>
            <strong>
              {draft.selected === 'NONE' ? 'Declined' : `Chose ${VARIANT_LABEL[draft.selected]}`}
            </strong>{' '}
            — {draft.selectionReason}
            <div className="text-dim">
              {draft.criticCalled
                ? 'the critic was asked'
                : 'settled arithmetically — no critic call was made'}
            </div>
          </div>

          {draft.variants.map((v) => (
            <VariantPanel key={v.kind} variant={v} chosen={v.kind === draft.selected} />
          ))}

          {draft.dropped.length > 0 && (
            <div style={{ marginTop: '0.8rem' }}>
              <div className="small text-dim">Dropped, and why:</div>
              <ul className="list">
                {draft.dropped.map((x, i) => (
                  <li key={`${x.kind}-${i}`} className="list-row" style={{ display: 'block' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="small">
                        <strong>{VARIANT_LABEL[x.kind]}</strong>
                      </span>
                      <span className="badge">{DROP_STAGE_LABEL[x.stage]}</span>
                    </div>
                    <ul className="small text-dim">
                      {x.reasons.map((r, j) => (
                        <li key={j}>{r}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Approve / reject. Approving copies nothing on its own — the copy
              button is on the chosen variant, because the text is the artefact
              and the decision is a record about it. */}
          {draft.status === 'pending' && chosen && (
            <div className="row" style={{ gap: '0.5rem', marginTop: '0.8rem', flexWrap: 'wrap' }}>
              <input
                className="input"
                placeholder="Why? (captured either way — this is what the floors get fitted against)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{ flex: 1, minWidth: '18rem' }}
              />
              <button
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onDecide(draft.draftId, 'approved', reason);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Check size={14} aria-hidden /> Approve
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onDecide(draft.draftId, 'rejected', reason);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <X size={14} aria-hidden /> Reject
              </button>
            </div>
          )}

          {draft.status !== 'pending' && draft.decisionReason && (
            <div className="small text-dim" style={{ marginTop: '0.6rem' }}>
              {draft.decidedByName ?? 'someone'}: {draft.decisionReason}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function VariantPanel({ variant, chosen }: { variant: WrittenVariant; chosen: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(variant.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="card"
      style={{
        marginTop: '0.7rem',
        opacity: chosen ? 1 : 0.75,
        borderLeft: chosen ? '3px solid var(--accent, #4a9)' : undefined,
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', gap: '0.5rem' }}>
        <strong className="small">
          {VARIANT_LABEL[variant.kind]}
          {chosen && ' — selected'}
        </strong>
        <div className="row" style={{ gap: '0.35rem' }}>
          <span className="badge">{variant.words} words</span>
          {variant.recommendation && <span className="badge">{variant.recommendation}</span>}
          <span className={`badge ${variant.compliancePassed ? 'badge-success' : ''}`}>
            {variant.compliancePassed ? (
              <>
                <ShieldCheck size={11} aria-hidden /> compliance clean
              </>
            ) : (
              <>
                <ShieldAlert size={11} aria-hidden /> {variant.complianceFailures.length} failure
                {variant.complianceFailures.length === 1 ? '' : 's'}
              </>
            )}
          </span>
        </div>
      </div>

      <p style={{ whiteSpace: 'pre-wrap', margin: '0.4rem 0' }}>{variant.text}</p>

      <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
        <button className="btn btn-secondary btn-sm" onClick={copy}>
          <Copy size={13} aria-hidden /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* The six numbers. Labelled as uncalibrated, every time they are shown —
          a number on a screen reads as a measurement unless it says otherwise. */}
      {variant.scores && (
        <div style={{ marginTop: '0.6rem' }}>
          <div className="row small" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            {DIMENSIONS.map((d) => (
              <span
                key={d}
                className="badge"
                title={`${DIMENSION_ASKS[d]}${isInverted(d) ? ' (lower is better)' : ''}`}
              >
                {DIMENSION_LABEL[d]} {variant.scores![d]}
                {isInverted(d) ? ' ↓' : ''}
              </span>
            ))}
          </div>
          <div className="text-dim small" style={{ marginTop: '0.2rem' }}>
            {variant.why} · <em>model output, not a measurement — uncalibrated until phase 5</em>
          </div>
        </div>
      )}

      {variant.disclosure.required && (
        <div className="small" style={{ marginTop: '0.5rem' }}>
          <span className="badge">Disclosure required</span> {variant.disclosure.why} Attach:{' '}
          <strong>{variant.disclosure.wording}</strong>
          <div className="text-dim">
            Not added to the text — you approve what gets posted, so the wording is yours to place.
          </div>
        </div>
      )}

      {variant.complianceFailures.length > 0 && (
        <ul className="small text-error" style={{ marginTop: '0.5rem' }}>
          {variant.complianceFailures.map((f, i) => (
            <li key={i}>
              <code>{f.code}</code> — {f.detail}
            </li>
          ))}
        </ul>
      )}

      <EvidencePanel variant={variant} />
    </div>
  );
}

/**
 * What the reply asserts, and what stands behind each assertion.
 *
 * Rendered whenever there is anything to say — including when the answer is
 * "this reply states no facts", which is itself the reason a reviewer can read
 * it quickly. An unbacked assertion is shown in the same list as a backed one,
 * marked, so the two are compared rather than one being hidden behind a failure
 * code further up.
 */
function EvidencePanel({ variant }: { variant: WrittenVariant }) {
  const [open, setOpen] = useState(variant.assertions.some((a) => a.backedBy === null));

  const byId = new Map(variant.evidence.map((e) => [e.claimId, e]));
  const unused = variant.evidence.filter((e) => !e.supports);

  if (variant.assertions.length === 0 && variant.evidence.length === 0) {
    return (
      <div className="small text-dim" style={{ marginTop: '0.5rem' }}>
        States no facts — nothing here needs a claim behind it.
      </div>
    );
  }

  return (
    <div style={{ marginTop: '0.5rem' }}>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        Evidence ({variant.assertions.length} assertion
        {variant.assertions.length === 1 ? '' : 's'})
      </button>

      {open && (
        <ul className="list">
          {variant.assertions.map((a, i) => {
            const claim = a.backedBy ? byId.get(a.backedBy) : null;
            return (
              <li key={i} className="list-row" style={{ display: 'block' }}>
                <div className="small">“{a.sentence}”</div>
                {claim ? (
                  <div className="small text-dim" style={{ marginTop: '0.2rem' }}>
                    backed by <code>{claim.claimId}</code>: “{claim.text}”
                    <br />
                    from <strong>{claim.assetTitle}</strong>{' '}
                    {claim.sourceUrl && (
                      <a href={claim.sourceUrl} target="_blank" rel="noreferrer">
                        source <ExternalLink size={11} aria-hidden />
                      </a>
                    )}
                  </div>
                ) : (
                  <div className="small text-error" style={{ marginTop: '0.2rem' }}>
                    nothing backs this — no live claim covers it
                  </div>
                )}
              </li>
            );
          })}

          {unused.map((e) => (
            <li key={`unused-${e.claimId}`} className="list-row" style={{ display: 'block' }}>
              <div className="small text-dim">
                read but not stated — <code>{e.claimId}</code>: “{e.text}”{' '}
                {e.sourceUrl && (
                  <a href={e.sourceUrl} target="_blank" rel="noreferrer">
                    source <ExternalLink size={11} aria-hidden />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
