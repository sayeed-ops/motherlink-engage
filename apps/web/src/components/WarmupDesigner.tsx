'use client';

import { useState } from 'react';
import {
  Sparkles,
  FilePlus2,
  Save,
  Trash2,
  ArrowUp,
  ArrowDown,
  Plus,
  Combine,
  Ungroup,
  Clock,
  Wand2,
} from 'lucide-react';
import { apiFetch, apiPost, ApiError } from '@/lib/api';
import {
  WARMUP_ACTIONS,
  WARMUP_ACTION_LIST,
  WARMUP_PACKAGE_LIST,
  instantiatePackage,
  makeAction,
  blankWarmupPlan,
  humanizeDuration,
  dayDurationSec,
  warmupId,
  type WarmupPlan,
  type WarmupDay,
  type WarmupAction,
  type WarmupActionType,
  type WarmupPackageId,
} from '@/modules/reddit/warmup';

// The warm-up designer.
//
// A plan is N days, each an ordered timeline of actions. Actions can be grouped
// into "packages" (pre-built human-like flows) that move as a unit; two or more
// actions can be merged into a package; every action's dwell, gap-to-next and
// jitter are editable; days and actions can be added, removed and reordered.
//
// AI designs a starting plan (server: DeepSeek → package skeleton → concrete
// actions, deterministic fallback); the user then reshapes it, or starts blank.
// NOTHING here executes — actions are labels for now; wiring each to a real
// AdsPower/Reddit step is a later pass.

// A contiguous run of same-group (or lone) actions — the unit we move/organise.
interface Block {
  key: string;
  groupId?: string;
  name?: string;
  actions: WarmupAction[];
}

function toBlocks(day: WarmupDay): Block[] {
  const blocks: Block[] = [];
  for (const a of day.actions) {
    const last = blocks[blocks.length - 1];
    if (a.groupId && last && last.groupId === a.groupId) {
      last.actions.push(a);
    } else {
      blocks.push({
        key: a.groupId ? `${a.groupId}:${blocks.length}` : a.id,
        groupId: a.groupId,
        name: a.groupId ? day.groups.find((g) => g.id === a.groupId)?.name ?? 'Package' : undefined,
        actions: [a],
      });
    }
  }
  return blocks;
}

