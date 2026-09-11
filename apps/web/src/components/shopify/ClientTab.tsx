'use client';

import { useState } from 'react';
import { Check, Copy, FileJson2, RefreshCw } from 'lucide-react';
import { apiFetch, apiPost, ApiError } from '@/lib/api';
import { clientFromJson, ClientImportError, type ShopifyClientProfile } from '@/modules/shopify/client';
import { buildClientImportPrompt } from '@/modules/shopify/importPrompts';
import { age } from './types';

/**
 * Who the client is, and where those words came from — filled three ways:
 * copied from Reddit, imported from JSON, or typed.
 *
 * ⚠️ AN IMPORT FILLS THE FORM; IT DOES NOT SAVE. Same as Reddit's "Fill form":
 * a model's description of a client is a draft a person reads before it
 * decides how every Growth and Brand reply is written. Fields the JSON does not
 * mention keep what is in the form.
 */
export default function ClientTab({
  projectId,
  client,
  onSaved,
  onError,
}: {
  projectId: string;
  client: ShopifyClientProfile;
  onSaved: (c: ShopifyClientProfile) => void;
  onError: (m: string | null) => void;
}) {
  const [draft, setDraft] = useState<ShopifyClientProfile>(client);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importErr, setImportErr] = useState<string | null>(null);
  const [company, setCompany] = useState('');
  const [copied, setCopied] = useState(false);

  const edit = (next: ShopifyClientProfile) => {
    setDraft(next);
    setDirty(true);
    setNote(null);
  };

  const save = async () => {
    setBusy('save');
    onError(null);
    setNote(null);
    try {
      const res = await apiFetch<{ client: ShopifyClientProfile }>(`/api/projects/${projectId}/shopify/client`, {
        method: 'PUT',
        body: JSON.stringify({ client: draft }),
      });
      setDraft(res.client);
      onSaved(res.client);
      setDirty(false);
      setNote('Saved.');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Those details were not saved.');
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('sync');
    onError(null);
    setNote(null);
    try {
      const res = await apiPost<{ client: ShopifyClientProfile; copied: Record<string, unknown> }>(
        `/api/projects/${projectId}/shopify/client`,
        {},
      );
      setDraft(res.client);
      onSaved(res.client);
      setDirty(false);
      setNote(`Copied from Reddit — ${res.copied.forbiddenPhrases} forbidden phrase(s) included.`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Nothing could be copied from Reddit.');
    } finally {
      setBusy(null);
    }
  };

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(buildClientImportPrompt({ company }));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const fillFromJson = () => {
    setImportErr(null);
    try {
      const res = clientFromJson(importJson, draft);
      edit(res.client);
      setImportJson('');
      setImportOpen(false);
      setNote(
        `Filled ${res.filled.length} field${res.filled.length === 1 ? '' : 's'} from JSON` +
          (res.ignored.length ? ` (ignored ${res.ignored.join(', ')} — they belong elsewhere)` : '') +
          '. Review, then Save.',
      );
    } catch (err) {
      setImportErr(err instanceof ClientImportError ? err.message : 'That JSON could not be read.');
    }
  };

  const field = (
    label: string,
    key: 'companyDescription' | 'targetCustomer' | 'productService' | 'brandMentionStyle',
    help: string,
    rows = 3,
  ) => (
    <div className="field">
      <label className="label">{label}</label>
      <textarea rows={rows} value={draft[key]} onChange={(e) => edit({ ...draft, [key]: e.target.value })} />
      <p className="text-dim small" style={{ marginTop: '0.2rem' }}>
        {help}
      </p>
    </div>
  );

  return (
    <div className="sections">
      <section className="card">
        <div className="card-head">
          <h3>
            <FileJson2 size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Import from JSON
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setImportOpen((o) => !o)}>
            {importOpen ? 'Hide' : 'Open'}
          </button>
        </div>
        {importOpen ? (
          <div className="stack">
            <p className="text-dim small">
              Ask any chat model to describe the client, then paste its JSON here to fill the form. The copied prompt
              names the company so the model does not mix it up with anything else in your chat. JSON written for
              Reddit works too — the subreddits and keywords are ignored.
            </p>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Which company? (name or URL)"
                style={{ maxWidth: 360 }}
              />
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyPrompt()}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy AI prompt'}
              </button>
            </div>
            <label className="field" style={{ maxWidth: 640 }}>
              <span>Paste the JSON the model returned</span>
              <textarea
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='{ "companyDescription": "…", "targetCustomer": "…", "productService": "…", "brandMentionStyle": "…", "forbiddenPhrases": [] }'
                rows={6}
              />
            </label>
            {importErr && <p className="text-error small">{importErr}</p>}
            <div className="row">
              <button type="button" className="btn btn-primary btn-sm" onClick={fillFromJson} disabled={!importJson.trim()}>
                Fill form
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setImportJson('');
                  setImportErr(null);
                }}
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <p className="text-dim small">Have a chat model draft the client details, then paste them in. Open to copy the prompt.</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Client details</h3>
          <button className="btn btn-secondary btn-sm" onClick={() => void sync()} disabled={!!busy}>
            <RefreshCw size={13} /> {busy === 'sync' ? 'Copying…' : 'Copy from Reddit'}
          </button>
        </div>

        <p className="text-dim small">
          Its own copy, not a live read of the Reddit module — a merchant forum is not a subreddit and the two may want
          to sound different. Copy from Reddit <strong>replaces</strong> every field here.{' '}
          {client.syncedFromRedditAtMs
            ? `Last copied from Reddit ${age(client.syncedFromRedditAtMs)}.`
            : 'These were entered here.'}
        </p>

        {note && <div className="alert alert-info">{note}</div>}

        <div className="grid-form">
          {field('What the company does', 'companyDescription', 'Needed before Growth or Brand can be scored or written.')}
          {field('Who they serve', 'targetCustomer', 'Shapes register more than content.', 2)}
          {field('What they sell', 'productService', 'Needed before a reply may name them.', 2)}
          {field(
            'How they may be mentioned',
            'brandMentionStyle',
            'Used to judge Brand fit and to write Brand replies. "Say we, not they." "Never claim to be the cheapest."',
          )}
        </div>

        <div className="field">
          <label className="label">Phrases that must never appear</label>
          <textarea
            rows={3}
            value={draft.forbiddenPhrases.join('\n')}
            onChange={(e) =>
              edit({ ...draft, forbiddenPhrases: e.target.value.split('\n').map((p) => p.trim()).filter(Boolean) })
            }
          />
          <p className="text-dim small" style={{ marginTop: '0.2rem' }}>
            One per line. ⚠️ The only rule that is <strong>checked</strong> rather than asked for — a draft containing one
            is stored and flagged, not silently discarded. Matched anywhere in the text, ignoring case.
          </p>
        </div>

        <div className="row">
          <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={!!busy}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          {dirty && <span className="small text-dim">Unsaved changes.</span>}
        </div>
      </section>
    </div>
  );
}
