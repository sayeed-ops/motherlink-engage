// Appending a posted comment to a project's Google Sheet.
//
// ════════════════════════════════════════════════════════════════════════════
// THE AGENT WRITES THE ROW, AND ONLY AFTER THE COMMENT IS REALLY UP.
//
// The web app decides WHAT the row says and freezes it onto the job at enqueue
// time (apps/web/src/modules/sheets/row.ts). This file adds the three things
// only posting knows — the date, the permalink, the Mention ID — and appends.
//
// It is deliberately downstream of the post. A sheet that is unreachable, a
// revoked share, an expired token: none of them may turn a comment that IS
// posted into a failed job. Every fault here leaves the job posted and the row
// pending, to be retried on a later poll.
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ VALUES ARE WRITTEN RAW, NEVER "USER_ENTERED".
//
// USER_ENTERED is how a human types: Sheets parses it. A reply beginning with
// `=`, `+`, `-` or `@` would become a FORMULA in somebody else's spreadsheet —
// the classic CSV-injection shape, except we would be the ones injecting, into
// a file we do not own. RAW stores every cell as the literal text that was
// posted. The cost is that "11/18/25" is a string rather than a date value,
// which is what the sheet already held anyway.

import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * The header row, in order.
 *
 * ⚠️ MIRRORED FROM apps/web/src/modules/sheets/row.ts. The agent is plain Node
 * and cannot import TypeScript, so the list exists twice;
 * tests/unit/sheets.test.mjs reads both files and fails if they drift.
 */
export const SHEET_COLUMNS = [
  'Month',
  'Mention ID',
  'Date Posted',
  'Post Type',
  'Board/Subreddit',
  'Content Description',
  'Content URL',
  'Comment/Text',
  'Original Post Title',
  'Original Post Body',
];

