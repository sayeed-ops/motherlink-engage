// The proxy list — what each proxy is, where it comes out, and who uses it.
//
// PURE: shared by the Proxies page, the account screens and the server. The
// password never reaches this file's callers in the browser; it is sealed on the
// server and only handed back, on request, for a copy.
//
// "Used" is detected, not set. A port is used when an Engage account is linked
// to it, or when any AdsPower profile points at it (the agent reports every
// profile's proxy, with or without an account). A note covers the rest: a proxy
// used somewhere AdsPower cannot see.
//
// "Disposed" IS set, by a person: an IP that should never be handed out again,
// usually because the account on it was banned or deleted. It wins over the rest.

import { parseProxy, type ParsedProxy, type ProxyType } from './proxy';

/** Where a proxy comes out, as ipinfo.io reports it. */
export interface IpInfo {
  ip: string;
  country: string;
  region: string;
  city: string;
  org: string;
  timezone: string;
}

/** What an account carries about its proxy, so its card needs no extra read. */
export interface AccountProxyIp extends IpInfo {
  key: string;
  port: number;
  checkedAtMs: number;
  /** The exit IP moved since the previous check. */
  changed: boolean;
}

/** One list entry as the browser sees it: no password. */
export interface PoolEntry {
  key: string;
  type: ProxyType;
  host: string;
  port: number;
  user: string;
  provider: ParsedProxy['provider'];
  ip: IpInfo | null;
  checkedAtMs: number;
  checkError: string;
  /** The IP before the latest check, when it changed. */
  previousIp: string;
  ipChangedAtMs: number;
  /** Who uses it outside Engage and AdsPower, typed by hand. Empty when nobody. */
  note: string;
  usedBy: { accountId: string; label: string }[];
  /** AdsPower profiles on this proxy that no Engage account stands for. */
  profiles: { id: string; name: string }[];
  /** Never to be handed out again. */
  disposed: boolean;
  /** Why, such as "Wasim 3, deleted". */
  disposedNote: string;
  disposedAtMs: number;
}

export type PoolStatus = 'free' | 'used' | 'disposed';

export const poolKey = (host: string, port: number | string): string => `${host.trim().toLowerCase()}:${port}`;

/** "US" → 🇺🇸. Anything that is not two letters gets no flag. */
export function flagOf(country: string | undefined | null): string {
  const cc = String(country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** "New York City, New York" — the city, and the region when it adds something. */
export function placeOf(ip: Pick<IpInfo, 'city' | 'region' | 'country'> | null | undefined): string {
  if (!ip) return '';
  const parts = [ip.city, ip.region && ip.region !== ip.city ? ip.region : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : ip.country;
}

export function isUsed(entry: Pick<PoolEntry, 'note' | 'usedBy'> & { profiles?: PoolEntry['profiles'] }): boolean {
  return entry.usedBy.length > 0 || (entry.profiles?.length ?? 0) > 0 || entry.note.trim() !== '';
}

export function statusOf(
  entry: Pick<PoolEntry, 'note' | 'usedBy'> & { profiles?: PoolEntry['profiles']; disposed?: boolean },
): PoolStatus {
  if (entry.disposed) return 'disposed';
  return isUsed(entry) ? 'used' : 'free';
}

/** The one-line form the account form's proxy box reads back. */
export function proxyUrl(p: Pick<ParsedProxy, 'type' | 'host' | 'port' | 'user' | 'password'>): string {
  const auth = p.user ? `${p.user}${p.password ? `:${p.password}` : ''}@` : '';
  return `${p.type}://${auth}${p.host}:${p.port}`;
}

/** A curl that shows the exit IP through this proxy. */
export function curlFor(p: Pick<ParsedProxy, 'type' | 'host' | 'port' | 'user' | 'password'>): string {
  const scheme = p.type === 'socks5' ? 'socks5h' : p.type;
  const auth = p.user ? ` -U "${p.user}:${p.password}"` : '';
  return `curl -x ${scheme}://${p.host}:${p.port}${auth} https://ipinfo.io/json`;
}

/** One proxy per line, in any format the account form accepts. Blank lines and
 *  duplicates are skipped; every unreadable line is reported by its number. */
export function parsePoolList(text: string): { proxies: ParsedProxy[]; errors: { line: number; error: string }[] } {
  const proxies: ParsedProxy[] = [];
  const errors: { line: number; error: string }[] = [];
  const seen = new Set<string>();
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim().replace(/^"|"$/g, '');
      if (!line) return;
      const r = parseProxy(line);
      if (!r.ok) {
        errors.push({ line: i + 1, error: r.error });
        return;
      }
      const key = poolKey(r.proxy.host, r.proxy.port);
      if (seen.has(key)) return;
      seen.add(key);
      proxies.push(r.proxy);
    });
  return { proxies, errors };
}

export const COPY_TYPES = ['https', 'http', 'socks5'] as const;
export type CopyType = (typeof COPY_TYPES)[number];
export const COPY_TYPE_LABEL: Record<CopyType, string> = { https: 'HTTPS', http: 'HTTP', socks5: 'SOCKS5' };

/** The same proxy in each protocol. Providers like Decodo serve all three on one
 *  port, with the same exit IP, so the choice is only how a tool connects. */
export function proxyFormats(
  p: Pick<ParsedProxy, 'host' | 'port' | 'user' | 'password'>,
): Record<CopyType, { url: string; curl: string }> {
  const out = {} as Record<CopyType, { url: string; curl: string }>;
  for (const type of COPY_TYPES) out[type] = { url: proxyUrl({ ...p, type }), curl: curlFor({ ...p, type }) };
  return out;
}

/** ipinfo.io's JSON → IpInfo, or null when it is not an answer. */
export function readIpInfo(json: unknown): IpInfo | null {
  const j = json as Record<string, unknown> | null;
  if (!j || typeof j.ip !== 'string' || !j.ip) return null;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return { ip: j.ip, country: s(j.country), region: s(j.region), city: s(j.city), org: s(j.org), timezone: s(j.timezone) };
}
