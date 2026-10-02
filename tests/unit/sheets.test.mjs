// The tracking sheet's pure half: settings, the row's prose, and the cells.
//
// The last test here is the important one. SHEET_COLUMNS exists twice — in
// TypeScript for the app and in plain Node for the agent that actually writes —
// because the agent cannot import TypeScript. Nothing at runtime would notice
// them drifting apart; a row would simply land under the wrong headers. So the
// two files are read from disk and compared.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  DEFAULT_TAB,
  mentionId,
  normaliseTabName,
  quoteTab,
  readSheetConfig,
  sheetRefusal,
  spreadsheetIdFrom,
  syncsKind,
} from '../../apps/web/src/modules/sheets/config.ts';
import {
  GROWTH_MIN,
  isBrandOpportunity,
  isGrowthOpportunity,
} from '../../apps/web/src/modules/reddit/opportunity.ts';
import {
  SHEET_COLUMNS,
  boundPayload,
  clamp,
  datePosted,
  describeReddit,
  describeShopify,
  MAX_DESCRIPTION_CHARS,
} from '../../apps/web/src/modules/sheets/row.ts';
import { rowValues, mentionId as agentMentionId, SHEET_COLUMNS as AGENT_COLUMNS, explain } from '../../apps/poster-agent/sheets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// The link an operator pastes
// ---------------------------------------------------------------------------