/** Last column letter for the header — A…J for ten columns. */
const LAST_COL = String.fromCharCode(64 + SHEET_COLUMNS.length);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A tab name as A1 notation. Apostrophes double; see config.ts. */
export function quoteTab(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

/** The Mention ID for one row. An empty prefix leaves the cell blank. */
export function mentionId(prefix, n) {
  const stem = String(prefix ?? '').trim().replace(/-+$/, '');
  return stem ? `${stem}-${n}` : '';
}

/** The month name and MM/DD/YY date, in this machine's timezone. */
export function datePosted(ms) {
  const d = new Date(ms);
  return {
    month: MONTHS[d.getMonth()] ?? '',
    date: `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear() % 100).padStart(2, '0')}`,
  };
}

/**
 * The frozen payload plus what posting knows → the cells, in column order.
 *
 * Pure. Everything below it talks to Google; this is the part worth reading
 * when a row comes out wrong.
 */
export function rowValues({ payload, mention, postedAtMs, permalink }) {
  const p = payload ?? {};
  const { month, date } = datePosted(postedAtMs);
  return [
    month,
    mention || '',
    date,
    p.postType || 'Comment',
    p.board || '',
    p.contentDescription || '',
    permalink || '',
    p.commentText || '',
    p.originalTitle || '',
    p.originalBody || '',
  ].map((v) => String(v ?? ''));
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

/**
 * A Sheets caller signed as the service account.
 *
 * The SAME key the agent already uses for Firestore. Nothing new to distribute
 * to the posting Mac, and nothing new to rotate: sharing a sheet with that
 * account's email is the whole setup step. google-auth-library caches and
 * refreshes the token, so one client is made per process.
 */
export function createSheets({ keyPath, serviceAccount, fetchImpl = fetch, timeoutMs = 15_000, auth } = {}) {
  const key = serviceAccount ?? JSON.parse(readFileSync(keyPath, 'utf8'));
  // `auth` is a seam for the tests. google-auth-library fetches its token
  // through gaxios rather than global fetch, so injecting fetchImpl alone would
  // still send a signing request to Google from a unit test.
  const signer = auth ?? new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE] });

  async function call(path, { method = 'GET', body, query } = {}) {
    const token = await signer.getAccessToken();
    const url = new URL(`${SHEETS_API}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token.token ?? token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        // ⚠️ BOUNDED ON PURPOSE. The append runs inside a finished job, which is
        // still holding one of the agent's concurrency slots. A request that
        // hung would stop the agent posting anything else — bookkeeping taking
        // the machine down with it. A timed-out row is simply retried later.
        signal: AbortSignal.timeout(timeoutMs),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new Error(`Google Sheets did not answer within ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw new Error(`Could not reach Google Sheets: ${e?.message || e}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(explain(res.status, text, key.client_email));
    return text ? JSON.parse(text) : {};
  }

  return {
    email: key.client_email,

    /** The spreadsheet's title and its tabs. The access check, and cheap. */
    async describe(spreadsheetId) {
      const doc = await call(`/${encodeURIComponent(spreadsheetId)}`, {
        query: { fields: 'properties.title,sheets.properties.title' },
      });
      return {
        title: String(doc?.properties?.title ?? ''),
        tabs: (doc?.sheets ?? []).map((s) => String(s?.properties?.title ?? '')).filter(Boolean),
      };
    },

    /** One column, as a flat list of strings. Used to spot a row we already
     *  wrote before a retry writes it twice. */
    async column(spreadsheetId, tabName, letter) {
      const range = `${quoteTab(tabName)}!${letter}:${letter}`;
      const out = await call(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
      return (out?.values ?? []).map((r) => String(r?.[0] ?? ''));
    },

    /** Create the tab if it is missing. Returns true if it made one. */
    async ensureTab(spreadsheetId, tabName) {
      const { tabs } = await this.describe(spreadsheetId);
      if (tabs.includes(tabName)) return false;
      await call(`/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
        method: 'POST',
        body: { requests: [{ addSheet: { properties: { title: tabName } } }] },
      });
      return true;
    },

    /**
     * Put the header in A1 if — and only if — A1 is empty.
     *
     * Never overwrites. An operator who renamed a column, or added their own
     * beyond J, has said something about how they use this sheet, and a header
     * we rewrote on every start would say it back at them once a day.
     */
    async ensureHeader(spreadsheetId, tabName) {
      const range = `${quoteTab(tabName)}!A1:${LAST_COL}1`;
      const out = await call(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
      const existing = out?.values?.[0] ?? [];
      if (existing.some((c) => String(c ?? '').trim())) return false;
      await call(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`, {
        method: 'PUT',
        query: { valueInputOption: 'RAW' },
        body: { values: [SHEET_COLUMNS] },
      });
      return true;
    },

    /** Append one row below everything already there. */
    async append(spreadsheetId, tabName, values) {
      const range = `${quoteTab(tabName)}!A:${LAST_COL}`;
      const out = await call(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`, {
        method: 'POST',
        query: {
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
        },
        body: { values: [values] },
      });
      return String(out?.updates?.updatedRange ?? '');
    },
  };
}

/**
 * Google's error, as something an operator can act on.
 *
 * The raw 403 here is "The caller does not have permission", which is true and
 * useless — it does not say that the fix is to share one file with one address.
 */
export function explain(status, text, email) {
  let detail = '';
  try {
    detail = String(JSON.parse(text)?.error?.message ?? '').trim();
  } catch {
    detail = String(text ?? '').slice(0, 200);
  }
  if (status === 403 && /permission|caller/i.test(detail)) {
    return `The sheet is not shared with ${email}. Open it in Google Sheets → Share → add that address as an Editor.`;
  }
  if (status === 403 && /API has not been used|disabled/i.test(detail)) {
    return `The Google Sheets API is not enabled for this Google Cloud project. Enable it, then try again. (${detail})`;
  }
  if (status === 404) {
    return 'No spreadsheet with that id. Check the URL on the project page — it may point at a file that was deleted or moved.';
  }
  if (status === 400 && /Unable to parse range/i.test(detail)) {
    return `The sheet has no tab by that name, and it could not be created. (${detail})`;
  }
  return `Google Sheets refused the write (${status})${detail ? `: ${detail}` : ''}.`;
}
