'use client';

import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Loader2, PenLine, RotateCcw } from 'lucide-react';
import type { Assessment } from '@/modules/shopify/assess';
import { ENGAGEMENT_LABEL } from '@/modules/shopify/digest';
import { MODE_LABEL, REPLY_MODES, type ReplyMode } from '@/modules/shopify/modes';
import DraftPanel from './DraftPanel';
import { age, tokens, type AssessmentVersion, type Draft, type StoredAssessment } from './types';

// One thread, opened: its analysis and its drafts.
//
// ════════════════════════════════════════════════════════════════════════════
// TWO SECTIONS, AND THE SCREEN MOVES TO WHERE THE WORK LANDS
//
// The first version laid everything out at once — question, three score
// blocks, the re-analyse box, what the replies said, the evidence, every
// draft — and the draft you had just asked for arrived a thousand pixels below
// the button you pressed, with nothing saying where. The operator's verdict:
// "no idea where to look".
//
// So: ANALYSIS and DRAFTS are two sections, each a header you can open and
// close. A collapsed header still carries its summary (the scores; the draft
// counts), so closing one loses no context. Pressing Draft collapses the
// analysis, opens the drafts on that mode, puts a "writing…" placeholder
// exactly where the reply will appear, and scrolls there.
//
// The three kinds of reply are three CARDS, each holding its own reason and its
// own Draft button — the action next to the argument for it.
//
// "What the replies already say" lives with the DRAFTS, not the analysis: the
// draft call produces it, and it explains the draft.
// ════════════════════════════════════════════════════════════════════════════

export function ScoreChips({ a }: { a: Assessment }) {
  return (
    <span className="row" style={{ gap: '0.3rem', flexWrap: 'wrap' }}>
      {REPLY_MODES.map((m) => (
        <span key={m} className={`badge ${a.suggested === m ? 'badge-success' : ''}`} title={a.scores[m].why}>
          {MODE_LABEL[m]} {a.scores[m].score}
          {a.suggested === m ? ' ★' : ''}
        </span>
      ))}
      {a.suggested === 'skip' && <span className="badge">suggests skip</span>}
    </span>
  );
}

