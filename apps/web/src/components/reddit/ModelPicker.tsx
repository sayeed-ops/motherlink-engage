'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, ApiError } from '@/lib/api';

// Which model analyses posts and which writes replies, for one project.
//
// Shows EVERY model in the catalogue and disables the ones this person cannot
// run, with the reason inline — "we can show all models available, but they
// should only be able to select the ones that their API allows". A hidden
// option teaches nothing; a disabled one with "needs an OpenRouter key" tells
// you what to go and do.

export interface ModelOption {
  ref: string;
  label: string;
  provider: string;
  family: string;
  json: boolean;
  speed: 'fast' | 'standard' | 'slow';
  note?: string;
  allowed: boolean;
  reason: 'no-key' | 'key-lacks-model' | null;
  source: 'project' | 'personal' | 'env' | null;
  unverified: boolean;
}

interface ModelsResponse {
  models: ModelOption[];
  defaultRef: string;
  selection: { analysisModel: string | null; draftModel: string | null };
}

const SOURCE_LABEL: Record<string, string> = {
  project: 'a key shared with this project',
  personal: 'your own key',
  env: 'the platform key',
};

function optionText(m: ModelOption): string {
  if (m.allowed) {
    const bits = [m.label];
    if (m.speed === 'slow') bits.push('slow');
    return bits.join(' — ');
  }
  return `${m.label} — ${m.reason === 'key-lacks-model' ? `your ${m.provider} key does not include it` : `needs a ${m.provider} key`}`;
}

export default function ModelPicker({
  projectId,
  analysisModel,
  draftModel,
  onChange,
}: {
  projectId: string;
  analysisModel: string | null;
  draftModel: string | null;
  onChange: (patch: { analysisModel?: string | null; draftModel?: string | null }) => void;
}) {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<ModelsResponse>(`/api/llm/models?projectId=${encodeURIComponent(projectId)}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the model list.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="text-error small">{error}</p>;
  if (!data) return <p className="text-dim small">Loading models…</p>;

  // Analysis output is parsed as JSON, so a model without JSON mode would turn
  // every run into a 502. Those are filtered out here rather than offered and
  // rejected on save.
  const analysisOptions = data.models.filter((m) => m.json);
  const draftOptions = data.models;

  const defaultModel = data.models.find((m) => m.ref === data.defaultRef);
  const chosen = (ref: string | null, opts: ModelOption[]) => (ref ? opts.find((m) => m.ref === ref) : null);
  const analysisChoice = chosen(analysisModel, analysisOptions);
  const draftChoice = chosen(draftModel, draftOptions);

  const select = (
    value: string | null,
    options: ModelOption[],
    onPick: (ref: string | null) => void,
    id: string,
  ) => (
    <select id={id} value={value ?? ''} onChange={(e) => onPick(e.target.value || null)}>
      <option value="">Platform default{defaultModel ? ` (${defaultModel.label})` : ''}</option>
      {options.map((m) => (
        // Kept in the list but disabled when unavailable — the point is to show
        // what exists and what it would take to unlock it.
        <option key={m.ref} value={m.ref} disabled={!m.allowed}>
          {optionText(m)}
        </option>
      ))}
    </select>
  );

  const footnote = (choice: ModelOption | null | undefined) => {
    if (!choice) {
      return (
        <span className="text-dim small">
          Runs on whatever key is available — a key shared with this project, then your own, then the
          platform key.
        </span>
      );
    }
    if (!choice.allowed) {
      return (
        <span className="text-error small">
          Configured, but you cannot run it: {choice.reason === 'key-lacks-model'
            ? `your ${choice.provider} key does not include this model.`
            : `you have no ${choice.provider} key.`}{' '}
          Someone else on the project may still be able to.
        </span>
      );
    }
    return (
      <span className="text-dim small">
        Runs on {SOURCE_LABEL[choice.source ?? 'env']}
        {choice.unverified ? ' (not verified for this model)' : ''}
        {choice.speed === 'slow' ? '. Slower models risk the 60s analysis timeout.' : '.'}
      </span>
    );
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <label className="field" style={{ maxWidth: 460 }}>
        <span>Analysis model</span>
        {select(analysisModel, analysisOptions, (ref) => onChange({ analysisModel: ref }), 'analysis-model')}
        {footnote(analysisChoice)}
      </label>

      <label className="field" style={{ maxWidth: 460 }}>
        <span>Draft model</span>
        {select(draftModel, draftOptions, (ref) => onChange({ draftModel: ref }), 'draft-model')}
        {footnote(draftChoice)}
      </label>

      <p className="text-dim small" style={{ margin: 0 }}>
        Only models that return structured JSON can be used for analysis, so the analysis list is shorter.
        Add a key under Settings → API keys to unlock more.
      </p>
    </div>
  );
}
