import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { adminDb } from './admin';
import { openSecret, sealSecret, type SecretEnvelope } from './crypto';
import {
  poolKey,
  readIpInfo,
  type AccountProxyIp,
  type IpInfo,
  type PoolEntry,
} from '@/modules/accounts/proxyPool';
import type { ParsedProxy } from '@/modules/accounts/proxy';

// The proxy list, server side: `proxyPool/{host:port}`.
//
// The password is sealed like an AI key, bound to its entry, and opened only to
// check the IP or to hand a copy to someone who manages accounts. Rules deny the
// collection to every client, so the list is only ever read through here.
//
// CHECKED FROM HERE, NOT FROM THE AGENT. One request through the proxy to
// ipinfo.io, from the web server, so a check never wakes the posting server and
// never touches Reddit. Each account keeps a copy of its proxy's result
// (`proxyIp`), which is what its card reads.

const pool = () => adminDb().collection('proxyPool');
const accounts = () => adminDb().collection('accounts');

const DAY_MS = 24 * 60 * 60 * 1000;
const ctxFor = (key: string) => ({ credentialId: `proxy:${key}`, provider: 'proxy', scope: 'pool' });

interface StoredEntry {
  key: string;
  type: ParsedProxy['type'];
  host: string;
  port: number;
  user: string;
  provider: ParsedProxy['provider'];
  secret?: SecretEnvelope;
  ip?: IpInfo | null;
  checkedAtMs?: number;
  checkError?: string;
  previousIp?: string;
  ipChangedAtMs?: number;
  note?: string;
  disposed?: boolean;
  disposedNote?: string;
  disposedAtMs?: number;
}

export class PoolError extends Error {}

async function readEntry(key: string): Promise<StoredEntry> {
  const snap = await pool().doc(key).get();
  if (!snap.exists) throw new PoolError('That proxy is not on the list.');
  return snap.data() as StoredEntry;
}

function passwordOf(entry: StoredEntry): string {
  return entry.secret ? openSecret(entry.secret, ctxFor(entry.key)) : '';
}

