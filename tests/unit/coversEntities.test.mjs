// What a post is about — teams, fixture, and the numbers it quotes.
//
// The strings here are betting-forum English, not sentences invented to suit the
// regexes: "took Sea -3.5 at -110", "SEA/SF o47.5", "the sea was rough". The
// last one is the point of the whole corroboration rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractEntities,
  mergeEntities,
  NO_CALENDAR,
} from '../../apps/web/src/modules/covers/entities.ts';
import { aliasIndex, hasLexicon, teamLabel } from '../../apps/web/src/modules/covers/teams.ts';

// ---------------------------------------------------------------------------
// The lexicon
// ---------------------------------------------------------------------------

test('a league we do not know says so, rather than returning no teams quietly', () => {
  assert.equal(hasLexicon('nfl'), true);
  assert.equal(hasLexicon('ncaaf'), false);
  assert.equal(hasLexicon(null), false);

  const e = extractEntities('Bama -7 over Auburn', 'ncaaf');
  assert.equal(e.lexicon, false, 'the caller must be able to tell unknown from absent');
  assert.deepEqual(e.teams, []);
  // A number is still a number even where the team names mean nothing to us.
  assert.equal(e.lines.length, 1);
  assert.equal(e.lines[0].value, -7);
});

test('an alias naming two teams in the same league is dropped, not guessed', () => {
  const nfl = aliasIndex('nfl');
  const aliases = new Set(nfl.map((a) => a.alias));

  assert.ok(!aliases.has('new york'), 'Giants and Jets both answer to it');
  assert.ok(!aliases.has('los angeles'), 'Rams and Chargers both answer to it');
  assert.ok(aliases.has('new york giants'));
  assert.ok(aliases.has('giants'));

  const mlb = new Set(aliasIndex('mlb').map((a) => a.alias));
  assert.ok(!mlb.has('chicago'), 'Cubs and White Sox both answer to it');
  assert.ok(mlb.has('cubs'));
});

test('the same nickname in two leagues is not a collision — the section says which', () => {
  const mlb = extractEntities('Rangers -1.5 tonight', 'mlb');
  const nhl = extractEntities('Rangers -1.5 tonight', 'nhl');
  assert.deepEqual(mlb.teams, ['mlb:tex']);
  assert.deepEqual(nhl.teams, ['nhl:nyr']);
});

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

test('the longest name wins, so New York Giants is one team and not two readings', () => {
  const e = extractEntities('New York Giants +7 looks live', 'nfl');
  assert.deepEqual(e.teams, ['nfl:nyg']);
});

test('an abbreviation is believed when it is written like one', () => {
  // All caps: nobody shouts a preposition.
  assert.deepEqual(extractEntities('took SEA -3.5 last night', 'nfl').teams, ['nfl:sea']);
  // Or sitting against a number.
  assert.deepEqual(extractEntities('Sea -3.5 for me', 'nfl').teams, ['nfl:sea']);
  assert.deepEqual(extractEntities('Seahawks and SF both looked bad', 'nfl').teams, [
    'nfl:sea',
    'nfl:sf',
  ]);
});

test('English is not a team, however many betting words surround it', () => {
  // ⚠️ THE REGRESSION FROM THE FIRST LIVE RUN. This exact headline became a
  // "New Orleans at Washington" fixture: `no` from "now", `was` from "was", both
  // waved through because the post mentioned odds — and on a betting forum every
  // post mentions odds.
  const e = extractEntities(
    'Odds shark is joining covers! You can now find the latest computer picks, and it was a long time coming.',
    'nfl',
  );
  assert.deepEqual(e.teams, []);
  assert.equal(e.fixture, null);

  assert.deepEqual(extractEntities('the sea was rough all week', 'nfl').teams, []);
  assert.deepEqual(
    extractEntities('No idea what happens here, taking the over', 'nfl').teams,
    [],
    'a capital at the start of a sentence is not a team code',
  );
});

test('a rejected abbreviation does not survive as a line attachment', () => {
  const e = extractEntities('no idea, took the over 44', 'nfl');
  assert.deepEqual(e.teams, []);
  assert.ok(e.lines.every((l) => l.teamKey === null));
});

test('a full name is believed on its own, with no line anywhere near it', () => {
  const e = extractEntities('Anyone watching the Maple Leafs lately?', 'nhl');
  assert.deepEqual(e.teams, ['nhl:tor']);
  assert.equal(teamLabel('nhl:tor'), 'Toronto Maple Leafs');
});

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

