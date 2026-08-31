// Who plays in the leagues Covers talks about.
//
// PURE DATA plus the index built from it. Entity extraction (./entities.ts) is
// the logic; this is the vocabulary it reads with.
//
// ════════════════════════════════════════════════════════════════════════════
// FOUR LEAGUES, AND SILENCE ABOUT THE REST — DELIBERATELY
//
// The lexicon covers NFL, NBA, MLB and NHL. It does NOT cover college football,
// college basketball, soccer or tennis, and those sections will therefore yield
// no teams at all.
//
// That is a decision, not an omission. NCAAF alone is ~130 teams whose short
// names are ordinary words ("Miami", "Army", "Rice", "Auburn"), and a lexicon
// that half-knows a league produces confident wrong answers — "Rice" in a post
// about rice. `hasLexicon()` exists so a caller can tell "nobody named a team"
// apart from "we do not know this league's teams", which is the same
// honest-unknown rule the reader follows about scores it cannot see.
// ════════════════════════════════════════════════════════════════════════════

export interface Team {
  /** `nfl:sea` — stable across renames of the display fields. */
  key: string;
  sport: string;
  city: string;
  nickname: string;
  /** The abbreviation a bettor types. Matched WEAKLY — see entities.ts. */
  abbr: string;
  /** Extra spellings that are not derivable: nicknames-of-nicknames, old
   *  names still in daily use, punctuation-free forms. */
  extra?: string[];
}

const NFL: Omit<Team, 'key' | 'sport'>[] = [
  { city: 'Arizona', nickname: 'Cardinals', abbr: 'ARI', extra: ['cards'] },
  { city: 'Atlanta', nickname: 'Falcons', abbr: 'ATL' },
  { city: 'Baltimore', nickname: 'Ravens', abbr: 'BAL' },
  { city: 'Buffalo', nickname: 'Bills', abbr: 'BUF' },
  { city: 'Carolina', nickname: 'Panthers', abbr: 'CAR' },
  { city: 'Chicago', nickname: 'Bears', abbr: 'CHI' },
  { city: 'Cincinnati', nickname: 'Bengals', abbr: 'CIN' },
  { city: 'Cleveland', nickname: 'Browns', abbr: 'CLE' },
  { city: 'Dallas', nickname: 'Cowboys', abbr: 'DAL' },
  { city: 'Denver', nickname: 'Broncos', abbr: 'DEN' },
  { city: 'Detroit', nickname: 'Lions', abbr: 'DET' },
  { city: 'Green Bay', nickname: 'Packers', abbr: 'GB', extra: ['packs'] },
  { city: 'Houston', nickname: 'Texans', abbr: 'HOU' },
  { city: 'Indianapolis', nickname: 'Colts', abbr: 'IND', extra: ['indy'] },
  { city: 'Jacksonville', nickname: 'Jaguars', abbr: 'JAX', extra: ['jags'] },
  { city: 'Kansas City', nickname: 'Chiefs', abbr: 'KC' },
  { city: 'Las Vegas', nickname: 'Raiders', abbr: 'LV' },
  { city: 'Los Angeles', nickname: 'Chargers', abbr: 'LAC', extra: ['bolts'] },
  { city: 'Los Angeles', nickname: 'Rams', abbr: 'LAR' },
  { city: 'Miami', nickname: 'Dolphins', abbr: 'MIA', extra: ['fins'] },
  { city: 'Minnesota', nickname: 'Vikings', abbr: 'MIN', extra: ['vikes'] },
  { city: 'New England', nickname: 'Patriots', abbr: 'NE', extra: ['pats'] },
  { city: 'New Orleans', nickname: 'Saints', abbr: 'NO' },
  { city: 'New York', nickname: 'Giants', abbr: 'NYG' },
  { city: 'New York', nickname: 'Jets', abbr: 'NYJ' },
  { city: 'Philadelphia', nickname: 'Eagles', abbr: 'PHI', extra: ['philly'] },
  { city: 'Pittsburgh', nickname: 'Steelers', abbr: 'PIT' },
  { city: 'San Francisco', nickname: '49ers', abbr: 'SF', extra: ['niners', '9ers'] },
  { city: 'Seattle', nickname: 'Seahawks', abbr: 'SEA', extra: ['hawks'] },
  { city: 'Tampa Bay', nickname: 'Buccaneers', abbr: 'TB', extra: ['bucs'] },
  { city: 'Tennessee', nickname: 'Titans', abbr: 'TEN' },
  { city: 'Washington', nickname: 'Commanders', abbr: 'WAS', extra: ['commies'] },
];

