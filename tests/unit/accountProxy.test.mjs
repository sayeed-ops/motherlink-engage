// The account form's proxy box: everything the providers hand out reads the same.
// Passwords here are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseProxy, describeProxy } from '../../apps/web/src/modules/accounts/proxy.ts';

const ok = (s) => {
  const r = parseProxy(s);
  assert.equal(r.ok, true, r.error);
  return r.proxy;
};

test('a Decodo curl line: -U for the login, -x for host and port', () => {
  const p = ok('curl -U "spxuser:Ab12~cd:ef" -x "isp.decodo.com:10001" "https://ip.decodo.com/json?provider=IPinfo"');
  assert.deepEqual(
    { type: p.type, host: p.host, port: p.port, user: p.user, password: p.password, provider: p.provider, rotating: p.rotating },
    { type: 'http', host: 'isp.decodo.com', port: 10001, user: 'spxuser', password: 'Ab12~cd:ef', provider: 'decodo', rotating: false },
  );
});

test('host:port:user:pass, with a colon in the password', () => {
  const p = ok('45.12.3.4:12323:alice:pa:ss');
  assert.deepEqual([p.host, p.port, p.user, p.password, p.provider], ['45.12.3.4', 12323, 'alice', 'pa:ss', 'other']);
});

test('user:pass@host:port and a socks5 URL', () => {
  const a = ok('alice:secret@geo.iproyal.com:12321');
  assert.deepEqual([a.type, a.host, a.user, a.provider], ['http', 'geo.iproyal.com', 'alice', 'iproyal']);
  const b = ok('socks5://bob:pw@1.2.3.4:1080');
  assert.deepEqual([b.type, b.host, b.port, b.user, b.password], ['socks5', '1.2.3.4', 1080, 'bob', 'pw']);
});

test('IPRoyal geo without a session rotates; with _session- it is sticky', () => {
  assert.equal(ok('geo.iproyal.com:12321:alice:pw_country-us').rotating, true);
  assert.equal(ok('geo.iproyal.com:12321:alice:pw_country-us_session-abc123_lifetime-30m').rotating, false);
});

test('Decodo gate on port 7000 rotates; ISP ports do not', () => {
  assert.equal(ok('gate.decodo.com:7000:user:pw').rotating, true);
  assert.equal(ok('isp.decodo.com:10001:user:pw').rotating, false);
});

test('a curl line whose -x already carries the login and scheme', () => {
  const p = ok('curl --proxy socks5h://u:p@9.9.9.9:4000 https://ipinfo.io');
  assert.deepEqual([p.type, p.host, p.port, p.user, p.password], ['socks5', '9.9.9.9', 4000, 'u', 'p']);
});

test('unreadable input says why, and the description never shows the password', () => {
  assert.equal(parseProxy('').ok, false);
  assert.equal(parseProxy('not a proxy').ok, false);
  assert.equal(parseProxy('ftp://1.2.3.4:21').ok, false);
  assert.equal(describeProxy(ok('1.2.3.4:8080:me:topsecret')).includes('topsecret'), false);
});

// ---- The AdsPower create body ----

import { adsPowerCreateBody, uaSystemVersions } from '../../apps/web/src/modules/accounts/profileSpec.ts';

test('only Windows and Mac are ever offered, and "any" means both', () => {
  const all = uaSystemVersions('any');
  assert.ok(all.every((v) => v.startsWith('Windows') || v.startsWith('Mac OS X')));
  assert.ok(uaSystemVersions('windows').every((v) => v.startsWith('Windows')));
  assert.ok(uaSystemVersions('mac').every((v) => v.startsWith('Mac OS X')));
});

test('the create body: proxy as typed, fingerprint follows the IP, newest browser of the chosen kind', () => {
  const body = adsPowerCreateBody(
    { name: 'Growth – budgetlee', groupId: '42', browser: 'firefox', os: 'mac', remark: 'login: x / recovery: y' },
    ok('isp.decodo.com:10001:spx:pw'),
  );
  assert.deepEqual(body.user_proxy_config, {
    proxy_soft: 'other', proxy_type: 'http', proxy_host: 'isp.decodo.com', proxy_port: '10001', proxy_user: 'spx', proxy_password: 'pw',
  });
  assert.equal(body.group_id, '42');
  assert.equal(body.remark, 'login: x / recovery: y');
  const fp = body.fingerprint_config;
  assert.deepEqual([fp.automatic_timezone, fp.location_switch, fp.language_switch, fp.webrtc], ['1', '1', '1', 'proxy']);
  assert.deepEqual(fp.browser_kernel_config, { type: 'firefox', version: 'ua_auto' });
  assert.ok(fp.random_ua.ua_system_version.every((v) => v.startsWith('Mac OS X')));
});

test("IPRoyal's curl line: the session and lifetime stay in the password, and it is sticky", () => {
  const p = ok('curl -v -x http://User123:Pw_country-us_city-chicago_session-lvCoBFhj_lifetime-59m@geo.iproyal.com:12321 -L https://ipv4.icanhazip.com');
  assert.deepEqual([p.host, p.port, p.user, p.password, p.provider, p.rotating],
    ['geo.iproyal.com', 12321, 'User123', 'Pw_country-us_city-chicago_session-lvCoBFhj_lifetime-59m', 'iproyal', false]);
});

test('a curl line with a word where the port should be says so', () => {
  const r = parseProxy('curl -v -x http://u:p@geo.iproyal.com:pass -L https://ipv4.icanhazip.com');
  assert.equal(r.ok, false);
  assert.match(r.error, /port .* "pass"/);
});
