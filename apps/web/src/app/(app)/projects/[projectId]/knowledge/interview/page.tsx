'use client';

import { use, useCallback, useEffect, useState } from 'react';
import {
  Sparkles,
  Play,
  Check,
  X,
  Clock,
  Merge,
  Quote,
  Download,
  Upload,
  Plus,
  Lightbulb,
  AlertTriangle,
  FileSearch,
  ShieldQuestion,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import ArrayInput from '@/components/reddit/ArrayInput';
import { apiGet, apiPost, apiPatch, ApiError } from '@/lib/api';
import { NOT_FOUND_LABEL } from '@/modules/knowledge/interview';
import type {
  CategoryCoverage,
  Interview,
  InterviewQuestion,
} from '@/modules/knowledge/interview';

// The deep client interview.
//
// THE SCREEN IS A RESEARCH DESK, NOT A FORM. It has four states and an operator
// moves through them once per client: describe the business → generate the
// questions → research them in batches, watching progress → review what came
// back. Everything after that is maintenance.
//
// The thing the layout has to make obvious is the one that is easiest to lose:
// NOTHING ON THIS PAGE IS IN THE LIBRARY YET. Research produces proposals with
// sources attached, and only Approve puts anything where the reply pipeline can
// reach it.

interface Counts {
  total: number;
  pending: number;
  answered: number;
  notFound: number;
  awaitingReview: number;
  approved: number;
}

/** How a not-found reads on screen. `blocked` is deliberately not a dead end —
 *  those pages exist and a person can read them. */
const REASON_TONE: Record<string, string> = {
  blocked: 'alert alert-error',
  'no-candidate': 'alert alert-warning',
  'not-covered': 'alert alert-info',
  'bad-response': 'alert alert-warning',
};

type ImportDecision = 'add' | 'add-answered' | 'fill' | 'replace' | 'keep' | 'skip';

const DECISION_LABEL: Record<ImportDecision, string> = {
  add: 'Add question',
  'add-answered': 'Add with answer',
  fill: 'Take answer',
  replace: 'Replace ours',
  keep: 'Keep ours',
  skip: 'Skip',
};

/** How each decision reads at a glance. `replace` is the only one that removes
 *  something, so it is the only one that looks like a warning. */
const DECISION_TONE: Record<ImportDecision, string> = {
  add: 'badge-info',
  'add-answered': 'badge-success',
  fill: 'badge-success',
  replace: 'badge-warning',
  keep: 'badge',
  skip: 'badge',
};

interface PlanRow {
  key: string;
  question: string;
  category: string;
  decision: ImportDecision;
  choices: ImportDecision[];
  reason: string;
  losesEvidence: boolean;
  incoming: {
    status: string;
    answerText: string;
    sourcesRead: string[];
    note: string;
    notFoundReason: string | null;
    priority: number;
  };
  existing: {
    status: string;
    review: string;
    answerText: string;
    sourcesRead: string[];
    claimCount: number;
    answerSource: string;
  } | null;
}

interface ImportPlan {
  counts: Record<ImportDecision, number>;
  rows: PlanRow[];
}

interface Payload {
  interview: Interview | null;
  questions: InterviewQuestion[];
  coverage: CategoryCoverage[];
  counts: Counts;
}

/** A URL short enough to sit in a list, long enough to recognise. */
function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname}`.slice(0, 60);
  } catch {
    return u.slice(0, 60);
  }
}

export default function InterviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  // Setup
  const [clientName, setClientName] = useState('');
  const [industry, setIndustry] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const [count, setCount] = useState(100);

  // Filters
  const [category, setCategory] = useState('');
  const [showState, setShowState] = useState<'review' | 'all' | 'notfound'>('review');

  // Adding a question by hand
  const [ownQuestion, setOwnQuestion] = useState('');

  // Answered-knowledge import: the file, the plan it produced, and the
  // decisions the operator has changed. Nothing is written until Apply.
  const [importFile, setImportFile] = useState<{ name: string; parsed: unknown } | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ImportDecision>>({});
  const [planFilter, setPlanFilter] = useState<'all' | 'writes' | 'conflicts'>('writes');

  // Bulk approve: armed by a first click, done by a second. It writes into the
  // library, so it does not happen on one press.
  const [bulkArmed, setBulkArmed] = useState(false);
  const [bulkDedupe, setBulkDedupe] = useState(true);

  const load = useCallback(async () => {
    try {
      const payload = await apiGet<Payload>(`/api/projects/${projectId}/knowledge/interview`);
      setData(payload);
      if (payload.interview) {
        setClientName((v) => v || payload.interview!.clientName);
        setIndustry((v) => v || payload.interview!.industry);
        setDomains((v) => (v.length ? v : payload.interview!.domains));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the interview.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate(replace: boolean) {
    setBusy(true);
    setError(null);
    setProgress('Writing the questionnaire…');
    try {
      const res = await apiPost<{ added: number; total: number; notes: string[] }>(
        `/api/projects/${projectId}/knowledge/interview`,
        { clientName, industry, domains, count, replace },
      );
      setProgress(`${res.added} question${res.added === 1 ? '' : 's'} written. ${res.notes.join(' ')}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The questionnaire could not be generated.');
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Research everything pending, a few at a time.
   *
   * The loop lives in the browser rather than the server because a hundred
   * questions is tens of minutes and no serverless function survives that. The
   * upside is the progress line below: each batch is banked before the next
   * starts, so closing the tab loses nothing but the loop.
   */
  async function researchAll(onlyCategory?: string) {
    setBusy(true);
    setError(null);
    try {
      for (;;) {
        const res = await apiPost<{
          researched: number;
          blocked: number;
          remaining: number;
          done: boolean;
          totals: { blocked: number; notCovered: number; noCandidate: number };
        }>(`/api/projects/${projectId}/knowledge/interview/research`, { limit: 5, category: onlyCategory });

        // The blocked count leads, because it is the one with a fix. Forty
        // questions that came back "the site refused us" is a different message
        // from forty that came back "they do not publish this", and burying
        // that distinction is what made the first run unreadable.
        const blocked = res.totals?.blocked ?? 0;
        setProgress(
          `${res.done ? 'Research finished.' : `${res.remaining} questions to go.`}` +
            (blocked > 0
              ? ` ${blocked} could not be answered because the pages refused us — those are answerable by pasting the page in.`
              : ''),
        );
        await load();
        if (res.done || res.researched === 0) break;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Research stopped. What it had finished is saved.');
    } finally {
      setBusy(false);
    }
  }

  async function gapPass() {
    setBusy(true);
    setError(null);
    setProgress('Looking for what the questionnaire missed…');
    try {
      const res = await apiPost<{ added: number; note: string }>(
        `/api/projects/${projectId}/knowledge/interview/gap`,
        {},
      );
      setProgress(res.note || `${res.added} thing${res.added === 1 ? '' : 's'} nobody thought to ask about.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The second pass could not run.');
    } finally {
      setBusy(false);
    }
  }

  async function decide(questionId: string, action: string, assetId?: string) {
    setBusy(true);
    try {
      await apiPatch(`/api/projects/${projectId}/knowledge/interview/questions/${questionId}`, {
        action,
        assetId,
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That decision could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function addOwn() {
    if (ownQuestion.trim().length < 6) return;
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/knowledge/interview/questions`, {
        questions: [{ question: ownQuestion.trim(), category: category || 'Operator', priority: 4 }],
      });
      setOwnQuestion('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that question.');
    } finally {
      setBusy(false);
    }
  }

  async function exportJson() {
    try {
      const payload = await apiGet<unknown>(`/api/projects/${projectId}/knowledge/interview/export`);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${clientName || 'client'}-knowledge.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Export failed.');
    }
  }

  /** The old path, unchanged: restore a questionnaire WITHOUT its answers. */
  async function importQuestionsOnly(file: File) {
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(await file.text()) as { questions?: unknown };
      const res = await apiPost<{ added: number; skipped: number; note: string }>(
        `/api/projects/${projectId}/knowledge/interview/export`,
        { questions: parsed.questions },
      );
      setProgress(`${res.added} imported, ${res.skipped} already present. ${res.note}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That file could not be imported.');
    } finally {
      setBusy(false);
    }
  }

  /** The answered path, step one: ask what the file WOULD do. Writes nothing. */
  async function planImport(file: File) {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const res = await apiPost<{ plan: ImportPlan }>(
        `/api/projects/${projectId}/knowledge/interview/import`,
        { file: parsed, fileName: file.name },
      );
      setImportFile({ name: file.name, parsed });
      setPlan(res.plan);
      setDecisions({});
      setPlanFilter(res.plan.counts.keep > 0 ? 'conflicts' : 'writes');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That file could not be read.');
    } finally {
      setBusy(false);
    }
  }

  /** Step two. The server re-plans and honours only decisions its own fresh
   *  plan offers, so what is sent are choices rather than instructions. */
  async function applyImport() {
    if (!importFile || !plan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ added: number; answered: number; replaced: number; skipped: number }>(
        `/api/projects/${projectId}/knowledge/interview/import`,
        { file: importFile.parsed, fileName: importFile.name, decisions, apply: true },
      );
      setProgress(
        `${res.added} question${res.added === 1 ? '' : 's'} added, ${res.answered} answered, ` +
          `${res.replaced} replaced, ${res.skipped} left alone. Imported answers are in the review queue, ` +
          `with no claims — they can shape a reply, not evidence one.`,
      );
      setPlan(null);
      setImportFile(null);
      setDecisions({});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import could not be applied.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Approve everything currently on screen.
   *
   * Sends the ids being SHOWN, in the order they are shown. The server approves
   * those and nothing else — there is no "approve all pending" switch — so the
   * filters above are the selection, and rows that scrolled past a filter are
   * not quietly included.
   */
  async function approveShown(ids: string[]) {
    setBusy(true);
    setError(null);
    setProgress(`Approving ${ids.length}…`);
    try {
      const res = await apiPost<{
        created: number;
        merged: number;
        skipped: number;
        alreadyApproved: number;
        skippedReasons: { reason: string }[];
      }>(`/api/projects/${projectId}/knowledge/interview/approve`, {
        questionIds: ids,
        dedupe: bulkDedupe,
      });
      setProgress(
        `${res.created} new asset${res.created === 1 ? '' : 's'}, ${res.merged} folded into assets that ` +
          `already covered the same page, ${res.skipped} skipped` +
          (res.alreadyApproved ? `, ${res.alreadyApproved} were already approved` : '') +
          '.',
      );
      setBulkArmed(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Those could not be approved.');
    } finally {
      setBusy(false);
    }
  }

  const decisionFor = (row: PlanRow): ImportDecision => decisions[row.key] ?? row.decision;

  const questions = data?.questions ?? [];
  const visible = questions
    .filter((q) => (category ? q.category === category : true))
    .filter((q) =>
      showState === 'review'
        ? q.review === 'pending'
        : showState === 'notfound'
          ? q.status === 'not-found'
          : true,
    )
    .sort((a, b) => b.priority - a.priority || a.category.localeCompare(b.category));

  // What "approve all shown" would act on: the rows on screen that have an
  // answer and are not already in the library. A not-found row has nothing to
  // approve and is excluded rather than counted and then skipped server-side.
  const approvable = visible.filter((q) => q.answer && q.review !== 'approved');

  const counts = data?.counts;
  const blockedTotal = questions.filter((q) => q.notFoundReason === 'blocked').length;

  return (
    <>
      <PageHeader
        title="Client interview"
        description="Work out what this client could usefully say in a conversation — before anyone needs it."
        crumbs={[
          { label: 'Projects', href: '/projects' },
          { label: 'Asset library', href: `/projects/${projectId}/knowledge` },
          { label: 'Client interview' },
        ]}
        action={
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={() => void exportJson()} disabled={busy}>
              <Download size={14} /> Export
            </button>
            {/* TWO IMPORTS, NAMED FOR WHAT THEY DO WITH ANSWERS.
                A file of researched answers put through the questions-only
                import reports "0 imported, 80 already present" and throws every
                answer away — which is what one button called "Import" did. */}
            <label className="btn btn-ghost btn-sm" title="Restore a questionnaire. Answers in the file are ignored.">
              <Upload size={14} /> Import questions
              <input
                type="file"
                accept="application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importQuestionsOnly(f);
                  e.target.value = '';
                }}
              />
            </label>
            <label
              className="btn btn-secondary btn-sm"
              title="Bring in answers researched elsewhere. You review every row before anything is written."
            >
              <FileSearch size={14} /> Import answered knowledge
              <input
                type="file"
                accept="application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void planImport(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        }
      />

      {error && <div className="alert alert-error">{error}</div>}
      {progress && <div className="alert alert-info">{progress}</div>}

      {blockedTotal > 0 && blockedTotal >= (counts?.notFound ?? 0) * 0.5 && (
        <div className="alert alert-error">
          <strong>
            {blockedTotal} of {counts?.notFound} unanswered questions failed because the site refused us, not
            because the client is silent.
          </strong>
          <p className="small">
            This run has mostly measured our access. Those pages exist and can be read in a browser — supply a
            few by hand from the asset library, or check whether the domains are right, before reading anything
            into the coverage below.
          </p>
        </div>
      )}

      {/* ── Answered-knowledge import: the review, before anything is written ── */}
      {plan && (
        <div className="card">
          <div className="card-head">
            <h2>
              <FileSearch size={16} aria-hidden /> Import answered knowledge — {importFile?.name}
            </h2>
            <p className="text-muted small">
              Nothing has been written. Every row below says what would happen and can be changed.
            </p>
          </div>

          <div className="alert alert-info">
            <ShieldQuestion size={15} aria-hidden />
            <div>
              <strong>Imported answers arrive as proposals, with no claims.</strong>
              <p className="small">
                Somebody else read those pages; this server did not. An imported answer can shape what a reply
                says, and it can never be the evidence behind a fact the reply states — approving one writes an
                asset marked <em>Not read yet</em>, usable but not citable, until a claim is verified against a
                page we fetch. That is why the answers may come in at all.
              </p>
            </div>
          </div>

          <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
            {(
              [
                ['add-answered', 'new, with answers'],
                ['add', 'new questions'],
                ['fill', 'answers for questions we have'],
                ['keep', 'conflicts to decide'],
                ['skip', 'nothing to do'],
              ] as [ImportDecision, string][]
            ).map(([d, label]) => (
              <span key={d} className={`badge ${DECISION_TONE[d]}`}>
                {plan.counts[d]} {label}
              </span>
            ))}
          </div>

          <div className="tabs-inline" style={{ marginTop: '0.75rem' }}>
            {(
              [
                ['writes', 'What will change'],
                ['conflicts', 'Conflicts'],
                ['all', 'Everything'],
              ] as ['writes' | 'conflicts' | 'all', string][]
            ).map(([id, label]) => (
              <button
                key={id}
                className={`tab ${planFilter === id ? 'active' : ''}`}
                onClick={() => setPlanFilter(id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {label}
              </button>
            ))}
          </div>

          <ul className="list">
            {plan.rows
              .filter((row) => {
                const d = decisionFor(row);
                if (planFilter === 'writes') return d !== 'keep' && d !== 'skip';
                if (planFilter === 'conflicts') return row.choices.includes('replace');
                return true;
              })
              .map((row) => {
                const chosen = decisionFor(row);
                return (
                  <li key={row.key} className="list-row" style={{ display: 'block' }}>
                    <div className="row" style={{ justifyContent: 'space-between', gap: '1rem' }}>
                      <div>
                        <strong>{row.question}</strong>
                        <div className="text-dim small">
                          {row.category} · priority {row.incoming.priority} · file says{' '}
                          {row.incoming.status}
                        </div>
                      </div>
                      <div className="row">
                        <span className={`badge ${DECISION_TONE[chosen]}`}>{DECISION_LABEL[chosen]}</span>
                        {row.choices.length > 1 && (
                          <select
                            value={chosen}
                            onChange={(e) =>
                              setDecisions((d) => ({ ...d, [row.key]: e.target.value as ImportDecision }))
                            }
                          >
                            {row.choices.map((c) => (
                              <option key={c} value={c}>
                                {DECISION_LABEL[c]}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>

                    <p className="text-dim small" style={{ marginTop: '0.3rem' }}>
                      {row.reason}
                    </p>

                    {/* Side by side, because "replace" is a choice nobody can
                        make from a summary — they have to read both. */}
                    {(row.incoming.answerText || row.existing?.answerText) && (
                      <div className="grid-2" style={{ marginTop: '0.4rem', gap: '0.75rem' }}>
                        {row.existing && (
                          <div>
                            <div className="eyebrow-muted">
                              Here now
                              {row.existing.claimCount > 0 && ` · ${row.existing.claimCount} verified claims`}
                              {row.existing.answerSource === 'imported' && ' · imported'}
                            </div>
                            <p className="small">
                              {row.existing.answerText || <em className="text-dim">no answer</em>}
                            </p>
                            <div className="text-dim small">
                              {row.existing.sourcesRead.map(shortUrl).join(' · ')}
                            </div>
                          </div>
                        )}
                        <div>
                          <div className="eyebrow-muted">In the file</div>
                          <p className="small">
                            {row.incoming.answerText || <em className="text-dim">no answer</em>}
                          </p>
                          {row.incoming.note && (
                            <p className="text-dim small">{row.incoming.note}</p>
                          )}
                          <div className="text-dim small">
                            {row.incoming.sourcesRead.length > 0
                              ? row.incoming.sourcesRead.map(shortUrl).join(' · ')
                              : 'no sources listed'}
                          </div>
                        </div>
                      </div>
                    )}

                    {row.losesEvidence && chosen === 'replace' && (
                      <div className="alert alert-warning small" style={{ marginTop: '0.4rem' }}>
                        <AlertTriangle size={13} aria-hidden /> Replacing this discards{' '}
                        {row.existing?.claimCount} quote-checked claim
                        {row.existing?.claimCount === 1 ? '' : 's'} that were verified against pages this
                        server read.
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>

          <div className="row">
            <button className="btn btn-primary" onClick={() => void applyImport()} disabled={busy}>
              <Check size={15} /> Apply import
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setPlan(null);
                setImportFile(null);
                setDecisions({});
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── 1. Who is this client ───────────────────────────────────────── */}
      <div className="card">
        <div className="card-head">
          <h2>The client</h2>
          <p className="text-muted small">
            The questionnaire is written from this description, which is what stops it being betting-specific.
            A sportsbook, a crypto exchange and a payroll tool each get questions shaped like their own field.
          </p>
        </div>

        <div className="field">
          <label className="label">Name</label>
          <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Stake" />
        </div>

        <div className="field">
          <label className="label">What do they do?</label>
          <textarea
            rows={2}
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            placeholder="A crypto-native online sportsbook and casino. Customers bet on sport, use cashout, deposit and withdraw in cryptocurrency."
          />
        </div>

        <div className="field">
          <label className="label">Approved domains</label>
          <ArrayInput value={domains} onChange={setDomains} placeholder="stake.com" />
        </div>

        <div className="field">
          <label className="label">How many questions</label>
          <input
            type="number"
            min={20}
            max={150}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            style={{ maxWidth: 120 }}
          />
        </div>

        <div className="row">
          <button
            className="btn btn-primary"
            onClick={() => void generate(false)}
            disabled={busy || !clientName.trim() || !industry.trim()}
          >
            <Sparkles size={14} /> {counts?.total ? 'Add more questions' : 'Generate the interview'}
          </button>
          {!!counts?.total && (
            <button className="btn btn-ghost" onClick={() => void generate(true)} disabled={busy}>
              Regenerate from scratch
            </button>
          )}
        </div>
        {!!counts?.total && (
          <p className="text-dim small">
            Regenerating replaces the generated questions only. Anything you wrote yourself, and anything the
            second pass or a live thread asked for, is kept.
          </p>
        )}
      </div>

      {/* ── 2. Research ─────────────────────────────────────────────────── */}
      {!!counts?.total && (
        <div className="card">
          <div className="card-head">
            <div className="page-head-row">
              <h2>Research</h2>
              <div className="row">
                <span className="badge">{counts.total} questions</span>
                <span className="badge badge-info">{counts.pending} to research</span>
                <span className="badge badge-success">{counts.approved} approved</span>
                {counts.notFound > 0 && <span className="badge badge-warning">{counts.notFound} not found</span>}
              </div>
            </div>
            <p className="text-muted small">
              Each question is answered from the client&apos;s own pages, with the exact sentence that supports
              every fact. A question the site does not answer comes back <strong>not found</strong> — that is a
              real result, not a failure.
            </p>
          </div>

          <div className="row">
            <button
              className="btn btn-primary"
              onClick={() => void researchAll(category || undefined)}
              disabled={busy || counts.pending === 0}
            >
              <Play size={14} /> {category ? `Research "${category}"` : 'Research everything pending'}
            </button>
            <button className="btn btn-secondary" onClick={() => void gapPass()} disabled={busy}>
              <Lightbulb size={14} /> What did we miss?
            </button>
          </div>

          {data && data.coverage.length > 0 && (
            <div className="field">
              <label className="label">Coverage by category</label>
              <ul className="list">
                {data.coverage.map((row) => (
                  <li className="list-row" key={row.category}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setCategory(category === row.category ? '' : row.category)}
                    >
                      {category === row.category ? <strong>{row.category}</strong> : row.category}
                    </button>
                    <span className="text-dim small">
                      {row.approved} approved · {row.answered} answered ·{' '}
                      {row.blocked > 0 ? (
                        <span className="text-error">{row.blocked} blocked</span>
                      ) : (
                        `${row.notFound} not found`
                      )}
                      {row.blocked > 0 && row.notFound > row.blocked && ` · ${row.notFound - row.blocked} not found`}{' '}
                      · {row.pending} pending
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="field">
            <label className="label">Ask your own question</label>
            <div className="input-group">
              <input
                value={ownQuestion}
                onChange={(e) => setOwnQuestion(e.target.value)}
                placeholder="If someone asks whether they can track each leg of a parlay, what does the client document?"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void addOwn();
                }}
              />
              <button className="btn btn-secondary" onClick={() => void addOwn()} disabled={busy}>
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 3. Review ───────────────────────────────────────────────────── */}
      {!!counts?.total && (
        <div className="card">
          <div className="card-head">
            <div className="page-head-row">
              <h2>Review queue</h2>
              <div className="tabs-inline">
                {(['review', 'notfound', 'all'] as const).map((s) => (
                  <button
                    key={s}
                    className={`chip-tab ${showState === s ? 'active' : ''}`}
                    onClick={() => setShowState(s)}
                  >
                    {s === 'review'
                      ? `Awaiting you (${counts.awaitingReview})`
                      : s === 'notfound'
                        ? `Not found (${counts.notFound})`
                        : `Everything (${counts.total})`}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-muted small">
              Nothing here is in the library. Approving a proposal is what puts it where the reply engine can
              use it.
            </p>

            {/* Approving eighty answers one at a time is not review, it is
                clicking. The filters above are the selection: this approves what
                is on screen, in the order it is on screen. */}
            {approvable.length > 0 && (
              <div className="row" style={{ flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.5rem' }}>
                {!bulkArmed ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => setBulkArmed(true)} disabled={busy}>
                    <Check size={14} /> Approve all {approvable.length} shown
                  </button>
                ) : (
                  <>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void approveShown(approvable.map((q) => q.questionId))}
                      disabled={busy}
                    >
                      <Check size={14} /> Yes — approve {approvable.length} into the library
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setBulkArmed(false)} disabled={busy}>
                      Cancel
                    </button>
                  </>
                )}

                <label className="row small" style={{ gap: '0.35rem' }}>
                  <input
                    type="checkbox"
                    checked={bulkDedupe}
                    onChange={(e) => setBulkDedupe(e.target.checked)}
                  />
                  Fold answers about a page the library already covers into that asset
                </label>
              </div>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="text-muted small">Nothing to show with these filters.</p>
          ) : (
            <div className="stack">
              {visible.map((q) => (
                <div className="card card-flush" key={q.questionId}>
                  <div className="page-head-row">
                    <strong>{q.question}</strong>
                    <div className="row">
                      <span className="badge">{q.category}</span>
                      {q.origin === 'gap' && <span className="badge badge-info">second pass</span>}
                      {q.origin === 'opportunity' && <span className="badge badge-warning">from a thread</span>}
                      {q.origin === 'operator' && <span className="badge">yours</span>}
                      {q.review === 'approved' && <span className="badge badge-success">approved</span>}
                      {q.review === 'later' && <span className="badge badge-warning">later</span>}
                      {q.review === 'rejected' && <span className="badge">rejected</span>}
                    </div>
                  </div>

                  {q.status === 'pending' && <p className="text-dim small">Not researched yet.</p>}

                  {q.status === 'not-found' && (
                    <div className={REASON_TONE[q.notFoundReason ?? ''] ?? 'alert alert-warning'}>
                      <AlertTriangle size={13} aria-hidden />{' '}
                      <strong>{NOT_FOUND_LABEL[q.notFoundReason ?? 'not-covered']}</strong>
                      {q.note && <> — {q.note}</>}

                      {q.sourcesRead.length > 0 && (
                        <div className="text-dim small" style={{ marginTop: 6 }}>
                          {q.notFoundReason === 'blocked' ? 'Refused: ' : 'Read: '}
                          {q.sourcesRead.map((u, i) => (
                            <span key={u}>
                              {i > 0 && ' · '}
                              <a href={u} target="_blank" rel="noreferrer" className="strong-link">
                                {shortUrl(u)}
                              </a>
                            </span>
                          ))}
                        </div>
                      )}

                      {q.notFoundReason === 'blocked' && q.sourcesRead[0] && (
                        <div className="row" style={{ marginTop: 8 }}>
                          <a
                            className="btn btn-secondary btn-sm"
                            href={`/projects/${projectId}/knowledge`}
                            title="Open the library and paste this page in by hand"
                          >
                            <Upload size={13} /> Supply this page by hand
                          </a>
                        </div>
                      )}
                    </div>
                  )}

                  {q.answer && (
                    <>
                      <p>{q.answer.shortAnswer}</p>

                      {q.dedupe && q.dedupe.action !== 'new' && (
                        <div className="alert alert-info">
                          {q.dedupe.reason}{' '}
                          <strong>{q.dedupe.assetTitle}</strong> ({q.dedupe.overlap}% overlap)
                        </div>
                      )}

                      <div className="text-dim small">
                        {q.answer.assetTitle} · confidence {Math.round(q.answer.confidence * 100)}% ·{' '}
                        {q.answer.brandAttributionHelps
                          ? 'naming the client adds information here'
                          : 'the useful part does not need the client named'}
                      </div>

                      {q.answer.claims.length > 0 && (
                        <ul className="list">
                          {q.answer.claims.map((c, i) => (
                            <li className="list-row" key={i}>
                              <span>
                                {c.claim}
                                <span className="de-reason-text text-dim small">
                                  <Quote size={11} aria-hidden /> {c.quote}
                                </span>
                              </span>
                              <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="strong-link small">
                                source
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}

                      {q.answer.claims.length === 0 && (
                        <p className="text-dim small">
                          No quotable facts — the pages describe this without asserting anything checkable. The
                          asset is still useful; it just cannot be cited.
                        </p>
                      )}

                      {q.answer.complianceCaveats.length > 0 && (
                        <p className="small text-warning">
                          Caveats: {q.answer.complianceCaveats.join(' · ')}
                        </p>
                      )}

                      {q.review === 'pending' && (
                        <div className="row">
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => void decide(q.questionId, 'approve')}
                            disabled={busy}
                          >
                            <Check size={13} /> Approve
                          </button>
                          {q.dedupe?.assetId && (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => void decide(q.questionId, 'merge', q.dedupe!.assetId!)}
                              disabled={busy}
                            >
                              <Merge size={13} /> Merge into {q.dedupe.assetTitle}
                            </button>
                          )}
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => void decide(q.questionId, 'later')}
                            disabled={busy}
                          >
                            <Clock size={13} /> Later
                          </button>
                          <button
                            className="btn btn-ghost btn-sm text-error"
                            onClick={() => void decide(q.questionId, 'reject')}
                            disabled={busy}
                          >
                            <X size={13} /> Reject
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