/** Add or update entries. Re-adding an entry keeps its IP, note and history. */
export async function importPool(proxies: ParsedProxy[]): Promise<{ added: number; updated: number; keys: string[] }> {
  let added = 0;
  let updated = 0;
  const keys: string[] = [];
  for (const p of proxies) {
    const key = poolKey(p.host, p.port);
    const ref = pool().doc(key);
    const exists = (await ref.get()).exists;
    await ref.set(
      {
        key,
        type: p.type,
        host: p.host.toLowerCase(),
        port: p.port,
        user: p.user,
        provider: p.provider,
        ...(p.password ? { secret: sealSecret(p.password, ctxFor(key)) } : {}),
        ...(exists ? {} : { note: '', ip: null, checkedAtMs: 0, checkError: '', createdAt: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    if (exists) updated += 1;
    else added += 1;
    keys.push(key);
  }
  return { added, updated, keys };
}

export async function listPool(): Promise<PoolEntry[]> {
  const [entries, accs, map, inv] = await Promise.all([
    pool().get(),
    accounts().get(),
    adminDb().collection('agentPrivate').doc('adspowerProxies').get(),
    adminDb().collection('agents').doc('adspower').get(),
  ]);
  const usedBy = new Map<string, { accountId: string; label: string }[]>();
  const withAccount = new Set<string>();
  for (const a of accs.docs) {
    const profileId = String(a.get('adsPowerProfileId') ?? '');
    if (profileId) withAccount.add(profileId);
    const key = a.get('proxyKey');
    if (typeof key !== 'string' || !key) continue;
    usedBy.set(key, [...(usedBy.get(key) ?? []), { accountId: a.id, label: String(a.get('label') ?? a.id) }]);
  }
  // Profiles in AdsPower with no Engage account still take their port.
  const names = new Map(((inv.get('profiles') ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  const profiles = new Map<string, { id: string; name: string }[]>();
  for (const p of (map.get('profiles') ?? []) as { id: string; host: string; port: string }[]) {
    if (!p.id || withAccount.has(p.id)) continue;
    const key = poolKey(p.host, p.port);
    profiles.set(key, [...(profiles.get(key) ?? []), { id: p.id, name: names.get(p.id) ?? p.id }]);
  }
  return entries.docs
    .map((d) => {
      const e = d.data() as StoredEntry;
      return {
        key: e.key,
        type: e.type,
        host: e.host,
        port: e.port,
        user: e.user,
        provider: e.provider,
        ip: e.ip ?? null,
        checkedAtMs: e.checkedAtMs ?? 0,
        checkError: e.checkError ?? '',
        previousIp: e.previousIp ?? '',
        ipChangedAtMs: e.ipChangedAtMs ?? 0,
        note: e.note ?? '',
        usedBy: usedBy.get(e.key) ?? [],
        profiles: profiles.get(e.key) ?? [],
        disposed: e.disposed === true,
        disposedNote: e.disposedNote ?? '',
        disposedAtMs: e.disposedAtMs ?? 0,
      };
    })
    .sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port);
}

/** The full proxy, for a copy. Only ever returned to accounts.manage holders. */
export async function revealProxy(key: string): Promise<ParsedProxy> {
  const e = await readEntry(key);
  return { type: e.type, host: e.host, port: e.port, user: e.user, password: passwordOf(e), provider: e.provider, rotating: false };
}

async function lookUp(e: StoredEntry): Promise<IpInfo> {
  const password = passwordOf(e);
  const token = e.user || password ? `Basic ${Buffer.from(`${e.user}:${password}`).toString('base64')}` : undefined;
  // The web server cannot speak SOCKS5, so a SOCKS5 entry is checked over HTTP on
  // the same port. Providers that offer both (Decodo does) give the same exit IP.
  const scheme = e.type === 'socks5' ? 'http' : e.type;
  // A fresh agent per check: nothing pooled, so a check is exactly one tunnel.
  const dispatcher = new ProxyAgent({ uri: `${scheme}://${e.host}:${e.port}`, ...(token ? { token } : {}) });
  try {
    const res = await undiciFetch('https://ipinfo.io/json', { dispatcher, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new PoolError(`The IP lookup answered ${res.status}.`);
    const info = readIpInfo(await res.json());
    if (!info) throw new PoolError('The proxy answered, but not with an IP. Check the login.');
    return info;
  } catch (err) {
    if (err instanceof PoolError) throw err;
    const e2 = err as { message?: string; cause?: { message?: string } };
    const why = e2.cause?.message || e2.message || 'unknown error';
    throw new PoolError(
      e.type === 'socks5'
        ? `This SOCKS5 proxy did not answer over HTTP too, so it cannot be checked from the web server (${why}).`
        : `The proxy did not answer: ${why}.`,
    );
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

function accountCopy(key: string, e: { port: number; ip: IpInfo; checkedAtMs: number; changed: boolean }): AccountProxyIp {
  return { key, port: e.port, ...e.ip, checkedAtMs: e.checkedAtMs, changed: e.changed };
}

/** Check one entry's exit IP and pass the result to every account on it. */
export async function checkProxy(key: string): Promise<{ ip: IpInfo | null; error: string; changed: boolean }> {
  const e = await readEntry(key);
  const nowMs = Date.now();
  let ip: IpInfo;
  try {
    ip = await lookUp(e);
  } catch (err) {
    const error = (err as Error).message;
    await pool().doc(key).update({ checkError: error, checkedAtMs: nowMs, updatedAt: FieldValue.serverTimestamp() });
    return { ip: e.ip ?? null, error, changed: false };
  }
  const was = e.ip?.ip ?? '';
  const changed = was !== '' && was !== ip.ip;
  await pool().doc(key).update({
    ip,
    checkedAtMs: nowMs,
    checkError: '',
    ...(changed ? { previousIp: was, ipChangedAtMs: nowMs } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });
  // `changed` lasts until the next check finds the same IP again.
  const linked = await accounts().where('proxyKey', '==', key).get();
  await Promise.all(
    linked.docs.map((a) => a.ref.update({ proxyIp: accountCopy(key, { port: e.port, ip, checkedAtMs: nowMs, changed }) })),
  );
  return { ip, error: '', changed };
}

export async function setNote(key: string, note: string): Promise<void> {
  await readEntry(key);
  await pool().doc(key).update({ note: note.trim().slice(0, 120), updatedAt: FieldValue.serverTimestamp() });
}

/** Mark an IP never to be handed out again, or make it available once more. */
export async function setDisposed(key: string, disposed: boolean, note = ''): Promise<void> {
  await readEntry(key);
  await pool().doc(key).update({
    disposed,
    disposedNote: disposed ? note.trim().slice(0, 120) : '',
    disposedAtMs: disposed ? Date.now() : 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** Is this host and port on the list as disposed? */
export async function isDisposed(host: string, port: number): Promise<boolean> {
  const snap = await pool().doc(poolKey(host, port)).get();
  return snap.exists && snap.get('disposed') === true;
}

export async function deleteProxy(key: string): Promise<void> {
  const linked = await accounts().where('proxyKey', '==', key).limit(1).get();
  if (!linked.empty) throw new PoolError(`${linked.docs[0].get('label') ?? 'An account'} uses this proxy. Unlink it first.`);
  await pool().doc(key).delete();
}

/** Point an account at a list entry (or at none). Copies the entry's last result. */
export async function linkAccount(accountId: string, key: string | null): Promise<void> {
  const ref = accounts().doc(accountId);
  if (!key) {
    await ref.update({ proxyKey: FieldValue.delete(), proxyIp: FieldValue.delete() });
    return;
  }
  const e = await readEntry(key);
  await ref.update({
    proxyKey: key,
    proxyIp: e.ip ? accountCopy(key, { port: e.port, ip: e.ip, checkedAtMs: e.checkedAtMs ?? 0, changed: false }) : FieldValue.delete(),
  });
}

/**
 * Link a new account to its proxy's list entry, adding the proxy to the list
 * first when it is not there. A rotating proxy is never added: it is not one IP.
 * An existing entry is linked as it is, never overwritten by the paste.
 */
export async function linkOrAddProxy(accountId: string, proxy: ParsedProxy): Promise<'linked' | 'added' | 'skipped'> {
  const key = poolKey(proxy.host, proxy.port);
  const exists = (await pool().doc(key).get()).exists;
  if (!exists) {
    if (proxy.rotating) return 'skipped';
    await importPool([proxy]);
  }
  await linkAccount(accountId, key);
  await checkProxy(key).catch(() => {});
  return exists ? 'linked' : 'added';
}

/**
 * AdsPower is the truth about which proxy a profile uses. The agent publishes
 * each profile's proxy host and port (never the login) to a server-only
 * document; every account whose profile points at a list entry is linked to it.
 */
export async function reconcileFromInventory(): Promise<number> {
  const map = (await adminDb().collection('agentPrivate').doc('adspowerProxies').get()).data();
  const byProfile = new Map<string, string>();
  for (const p of (map?.profiles ?? []) as { id?: string; host?: string; port?: string }[]) {
    if (p.id && p.host && p.port) byProfile.set(String(p.id), poolKey(String(p.host), String(p.port)));
  }
  if (!byProfile.size) return 0;
  const listed = new Set((await pool().select().get()).docs.map((d) => d.id));
  let linked = 0;
  for (const a of (await accounts().get()).docs) {
    const key = byProfile.get(String(a.get('adsPowerProfileId') ?? ''));
    if (!key || !listed.has(key) || a.get('proxyKey') === key) continue;
    await linkAccount(a.id, key);
    linked += 1;
  }
  return linked;
}

/** Re-check entries not checked for a day, a few per call. */
export async function refreshStaleProxies(max = 3): Promise<number> {
  const stale = await pool().where('checkedAtMs', '<', Date.now() - DAY_MS).limit(max).get();
  for (const d of stale.docs) await checkProxy(d.id).catch(() => {});
  return stale.size;
}
