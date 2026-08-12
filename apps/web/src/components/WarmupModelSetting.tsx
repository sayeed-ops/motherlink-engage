'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { apiGet, apiFetch, ApiError } from '@/lib/api';
import type { ModelOption } from '@/components/reddit/ModelPicker';

// The model that designs warm-up plans — one platform-wide setting.
//
// Lives on the API-keys page rather than in a project's settings because
// warm-up is account-scoped: a Reddit identity is not owned by one client, so
// there is no project to hang the choice on.

export default function WarmupModelSetting() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [value, setValue] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, w] = await Promise.all([
        // No projectId: entitlement is computed against all-projects keys and
        // the caller's own, which is exactly what warm-up can use.
        apiGet<{ models: ModelOption[] }>('/api/llm/models'),
        apiGet<{ warmupModel: string | null }>('/api/llm/warmup-model'),
      ]);
      setModels(m.models.filter((x) => x.json));
      setValue(w.warmupModel ?? '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the warm-up model setting.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: string) {
    setValue(next);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch('/api/llm/warmup-model', {
        method: 'PUT',
        body: JSON.stringify({ warmupModel: next || null }),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  const chosen = value ? models.find((m) => m.ref === value) : null;

  return (
    <section className="card">
      <div className="card-head">
        <h3>Warm-up design model</h3>
      </div>
      <p className="text-dim small">
        Which model shapes account warm-up schedules. This is platform-wide — warm-up belongs to a Reddit
        account, not to a client project. If the model is unavailable or returns junk, the deterministic
        planner takes over, so this can never block a warm-up.
      </p>
      <label className="field" style={{ maxWidth: 460 }}>
        <span>Model</span>
        <select value={value} onChange={(e) => save(e.target.value)} disabled={busy}>
          <option value="">Platform default (DeepSeek Chat)</option>
          {models.map((m) => (
            <option key={m.ref} value={m.ref} disabled={!m.allowed}>
              {m.allowed ? m.label : `${m.label} — needs a ${m.provider} key`}
            </option>
          ))}
        </select>
        {chosen && !chosen.allowed && (
          <span className="text-error small">
            Configured, but no key here reaches it — warm-up will fall back to the deterministic planner.
          </span>
        )}
      </label>
      {error && <p className="text-error small">{error}</p>}
      {saved && (
        <p className="text-success small">
          <Check size={12} style={{ verticalAlign: '-1px' }} /> Saved.
        </p>
      )}
    </section>
  );
}
