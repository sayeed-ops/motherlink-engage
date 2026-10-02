import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import {
  checkSheetAccess,
  getSheetConfig,
  retryFailedSheetRows,
  saveSheetConfig,
  sheetServiceAccountEmail,
} from '@/server/sheets';
import { normaliseTabName, spreadsheetIdFrom } from '@/modules/sheets/config';
import { writeActivityLog } from '@/server/activityLog';

// The project's tracking sheet — read the settings, save them, test the link.
//
// Behind `project.settings`, the same permission as the module toggles and the
// danger zone. Pointing a client's posting record at a different spreadsheet is
// a configuration change, not day-to-day work.
//
// ⚠️ NO HANDLER HERE WRITES A ROW. POST ?action=check does one READ of the
// spreadsheet's title and tab names, which is how the page can say "shared, I
// can see it" before the first comment goes out. Rows are appended by the local
// agent, after a comment is really posted.

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.settings');
  return NextResponse.json({
    sheet: await getSheetConfig(projectId),
    // The address the operator has to share the file with. Shown rather than
    // documented: it is per-deployment, and getting it wrong is the single
    // most likely reason this never writes a row.
    serviceAccountEmail: sheetServiceAccountEmail(),
  });
});

interface PutBody {
  enabled?: unknown;
  sheetUrl?: unknown;
  tabName?: unknown;
  mentionPrefix?: unknown;
  includeGrowth?: unknown;
}

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.settings');

  const body = await jsonBody<PutBody>(req);
  const enabled = body.enabled === true;
  const raw = String(body.sheetUrl ?? '').trim();

  // Turning it ON without a usable link would look saved and write nothing, so
  // the link is required exactly when it is about to be used.
  const spreadsheetId = raw ? spreadsheetIdFrom(raw) : '';
  if (raw && !spreadsheetId) {
    return badRequest(
      'That is not a Google Sheets link. Copy the URL from the sheet’s address bar — it looks like https://docs.google.com/spreadsheets/d/…',
    );
  }
  if (enabled && !spreadsheetId) return badRequest('Paste the sheet’s link before turning logging on.');

  const saved = await saveSheetConfig(projectId, {
    enabled,
    spreadsheetId: spreadsheetId || '',
    tabName: normaliseTabName(String(body.tabName ?? '')),
    mentionPrefix: String(body.mentionPrefix ?? '').trim().slice(0, 40),
    // Absent reads as ON, matching readSheetConfig — a caller that omits the
    // field is not asking for the sheet to be narrowed.
    includeGrowth: body.includeGrowth !== false,
  });

  await writeActivityLog({
    caller,
    action: 'project.sheet_updated',
    targetType: 'project',
    targetId: projectId,
    metadata: {
      enabled: saved.enabled,
      spreadsheetId: saved.spreadsheetId,
      tabName: saved.tabName,
      includeGrowth: saved.includeGrowth,
    },
  });

  return NextResponse.json({ sheet: saved });
});

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.settings');

  const { action } = await jsonBody<{ action?: string }>(req);
  const cfg = await getSheetConfig(projectId);

  if (action === 'retry') {
    return NextResponse.json({ requeued: await retryFailedSheetRows(projectId) });
  }

  if (action !== 'check') return badRequest('Unknown action.');
  if (!cfg.spreadsheetId) return badRequest('No sheet is linked to this project yet.');

  try {
    return NextResponse.json({ access: await checkSheetAccess(cfg.spreadsheetId, cfg.tabName) });
  } catch (err) {
    // A share that has not been granted is the expected answer here, not a
    // server fault — it comes back as a message the page can print as-is.
    return badRequest((err as Error).message);
  }
});