export default function WarmupDesigner({
  accountId,
  hasSavedPlan,
  initialPlan,
  keywords,
  canManage,
}: {
  accountId: string;
  hasSavedPlan: boolean;
  initialPlan: WarmupPlan | null;
  keywords: string[];
  canManage: boolean;
}) {
  const [plan, setPlan] = useState<WarmupPlan | null>(initialPlan);
  const [days, setDays] = useState(initialPlan?.days.length ?? 7);
  const [dirty, setDirty] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function update(next: WarmupPlan) {
    setPlan(next);
    setDirty(true);
    setNotice(null);
  }

  function mapDay(dayIndex: number, fn: (d: WarmupDay) => WarmupDay) {
    if (!plan) return;
    update({ ...plan, days: plan.days.map((d, i) => (i === dayIndex ? fn(d) : d)) });
  }

  // --- plan-level ---
  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await apiPost<{ plan: WarmupPlan; ai: boolean }>(
        `/api/accounts/${accountId}/warmup/generate`,
        { days, keywords },
      );
      setPlan(res.plan);
      setDirty(true);
      setSelected(new Set());
      setNotice(res.ai ? 'AI designed a plan. Tweak it below, then save.' : 'Designed a plan. Tweak it below, then save.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate a plan.');
    } finally {
      setGenerating(false);
    }
  }

  function startBlank() {
    setPlan(blankWarmupPlan(days));
    setDirty(true);
    setSelected(new Set());
    setNotice('Blank plan. Add packages or actions to each day.');
  }

  async function save() {
    if (!plan) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/accounts/${accountId}/warmup`, {
        method: 'PUT',
        body: JSON.stringify({ plan }),
      });
      setDirty(false);
      setNotice('Saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the plan.');
    } finally {
      setSaving(false);
    }
  }

  async function clearSaved() {
    if (!confirm('Delete this saved warm-up plan?')) return;
    setError(null);
    try {
      await apiFetch(`/api/accounts/${accountId}/warmup`, { method: 'DELETE' });
      setPlan(null);
      setDirty(false);
      setNotice('Plan deleted.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the plan.');
    }
  }

  // --- day-level ---
  function addDay() {
    if (!plan) return;
    update({
      ...plan,
      days: [...plan.days, { day: plan.days.length + 1, label: '', actions: [], groups: [] }],
    });
  }

  function removeDay(dayIndex: number) {
    if (!plan) return;
    const remaining = plan.days.filter((_, i) => i !== dayIndex).map((d, i) => ({ ...d, day: i + 1 }));
    update({ ...plan, days: remaining });
  }

  // --- action-level ---
  function addAction(dayIndex: number, type: WarmupActionType) {
    mapDay(dayIndex, (d) => ({ ...d, actions: [...d.actions, makeAction(type, { gapAfterSec: 0 })] }));
  }

  function addPackage(dayIndex: number, id: WarmupPackageId) {
    mapDay(dayIndex, (d) => {
      const { actions, group } = instantiatePackage(id);
      actions[actions.length - 1].gapAfterSec = 0;
      return { ...d, actions: [...d.actions, ...actions], groups: [...d.groups, group] };
    });
  }

  function removeAction(dayIndex: number, actionId: string) {
    mapDay(dayIndex, (d) => {
      const actions = d.actions.filter((a) => a.id !== actionId);
      const usedGroups = new Set(actions.map((a) => a.groupId).filter(Boolean));
      return { ...d, actions, groups: d.groups.filter((g) => usedGroups.has(g.id)) };
    });
    setSelected((s) => {
      const n = new Set(s);
      n.delete(actionId);
      return n;
    });
  }

  function patchAction(dayIndex: number, actionId: string, patch: Partial<WarmupAction>) {
    mapDay(dayIndex, (d) => ({
      ...d,
      actions: d.actions.map((a) => (a.id === actionId ? { ...a, ...patch } : a)),
    }));
  }

  function setParam(dayIndex: number, actionId: string, key: string, value: string) {
    mapDay(dayIndex, (d) => ({
      ...d,
      actions: d.actions.map((a) => {
        if (a.id !== actionId) return a;
        const params = { ...(a.params ?? {}) };
        if (value.trim()) params[key] = value;
        else delete params[key];
        return { ...a, params: Object.keys(params).length ? params : undefined };
      }),
    }));
  }

  // Move a whole block (package or lone action) up/down among the day's blocks.
  function moveBlock(dayIndex: number, blockIdx: number, dir: -1 | 1) {
    mapDay(dayIndex, (d) => {
      const blocks = toBlocks(d);
      const j = blockIdx + dir;
      if (j < 0 || j >= blocks.length) return d;
      [blocks[blockIdx], blocks[j]] = [blocks[j], blocks[blockIdx]];
      return { ...d, actions: blocks.flatMap((b) => b.actions) };
    });
  }

  // Merge the day's selected actions into a new package (gathered contiguous at
  // the position of the earliest selected action).
  function mergeSelected(dayIndex: number, ids: string[]) {
    if (ids.length < 2) return;
    mapDay(dayIndex, (d) => {
      const groupId = warmupId('g');
      const chosen = d.actions.filter((a) => ids.includes(a.id)).map((a) => ({ ...a, groupId }));
      const firstIdx = d.actions.findIndex((a) => ids.includes(a.id));
      const rest = d.actions.filter((a) => !ids.includes(a.id));
      const merged = [...rest.slice(0, firstIdx), ...chosen, ...rest.slice(firstIdx)];
      return { ...d, actions: merged, groups: [...d.groups, { id: groupId, name: 'Custom package' }] };
    });
    setSelected(new Set());
  }

  function ungroup(dayIndex: number, groupId: string) {
    mapDay(dayIndex, (d) => ({
      ...d,
      actions: d.actions.map((a) => (a.groupId === groupId ? { ...a, groupId: undefined } : a)),
      groups: d.groups.filter((g) => g.id !== groupId),
    }));
  }

  function renameGroup(dayIndex: number, groupId: string, name: string) {
    mapDay(dayIndex, (d) => ({
      ...d,
      groups: d.groups.map((g) => (g.id === groupId ? { ...g, name } : g)),
    }));
  }

  function toggleSelect(actionId: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(actionId)) n.delete(actionId);
      else n.add(actionId);
      return n;
    });
  }

  const daysClamp = (v: number) => Math.max(1, Math.min(60, Math.round(v) || 1));

  // ---- render ----
  const setupBar = (
    <div className="wu-setup">
      <label className="field" style={{ maxWidth: 130 }}>
        <span>Days</span>
        <input
          type="number"
          min={1}
          max={60}
          value={days}
          onChange={(e) => setDays(daysClamp(Number(e.target.value)))}
          disabled={!canManage}
        />
      </label>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={generate} disabled={!canManage || generating}>
          <Sparkles size={14} /> {generating ? 'Designing…' : plan ? 'Re-generate with AI' : 'Generate with AI'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={startBlank} disabled={!canManage}>
          <FilePlus2 size={14} /> Start blank
        </button>
      </div>
    </div>
  );

  if (!plan) {
    return (
      <div className="card">
        <div className="stack">
          <div className="row" style={{ gap: 8 }}>
            <Wand2 size={16} className="text-primary" />
            <strong>Design a warm-up</strong>
          </div>
          <p className="text-dim small" style={{ maxWidth: 620 }}>
            A warm-up ages this account with ordinary, human-like activity — browsing, reading,
            joining subreddits, the odd upvote — ramping up over the days before it ever posts. Pick a
            length and let AI draft one, or start from a blank timeline and build it yourself.
          </p>
          {setupBar}
          {error && <p className="text-error small">{error}</p>}
          {!canManage && <p className="text-faint small">You need the accounts.manage permission to design warm-ups.</p>}
        </div>
      </div>
    );
  }

  const totalActions = plan.days.reduce((s, d) => s + d.actions.length, 0);

  return (
    <div className="stack">
      <div className="card">
        <div className="wu-toolbar">
          {setupBar}
          <div className="row" style={{ gap: 8 }}>
            {dirty && <span className="badge badge-warning">Unsaved changes</span>}
            <button className="btn btn-primary btn-sm" onClick={save} disabled={!canManage || saving || !dirty}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save plan'}
            </button>
            {hasSavedPlan && (
              <button className="btn btn-danger btn-sm" onClick={clearSaved} disabled={!canManage}>
                <Trash2 size={14} /> Delete
              </button>
            )}
          </div>
        </div>
        <p className="text-dim small" style={{ marginTop: 8 }}>
          {plan.days.length} day{plan.days.length === 1 ? '' : 's'} · {totalActions} action
          {totalActions === 1 ? '' : 's'} · {plan.source === 'ai' ? 'AI-designed' : 'hand-built'} · actions
          are placeholders until wired to Reddit.
        </p>
        {error && <p className="text-error small">{error}</p>}
        {notice && <p className="text-success small">{notice}</p>}
      </div>

      {plan.days.map((day, dayIndex) => {
        const blocks = toBlocks(day);
        const daySelected = day.actions.filter((a) => selected.has(a.id)).map((a) => a.id);
        return (
          <section className="card wu-day" key={dayIndex}>
            <div className="wu-day-head">
              <div className="row" style={{ gap: 10, minWidth: 0 }}>
                <span className="wu-day-num">Day {day.day}</span>
                <input
                  className="wu-day-label"
                  value={day.label}
                  placeholder="Day theme (optional)"
                  onChange={(e) => mapDay(dayIndex, (d) => ({ ...d, label: e.target.value }))}
                  disabled={!canManage}
                />
              </div>
              <div className="row" style={{ gap: 8 }}>
                <span className="text-faint small">
                  <Clock size={12} style={{ verticalAlign: '-2px' }} /> ~{humanizeDuration(dayDurationSec(day))} span ·{' '}
                  {day.actions.length} action{day.actions.length === 1 ? '' : 's'}
                </span>
                {canManage && (
                  <button
                    className="btn btn-ghost btn-sm btn-icon"
                    onClick={() => removeDay(dayIndex)}
                    aria-label={`Remove day ${day.day}`}
                    title="Remove day"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>

            {day.actions.length === 0 && (
              <p className="text-dim small wu-empty">Empty day — add a package or an action below.</p>
            )}

            <div className="wu-timeline">
              {blocks.map((block, blockIdx) => (
                <div key={block.key} className={block.groupId ? 'wu-block wu-block-pkg' : 'wu-block'}>
                  {block.groupId && (
                    <div className="wu-pkg-head">
                      <Combine size={12} className="text-primary" />
                      <input
                        className="wu-pkg-name"
                        value={block.name ?? 'Package'}
                        onChange={(e) => renameGroup(dayIndex, block.groupId!, e.target.value)}
                        disabled={!canManage}
                      />
                      {canManage && (
                        <button
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={() => ungroup(dayIndex, block.groupId!)}
                          title="Ungroup package"
                          aria-label="Ungroup package"
                        >
                          <Ungroup size={13} />
                        </button>
                      )}
                    </div>
                  )}

                  <div className="wu-block-body">
                    {canManage && (
                      <div className="wu-block-move">
                        <button
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={() => moveBlock(dayIndex, blockIdx, -1)}
                          disabled={blockIdx === 0}
                          aria-label="Move up"
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={() => moveBlock(dayIndex, blockIdx, 1)}
                          disabled={blockIdx === blocks.length - 1}
                          aria-label="Move down"
                        >
                          <ArrowDown size={13} />
                        </button>
                      </div>
                    )}

                    <div className="wu-actions">
                      {block.actions.map((a) => {
                        const def = WARMUP_ACTIONS[a.type];
                        const isLastOfDay = day.actions[day.actions.length - 1]?.id === a.id;
                        return (
                          <div key={a.id}>
                            <div className={`wu-action wu-cat-${def.category}`}>
                              {canManage && (
                                <input
                                  type="checkbox"
                                  checked={selected.has(a.id)}
                                  onChange={() => toggleSelect(a.id)}
                                  title="Select to merge"
                                />
                              )}
                              <span className={`wu-dot wu-cat-${def.category}`} />
                              <input
                                className="wu-action-label"
                                value={a.label}
                                onChange={(e) => patchAction(dayIndex, a.id, { label: e.target.value })}
                                disabled={!canManage}
                              />
                              {def.paramKeys?.map((k) => (
                                <input
                                  key={k}
                                  className="wu-param"
                                  value={a.params?.[k] ?? ''}
                                  placeholder={k}
                                  onChange={(e) => setParam(dayIndex, a.id, k, e.target.value)}
                                  disabled={!canManage}
                                />
                              ))}
                              <label className="wu-num" title="Dwell — how long this takes">
                                <input
                                  type="number"
                                  min={0}
                                  value={a.dwellSec}
                                  onChange={(e) => patchAction(dayIndex, a.id, { dwellSec: Math.max(0, Number(e.target.value) || 0) })}
                                  disabled={!canManage}
                                />
                                <span>s</span>
                              </label>
                              <span className="wu-jitter" title="Randomness applied at run time">±{a.jitterPct}%</span>
                              {canManage && (
                                <button
                                  className="btn btn-ghost btn-sm btn-icon wu-del"
                                  onClick={() => removeAction(dayIndex, a.id)}
                                  aria-label="Remove action"
                                >
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </div>

                            {!isLastOfDay && (
                              <div className="wu-gap">
                                <span className="wu-gap-line" />
                                <label title="Wait before the next action">
                                  wait
                                  <input
                                    type="number"
                                    min={0}
                                    value={a.gapAfterSec}
                                    onChange={(e) => patchAction(dayIndex, a.id, { gapAfterSec: Math.max(0, Number(e.target.value) || 0) })}
                                    disabled={!canManage}
                                  />
                                  s
                                  <em className="text-faint">({humanizeDuration(a.gapAfterSec)})</em>
                                </label>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {canManage && (
              <div className="wu-day-foot">
                <select
                  className="wu-add"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) addPackage(dayIndex, e.target.value as WarmupPackageId);
                    e.currentTarget.value = '';
                  }}
                >
                  <option value="">+ Add package…</option>
                  {WARMUP_PACKAGE_LIST.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  className="wu-add"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) addAction(dayIndex, e.target.value as WarmupActionType);
                    e.currentTarget.value = '';
                  }}
                >
                  <option value="">+ Add action…</option>
                  {WARMUP_ACTION_LIST.map((a) => (
                    <option key={a.type} value={a.type}>
                      {a.label}
                    </option>
                  ))}
                </select>
                {daySelected.length >= 2 && (
                  <button className="btn btn-secondary btn-sm" onClick={() => mergeSelected(dayIndex, daySelected)}>
                    <Combine size={13} /> Merge {daySelected.length} into package
                  </button>
                )}
                {daySelected.length === 1 && <span className="text-faint small">Select one more to merge</span>}
              </div>
            )}
          </section>
        );
      })}

      {canManage && (
        <button className="btn btn-secondary btn-sm wu-add-day" onClick={addDay}>
          <Plus size={14} /> Add day
        </button>
      )}
    </div>
  );
}
