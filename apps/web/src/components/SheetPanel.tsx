'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Sheet, TriangleAlert } from 'lucide-react';
import { apiGet, apiPost, apiPut, ApiError } from '@/lib/api';
import { SHEET_COLUMNS } from '@/modules/sheets/row';
import { DEFAULT_TAB, type SheetConfig } from '@/modules/sheets/config';

// Where a project's posted comments get logged.
//
// The whole setup is three fields and one address to share the file with. The
// address is shown rather than documented because it is per-deployment, and a
// sheet that was never shared is far and away the most likely reason this
// writes nothing — so the page says what to do about it before anything has
// gone wrong, and "Check the link" confirms it in one click.
//
// ⚠️ WHAT THIS SCREEN CANNOT DO IS WRITE A ROW. Rows are appended by the local
// posting agent, seconds after a comment actually goes up. Saying so here
// matters: somebody who turns this on and watches an empty sheet should know
// they are waiting for the next post, not for a sync that is stuck.

interface SheetResponse {
  sheet: SheetConfig;
  serviceAccountEmail: string;
}

interface Access {
  title: string;
  tabs: string[];
  tabExists: boolean;
}

const sheetUrlOf = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

export default function SheetPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [cfg, setCfg] = useState<SheetConfig | null>(null);
  const [email, setEmail] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [sheetUrl, setSheetUrl] = useState('');
  const [tabName, setTabName] = useState(DEFAULT_TAB);
  const [mentionPrefix, setMentionPrefix] = useState('');
  const [includeGrowth, setIncludeGrowth] = useState(true);

  const [busy, setBusy] = useState<'save' | 'check' | 'retry' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Copy a freshly read config into the form. Split out from the reads so the
  // effect below can do its own fetch inline — the react-hooks lint rule
  // cannot see through a useCallback that eventually calls setState, and an
  // effect that fetches is exactly what this panel is for.
  const apply = (r: SheetResponse) => {
    setCfg(r.sheet);
    setEmail(r.serviceAccountEmail);
    setEnabled(r.sheet.enabled);
    setSheetUrl(r.sheet.spreadsheetId ? sheetUrlOf(r.sheet.spreadsheetId) : '');
    setTabName(r.sheet.tabName || DEFAULT_TAB);
    setMentionPrefix(r.sheet.mentionPrefix);
    setIncludeGrowth(r.sheet.includeGrowth);
  };

  // `on` matters rather than being boilerplate: the panel is mounted by the
  // project page, so switching projects starts a second read while the first is
  // still in flight. Without it the slower answer wins and the form shows
  // another client's sheet.
  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const r = await apiGet<SheetResponse>(`/api/projects/${projectId}/sheet`);
        if (on) apply(r);
      } catch (err) {
        if (!on) return;
        // A member without project.settings simply does not get this panel.
        if (!(err instanceof ApiError && err.status === 403)) {
          setError(err instanceof ApiError ? err.message : 'Could not read the sheet settings.');
        }
        setCfg(null);
      }
    })();
    return () => {
      on = false;
    };
  }, [projectId]);

  async function save() {
    if (busy) return;
    setBusy('save');
    setError(null);
    setNote(null);
    setAccess(null);
    try {
      const r = await apiPut<{ sheet: SheetConfig }>(`/api/projects/${projectId}/sheet`, {
        enabled,
        sheetUrl,
        tabName,
        mentionPrefix,
        includeGrowth,
      });
      setCfg(r.sheet);
      setNote(r.sheet.enabled ? 'Saved. The next comment posted from this project will be logged.' : 'Saved. Nothing will be logged.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save those settings.');
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    if (busy) return;
    setBusy('check');
    setError(null);
    setNote(null);
    setAccess(null);
    try {
      const r = await apiPost<{ access: Access }>(`/api/projects/${projectId}/sheet`, { action: 'check' });
      setAccess(r.access);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach that sheet.');
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    if (busy) return;
    setBusy('retry');
    setError(null);
    setNote(null);
    try {
      const r = await apiPost<{ requeued: number }>(`/api/projects/${projectId}/sheet`, { action: 'retry' });
      setNote(
        r.requeued
          ? `${r.requeued} row${r.requeued === 1 ? '' : 's'} queued again — the agent will write ${r.requeued === 1 ? 'it' : 'them'} on its next poll.`
          : 'There are no failed rows to retry.',
      );
      apply(await apiGet<SheetResponse>(`/api/projects/${projectId}/sheet`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not queue those rows again.');
    } finally {
      setBusy(null);
    }
  }

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy — select the address and copy it by hand.');
    }
  }

  if (!cfg) return null;

  const dirty =
    enabled !== cfg.enabled ||
    tabName !== (cfg.tabName || DEFAULT_TAB) ||
    mentionPrefix !== cfg.mentionPrefix ||
    includeGrowth !== cfg.includeGrowth ||
    sheetUrl.trim() !== (cfg.spreadsheetId ? sheetUrlOf(cfg.spreadsheetId) : '');

  return (
    <section className="card">
      <div className="card-head">
        <h3>Posting record</h3>
        {cfg.spreadsheetId && (
          <a className="btn btn-secondary btn-sm" href={sheetUrlOf(cfg.spreadsheetId)} target="_blank" rel="noreferrer">
            Open sheet <ExternalLink size={13} />
          </a>
        )}
      </div>

      <p className="text-dim small">
        Every comment this project posts — Reddit and Shopify Community — is appended to a Google Sheet as one
        row, by the posting agent, moments after it goes up. Nothing is ever edited or reordered, so the sheet
        stays yours to mark up.
      </p>

      <fieldset className="stack bordered" disabled={!canEdit || busy !== null}>
        <label className="row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Log posted comments to a Google Sheet</span>
        </label>

        <label className="field">
          <span>Sheet link</span>
          <input
            type="url"
            value={sheetUrl}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            onChange={(e) => setSheetUrl(e.target.value)}
          />
        </label>

        <div className="stack bordered">
          <div className="row">
            <Sheet size={15} className="text-primary" />
            <strong className="small">Share the sheet with this address first</strong>
          </div>
          <div className="row">
            <code className="small">{email}</code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyEmail()}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-dim small" style={{ margin: 0 }}>
            In Google Sheets: Share → paste that address → <strong>Editor</strong> → Send. Engage can only append
            rows to files it has been given.
          </p>
        </div>

        <label className="field">
          <span>Tab</span>
          <input value={tabName} placeholder={DEFAULT_TAB} onChange={(e) => setTabName(e.target.value)} />
          <span className="text-dim small">Created, with a header row, the first time a comment is logged.</span>
        </label>

        <div className="stack bordered">
          <label className="row">
            <input
              type="checkbox"
              checked={includeGrowth}
              onChange={(e) => setIncludeGrowth(e.target.checked)}
            />
            <span>Include replies that don&rsquo;t mention the client</span>
          </label>
          <p className="text-dim small" style={{ margin: 0 }}>
            {includeGrowth
              ? 'On \u2014 the sheet records every comment this project posts, brand mentions and account-building replies alike.'
              : 'Off \u2014 only comments that mention the client reach the sheet. Growth replies are still posted; they just are not logged here, and they do not take a Mention ID.'}
          </p>
        </div>

        <label className="field">
          <span>Mention ID prefix</span>
          <input value={mentionPrefix} placeholder="RM292-1" onChange={(e) => setMentionPrefix(e.target.value)} />
          <span className="text-dim small">
            {mentionPrefix.trim()
              ? `Rows will be numbered ${mentionPrefix.trim().replace(/-+$/, '')}-${cfg.nextMention}, ${mentionPrefix
                  .trim()
                  .replace(/-+$/, '')}-${cfg.nextMention + 1}, and so on.`
              : 'Leave empty to fill the Mention ID column in by hand. Changing the prefix starts the numbering again at 1.'}
          </span>
        </label>

        <div className="row">
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty} onClick={() => void save()}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!cfg.spreadsheetId || dirty}
            onClick={() => void check()}
          >
            {busy === 'check' ? 'Checking…' : 'Check the link'}
          </button>
        </div>
      </fieldset>

      {error && <p className="text-error small">{error}</p>}
      {note && <p className="text-dim small">{note}</p>}

      {access && (
        <p className="text-dim small">
          Reached <strong>{access.title}</strong>.{' '}
          {access.tabExists
            ? `The "${cfg.tabName}" tab is there.`
            : `There is no "${cfg.tabName}" tab yet — the agent will create it, with a header row, on the first comment.`}
        </p>
      )}

      {cfg.lastError && (
        <div className="row">
          <TriangleAlert size={15} className="text-error" />
          <div>
            <p className="text-error small" style={{ margin: 0 }}>
              The last row could not be written: {cfg.lastError}
            </p>
            <p className="text-dim small" style={{ margin: 0 }}>
              The comments themselves are posted — only the sheet is behind.
            </p>
            {canEdit && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void retry()}>
                {busy === 'retry' ? 'Queueing…' : 'Retry failed rows'}
              </button>
            )}
          </div>
        </div>
      )}

      {cfg.lastWrittenAtMs && !cfg.lastError && (
        <p className="text-dim small">Last row written {new Date(cfg.lastWrittenAtMs).toLocaleString()}.</p>
      )}

      <details>
        <summary className="text-dim small">What each row holds</summary>
        <ol className="text-dim small">
          {SHEET_COLUMNS.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <p className="text-dim small">
          <strong>Content Description</strong> is a copy of the analysis this reply was written from — the
          verdict, the reasoning and the angle — frozen when the reply was approved, so it always describes the
          reply beside it rather than a later re-read of the thread.
        </p>
      </details>
    </section>
  );
}
