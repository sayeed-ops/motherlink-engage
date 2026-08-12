'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2, RefreshCw, Check, AlertTriangle } from 'lucide-react';
import { apiGet, apiPost, apiFetch, ApiError } from '@/lib/api';
import { PROVIDERS, MODELS, modelByRef } from '@/lib/llm/catalog';
import type { LlmProviderId, ModelRef } from '@/lib/llm/types';
import EncryptionNotice from '@/components/EncryptionNotice';

// Your own LLM API keys.
//
// This component is the reason /api/llm/credentials exists. Every other page in
// this app reads Firestore directly under rules; llmCredentials is
// `allow read: if false` for everyone including its owner, so the only way to
// render this list is a server route handing back masked metadata. The most a
// browser ever sees of a key is its last four characters.

export interface MaskedCredential {
  credentialId: string;
  provider: LlmProviderId;
  label: string;
  keyHint: string;
  modelCount: number;
  allowedModels: ModelRef[];
  verification: 'probed' | 'assumed';
  lastError: string | null;
  status: 'active' | 'invalid' | 'disabled';
  grantedProjectIds: string[];
  grantAllProjects: boolean;
}

export default function LlmCredentialsAdmin() {
  const [creds, setCreds] = useState<MaskedCredential[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [provider, setProvider] = useState<string>(PROVIDERS[0]?.id ?? 'deepseek');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ personal: MaskedCredential[]; encryptionConfigured: boolean }>(
        '/api/llm/credentials',
      );
      setCreds(r.personal);
      setConfigured(r.encryptionConfigured);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your API keys.');
      setCreds([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The route probes the key before storing it, so this request is a real
      // round-trip to the provider — hence the "Checking…" state.
      const r = await apiPost<{ credential: MaskedCredential }>('/api/llm/credentials', {
        provider,
        label: label.trim(),
        apiKey: apiKey.trim(),
      });
      setNotice(
        `Key saved and verified — it reaches ${r.credential.modelCount} model${r.credential.modelCount === 1 ? '' : 's'}.`,
      );
      setLabel('');
      setApiKey('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that key.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: MaskedCredential) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/llm/credentials/${c.credentialId}`, { method: 'DELETE' });
      setNotice(`Removed “${c.label}”.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that key.');
    } finally {
      setBusy(false);
    }
  }

  async function recheck(c: MaskedCredential) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await apiPost<{ ok: boolean; error: string | null }>(
        `/api/llm/credentials/${c.credentialId}/verify`,
        {},
      );
      setNotice(r.ok ? `“${c.label}” is working.` : `“${c.label}” failed: ${r.error}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not re-check that key.');
    } finally {
      setBusy(false);
    }
  }

  if (!configured) {
    return (
      <section className="card">
        <div className="card-head">
          <h3>Your API keys</h3>
        </div>
        <EncryptionNotice />
      </section>
    );
  }

  // Which models the user's keys currently unlock, for the read-only summary.
  const unlocked = new Set((creds ?? []).flatMap((c) => (c.status === 'active' ? c.allowedModels : [])));

  return (
    <div className="sections">
      <section className="card">
        <div className="card-head">
          <h3>Your API keys</h3>
        </div>
        <p className="text-dim small">
          Add your own provider key and analysis, drafting and warm-up design run on it — billed to your
          account, not the shared one. Keys are encrypted before they are stored and are never shown back to
          you.
        </p>

        {creds === null ? (
          <p className="text-dim small">Loading…</p>
        ) : creds.length === 0 ? (
          <p className="text-dim small">You have no keys yet. Everything runs on the platform key.</p>
        ) : (
          <div className="list">
            {creds.map((c) => (
              <div key={c.credentialId} className="list-row">
                <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <strong>{c.label}</strong>
                  <span className="badge">{c.provider}</span>
                  <span className="text-dim small">{c.keyHint}</span>
                  <span className="text-dim small">
                    {c.modelCount} model{c.modelCount === 1 ? '' : 's'}
                    {c.verification === 'assumed' ? ' (not confirmed by the provider)' : ''}
                  </span>
                  {c.status === 'invalid' && (
                    <span className="badge badge-warning">
                      <AlertTriangle size={11} style={{ verticalAlign: '-1px' }} /> not working
                    </span>
                  )}
                </span>
                <span className="row small" style={{ gap: 8 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => recheck(c)} disabled={busy}>
                    <RefreshCw size={13} /> Re-check
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => remove(c)} disabled={busy}>
                    <Trash2 size={13} /> Remove
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        {creds?.some((c) => c.lastError) && (
          <p className="text-error small">
            {creds.find((c) => c.lastError)?.lastError}
          </p>
        )}

        <form className="stack" onSubmit={add} style={{ marginTop: 14 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field" style={{ maxWidth: 180 }}>
              <span>Provider</span>
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ maxWidth: 220 }}>
              <span>Label</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="My OpenRouter key"
              />
            </label>
            <label className="field" style={{ maxWidth: 320 }}>
              <span>API key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={PROVIDERS.find((p) => p.id === provider)?.keyHint ?? ''}
                autoComplete="off"
              />
            </label>
            <button className="btn btn-primary btn-sm" disabled={busy || !label.trim() || !apiKey.trim()}>
              {busy ? 'Checking…' : 'Add key'}
            </button>
          </div>
          <p className="text-dim small">
            We make one tiny test call to confirm the key works before saving it — a key with no credit left
            is rejected here rather than halfway through an analysis run.{' '}
            {provider === 'openrouter' && (
              <>
                Note that a card-backed OpenRouter account keeps billing; DeepSeek&apos;s prepaid credit fails
                closed instead.
              </>
            )}
          </p>
        </form>

        {error && <p className="text-error small">{error}</p>}
        {notice && (
          <p className="text-success small">
            <Check size={12} style={{ verticalAlign: '-1px' }} /> {notice}
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Models</h3>
        </div>
        <p className="text-dim small">
          Everything Engage can use. A model is available to you once you hold a key that reaches it — so you
          can see what a key would buy before pasting one in.
        </p>
        <div className="list">
          {MODELS.map((m) => {
            const ok = unlocked.has(m.ref);
            return (
              <div key={m.ref} className="list-row">
                <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <strong>{m.label}</strong>
                  <span className="badge">{modelByRef(m.ref)?.provider}</span>
                  {!m.json && <span className="text-dim small">no JSON mode — drafting only</span>}
                  {m.speed === 'slow' && <span className="text-dim small">slow</span>}
                </span>
                <span className={`small ${ok ? 'text-success' : 'text-dim'}`}>
                  {ok ? 'Available to you' : 'Needs a key'}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
