// The proxy list: reading a pasted list, flags, places and the copy formats.
// Passwords here are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  curlFor,
  flagOf,
  isUsed,
  parsePoolList,
  placeOf,
  poolKey,
  proxyFormats,
  statusOf,
  proxyUrl,
  readIpInfo,
} from '../../apps/web/src/modules/accounts/proxyPool.ts';

test('a pasted list reads one proxy per line, keeping https', () => {
  const { proxies, errors } = parsePoolList(
    'https://user1:Ab~12@isp.decodo.com:10001\n\n"https://user1:Ab~12@isp.decodo.com:10002"\r\nhttps://user1:Ab~12@isp.decodo.com:10001',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(proxies.map((p) => [p.type, p.port, p.password]), [['https', 10001, 'Ab~12'], ['https', 10002, 'Ab~12']]);
});

test('unreadable lines are reported by number and do not stop the rest', () => {
  const { proxies, errors } = parsePoolList('nonsense here\nhttps://u:p@isp.decodo.com:10003');
  assert.equal(proxies.length, 1);
  assert.equal(errors[0].line, 1);
});

test('the key ignores host case', () => {
  assert.equal(poolKey('ISP.Decodo.com', 10004), 'isp.decodo.com:10004');
});

test('two-letter countries get a flag, anything else none', () => {
  assert.equal(flagOf('us'), '🇺🇸');
  assert.equal(flagOf('DE'), '🇩🇪');
  assert.equal(flagOf(''), '');
  assert.equal(flagOf('USA'), '');
});

test('a place is the city, then the region when it differs', () => {
  assert.equal(placeOf({ city: 'Boston', region: 'Massachusetts', country: 'US' }), 'Boston, Massachusetts');
  assert.equal(placeOf({ city: 'Paris', region: 'Paris', country: 'FR' }), 'Paris');
  assert.equal(placeOf({ city: '', region: '', country: 'NL' }), 'NL');
  assert.equal(placeOf(null), '');
});

test('used means an account, an AdsPower profile, or a note', () => {
  assert.equal(isUsed({ note: '', usedBy: [] }), false);
  assert.equal(isUsed({ note: '  ', usedBy: [] }), false);
  assert.equal(isUsed({ note: 'Facebook page', usedBy: [] }), true);
  assert.equal(isUsed({ note: '', usedBy: [{ accountId: 'a', label: 'A' }] }), true);
  assert.equal(isUsed({ note: '', usedBy: [], profiles: [{ id: 'k9', name: 'side profile' }] }), true);
  assert.equal(isUsed({ note: '', usedBy: [], profiles: [] }), false);
});

test('the copies are the URL the account form reads and a working curl', () => {
  const p = { type: 'https', host: 'isp.decodo.com', port: 10004, user: 'u1', password: 'Ab~12' };
  assert.equal(proxyUrl(p), 'https://u1:Ab~12@isp.decodo.com:10004');
  assert.equal(curlFor(p), 'curl -x https://isp.decodo.com:10004 -U "u1:Ab~12" https://ipinfo.io/json');
  assert.equal(curlFor({ ...p, type: 'socks5' }).startsWith('curl -x socks5h://'), true);
});

test('only a real ipinfo answer is read', () => {
  assert.equal(readIpInfo({ error: 'x' }), null);
  assert.deepEqual(readIpInfo({ ip: '1.2.3.4', country: 'US', city: 'Boston' }), {
    ip: '1.2.3.4',
    country: 'US',
    region: '',
    city: 'Boston',
    org: '',
    timezone: '',
  });
});

test('one proxy copies in all three protocols, same host and port', () => {
  const f = proxyFormats({ host: 'isp.decodo.com', port: 10004, user: 'u1', password: 'Ab~12' });
  assert.equal(f.https.url, 'https://u1:Ab~12@isp.decodo.com:10004');
  assert.equal(f.http.url, 'http://u1:Ab~12@isp.decodo.com:10004');
  assert.equal(f.socks5.url, 'socks5://u1:Ab~12@isp.decodo.com:10004');
  assert.equal(f.socks5.curl, 'curl -x socks5h://isp.decodo.com:10004 -U "u1:Ab~12" https://ipinfo.io/json');
});

test('disposed wins over everything, then used, then free', () => {
  const base = { note: '', usedBy: [], profiles: [] };
  assert.equal(statusOf(base), 'free');
  assert.equal(statusOf({ ...base, note: 'elsewhere' }), 'used');
  assert.equal(statusOf({ ...base, disposed: true }), 'disposed');
  assert.equal(statusOf({ ...base, usedBy: [{ accountId: 'a', label: 'A' }], disposed: true }), 'disposed');
});