const NBA: Omit<Team, 'key' | 'sport'>[] = [
  { city: 'Atlanta', nickname: 'Hawks', abbr: 'ATL' },
  { city: 'Boston', nickname: 'Celtics', abbr: 'BOS', extra: ['cs'] },
  { city: 'Brooklyn', nickname: 'Nets', abbr: 'BKN' },
  { city: 'Charlotte', nickname: 'Hornets', abbr: 'CHA' },
  { city: 'Chicago', nickname: 'Bulls', abbr: 'CHI' },
  { city: 'Cleveland', nickname: 'Cavaliers', abbr: 'CLE', extra: ['cavs'] },
  { city: 'Dallas', nickname: 'Mavericks', abbr: 'DAL', extra: ['mavs'] },
  { city: 'Denver', nickname: 'Nuggets', abbr: 'DEN', extra: ['nugs'] },
  { city: 'Detroit', nickname: 'Pistons', abbr: 'DET' },
  { city: 'Golden State', nickname: 'Warriors', abbr: 'GSW', extra: ['dubs'] },
  { city: 'Houston', nickname: 'Rockets', abbr: 'HOU' },
  { city: 'Indiana', nickname: 'Pacers', abbr: 'IND' },
  { city: 'Los Angeles', nickname: 'Clippers', abbr: 'LAC', extra: ['clips'] },
  { city: 'Los Angeles', nickname: 'Lakers', abbr: 'LAL' },
  { city: 'Memphis', nickname: 'Grizzlies', abbr: 'MEM', extra: ['grizz'] },
  { city: 'Miami', nickname: 'Heat', abbr: 'MIA' },
  { city: 'Milwaukee', nickname: 'Bucks', abbr: 'MIL' },
  { city: 'Minnesota', nickname: 'Timberwolves', abbr: 'MIN', extra: ['wolves'] },
  { city: 'New Orleans', nickname: 'Pelicans', abbr: 'NOP', extra: ['pels'] },
  { city: 'New York', nickname: 'Knicks', abbr: 'NYK' },
  { city: 'Oklahoma City', nickname: 'Thunder', abbr: 'OKC' },
  { city: 'Orlando', nickname: 'Magic', abbr: 'ORL' },
  { city: 'Philadelphia', nickname: '76ers', abbr: 'PHI', extra: ['sixers', 'philly'] },
  { city: 'Phoenix', nickname: 'Suns', abbr: 'PHX' },
  { city: 'Portland', nickname: 'Trail Blazers', abbr: 'POR', extra: ['blazers'] },
  { city: 'Sacramento', nickname: 'Kings', abbr: 'SAC' },
  { city: 'San Antonio', nickname: 'Spurs', abbr: 'SAS' },
  { city: 'Toronto', nickname: 'Raptors', abbr: 'TOR', extra: ['raps'] },
  { city: 'Utah', nickname: 'Jazz', abbr: 'UTA' },
  { city: 'Washington', nickname: 'Wizards', abbr: 'WAS', extra: ['wiz'] },
];