test('a price is called a price, because -110 juice and -140 moneyline read alike', () => {
  const e = extractEntities('Seattle -3.5 at -110, Detroit ML +150', 'nfl');
  const kinds = e.lines.map((l) => l.kind);
  assert.ok(kinds.includes('spread'));
  assert.equal(kinds.filter((k) => k === 'price').length, 2);
  assert.ok(!kinds.includes('moneyline'), 'a guess must not harden into a stored fact');

  const spread = e.lines.find((l) => l.kind === 'spread');
  assert.equal(spread.value, -3.5);
  assert.equal(spread.teamKey, 'nfl:sea', 'the team written before the number owns it');
});

test('totals are read in both notations, with their side', () => {
  const short = extractEntities('SEA/SF o47.5 for me', 'nfl');
  const long = extractEntities('taking under 2.5 goals', 'nhl');

  const t1 = short.lines.find((l) => l.kind === 'total');
  assert.equal(t1.value, 47.5);
  assert.equal(t1.side, 'over');

  const t2 = long.lines.find((l) => l.kind === 'total');
  assert.equal(t2.value, 2.5);
  assert.equal(t2.side, 'under');
});

test('a number after the team is attached too, in the order bettors write', () => {
  const e = extractEntities('+7 Jets is free money', 'nfl');
  const spread = e.lines.find((l) => l.kind === 'spread');
  assert.equal(spread.value, 7);
  assert.equal(spread.teamKey, 'nfl:nyj');
});

test('a number far from any team keeps no team', () => {
  const e = extractEntities(
    'Seahawks looked awful and I have said that for weeks now honestly, anyway -3.5',
    'nfl',
  );
  const spread = e.lines.find((l) => l.kind === 'spread');
  assert.equal(spread.teamKey, null, 'sixty characters away is not "attached"');
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

test('two teams make a fixture; one or ten do not', () => {
  const game = extractEntities('Seahawks at 49ers, took the under', 'nfl');
  assert.equal(game.fixture.key, 'nfl:sea+sf');
  assert.equal(game.fixture.away, 'nfl:sea', '"at" says who travels');
  assert.equal(game.fixture.home, 'nfl:sf');

  const one = extractEntities('Seahawks -3.5', 'nfl');
  assert.equal(one.fixture, null);

  const many = extractEntities('Bills, Jets, Eagles, Lions all on my card', 'nfl');
  assert.equal(many.fixture, null, 'a card is not a game');
});

test('"vs" does not settle who is at home, and nothing pretends it does', () => {
  const e = extractEntities('Rams vs Cowboys tonight', 'nfl');
  assert.equal(e.fixture.key, 'nfl:dal+lar');
  assert.equal(e.fixture.home, null);
  assert.equal(e.fixture.away, null);
});

test('the fixture key does not depend on which team was named first', () => {
  const a = extractEntities('Seahawks at 49ers', 'nfl').fixture.key;
  const b = extractEntities('49ers hosting Seahawks', 'nfl').fixture.key;
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// Merging, and kickoff
// ---------------------------------------------------------------------------

test('the title decides the fixture, not a passing mention in post nine', () => {
  const title = extractEntities('Seahawks at 49ers game thread', 'nfl');
  const stray = extractEntities('meanwhile the Bills at Jets total is way too high', 'nfl');

  const merged = mergeEntities([title, stray]);
  assert.equal(merged.fixture.key, 'nfl:sea+sf');
  assert.ok(merged.teams.includes('nfl:buf'), 'the stray teams are still recorded');
});

test('a card of six games gets no fixture from the one post that named two teams', () => {
  // ⚠️ THE OTHER REGRESSION FROM THE FIRST LIVE RUN. "Dk nfl preseason week 3"
  // was filed under Baltimore-at-Washington because a single post inside it
  // named exactly those two. A card is not a game.
  const title = extractEntities('Dk nfl preseason week 3', 'nfl');
  const posts = [
    extractEntities('Ravens at Commanders -2.5, we usually own Washington in preseason', 'nfl'),
    extractEntities('Broncos -4.5 over the Saints', 'nfl'),
    extractEntities('Bucs -1.5 and the Jaguars total', 'nfl'),
  ];

  const merged = mergeEntities([title, ...posts]);
  assert.equal(merged.fixture, null, 'no title fixture and more than two teams means unknown');
  assert.ok(merged.teams.length > 2);
});

test('a thread that only ever mentions two teams is that game, title or not', () => {
  const merged = mergeEntities([
    extractEntities('who do we like tonight', 'nfl'),
    extractEntities('Seahawks looked sharp', 'nfl'),
    extractEntities('49ers -3 is too many points', 'nfl'),
  ]);
  assert.equal(merged.fixture.key, 'nfl:sea+sf');
  assert.equal(merged.fixture.home, null, 'nobody said who travels');
});

test('kickoff is unknown in V1 and the seam says so out loud', async () => {
  const fixture = extractEntities('Seahawks at 49ers', 'nfl').fixture;
  assert.equal(await NO_CALENDAR.kickoffFor(fixture, Date.now()), null);
});
