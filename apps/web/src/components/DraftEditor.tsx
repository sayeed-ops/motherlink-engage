'use client';

import { useRef, useState } from 'react';
import { Bold, Italic, Strikethrough, Link2, Quote, List, Code, Superscript, Eye, PenLine } from 'lucide-react';
import { apiPost, ApiError } from '@/lib/api';
import { renderRedditMarkdown } from '@/modules/reddit/redditMarkdown';
import { DRAFT_REASON_TAGS, DRAFT_REASON_LABELS, type DraftReasonTag } from '@/modules/reddit/types';

// Inline editor for a draft reply.
//
// The body is Reddit Markdown (what the agent types into old.reddit), so the
// editor is a markdown textarea with a formatting toolbar and a live preview of
// Reddit's subset — no WYSIWYG, so what you see is what posts. For drafts.train
// holders a reason (tags + text) is required before saving, unless the edit is
// flagged minor; that reason is the training signal. Non-train editors just see
// the editor and save a plain fix.

const TOOLBAR: { icon: typeof Bold; title: string; wrap?: [string, string]; linePrefix?: string }[] = [
  { icon: Bold, title: 'Bold', wrap: ['**', '**'] },
  { icon: Italic, title: 'Italic', wrap: ['*', '*'] },
  { icon: Strikethrough, title: 'Strikethrough', wrap: ['~~', '~~'] },
  { icon: Code, title: 'Inline code', wrap: ['`', '`'] },
  { icon: Superscript, title: 'Superscript', wrap: ['^(', ')'] },
  { icon: Link2, title: 'Link', wrap: ['[', '](https://)'] },
  { icon: Quote, title: 'Quote', linePrefix: '> ' },
  { icon: List, title: 'List', linePrefix: '- ' },
];

export default function DraftEditor({
  projectId,
  draftId,
  initialBody,
  canTrain,
  onClose,
  onSaved,
}: {
  projectId: string;
  draftId: string;
  initialBody: string;
  canTrain: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(initialBody);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [tags, setTags] = useState<Set<DraftReasonTag>>(new Set());
  const [reason, setReason] = useState('');
  const [minor, setMinor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const changed = text.trim() !== initialBody.trim();
  const reasonGiven = tags.size > 0 || reason.trim().length > 0;
  // Train holders must justify a substantive edit (unless flagged minor).
  const needsReason = canTrain && !minor;
  const canSave = changed && !busy && (!needsReason || reasonGiven);

  function applyToSelection(mut: (sel: string, before: string, after: string) => { text: string; selStart: number; selEnd: number }) {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const sel = text.slice(start, end);
    const next = mut(sel, before, after);
    setText(next.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.selStart, next.selEnd);
    });
  }

  function wrap(pre: string, post: string) {
    applyToSelection((sel, before, after) => ({
      text: `${before}${pre}${sel}${post}${after}`,
      selStart: before.length + pre.length,
      selEnd: before.length + pre.length + sel.length,
    }));
  }

  function prefixLines(prefix: string) {
    applyToSelection((sel, before, after) => {
      const block = (sel || '').split('\n').map((l) => `${prefix}${l}`).join('\n');
      return { text: `${before}${block}${after}`, selStart: before.length, selEnd: before.length + block.length };
    });
  }

  function toggleTag(t: DraftReasonTag) {
    setTags((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/reddit/draft/feedback`, {
        draftId,
        kind: 'edit',
        body: text,
        reasonTags: needsReason ? [...tags] : [],
        reasonText: needsReason ? reason.trim() : '',
        minor,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the edit.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="draft-editor">
      <div className="de-tabs">
        <button className={`de-tab ${tab === 'write' ? 'active' : ''}`} onClick={() => setTab('write')}>
          <PenLine size={13} /> Write
        </button>
        <button className={`de-tab ${tab === 'preview' ? 'active' : ''}`} onClick={() => setTab('preview')}>
          <Eye size={13} /> Preview
        </button>
        <span className="de-hint text-faint small">Reddit markdown</span>
      </div>

      {tab === 'write' ? (
        <>
          <div className="de-toolbar">
            {TOOLBAR.map(({ icon: Icon, title, wrap: w, linePrefix }) => (
              <button
                key={title}
                className="btn btn-ghost btn-sm btn-icon"
                title={title}
                aria-label={title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (w ? wrap(w[0], w[1]) : linePrefix ? prefixLines(linePrefix) : undefined)}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
          <textarea
            ref={ref}
            className="de-body"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            spellCheck
          />
        </>
      ) : (
        <div
          className="reddit-preview"
          dangerouslySetInnerHTML={{ __html: renderRedditMarkdown(text) || '<p class="text-faint">Nothing to preview.</p>' }}
        />
      )}

      {canTrain && (
        <div className="de-reason bordered">
          <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <strong className="small">Why did you change it?</strong>
            <label className="row small text-dim" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={minor} onChange={(e) => setMinor(e.target.checked)} />
              Minor edit — don&apos;t train on this
            </label>
          </div>
          {!minor && (
            <>
              <p className="text-dim small" style={{ margin: '2px 0 0' }}>
                Captured to teach the AI how to write next time. Pick what applies, and add the specifics.
              </p>
              <div className="de-tags">
                {DRAFT_REASON_TAGS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`de-chip ${tags.has(t) ? 'on' : ''}`}
                    onClick={() => toggleTag(t)}
                  >
                    {DRAFT_REASON_LABELS[t]}
                  </button>
                ))}
              </div>
              <textarea
                className="de-reason-text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Dropped the product plug — this sub bans self-promo; kept the how-to so it still helps."
                rows={2}
              />
            </>
          )}
        </div>
      )}

      {error && <p className="text-error small">{error}</p>}

      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={!canSave}>
          {busy ? 'Saving…' : 'Save edit'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {needsReason && !reasonGiven && changed && (
          <span className="text-faint small">Add a reason (or mark it minor) to save.</span>
        )}
      </div>
    </div>
  );
}