const MLB: Omit<Team, 'key' | 'sport'>[] = [
  { city: 'Arizona', nickname: 'Diamondbacks', abbr: 'ARI', extra: ['dbacks', 'd-backs'] },
  { city: 'Atlanta', nickname: 'Braves', abbr: 'ATL' },
  { city: 'Baltimore', nickname: 'Orioles', abbr: 'BAL', extra: ['os'] },
  { city: 'Boston', nickname: 'Red Sox', abbr: 'BOS', extra: ['bosox'] },
  { city: 'Chicago', nickname: 'Cubs', abbr: 'CHC' },
  { city: 'Chicago', nickname: 'White Sox', abbr: 'CWS', extra: ['chisox'] },
  { city: 'Cincinnati', nickname: 'Reds', abbr: 'CIN' },
  { city: 'Cleveland', nickname: 'Guardians', abbr: 'CLE' },
  { city: 'Colorado', nickname: 'Rockies', abbr: 'COL' },
  { city: 'Detroit', nickname: 'Tigers', abbr: 'DET' },
  { city: 'Houston', nickname: 'Astros', abbr: 'HOU', extra: ['stros'] },
  { city: 'Kansas City', nickname: 'Royals', abbr: 'KC' },
  { city: 'Los Angeles', nickname: 'Angels', abbr: 'LAA' },
  { city: 'Los Angeles', nickname: 'Dodgers', abbr: 'LAD' },
  { city: 'Miami', nickname: 'Marlins', abbr: 'MIA' },
  { city: 'Milwaukee', nickname: 'Brewers', abbr: 'MIL', extra: ['brew crew'] },
  { city: 'Minnesota', nickname: 'Twins', abbr: 'MIN' },
  { city: 'New York', nickname: 'Mets', abbr: 'NYM' },
  { city: 'New York', nickname: 'Yankees', abbr: 'NYY', extra: ['yanks'] },
  { city: 'Oakland', nickname: 'Athletics', abbr: 'OAK', extra: ['as'] },
  { city: 'Philadelphia', nickname: 'Phillies', abbr: 'PHI', extra: ['phils'] },
  { city: 'Pittsburgh', nickname: 'Pirates', abbr: 'PIT', extra: ['bucs'] },
  { city: 'San Diego', nickname: 'Padres', abbr: 'SD', extra: ['pads'] },
  { city: 'San Francisco', nickname: 'Giants', abbr: 'SF' },
  { city: 'Seattle', nickname: 'Mariners', abbr: 'SEA', extra: ['ms'] },
  { city: 'St. Louis', nickname: 'Cardinals', abbr: 'STL', extra: ['st louis', 'cards'] },
  { city: 'Tampa Bay', nickname: 'Rays', abbr: 'TB' },
  { city: 'Texas', nickname: 'Rangers', abbr: 'TEX' },
  { city: 'Toronto', nickname: 'Blue Jays', abbr: 'TOR', extra: ['jays'] },
  { city: 'Washington', nickname: 'Nationals', abbr: 'WSH', extra: ['nats'] },
];

const NHL: Omit<Team, 'key' | 'sport'>[] = [
  { city: 'Anaheim', nickname: 'Ducks', abbr: 'ANA' },
  { city: 'Boston', nickname: 'Bruins', abbr: 'BOS', extra: ['bs'] },
  { city: 'Buffalo', nickname: 'Sabres', abbr: 'BUF' },
  { city: 'Calgary', nickname: 'Flames', abbr: 'CGY' },
  { city: 'Carolina', nickname: 'Hurricanes', abbr: 'CAR', extra: ['canes'] },
  { city: 'Chicago', nickname: 'Blackhawks', abbr: 'CHI' },
  { city: 'Colorado', nickname: 'Avalanche', abbr: 'COL', extra: ['avs'] },
  { city: 'Columbus', nickname: 'Blue Jackets', abbr: 'CBJ' },
  { city: 'Dallas', nickname: 'Stars', abbr: 'DAL' },
  { city: 'Detroit', nickname: 'Red Wings', abbr: 'DET', extra: ['wings'] },
  { city: 'Edmonton', nickname: 'Oilers', abbr: 'EDM' },
  { city: 'Florida', nickname: 'Panthers', abbr: 'FLA' },
  { city: 'Los Angeles', nickname: 'Kings', abbr: 'LAK' },
  { city: 'Minnesota', nickname: 'Wild', abbr: 'MIN' },
  { city: 'Montreal', nickname: 'Canadiens', abbr: 'MTL', extra: ['habs'] },
  { city: 'Nashville', nickname: 'Predators', abbr: 'NSH', extra: ['preds'] },
  { city: 'New Jersey', nickname: 'Devils', abbr: 'NJD' },
  { city: 'New York', nickname: 'Islanders', abbr: 'NYI', extra: ['isles'] },
  { city: 'New York', nickname: 'Rangers', abbr: 'NYR' },
  { city: 'Ottawa', nickname: 'Senators', abbr: 'OTT', extra: ['sens'] },
  { city: 'Philadelphia', nickname: 'Flyers', abbr: 'PHI' },
  { city: 'Pittsburgh', nickname: 'Penguins', abbr: 'PIT', extra: ['pens'] },
  { city: 'San Jose', nickname: 'Sharks', abbr: 'SJS' },
  { city: 'Seattle', nickname: 'Kraken', abbr: 'SEA' },
  { city: 'St. Louis', nickname: 'Blues', abbr: 'STL', extra: ['st louis'] },
  { city: 'Tampa Bay', nickname: 'Lightning', abbr: 'TBL', extra: ['bolts'] },
  { city: 'Toronto', nickname: 'Maple Leafs', abbr: 'TOR', extra: ['leafs'] },
  { city: 'Utah', nickname: 'Mammoth', abbr: 'UTA' },
  { city: 'Vancouver', nickname: 'Canucks', abbr: 'VAN', extra: ['nucks'] },
  { city: 'Vegas', nickname: 'Golden Knights', abbr: 'VGK', extra: ['knights'] },
  { city: 'Washington', nickname: 'Capitals', abbr: 'WSH', extra: ['caps'] },
  { city: 'Winnipeg', nickname: 'Jets', abbr: 'WPG' },
];

