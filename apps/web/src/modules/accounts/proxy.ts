// Reading a proxy the way the providers hand it out.
//
// One box on the account form accepts whatever was copied from the provider's
// dashboard — a curl line, a URL, host:port:user:pass, user:pass@host:port — and
// turns it into the fields AdsPower's proxy tab takes. Shared by the form (to
// show what it understood) and the server (which is what is trusted).
//
// The provider is recognised from the host, only to label it and to know when a
// proxy ROTATES: a rotating exit IP changes on every connection, so "is this IP
// already used by another account?" means nothing for it (fine for testing; a
// real account wants a static or sticky IP).

export type ProxyType = 'http' | 'socks5';
export type ProxyProvider = 'decodo' | 'iproyal' | 'other';

export interface ParsedProxy {
  type: ProxyType;
  host: string;
  port: number;
  user: string;
  password: string;
  provider: ProxyProvider;
  /** The exit IP changes on every connection — testing only. */
  rotating: boolean;
}

export type ProxyParse = { ok: true; proxy: ParsedProxy } | { ok: false; error: string };

export const PROVIDER_LABEL: Record<ProxyProvider, string> = {
  decodo: 'Decodo',
  iproyal: 'IPRoyal',
  other: 'Other / static IP',
};

/** A value after a curl flag, quoted or not: -x "host:port" / --proxy=host:port. */
function curlFlag(text: string, flags: string[]): string | null {
  for (const f of flags) {
    const re = new RegExp(`(?:^|\\s)${f}(?:\\s+|=)(?:"([^"]*)"|'([^']*)'|(\\S+))`);
    const m = text.match(re);
    if (m) return m[1] ?? m[2] ?? m[3] ?? null;
  }
  return null;
}

function typeOf(scheme: string | undefined): ProxyType | null {
  if (!scheme) return 'http';
  const s = scheme.toLowerCase();
  if (s === 'http' || s === 'https') return 'http';
  if (s === 'socks5' || s === 'socks5h' || s === 'socks') return 'socks5';
  return null;
}

function providerOf(host: string): ProxyProvider {
  const h = host.toLowerCase();
  if (h === 'decodo.com' || h.endsWith('.decodo.com') || h.endsWith('.smartproxy.com')) return 'decodo';
  if (h === 'iproyal.com' || h.endsWith('.iproyal.com')) return 'iproyal';
  return 'other';
}

/** Gateway hosts hand out a new IP per connection unless the username pins a
 *  session. IPRoyal: geo.iproyal.com without `_session-`. Decodo: gate.decodo.com
 *  on port 7000 (its rotating port) without `session-`. */
function rotatingOf(p: Omit<ParsedProxy, 'rotating'>): boolean {
  const h = p.host.toLowerCase();
  const auth = `${p.user}:${p.password}`.toLowerCase();
  if (p.provider === 'iproyal' && h.startsWith('geo.')) return !auth.includes('_session-');
  if (p.provider === 'decodo' && h.startsWith('gate.') && p.port === 7000) return !auth.includes('session-');
  return false;
}

function finish(fields: { scheme?: string; host: string; port: string; user?: string; password?: string }): ProxyParse {
  const type = typeOf(fields.scheme);
  if (!type) return { ok: false, error: `Unsupported proxy type "${fields.scheme}" — use http or socks5.` };
  const host = fields.host.trim();
  const port = Number(fields.port);
  if (!host || /\s/.test(host)) return { ok: false, error: 'Could not find the proxy host.' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Could not find a valid proxy port.' };
  const base = { type, host, port, user: (fields.user ?? '').trim(), password: (fields.password ?? '').trim(), provider: providerOf(host) };
  return { ok: true, proxy: { ...base, rotating: rotatingOf(base) } };
}

/** scheme://user:pass@host:port, user:pass@host:port, host:port */
function parseUrlish(s: string): ProxyParse | null {
  const m = s.match(/^(?:([a-z0-9]+):\/\/)?(?:(.+)@)?([^@:/\s]+):(\d+)\/?$/i);
  if (!m) return null;
  const [, scheme, auth, host, port] = m;
  let user = '';
  let password = '';
  if (auth) {
    const i = auth.indexOf(':');
    user = i >= 0 ? auth.slice(0, i) : auth;
    password = i >= 0 ? auth.slice(i + 1) : '';
  }
  return finish({ scheme, host, port, user: decodeURIComponent(user), password: decodeURIComponent(password) });
}

export function parseProxy(input: string): ProxyParse {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, error: 'Paste the proxy first.' };

  // A curl line: -x / --proxy for where, -U / --proxy-user for who.
  if (/^curl\b/i.test(text)) {
    const where = curlFlag(text, ['-x', '--proxy']);
    if (!where) return { ok: false, error: 'This curl line has no -x / --proxy part.' };
    const who = curlFlag(text, ['-U', '--proxy-user']);
    const base = parseUrlish(where);
    if (!base) {
      const port = where.match(/:([^:@/]*)\/?$/)?.[1];
      return {
        ok: false,
        error:
          port !== undefined && !/^\d+$/.test(port)
            ? `The port after the host should be a number, but it reads "${port}" (IPRoyal's is usually 12321).`
            : 'Could not read the -x part of the curl line.',
      };
    }
    if (!base.ok) return base;
    if (who && !base.proxy.user) {
      const i = who.indexOf(':');
      return finish({
        scheme: base.proxy.type,
        host: base.proxy.host,
        port: String(base.proxy.port),
        user: i >= 0 ? who.slice(0, i) : who,
        password: i >= 0 ? who.slice(i + 1) : '',
      });
    }
    return base;
  }

  const urlish = parseUrlish(text);
  if (urlish) return urlish;

  // host:port:user:pass — the password may itself contain ':'.
  const parts = text.split(':');
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    return finish({ host: parts[0], port: parts[1], user: parts[2], password: parts.slice(3).join(':') });
  }
  return { ok: false, error: 'Could not read that. Paste host:port:user:pass, user:pass@host:port, or the provider’s curl line.' };
}

/** host:port, with the user — never the password. For showing what was understood. */
export function describeProxy(p: ParsedProxy): string {
  return `${p.type}://${p.user ? `${p.user}@` : ''}${p.host}:${p.port}`;
}
