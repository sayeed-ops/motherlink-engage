'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { subscribeDoc, adsPowerInventoryPath } from '@/lib/data';
import { describeProxy, parseProxy, PROVIDER_LABEL } from '@/modules/accounts/proxy';
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

      <label className="field" style={{ maxWidth: 640 }}>
        <span>Proxy — paste it as the provider gave it</span>
        <textarea
          rows={2}
          value={value.proxy}
          onChange={(e) => onChange({ ...value, proxy: e.target.value })}
          placeholder={'host:port:user:pass, user:pass@host:port, or the curl line from Decodo / IPRoyal'}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
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
