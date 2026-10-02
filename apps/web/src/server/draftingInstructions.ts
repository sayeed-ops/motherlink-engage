import 'server-only';

// Storage for the team's drafting instructions — see
// modules/drafting/instructions.ts for what they are and what they may not do.
//
// Two collections, one shape:
//
//   draftingInstructions/{id}                        platform — every project
//   projects/{pid}/draftingInstructions/{id}         one client
//
// Separate collections rather than one with a `projectId` field, because the
// authority over them is different: the platform set is admin-only and changing
// it changes every client's replies at once, while a project's own set is
// `project.edit` like the rest of that module's configuration. Keeping them
// apart makes that distinction structural instead of a filter somebody can
// forget.

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import {
  activeInstructions,
  instructionsFingerprint,
  readInstruction,
  type DraftingInstruction,
  type InstructionScope,
} from '@/modules/drafting/instructions';

const db = () => adminDb();

/** The collection for a scope. `projectId` is required for 'project'. */
function collectionFor(scope: InstructionScope, projectId?: string) {
  if (scope === 'platform') return db().collection('draftingInstructions');
  if (!projectId) throw new Error('A project scope needs a projectId.');
  return db().collection('projects').doc(projectId).collection('draftingInstructions');
}

export async function listInstructions(
  scope: InstructionScope,
  projectId?: string,
): Promise<DraftingInstruction[]> {
  const snap = await collectionFor(scope, projectId).get();
  return snap.docs
    .map((d) => readInstruction(d.id, { ...(d.data() as object), scope }))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export async function createInstruction(input: {
  scope: InstructionScope;
  projectId?: string;
  title: string;
  body: string;
  uid: string;
  name: string;
}): Promise<DraftingInstruction> {
  const ref = collectionFor(input.scope, input.projectId).doc();
  const doc = {
    instructionId: ref.id,
    scope: input.scope,
    title: input.title.trim(),
    // Stored VERBATIM, newlines and all. This is prose a person wrote for a
    // model to read; reformatting it would change what the model is told.
    body: input.body,
    active: true,
    createdAtMs: Date.now(),
    createdBy: input.uid,
    createdByName: input.name,
    createdAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);
  return readInstruction(ref.id, doc);
}

/** Switch a block on or off. The only field a later edit may change — the text
 *  itself is immutable, so a draft's stamp always means one exact wording.
 *  Rewording is adding a new block and deleting the old one. */
export async function setInstructionActive(
  scope: InstructionScope,
  instructionId: string,
  active: boolean,
  projectId?: string,
): Promise<boolean> {
  const ref = collectionFor(scope, projectId).doc(instructionId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.update({ active, updatedAt: FieldValue.serverTimestamp() });
  return true;
}

export async function deleteInstruction(
  scope: InstructionScope,
  instructionId: string,
  projectId?: string,
): Promise<boolean> {
  const ref = collectionFor(scope, projectId).doc(instructionId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}

export interface InstructionsForDraft {
  /** In send order: platform first, then this project's own. */
  active: DraftingInstruction[];
  /** What the draft records, so two replies to one post can be told apart. */
  instructionIds: string[];
  fingerprint: string;
}

/**
 * Everything a draft run needs, both scopes resolved.
 *
 * Read fresh on every draft rather than cached: switching a block off and
 * pressing Draft again is exactly how you compare, so a stale read would make
 * the feature look broken.
 */
export async function instructionsForDraft(projectId: string): Promise<InstructionsForDraft> {
  const [platform, project] = await Promise.all([
    listInstructions('platform'),
    listInstructions('project', projectId),
  ]);
  const active = activeInstructions([...platform, ...project]);
  return {
    active,
    instructionIds: active.map((i) => i.instructionId),
    fingerprint: instructionsFingerprint(active),
  };
}
