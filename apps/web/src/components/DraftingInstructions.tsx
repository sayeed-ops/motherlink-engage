'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiFetch, ApiError } from '@/lib/api';
import {
  MAX_INSTRUCTION_CHARS,
  type DraftingInstruction,
  type InstructionScope,
} from '@/modules/drafting/instructions';

// House style for drafting, as a list you can add to, switch off and delete.
//
// One component for both scopes — the platform set under Settings and a
// client's own on its Reddit settings page — because they are the same thing
// read one after the other. `base` is the only difference.
//
// The switch matters as much as the delete. Turning a block off and pressing
// Draft again is how you see what it actually changed: both replies stay on the
// post, each stamped with what it was written under. Deleting is for when you
// have decided.

const fmtDate = (ms: number) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'undated';

export default function DraftingInstructions({
  scope,
  projectId,
  canEdit,
}: {
  scope: InstructionScope;
  projectId?: string;
  canEdit: boolean;
}) {
  const base = scope === 'platform' ? '/api/drafting-instructions' : `/api/projects/${projectId}/drafting-instructions`;

  const [items, setItems] = useState<DraftingInstruction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const r = await apiGet<{ instructions: DraftingInstruction[] }>(base);
        if (on) setItems(r.instructions);
      } catch (err) {
        if (!on) return;
        setError(err instanceof ApiError ? err.message : 'Could not read the drafting instructions.');
        setItems([]);
      }
    })();
    return () => {
      on = false;
    };
  }, [base]);

  async function reload() {
    const r = await apiGet<{ instructions: DraftingInstruction[] }>(base);
    setItems(r.instructions);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy('add');
    setError(null);
    try {
      await apiPost(base, { title, body });
      setTitle('');
      setBody('');
      setAdding(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save those instructions.');
    } finally {
      setBusy(null);
    }
  }

  async function toggle(i: DraftingInstruction) {
    if (busy) return;
    setBusy(i.instructionId);
    setError(null);
    try {
      await apiPatch(`${base}/${i.instructionId}`, { active: !i.active });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(i: DraftingInstruction) {
    if (busy) return;
    setBusy(i.instructionId);
    setError(null);
    try {
      await apiFetch(`${base}/${i.instructionId}`, { method: 'DELETE' });
      setConfirmDelete(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete those instructions.');
    } finally {
      setBusy(null);
    }
  }

  if (!items) return null;

  const activeCount = items.filter((i) => i.active).length;

  return (
    <section className="card">
      <div className="card-head">
        <h3>{scope === 'platform' ? 'Drafting instructions — all projects' : 'Drafting instructions — this client'}</h3>
        {canEdit && !adding && (
          <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add instructions
          </button>
        )}
      </div>

      <p className="text-dim small">
        {scope === 'platform'
          ? 'House style for every Reddit reply this platform writes. Added to the draft prompt after the built-in rules, so it overrides them where they disagree.'
          : 'Extra rules for this client only, read after the platform house style.'}{' '}
        They cannot override the brand mention level or the forbidden phrases — a reply the analysis said must not
        name the client still will not, whatever these say.
      </p>

      {adding && (
        <form className="stack bordered" onSubmit={add}>
          <label className="field">
            <span>Name</span>
            <input
              autoFocus
              value={title}
              placeholder="Reddit writing style"
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Instructions</span>
            <textarea
              value={body}
              rows={12}
              placeholder={'REDDIT WRITING STYLE\n\nWrite like a natural conversation, not an article…'}
              onChange={(e) => setBody(e.target.value)}
              required
            />
            <span className={body.length > MAX_INSTRUCTION_CHARS ? 'text-error small' : 'text-dim small'}>
              {body.length.toLocaleString()} / {MAX_INSTRUCTION_CHARS.toLocaleString()} characters. Written straight
              into the prompt, exactly as typed.
            </span>
          </label>
          <div className="row">
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy !== null}>
              {busy === 'add' ? 'Saving…' : 'Save instructions'}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p className="text-error small">{error}</p>}

      {items.length === 0 ? (
        <div className="empty">
          <p className="text-dim small">
            None yet. Replies are written under the built-in rules alone.
          </p>
        </div>
      ) : (
        <ul className="list">
          {items.map((i) => (
            <li key={i.instructionId} className={open === i.instructionId ? '' : 'list-row'}>
              <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setOpen(open === i.instructionId ? null : i.instructionId)}
                  style={{ textAlign: 'left' }}
                >
                  {open === i.instructionId ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>
                    <strong className={i.active ? '' : 'text-dim'}>{i.title}</strong>
                    <span className="text-dim small" style={{ marginLeft: 8 }}>
                      added {fmtDate(i.createdAtMs)}
                      {i.createdByName ? ` by ${i.createdByName}` : ''} · {i.body.length.toLocaleString()} chars
                    </span>
                  </span>
                </button>
                <div className="row">
                  {!i.active && <span className="badge">off</span>}
                  {canEdit && (
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy !== null}
                      onClick={() => void toggle(i)}
                      title={i.active ? 'Stop using these without deleting them' : 'Use these again'}
                    >
                      {busy === i.instructionId ? '…' : i.active ? 'Turn off' : 'Turn on'}
                    </button>
                  )}
                  {canEdit &&
                    (confirmDelete === i.instructionId ? (
                      <>
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={busy !== null}
                          onClick={() => void remove(i)}
                        >
                          Delete for good
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy !== null}
                        onClick={() => setConfirmDelete(i.instructionId)}
                        title="Delete these instructions"
                      >
                        <Trash2 size={13} />
                      </button>
                    ))}
                </div>
              </div>

              {open === i.instructionId && (
                <pre className="text-dim small" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>
                  {i.body}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <p className="text-dim small">
          {activeCount === 0
            ? 'All switched off — replies are written under the built-in rules alone.'
            : `${activeCount} of ${items.length} in force. Every draft records which ones it was written under, so you can turn one off, draft again, and compare the two replies on the post.`}
        </p>
      )}
    </section>
  );
}