function SectionHeader({
  open,
  onToggle,
  title,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="row"
      style={{
        width: '100%',
        gap: '0.6rem',
        flexWrap: 'wrap',
        background: 'none',
        border: 'none',
        padding: '0.2rem 0',
        cursor: 'pointer',
        color: 'inherit',
        textAlign: 'left',
      }}
    >
      {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
      <strong style={{ fontSize: '0.95rem' }}>{title}</strong>
      {children}
    </button>
  );
}

function ModeCard({
  mode,
  v,
  draftCount,
  blocked,
  writing,
  disabled,
  sourceTitle,
  onDraft,
  onShowDrafts,
}: {
  mode: ReplyMode;
  v: AssessmentVersion;
  draftCount: number;
  blocked: string | null;
  writing: boolean;
  disabled: boolean;
  sourceTitle: (id: string) => string;
  onDraft: () => void;
  onShowDrafts: () => void;
}) {
  const a = v.assessment;
  const s = a.scores[mode];
  const suggested = a.suggested === mode;
  return (
    <div
      style={{
        border: `1px solid ${suggested ? 'var(--primary)' : 'var(--border)'}`,
        background: suggested ? 'var(--primary-softer)' : 'transparent',
        borderRadius: 'var(--radius-md)',
        padding: '0.8rem 0.9rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.45rem',
        minWidth: 0,
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', gap: '0.5rem' }}>
        <span className="row" style={{ gap: '0.4rem' }}>
          <strong>{MODE_LABEL[mode]}</strong>
          {suggested && <span className="badge badge-success">suggested</span>}
        </span>
        <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {s.score}
          <span className="text-dim small">/10</span>
        </span>
      </div>

      {s.why && <p className="small" style={{ margin: 0 }}>{s.why}</p>}
      {s.angle && (
        <p className="small text-dim" style={{ margin: 0 }}>
          <strong style={{ fontWeight: 500 }}>Approach:</strong> {s.angle}
        </p>
      )}
      {mode === 'brand' && a.scores.brand.sourceIds.length > 0 && (
        <p className="small text-dim" style={{ margin: 0 }}>
          Backed by: {a.scores.brand.sourceIds.map(sourceTitle).join('; ')}
        </p>
      )}
      {blocked && (
        <p className="small" style={{ margin: 0, color: 'var(--warning)' }}>
          {blocked}
        </p>
      )}

      <div className="row" style={{ gap: '0.4rem', marginTop: 'auto', paddingTop: '0.3rem', flexWrap: 'wrap' }}>
        <button
          className={`btn btn-sm ${suggested ? 'btn-primary' : 'btn-secondary'}`}
          onClick={onDraft}
          disabled={disabled || blocked !== null}
          title={blocked ?? `One model call. Reads the replies, then writes a ${MODE_LABEL[mode]} reply.`}
        >
          {writing ? <Loader2 size={12} className="spin" /> : <PenLine size={12} />}{' '}
          {writing ? 'Writing…' : `Draft ${MODE_LABEL[mode]}`}
        </button>
        {draftCount > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={onShowDrafts}>
            {draftCount} draft{draftCount === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </div>
  );
}

function HistoryScores({ v }: { v: AssessmentVersion }) {
  return (
    <ul className="small" style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>
      {REPLY_MODES.map((m) => (
        <li key={m}>
          <strong>
            {MODE_LABEL[m]} {v.assessment.scores[m].score}
          </strong>{' '}
          — {v.assessment.scores[m].why}
        </li>
      ))}
    </ul>
  );
}

function Digest({ stored }: { stored: StoredAssessment }) {
  const d = stored.digest;
  if (!d) return null;
  const summary = [
    `${d.offered.length} answer${d.offered.length === 1 ? '' : 's'} already given`,
    d.whatIsMissing ? `gap: ${d.whatIsMissing.length > 90 ? `${d.whatIsMissing.slice(0, 90).trimEnd()}…` : d.whatIsMissing}` : 'no obvious gap',
  ].join(' · ');

  return (
    <details style={{ marginTop: '0.2rem' }}>
      <summary className="small" style={{ cursor: 'pointer' }}>
        <strong>What the thread already says</strong> <span className="text-dim">— {summary}</span>
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '0.5rem', paddingLeft: '0.9rem' }}>
        <div className="row small text-dim" style={{ gap: '0.6rem', flexWrap: 'wrap' }}>
          <span className="badge">{ENGAGEMENT_LABEL[d.engagement] ?? d.engagement}</span>
          <span>
            Read when you last drafted, {age(stored.digestAtMs)} · {stored.postsSeen} of {stored.postsTotal} posts
            {stored.truncated ? ' (partial)' : ''}
          </span>
        </div>

        {d.whatIsMissing && (
          <div>
            <span className="eyebrow-muted">Nobody has said</span>
            <p className="small" style={{ margin: '0.15rem 0 0' }}>{d.whatIsMissing}</p>
          </div>
        )}

        {d.offered.length > 0 && (
          <div>
            <span className="eyebrow-muted">Already offered ({d.offered.length})</span>
            <ul className="small" style={{ margin: '0.15rem 0 0', paddingLeft: '1.1rem' }}>
              {d.offered.map((o, i) => (
                <li key={i}>
                  {o.endorsed && <span className="badge badge-success" style={{ marginRight: '0.3rem' }}>endorsed</span>}
                  {o.approach}
                  <span className="text-dim">
                    {' '}
                    — {o.byUsername}
                    {o.postNumber > 0 && ` #${o.postNumber}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {d.alreadySaid.length > 0 && (
          <div>
            <span className="eyebrow-muted">Said often enough already</span>
            <p className="small text-dim" style={{ margin: '0.15rem 0 0' }}>{d.alreadySaid.join(' · ')}</p>
          </div>
        )}

        {stored.evidence.length > 0 && (
          <details>
            <summary className="small text-dim" style={{ cursor: 'pointer' }}>
              The posts this is based on ({stored.evidence.length})
            </summary>
            <ul className="list" style={{ marginTop: '0.3rem' }}>
              {stored.evidence.map((e) => (
                <li key={e.postNumber} className="list-row small" style={{ display: 'block' }}>
                  <div className="text-dim">
                    #{e.postNumber} {e.username}
                    {e.likeCount > 0 && ` · ${e.likeCount} likes`}
                    {e.isAcceptedAnswer && ' · accepted answer'}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{e.quote}</div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </details>
  );
}

export default function ThreadDetail({
  stored,
  drafts,
  writing,
  reanalysing,
  anyBusy,
  freshDraftId,
  blockReason,
  sourceTitle,
  onDraft,
  onReanalyse,
  onDecide,
}: {
  stored: StoredAssessment;
  /** This thread's drafts, newest first. */
  drafts: Draft[];
  /** The mode being written for THIS thread right now, if any. */
  writing: ReplyMode | null;
  reanalysing: boolean;
  anyBusy: boolean;
  /** The draft that just arrived, so it can be marked as new. */
  freshDraftId: string | null;
  blockReason: (mode: ReplyMode) => string | null;
  sourceTitle: (id: string) => string;
  onDraft: (mode: ReplyMode) => void | Promise<void>;
  onReanalyse: (comment: string) => void | Promise<void>;
  onDecide: (draftId: string, status: 'approved' | 'rejected') => void | Promise<void>;
}) {
  // Opened with drafts already written → the drafts are the latest work, so
  // they open and the analysis waits as a one-line summary. Otherwise the
  // analysis is what there is to read.
  const [analysisOpen, setAnalysisOpen] = useState(drafts.length === 0);
  const [draftsOpen, setDraftsOpen] = useState(drafts.length > 0);
  const [tab, setTab] = useState<ReplyMode | null>(drafts[0]?.mode ?? null);
  const [comment, setComment] = useState('');
  const draftsRef = useRef<HTMLDivElement>(null);

  const v = stored.current;
  const a = v.assessment;
  const byMode = (m: ReplyMode) => drafts.filter((d) => d.mode === m);

  const showDrafts = (mode: ReplyMode) => {
    setAnalysisOpen(false);
    setDraftsOpen(true);
    setTab(mode);
    // After the sections have re-rendered, bring the drafts to the top of the
    // view — this is the "where did it go" the first version never answered.
    setTimeout(() => draftsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };

  const draft = (mode: ReplyMode) => {
    showDrafts(mode);
    void onDraft(mode);
  };

  // Tabs: every mode with a draft, plus the one being written.
  const tabs = REPLY_MODES.filter((m) => byMode(m).length > 0 || writing === m);
  const activeTab = tab && tabs.includes(tab) ? tab : (tabs[0] ?? null);
  const tabDrafts = activeTab ? byMode(activeTab) : [];
  const [latest, ...earlier] = tabDrafts;

  const sectionStyle: React.CSSProperties = {
    marginTop: '0.6rem',
    padding: '0.7rem 1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.7rem',
  };

  return (
    <div style={{ marginTop: '0.2rem' }}>
      {/* ── ANALYSIS ─────────────────────────────────────────────────────── */}
      <div className="card" style={sectionStyle}>
        <SectionHeader open={analysisOpen} onToggle={() => setAnalysisOpen((o) => !o)} title="Analysis">
          <ScoreChips a={a} />
        </SectionHeader>

        {analysisOpen && (
          <>
            {v.comment && (
              <p className="small" style={{ margin: 0 }}>
                <span className="text-dim">Re-analysed with your comment:</span> “{v.comment}”
              </p>
            )}

            <div>
              <p style={{ margin: 0, fontWeight: 500 }}>{a.question}</p>
              {a.askerContext && <p className="small text-dim" style={{ margin: '0.15rem 0 0' }}>{a.askerContext}</p>}
              {a.needs && (
                <p className="small" style={{ margin: '0.35rem 0 0' }}>
                  {/* The model often opens this field with "A good answer
                      must…" itself; a label saying the same thing again is
                      the stutter the operator saw. */}
                  {!/^a good answer\b/i.test(a.needs) && <span className="text-dim">A good answer covers: </span>}
                  {a.needs}
                </p>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '0.7rem' }}>
              {REPLY_MODES.map((m) => (
                <ModeCard
                  key={m}
                  mode={m}
                  v={v}
                  draftCount={byMode(m).length}
                  blocked={blockReason(m)}
                  writing={writing === m}
                  disabled={anyBusy}
                  sourceTitle={sourceTitle}
                  onDraft={() => draft(m)}
                  onShowDrafts={() => showDrafts(m)}
                />
              ))}
            </div>

            <div>
              <label className="small text-dim" htmlFor={`steer-${stored.topicId}`}>
                Think about it differently
              </label>
              <div className="row" style={{ gap: '0.5rem', alignItems: 'flex-start', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                <textarea
                  id={`steer-${stored.topicId}`}
                  rows={2}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="e.g. “Read it as an agency running client stores.” or “Brand fits better than you think — our migration guide covers this.”"
                  style={{ flex: '1 1 320px', minWidth: 0 }}
                />
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    void onReanalyse(comment);
                    setComment('');
                  }}
                  disabled={anyBusy || !comment.trim()}
                  title="One model call. The current analysis is kept under Earlier analyses."
                >
                  <RotateCcw size={13} /> {reanalysing ? 'Re-analysing…' : 'Re-analyse'}
                </button>
              </div>
            </div>

            {stored.history.length > 0 && (
              <details>
                <summary className="small text-dim" style={{ cursor: 'pointer' }}>
                  Earlier analyses ({stored.history.length})
                </summary>
                <ul className="list" style={{ marginTop: '0.3rem' }}>
                  {stored.history.map((h) => (
                    <li key={h.assessedAtMs} className="list-row small" style={{ display: 'block' }}>
                      <div className="row text-dim" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                        <ScoreChips a={h.assessment} />
                        <span>{age(h.assessedAtMs)}</span>
                        {h.comment && <span>· after “{h.comment}”</span>}
                      </div>
                      <HistoryScores v={h} />
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="row small text-faint" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
              <span>
                From the question only · {v.counts.replies} {v.counts.replies === 1 ? 'reply' : 'replies'} not read ·{' '}
                {age(v.assessedAtMs)} · {v.model}
                {v.usage ? ` · ${tokens(v.usage)}` : ''} ·
              </span>
              <a href={stored.url} target="_blank" rel="noopener noreferrer">
                Thread on the community <ExternalLink size={10} aria-hidden />
              </a>
            </div>
          </>
        )}
      </div>

      {/* ── DRAFTS ───────────────────────────────────────────────────────── */}
      <div className="card" style={{ ...sectionStyle, scrollMarginTop: '5rem' }} ref={draftsRef}>
        <SectionHeader open={draftsOpen} onToggle={() => setDraftsOpen((o) => !o)} title="Drafts">
          <span className="small text-dim">
            {writing
              ? `writing ${MODE_LABEL[writing]}…`
              : drafts.length
                ? REPLY_MODES.filter((m) => byMode(m).length)
                    .map((m) => `${MODE_LABEL[m]} ${byMode(m).length}`)
                    .join(' · ')
                : 'none yet'}
          </span>
        </SectionHeader>

        {draftsOpen && (
          <>
            {tabs.length === 0 ? (
              <p className="small text-dim" style={{ margin: 0 }}>
                No drafts yet. Choose a kind of reply on one of the cards in the analysis — drafting is the step that
                reads the replies.
              </p>
            ) : (
              <>
                {tabs.length > 1 && (
                  <div className="tabs-inline">
                    {tabs.map((m) => (
                      <button key={m} className={`chip-tab ${activeTab === m ? 'active' : ''}`} onClick={() => setTab(m)}>
                        {MODE_LABEL[m]}
                        <span className="chip-count">{byMode(m).length}</span>
                      </button>
                    ))}
                  </div>
                )}

                {writing && writing === activeTab && (
                  <div
                    className="row small"
                    style={{
                      gap: '0.5rem',
                      padding: '0.9rem 1rem',
                      border: '1px dashed var(--primary)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--primary-softer)',
                    }}
                  >
                    <Loader2 size={14} className="spin" aria-hidden />
                    Writing a {MODE_LABEL[writing]} reply — reading the {v.counts.replies}{' '}
                    {v.counts.replies === 1 ? 'reply' : 'replies'} first. This takes up to a minute; it will appear here.
                  </div>
                )}

                {latest && (
                  <DraftPanel draft={latest} fresh={latest.draftId === freshDraftId} sourceTitle={sourceTitle} onDecide={onDecide} />
                )}

                {earlier.length > 0 && (
                  <details>
                    <summary className="small text-dim" style={{ cursor: 'pointer' }}>
                      Earlier {activeTab ? MODE_LABEL[activeTab] : ''} drafts ({earlier.length})
                    </summary>
                    {earlier.map((d) => (
                      <DraftPanel key={d.draftId} draft={d} fresh={false} sourceTitle={sourceTitle} onDecide={onDecide} />
                    ))}
                  </details>
                )}

                <Digest stored={stored} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
