import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';

// Knowledge sources — what the client can credibly speak to.
//
// These drive every analysis: the prompt tells the model to downgrade toward
// skip when no source supports a reply, and relevantSourceIds must be empty for
// a skip. So sources are not reference material, they are the thing that decides
// whether the tool recommends speaking at all. Hence their own permission
// (knowledge.manage) rather than folding into project.edit.

type Ctx = { params: Promise<{ projectId: string }> };

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
    : [];

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const snap = await adminDb().collection('projects').doc(projectId).collection('sources').get();

  const sources = snap.docs
    .map((d) => ({
      sourceId: d.id,
      ...d.data(),
      createdAt:
        (d.data().createdAt as { toDate?(): Date } | undefined)?.toDate?.()?.toISOString() ?? null,
    }))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

  return NextResponse.json({ sources });
});

interface Body {
  type?: string;
  title?: string;
  url?: string | null;
  rawContent?: string;
  summary?: string;
  keyPoints?: unknown;
  answerAngles?: unknown;
  relatedProblems?: unknown;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);

  const title = body.title?.trim();
  if (!title) return badRequest('A title is required.');

  const type = body.type === 'pasted_text' ? 'pasted_text' : 'url';
  const url = body.url?.trim() || null;
  if (type === 'url' && url && !/^https?:\/\//i.test(url)) {
    return badRequest('A source URL must start with http:// or https://');
  }

  const ref = adminDb().collection('projects').doc(projectId).collection('sources').doc();

  await ref.set({
    sourceId: ref.id,
    projectId,
    type,
    title,
    url,
    rawContent: body.rawContent?.trim() ?? '',
    summary: body.summary?.trim() ?? '',
    keyPoints: strings(body.keyPoints),
    answerAngles: strings(body.answerAngles),
    relatedProblems: strings(body.relatedProblems),
    createdBy: caller.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ sourceId: ref.id, title }, { status: 201 });
});
