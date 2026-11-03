'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { subscribeDoc, adsPowerInventoryPath } from '@/lib/data';
import { describeProxy, parseProxy, PROVIDER_LABEL } from '@/modules/accounts/proxy';
import {
  COPY_TYPE_LABEL,
  COPY_TYPES,
  flagOf,
  placeOf,
  statusOf,
  type CopyType,
  type PoolEntry,
} from '@/modules/accounts/proxyPool';
import { BROWSER_LABEL, OS_LABEL, type BrowserKind, type OsChoice } from '@/modules/accounts/profileSpec';

// The "new AdsPower profile" half of the account form, also used on its own to
// set up a profile for an account that has none (a retry, or an older account).
//
// Proxy: one box takes whatever the provider gave you; the line under it says
// what was understood. "Test proxy" asks the agent, on the server, to go out
// through it once and report the exit IP and place — and whether another
// profile already uses that proxy or IP (one profile per IP).
//
// Groups come from agents/adspower, which the agent publishes from AdsPower.

export interface ProfileFieldValues {
  name: string;
  groupId: string;
  browser: BrowserKind;
  os: OsChoice;
  proxy: string;
}

export const EMPTY_PROFILE_FIELDS: ProfileFieldValues = { name: '', groupId: '', browser: 'chrome', os: 'any', proxy: '' };

interface Inventory {
  groups: { id: string; name: string }[];
  profiles: { id: string; name: string; group: string }[];
}

interface TestResult {
  ip: string;
  country: string;
  region: string;
  city: string;
  timezone: string;
  usedBy: string[];
}

/** The group the operator files Reddit profiles under, when AdsPower has it. */
const DEFAULT_GROUP = /reddit/i;

export function useAdsPowerInventory(): Inventory | null {
  const [inv, setInv] = useState<Inventory | null>(null);
  useEffect(
    () =>
      subscribeDoc<Inventory>(adsPowerInventoryPath, (d) =>
        setInv(d ? { groups: d.groups ?? [], profiles: d.profiles ?? [] } : { groups: [], profiles: [] }),
      ),
    [],
  );
  return inv;
}