function league(sport: string, rows: Omit<Team, 'key' | 'sport'>[]): Team[] {
  return rows.map((t) => ({
    ...t,
    sport,
    key: `${sport}:${t.abbr.toLowerCase()}`,
  }));
}

export const TEAMS: readonly Team[] = [
  ...league('nfl', NFL),
  ...league('nba', NBA),
  ...league('mlb', MLB),
  ...league('nhl', NHL),
];

/** The sports this file can actually speak about. See the header. */
export const LEXICON_SPORTS: readonly string[] = ['nfl', 'nba', 'mlb', 'nhl'] as const;

export function hasLexicon(sport: string | null): boolean {
  return sport !== null && LEXICON_SPORTS.includes(sport);
}

export function teamsForSport(sport: string): Team[] {
  return TEAMS.filter((t) => t.sport === sport);
}

export function teamByKey(key: string): Team | null {
  return TEAMS.find((t) => t.key === key) ?? null;
}

export function teamLabel(key: string): string {
  const t = teamByKey(key);
  return t ? `${t.city} ${t.nickname}` : key;
}

// ---------------------------------------------------------------------------
// The alias index
// ---------------------------------------------------------------------------

export type AliasStrength = 'strong' | 'weak';

export interface AliasEntry {
  alias: string;
  key: string;
  strength: AliasStrength;
}

const norm = (s: string) => s.toLowerCase().replace(/[.']/g, '').replace(/\s+/g, ' ').trim();

/**
 * Every way one league's teams get written, with the ambiguous ones removed.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AMBIGUITY IS COMPUTED, NOT CURATED
 *
 * "New York" names two NFL teams, "Chicago" two MLB teams, "Los Angeles" two in
 * three of the four leagues. Rather than keep a hand-written list of the cities
 * to leave out — which is wrong the day a team relocates — any alias that
 * resolves to more than one team IN THE SAME SPORT is dropped from the index
 * entirely. A post saying only "New York" in an NFL thread yields no team, which
 * is the truth: the writer has not said which one.
 *
 * Cross-SPORT collisions need no such treatment. "Rangers" is a hockey team and
 * a baseball team, and the section says which forum we are in.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Abbreviations are `weak`: two or three letters collide with ordinary words
 * ("no", "as", "os", "min", "car", "wash") and with each other's plain-English
 * readings. entities.ts requires corroboration before believing one.
 */
export function aliasIndex(sport: string): AliasEntry[] {
  const claims = new Map<string, { keys: Set<string>; strength: AliasStrength }>();

  const add = (alias: string, key: string, strength: AliasStrength) => {
    const a = norm(alias);
    if (a.length < 2) return;
    const existing = claims.get(a);
    if (existing) {
      existing.keys.add(key);
      // A spelling that is strong for one team and weak for another is only as
      // trustworthy as its weakest reading.
      if (strength === 'weak') existing.strength = 'weak';
      return;
    }
    claims.set(a, { keys: new Set([key]), strength });
  };

  for (const t of teamsForSport(sport)) {
    add(`${t.city} ${t.nickname}`, t.key, 'strong');
    add(t.nickname, t.key, 'strong');
    add(t.city, t.key, 'strong');
    add(t.abbr, t.key, 'weak');
    for (const e of t.extra ?? []) add(e, t.key, 'strong');
  }

  return [...claims.entries()]
    .filter(([, v]) => v.keys.size === 1)
    .map(([alias, v]) => ({ alias, key: [...v.keys][0], strength: v.strength }))
    // Longest first, so "new york giants" is consumed before "giants" and
    // "red sox" before "sox".
    .sort((a, b) => b.alias.length - a.alias.length);
}
