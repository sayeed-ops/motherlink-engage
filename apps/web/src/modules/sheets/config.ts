// The Google Sheet a project logs its posted comments to — the settings, and
// the rules for reading them.
//
// ════════════════════════════════════════════════════════════════════════════
// ENGAGE NEVER OWNS THE SHEET. A person makes it, shares it with the service
// account, and pastes its URL here. Engage only ever APPENDS.
//
// That is deliberate and it is the whole safety story. The sheet in front of
// this feature is a working document — rows get recoloured, a Mention ID gets
// blanked because automod removed the comment, a note gets typed in a spare
// column. Anything that rewrote or reordered rows would destroy that work on
// its next run, silently, in a file nobody thinks of as ours. Appending can
// only ever add a row at the bottom.
// ════════════════════════════════════════════════════════════════════════════

/** The tab rows are appended to when nobody says otherwise. */
export const DEFAULT_TAB = 'Posts';

/** What the operator sets, and what the agent has written so far. */
export interface SheetConfig {
  /** Off by default. Nothing is written, and no row is even prepared, until a
   *  person turns this on for this project. */
  enabled: boolean;
  /** The spreadsheet's id, extracted from whatever URL was pasted. */
  spreadsheetId: string;
  /** The tab within it. Created on first write if it is not there. */
  tabName: string;
  /**
   * Whether replies that do NOT name the client belong in the sheet.
   *
   * On, the sheet is a record of everything this project posted. Off, it is a
   * record of BRAND MENTIONS only — which is what a sheet with a "Mention ID"
   * column is usually for, and what a client is usually shown.
   *
   * Defaults ON, because that is what the sheet did before this existed and
   * narrowing what gets recorded should be a decision somebody made.
   */
  includeGrowth: boolean;
  /** The stem of the Mention ID — "RM292-1" gives RM292-1-1, RM292-1-2, …
   *  Empty means the column is left blank for a person to fill by hand. */
  mentionPrefix: string;
  /** The next number to hand out. Advanced in a transaction by whichever job
   *  claims it, so two jobs posting at once cannot take the same one. */
  nextMention: number;
  /** When a row last reached the sheet, and what went wrong if one did not.
   *  Both are for the screen — neither gates anything. */
  lastWrittenAtMs: number | null;
  lastError: string | null;
}

export const EMPTY_SHEET_CONFIG: SheetConfig = {
  enabled: false,
  spreadsheetId: '',
  tabName: DEFAULT_TAB,
  includeGrowth: true,
  mentionPrefix: '',
  nextMention: 1,
  lastWrittenAtMs: null,
  lastError: null,
};

// A Google file id: the opaque segment after /d/. Length is not fixed by any
// published contract (44 today), so this bounds it loosely rather than pinning
// a number that could change under us.
const FILE_ID = /^[A-Za-z0-9_-]{20,120}$/;

/**
 * The spreadsheet id inside whatever the operator pasted.
 *
 * Takes the full edit URL (the usual case — it is what the address bar holds),
 * a sharing URL with a `?usp=` tail, or a bare id. Returns null for anything
 * else, INCLUDING a Google Docs or Drive URL: pointing this at a document
 * rather than a spreadsheet fails later with an opaque API error, and it is
 * cheaper to say so here.
 */
export function spreadsheetIdFrom(input: string): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const m = raw.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];

  // Any other URL is a mistake worth naming, not an id to try.
  if (/^https?:\/\//i.test(raw) || raw.includes('/')) return null;

  return FILE_ID.test(raw) ? raw : null;
}

/**
 * A tab name Sheets will accept.
 *
 * Sheets forbids nothing much in a tab name, but the range syntax we build
 * from it (`'Name'!A1`) breaks on a newline and needs doubled apostrophes.
 * Escaping is quoteTab()'s job; this only trims and bounds.
 */
export function normaliseTabName(raw: string): string {
  const name = String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 100);
  return name || DEFAULT_TAB;
}

/** A tab name as A1 notation — the one place the apostrophe rule lives. */
export function quoteTab(name: string): string {
  return `'${String(name).replace(/'/g, "''")}'`;
}

/**
 * The Mention ID for one row: the prefix, a hyphen, the number.
 *
 * An empty prefix gives an empty cell rather than a bare "17" — a number with
 * no scheme behind it reads like data and would be worse than a blank a person
 * can see is theirs to fill.
 */
export function mentionId(prefix: string, n: number): string {
  const stem = String(prefix ?? '').trim().replace(/-+$/, '');
  if (!stem) return '';
  return `${stem}-${n}`;
}

/** A stored `sheet` map → the settings, with every field defaulted. */
export function readSheetConfig(raw: unknown): SheetConfig {
  const s = (raw ?? {}) as Record<string, unknown>;
  const n = Number(s.nextMention);
  return {
    enabled: s.enabled === true,
    spreadsheetId: typeof s.spreadsheetId === 'string' ? s.spreadsheetId : '',
    tabName: normaliseTabName(typeof s.tabName === 'string' ? s.tabName : DEFAULT_TAB),
    // Absent reads as ON — every sheet configured before this setting existed
    // was recording growth replies, and a silent narrowing would look like rows
    // had gone missing. ⚠️ The agent repeats this `!== false` rule in
    // agent-core.mjs claimSheetRow; change both.
    includeGrowth: s.includeGrowth !== false,
    mentionPrefix: typeof s.mentionPrefix === 'string' ? s.mentionPrefix.trim() : '',
    nextMention: Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1,
    lastWrittenAtMs: typeof s.lastWrittenAtMs === 'number' ? s.lastWrittenAtMs : null,
    lastError: typeof s.lastError === 'string' && s.lastError ? s.lastError : null,
  };
}

/**
 * Why this project will not log a posted comment, or null if it will.
 *
 * Read at ENQUEUE time, not at post time: a job queued while the sheet was off
 * carries no row payload, and turning the sheet on later cannot conjure one.
 * That is the honest behaviour — the row's content description is a copy of the
 * analysis the draft was written from, and re-deriving it days later from an
 * analysis that may since have been re-run would log something that was never
 * true of this reply.
 */
export function sheetRefusal(cfg: SheetConfig): string | null {
  if (!cfg.enabled) return 'Sheet logging is off for this project.';
  if (!cfg.spreadsheetId) return 'No spreadsheet is linked to this project.';
  return null;
}

/**
 * Does a reply of this kind belong in the sheet?
 *
 * ⚠️ EVALUATED WHEN THE ROW IS WRITTEN, NOT WHEN THE REPLY IS QUEUED — unlike
 * everything else about a row, which is frozen at enqueue time.
 *
 * The difference is deliberate. The row's CONTENT has to describe the reply as
 * it was approved, so it is frozen. Whether the sheet carries growth replies at
 * all is a statement about what the sheet is for, and a person who turns it off
 * means "stop putting them in", including the ones already queued. Reading it
 * late is what makes the toggle behave the way the sentence sounds.
 *
 * Skipping is checked BEFORE a Mention ID is claimed, so a skipped growth reply
 * never burns a number and leaves a hole in the client's sequence.
 */
export function syncsKind(cfg: Pick<SheetConfig, 'includeGrowth'>, kind: 'brand' | 'growth'): boolean {
  return kind === 'brand' || cfg.includeGrowth;
}