export default function ProfileFields({
  value,
  onChange,
  namePlaceholder,
}: {
  value: ProfileFieldValues;
  onChange: (v: ProfileFieldValues) => void;
  namePlaceholder: string;
}) {
  const inv = useAdsPowerInventory();
  const free = useFreeProxies();
  // From the list when there is anything free on it; pasting is always there.
  const [source, setSource] = useState<'list' | 'paste'>('list');
  const fromList = source === 'list' && free.length > 0;
  const parsed = useMemo(() => (value.proxy.trim() ? parseProxy(value.proxy) : null), [value.proxy]);
  const [testing, setTesting] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [test, setTest] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testedFor, setTestedFor] = useState('');

  // Pick the operator's Reddit group once the list arrives, if none is chosen.
  useEffect(() => {
    if (!inv || value.groupId) return;
    const g = inv.groups.find((x) => DEFAULT_GROUP.test(x.name));
    if (g) onChange({ ...value, groupId: g.id });
  }, [inv, value, onChange]);

  // A result belongs to the proxy it was run on.
  const stale = testing !== 'idle' && testedFor !== value.proxy;

  async function runTest() {
    setTesting('running');
    setTest(null);
    setTestError(null);
    setTestedFor(value.proxy);
    try {
      const { taskId } = await apiPost<{ taskId: string }>('/api/accounts/proxy-test', { proxy: value.proxy });
      // The server may be asleep: allow a wake (3–5 min) plus the test itself.
      const until = Date.now() + 7 * 60_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2500));
        const t = await apiGet<{ status: string; error: string; result: TestResult | null }>(`/api/accounts/profile-tasks/${taskId}`);
        if (t.status === 'done' && t.result) {
          setTest(t.result);
          setTesting('done');
          return;
        }
        if (t.status === 'failed') {
          setTestError(t.error || 'The proxy test failed.');
          setTesting('failed');
          return;
        }
      }
      setTestError('No answer from the agent after 7 minutes — is the server on?');
      setTesting('failed');
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : 'Could not start the proxy test.');
      setTesting('failed');
    }
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="grid-form">
        <label className="field">
          <span>Profile name in AdsPower</span>
          <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder={namePlaceholder} />
        </label>
        <label className="field">
          <span>AdsPower group</span>
          <select value={value.groupId} onChange={(e) => onChange({ ...value, groupId: e.target.value })}>
            <option value="0">Ungrouped</option>
            {(inv?.groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Browser</span>
          <select value={value.browser} onChange={(e) => onChange({ ...value, browser: e.target.value as BrowserKind })}>
            {(Object.keys(BROWSER_LABEL) as BrowserKind[]).map((b) => (
              <option key={b} value={b}>
                {BROWSER_LABEL[b]} — latest
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Operating system</span>
          <select value={value.os} onChange={(e) => onChange({ ...value, os: e.target.value as OsChoice })}>
            {(Object.keys(OS_LABEL) as OsChoice[]).map((o) => (
              <option key={o} value={o}>
                {OS_LABEL[o]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="field" style={{ maxWidth: 640 }}>
        <span>Proxy</span>
        {free.length > 0 && (
          <div className="tabs-inline">
            <button
              type="button"
              className={`chip-tab ${fromList ? 'active' : ''}`}
              onClick={() => {
                setSource('list');
                onChange({ ...value, proxy: '' });
              }}
            >
              From the list <span className="chip-count">{free.length} free</span>
            </button>
            <button
              type="button"
              className={`chip-tab ${!fromList ? 'active' : ''}`}
              onClick={() => {
                setSource('paste');
                onChange({ ...value, proxy: '' });
              }}
            >
              Paste
            </button>
          </div>
        )}
      </div>

      {fromList ? (
        <PoolPicker free={free} onPick={(url) => onChange({ ...value, proxy: url })} />
      ) : (
        <label className="field" style={{ maxWidth: 640 }}>
          <span>Paste it as the provider gave it</span>
          <textarea
            rows={2}
            value={value.proxy}
            onChange={(e) => onChange({ ...value, proxy: e.target.value })}
            placeholder={'host:port:user:pass, user:pass@host:port, or the curl line from Decodo / IPRoyal'}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="text-dim small">A proxy that is not on the list yet is added to it when the account is created.</span>
        </label>
      )}
      {parsed && !parsed.ok && <p className="text-error small" style={{ margin: 0 }}>{parsed.error}</p>}
      {parsed && parsed.ok && (
        <p className="text-dim small" style={{ margin: 0 }}>
          Understood: <code>{describeProxy(parsed.proxy)}</code> · {PROVIDER_LABEL[parsed.proxy.provider]}
          {parsed.proxy.rotating && (
            <strong className="text-warning"> · rotating — the IP changes every time; fine for testing, not for a real account</strong>
          )}
        </p>
      )}

      <p className="text-dim small" style={{ margin: 0 }}>
        Time zone, location and language follow the proxy&apos;s IP, and WebRTC goes through the proxy.
      </p>

      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-secondary btn-sm" onClick={runTest} disabled={!parsed?.ok || testing === 'running'}>
          {testing === 'running' ? 'Testing… (wakes the server if needed)' : 'Test proxy'}
        </button>
        {!stale && testing === 'done' && test && (
          <span className="small">
            <strong>{test.ip}</strong> · {[test.city, test.region, test.country].filter(Boolean).join(', ')}
            {test.timezone ? ` · ${test.timezone}` : ''}
          </span>
        )}
        {!stale && testing === 'failed' && testError && <span className="text-error small">{testError}</span>}
      </div>
      {!stale && testing === 'done' && test && test.usedBy.length > 0 && (
        <p className="text-error small" style={{ margin: 0 }}>
          Already used by {test.usedBy.join(', ')}. One profile per IP — use a different proxy unless this is deliberate.
        </p>
      )}
    </div>
  );
}

/** The free entries on the proxy list. Empty when there are none, or when the
 *  list cannot be read, which leaves the form on pasting. */
function useFreeProxies(): PoolEntry[] {
  const [free, setFree] = useState<PoolEntry[]>([]);
  useEffect(() => {
    let on = true;
    apiGet<{ entries: PoolEntry[] }>('/api/proxies')
      .then((r) => on && setFree(r.entries.filter((e) => statusOf(e) === 'free')))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);
  return free;
}

/** Choose a free proxy and the protocol AdsPower should use for it. The same
 *  port gives the same IP in each protocol. */
function PoolPicker({ free, onPick }: { free: PoolEntry[]; onPick: (url: string) => void }) {
  const [key, setKey] = useState('');
  const [type, setType] = useState<CopyType>('https');
  const [error, setError] = useState<string | null>(null);

  async function pick(nextKey: string, nextType: CopyType) {
    setKey(nextKey);
    setType(nextType);
    if (!nextKey) return;
    setError(null);
    try {
      const r = await apiPost<{ formats: Record<CopyType, { url: string }> }>(
        `/api/proxies/${encodeURIComponent(nextKey)}`,
        { action: 'reveal' },
      );
      onPick(r.formats[nextType].url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that proxy.');
    }
  }

  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap', maxWidth: 640 }}>
      <select value={key} onChange={(e) => void pick(e.target.value, type)} style={{ flex: 1, minWidth: 260 }}>
        <option value="" disabled>
          Choose a free proxy…
        </option>
        {free.map((e) => (
          <option key={e.key} value={e.key}>
            {e.port} · {flagOf(e.ip?.country)} {placeOf(e.ip) || 'not checked'} · {e.ip?.ip ?? ''}
          </option>
        ))}
      </select>
      <select value={type} onChange={(e) => void pick(key, e.target.value as CopyType)} aria-label="Protocol" style={{ width: 120 }}>
        {COPY_TYPES.map((t) => (
          <option key={t} value={t}>
            {COPY_TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      {error && <span className="text-error small">{error}</span>}
    </div>
  );
}