test('a spreadsheet id is found in whatever form the URL was copied in', () => {
  const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  assert.equal(spreadsheetIdFrom(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(spreadsheetIdFrom(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`), id);
  assert.equal(spreadsheetIdFrom(`https://docs.google.com/spreadsheets/d/${id}`), id);
  assert.equal(spreadsheetIdFrom(`  ${id}  `), id);
});

test('a link to something that is not a spreadsheet is refused, not guessed at', () => {
  // These fail LATER with an opaque Google error, which is why they fail here.
  assert.equal(spreadsheetIdFrom('https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74Og/edit'), null);
  assert.equal(spreadsheetIdFrom('https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74Og/view'), null);
  assert.equal(spreadsheetIdFrom(''), null);
  assert.equal(spreadsheetIdFrom('short'), null);
});

// ---------------------------------------------------------------------------
// Tab names and Mention IDs
// ---------------------------------------------------------------------------

test('a tab name is bounded and never empty', () => {
  assert.equal(normaliseTabName('  Posted replies  '), 'Posted replies');
  assert.equal(normaliseTabName('one\ntwo'), 'one two');
  assert.equal(normaliseTabName(''), DEFAULT_TAB);
  assert.equal(normaliseTabName('x'.repeat(300)).length, 100);
});

test("a tab name with an apostrophe still makes a valid range", () => {
  // A1 notation escapes ' by doubling it. Getting this wrong makes Sheets
  // answer "Unable to parse range", which reads like a bug in the tab name.
  assert.equal(quoteTab("Sayeed's rows"), "'Sayeed''s rows'");
  assert.equal(quoteTab('Posts'), "'Posts'");
});

test('a Mention ID needs a prefix — a bare number is not an id', () => {
  assert.equal(mentionId('RM292-1', 17), 'RM292-1-17');
  assert.equal(mentionId('RM292-1-', 17), 'RM292-1-17', 'a trailing hyphen is not doubled');
  assert.equal(mentionId('', 17), '', 'no scheme means an empty cell for a person to fill');
  assert.equal(mentionId('   ', 3), '');
});

test('the agent and the app number rows identically', () => {
  for (const [prefix, n] of [['RM292-1', 4], ['', 9], ['AB-', 1]]) {
    assert.equal(agentMentionId(prefix, n), mentionId(prefix, n));
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('settings default safely — off, and numbering from 1', () => {
  const cfg = readSheetConfig(undefined);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.spreadsheetId, '');
  assert.equal(cfg.tabName, DEFAULT_TAB);
  assert.equal(cfg.nextMention, 1);
});

test('a nonsense nextMention cannot make the counter go backwards or fractional', () => {
  assert.equal(readSheetConfig({ nextMention: 0 }).nextMention, 1);
  assert.equal(readSheetConfig({ nextMention: -5 }).nextMention, 1);
  assert.equal(readSheetConfig({ nextMention: 12.7 }).nextMention, 12);
  assert.equal(readSheetConfig({ nextMention: 'x' }).nextMention, 1);
});

test('nothing is logged until somebody both turns it on and links a sheet', () => {
  assert.match(sheetRefusal(readSheetConfig({ enabled: false, spreadsheetId: 'abc' })), /off/i);
  assert.match(sheetRefusal(readSheetConfig({ enabled: true, spreadsheetId: '' })), /No spreadsheet/i);
  assert.equal(sheetRefusal(readSheetConfig({ enabled: true, spreadsheetId: 'abc' })), null);
});


// ---------------------------------------------------------------------------
// Brand vs growth — which replies the sheet carries
// ---------------------------------------------------------------------------

const analysis = (over = {}) => ({
  decision: 'reply',
  mentionRecommendation: 'yes',
  growthScore: 80,
  ...over,
});

test('a soft mention is a BRAND reply', () => {
  // "soft" is what the draft was asked to do. Whether the model found a natural
  // place for the name is a property of that one draft, not of the opportunity
  // — and the screen's "Brand opportunities" tab counts it the same way.
  assert.equal(isBrandOpportunity(analysis({ mentionRecommendation: 'soft' })), true);
  assert.equal(isBrandOpportunity(analysis({ mentionRecommendation: 'yes' })), true);
  assert.equal(isBrandOpportunity(analysis({ mentionRecommendation: 'no' })), false);
});

test('a skipped post is never a brand reply, whatever the mention says', () => {
  assert.equal(isBrandOpportunity(analysis({ decision: 'skip', mentionRecommendation: 'yes' })), false);
});

test('growth means the analysis said do NOT name the client', () => {
  // Structural: this equivalence is what stops a growth reply pitching the
  // client, and the sheet filter leans on the same rule.
  assert.equal(isGrowthOpportunity(analysis({ mentionRecommendation: 'no', growthScore: GROWTH_MIN })), true);
  assert.equal(isGrowthOpportunity(analysis({ mentionRecommendation: 'no', growthScore: GROWTH_MIN - 1 })), false);
  assert.equal(isGrowthOpportunity(analysis({ mentionRecommendation: 'soft', growthScore: 99 })), false);
});

test('a brand reply always reaches the sheet, on either setting', () => {
  assert.equal(syncsKind({ includeGrowth: true }, 'brand'), true);
  assert.equal(syncsKind({ includeGrowth: false }, 'brand'), true);
});

test('a growth reply reaches the sheet only when growth is switched on', () => {
  assert.equal(syncsKind({ includeGrowth: true }, 'growth'), true);
  assert.equal(syncsKind({ includeGrowth: false }, 'growth'), false);
});

test('a sheet configured before this setting existed still records everything', () => {
  // Silently narrowing an existing sheet would look like rows had gone missing.
  assert.equal(readSheetConfig({ enabled: true, spreadsheetId: 'x' }).includeGrowth, true);
  assert.equal(readSheetConfig({ includeGrowth: false }).includeGrowth, false);
  assert.equal(readSheetConfig({ includeGrowth: true }).includeGrowth, true);
});

// ---------------------------------------------------------------------------
// The analysis, as prose
// ---------------------------------------------------------------------------

test('a Reddit description reports BOTH axes, not only the brand verdict', () => {
  // A thread can be "skip" on brand and excellent for growth — that pairing is
  // the reason some replies exist at all, and a row showing only the skip would
  // read as a mistake.
  const text = describeReddit({
    decision: 'skip',
    score: 12,
    reason: 'Nothing here touches what the client sells.',
    suggestedAngle: '',
    riskLevel: 'low',
    mentionRecommendation: 'no',
    growthScore: 74,
    growthAngle: 'Answer the deposit-limit question plainly.',
  });
  assert.match(text, /skip — 12\/100/);
  assert.match(text, /Growth: 74\/100 — Answer the deposit-limit question plainly\./);
  assert.match(text, /do not name the client/);
  assert.ok(!/Angle:/.test(text), 'an empty angle is left out rather than printed blank');
});

test('an older Reddit analysis with no growth score still describes cleanly', () => {
  const text = describeReddit({
    decision: 'reply',
    score: 80,
    reason: 'Directly about payout times.',
    suggestedAngle: 'Share real timings.',
    riskLevel: 'medium',
    mentionRecommendation: 'soft',
  });
  assert.ok(!text.includes('Growth'));
  assert.match(text, /name the client only if it fits/);
});

test('a Shopify description leads with the mode that was actually drafted', () => {
  const assessment = {
    question: 'How do I stop duplicate variants syncing?',
    askerContext: 'A small merchant with two staff.',
    needs: 'Exact steps, no app pitch.',
    scores: {
      open: { score: 5, why: 'Generic.', angle: '' },
      growth: { score: 8, why: 'No working answer yet.', angle: 'Give the exact fix.' },
      brand: { score: 2, why: 'Nothing to cite.', angle: '', sourceIds: [] },
    },
    suggested: 'growth',
    confidence: 0.8,
  };
  const text = describeShopify(assessment, 'growth');
  assert.match(text, /^Reply: growth — scored 8\/10 \(open 5\/10, brand 2\/10\)/);
  assert.match(text, /Why this mode: No working answer yet\./);
  assert.match(text, /Angle: Give the exact fix\./);
  // The modes NOT chosen contribute their score and nothing else — otherwise
  // the cell is three paragraphs of reasoning about replies nobody sent.
  assert.ok(!text.includes('Generic.'));
  assert.ok(!text.includes('Nothing to cite.'));
});

test('a description is capped, and says that it was', () => {
  const long = 'x'.repeat(20_000);
  const text = describeReddit({
    decision: 'reply', score: 50, reason: long, suggestedAngle: '',
    riskLevel: 'low', mentionRecommendation: 'no',
  });
  assert.ok(text.length <= MAX_DESCRIPTION_CHARS);
  assert.ok(text.endsWith('…'));
});

test('clamp leaves anything already short exactly as it is', () => {
  assert.equal(clamp('  hello  ', 100), 'hello');
  assert.equal(clamp('abcdef', 4), 'abc…');
});

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

test('the date columns match the shape the sheet already holds', () => {
  const { month, date } = datePosted(Date.UTC(2025, 10, 18, 12, 0, 0), 'UTC');
  assert.equal(month, 'November');
  assert.equal(date, '11/18/25');
});

test('the cells land under the right headers', () => {
  const values = rowValues({
    payload: {
      postType: 'Comment',
      board: 'r/gambling',
      contentDescription: 'Verdict: reply',
      originalTitle: 'Best payout times?',
      originalBody: 'Been waiting three days.',
      commentText: 'Mine clear in about 20 minutes.',
    },
    mention: 'RM292-1-17',
    postedAtMs: new Date(2025, 10, 18, 9, 0, 0).getTime(),
    permalink: 'https://reddit.com/r/gambling/comments/abc/x/def',
  });

  assert.equal(values.length, SHEET_COLUMNS.length);
  const row = Object.fromEntries(SHEET_COLUMNS.map((c, i) => [c, values[i]]));
  assert.equal(row['Month'], 'November');
  assert.equal(row['Mention ID'], 'RM292-1-17');
  assert.equal(row['Date Posted'], '11/18/25');
  assert.equal(row['Post Type'], 'Comment');
  assert.equal(row['Board/Subreddit'], 'r/gambling');
  assert.equal(row['Content Description'], 'Verdict: reply');
  assert.equal(row['Content URL'], 'https://reddit.com/r/gambling/comments/abc/x/def');
  assert.equal(row['Comment/Text'], 'Mine clear in about 20 minutes.');
  assert.equal(row['Original Post Title'], 'Best payout times?');
  assert.equal(row['Original Post Body'], 'Been waiting three days.');
});

test('a row is all strings, even where the payload is missing fields', () => {
  const values = rowValues({ payload: {}, mention: '', postedAtMs: Date.now(), permalink: '' });
  assert.equal(values.length, SHEET_COLUMNS.length);
  for (const v of values) assert.equal(typeof v, 'string');
  assert.equal(values[3], 'Comment', 'Post Type falls back rather than going out blank');
});

test('a reply that starts with = is carried through as text, not a formula', () => {
  // The defence is valueInputOption: RAW in sheets.mjs — asserted there. Here:
  // the cell itself is never rewritten or escaped on the way, so what a person
  // approved is what the sheet shows.
  const text = '=SUM(A1:A9) is what the merchant asked about';
  const values = rowValues({ payload: { commentText: text }, mention: '', postedAtMs: Date.now(), permalink: '' });
  assert.equal(values[7], text);
});

test('the payload is bounded once, before it is stored on the job', () => {
  const p = boundPayload({
    platform: 'reddit',
    kind: 'brand',
    postType: '',
    board: 'r/x',
    contentDescription: 'a'.repeat(50_000),
    originalTitle: 't'.repeat(2000),
    originalBody: 'b'.repeat(50_000),
    commentText: 'c'.repeat(50_000),
  });
  assert.equal(p.postType, 'Comment');
  assert.equal(p.originalTitle.length, 500);
  // Google's own ceiling is 50,000 per cell; every field is well under it.
  for (const v of Object.values(p)) assert.ok(String(v).length <= 8000);
});

// ---------------------------------------------------------------------------
// Google's errors, and the two column lists
// ---------------------------------------------------------------------------

test('a 403 is turned into the action that fixes it', () => {
  const msg = explain(403, JSON.stringify({ error: { message: 'The caller does not have permission' } }), 'bot@x.iam.gserviceaccount.com');
  assert.match(msg, /not shared with bot@x\.iam\.gserviceaccount\.com/);
  assert.match(msg, /Share/);
});

test('a 404 says the file is gone rather than repeating an id', () => {
  assert.match(explain(404, '{}', 'bot@x'), /No spreadsheet with that id/);
});

test('the agent and the app agree on the columns, in order', () => {
  assert.deepEqual(AGENT_COLUMNS, [...SHEET_COLUMNS]);
});

test('neither column list can be edited without the other', () => {
  // deepEqual above compares what the modules EXPORT. This compares the source
  // text, so a list rebuilt at runtime from the other one — which would make
  // the check above vacuous — is caught too.
  const listIn = (file, name) => {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    const body = src.slice(src.indexOf(`${name} = [`));
    return [...body.slice(0, body.indexOf(']')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };
  const app = listIn('apps/web/src/modules/sheets/row.ts', 'export const SHEET_COLUMNS');
  const agent = listIn('apps/poster-agent/sheets.mjs', 'export const SHEET_COLUMNS');
  assert.ok(app.length >= 10, 'the app list was not found in the source');
  assert.deepEqual(agent, app);
});

// ---------------------------------------------------------------------------
// The Google calls, with fetch injected
//
// A throwaway RSA key signs the JWT so google-auth-library will build a client;
// nothing here reaches the network, and every request is answered by hand.
// ---------------------------------------------------------------------------

import { createSheets } from '../../apps/poster-agent/sheets.mjs';

const KEY = { client_email: 'engage@motherlink-engage.iam.gserviceaccount.com', private_key: 'unused' };
// The signing half is injected, not faked at the network layer:
// google-auth-library fetches its token through gaxios, so a stubbed global
// fetch would not catch it and a unit test would call Google to sign in.
const AUTH = { getAccessToken: async () => ({ token: 'test-token' }) };

/** A sheets client whose every request is answered from `routes`, in order. */
function stubbed(routes) {
  const seen = [];
  const api = createSheets({
    serviceAccount: KEY,
    auth: AUTH,
    fetchImpl: async (url, init) => {
      seen.push({ url: new URL(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
      const next = routes.shift();
      if (!next) throw new Error(`unexpected request: ${init.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
    },
  });
  return { api, seen };
}

test('every request is signed with the service account\u2019s token', async () => {
  let authHeader = null;
  const api = createSheets({
    serviceAccount: KEY,
    auth: AUTH,
    fetchImpl: async (_url, init) => {
      authHeader = init.headers.Authorization;
      return new Response('{}');
    },
  });
  await api.append('SS', 'Posts', ['a']);
  assert.equal(authHeader, 'Bearer test-token');
});

test('an append is RAW and inserts rows — never parsed, never overwriting', async () => {
  // RAW is the whole defence against a reply that starts with "=" becoming a
  // formula in a spreadsheet we do not own.
  const { api, seen } = stubbed([{ body: { updates: { updatedRange: "'Posts'!A9" } } }]);
  await api.append('SS', 'Posts', ['a', 'b']);

  const req = seen[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url.searchParams.get('valueInputOption'), 'RAW');
  assert.equal(req.url.searchParams.get('insertDataOption'), 'INSERT_ROWS');
  assert.match(decodeURIComponent(req.url.pathname), /'Posts'!A:J:append$/);
  assert.deepEqual(req.body.values, [['a', 'b']]);
});

test('a header is written only into an empty A1', async () => {
  const { api, seen } = stubbed([{ body: { values: [] } }, { body: {} }]);
  assert.equal(await api.ensureHeader('SS', 'Posts'), true);
  assert.equal(seen[1].method, 'PUT');
  assert.deepEqual(seen[1].body.values[0], AGENT_COLUMNS);
});

test("a header is NEVER rewritten over somebody's own column names", async () => {
  // Renaming a column is a person saying how they use this sheet. A header we
  // rewrote every run would say it back at them once a day.
  const { api, seen } = stubbed([{ body: { values: [['Month', 'Ref no.', 'Posted']] } }]);
  assert.equal(await api.ensureHeader('SS', 'Posts'), false);
  assert.equal(seen.length, 1, 'it read, and wrote nothing');
});

test('an existing tab is not created a second time', async () => {
  const { api, seen } = stubbed([{ body: { sheets: [{ properties: { title: 'Posts' } }] } }]);
  assert.equal(await api.ensureTab('SS', 'Posts'), false);
  assert.equal(seen.length, 1);
});

test('a missing tab is created', async () => {
  const { api, seen } = stubbed([{ body: { sheets: [{ properties: { title: 'Sheet1' } }] } }, { body: {} }]);
  assert.equal(await api.ensureTab('SS', 'Posts'), true);
  assert.equal(seen[1].body.requests[0].addSheet.properties.title, 'Posts');
});

test('a tab name with an apostrophe survives the round trip to a range', async () => {
  const { api, seen } = stubbed([{ body: { values: [['RM292-1-1'], ['RM292-1-2']] } }]);
  const col = await api.column('SS', "Sayeed's rows", 'B');
  assert.deepEqual(col, ['RM292-1-1', 'RM292-1-2']);
  assert.match(decodeURIComponent(seen[0].url.pathname), /'Sayeed''s rows'!B:B$/);
});

test('a 403 from the API surfaces as the share instruction, not a status code', async () => {
  const { api } = stubbed([{ status: 403, body: { error: { message: 'The caller does not have permission' } } }]);
  await assert.rejects(api.append('SS', 'Posts', ['a']), /not shared with engage@motherlink-engage/);
});

test('a request that hangs is cut off and says so', async () => {
  // Unbounded, this would hold one of the agent's posting slots forever.
  const api = createSheets({
    serviceAccount: KEY,
    auth: AUTH,
    timeoutMs: 30,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        // AbortSignal.timeout's own timer does not hold the event loop open, so
        // without a ref'd timer here the test process drains before it fires.
        const keepAlive = setTimeout(() => {}, 5000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason);
        });
      }),
  });
  await assert.rejects(api.append('SS', 'Posts', ['a']), /did not answer within/);
});
