import 'server-only';

// The credential store: `llmCredentials/{credentialId}`, top-level.
//
// TOP-LEVEL BY NECESSITY, not by taste. firestore.rules has
// `match /projects/{pid}/{document=**} { allow read: if can(pid,'project.view') }`
// and rules are a UNION of grants — a nested `allow read: if false` would NOT
// revoke that. Nesting credentials under a project would hand every project
// member the ciphertext (and, without encryption, the key). There is a rules
// test that proves this; see tests/rules.test.mjs.
//
// The document is `allow read, write: if false`, so the client cannot read even
// its own credential. Everything the settings UI shows comes from
// GET /api/llm/credentials as masked metadata. That is a deliberate exception
// to lib/data.ts's "reads go browser -> Firestore direct" convention, and it is
// contained to this collection.

import { FieldValue, type Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { keyHint, openSecret, sealSecret, type SecretEnvelope } from '@/server/crypto';
import type { LlmProviderId, ModelRef } from '@/lib/llm/types';

export type CredentialScope = 'shared' | 'personal';
export type CredentialStatus = 'active' | 'invalid' | 'disabled';

/** The stored document. `secret` is ciphertext; nothing here reaches a browser
 *  except by way of `maskCredential` below. */
export interface LlmCredentialDoc {
  credentialId: string;
  provider: LlmProviderId;
  label: string;
  scope: CredentialScope;
  /** null for shared credentials, the owner's uid for personal ones. */
  ownerUid: string | null;
  secret: SecretEnvelope;
  keyHint: string;
  allowedModels: ModelRef[];
  verification: 'probed' | 'assumed';
  modelsCheckedAt: Timestamp | null;
  lastError: string | null;
  /** Phase 2. Present from the start so the shape does not change under
   *  existing documents when grants ship. */
  grantedProjectIds: string[];
  grantAllProjects: boolean;
  status: CredentialStatus;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Everything the settings UI is allowed to see. No ciphertext, no envelope,
 *  no key — just the last four characters. */
export interface MaskedCredential {
  credentialId: string;
  provider: LlmProviderId;
  label: string;
  scope: CredentialScope;
  ownerUid: string | null;
  keyHint: string;
  modelCount: number;
  allowedModels: ModelRef[];
  verification: 'probed' | 'assumed';
  modelsCheckedAtMs: number | null;
  lastError: string | null;
  grantedProjectIds: string[];
  grantAllProjects: boolean;
  status: CredentialStatus;
  createdAtMs: number | null;
}

const credentials = () => adminDb().collection('llmCredentials');

export function maskCredential(d: LlmCredentialDoc): MaskedCredential {
  return {
    credentialId: d.credentialId,
    provider: d.provider,
    label: d.label,
    scope: d.scope,
    ownerUid: d.ownerUid,
    keyHint: d.keyHint,
    modelCount: d.allowedModels?.length ?? 0,
    allowedModels: d.allowedModels ?? [],
    verification: d.verification ?? 'assumed',
    modelsCheckedAtMs: d.modelsCheckedAt?.toMillis?.() ?? null,
    lastError: d.lastError ?? null,
    grantedProjectIds: d.grantedProjectIds ?? [],
    grantAllProjects: d.grantAllProjects ?? false,
    status: d.status,
    createdAtMs: d.createdAt?.toMillis?.() ?? null,
  };
}

/** Every credential owned by this user. */
export async function listPersonalCredentials(uid: string): Promise<LlmCredentialDoc[]> {
  const snap = await credentials().where('scope', '==', 'personal').where('ownerUid', '==', uid).get();
  return snap.docs.map((d) => d.data() as LlmCredentialDoc);
}

/** Every shared credential.
 *
 *  Filtering by granted project happens IN MEMORY at the call site, not here.
 *  An `array-contains` combined with an equality filter needs a composite
 *  index; the document count is single digits, so the index is not worth it. */
export async function listSharedCredentials(): Promise<LlmCredentialDoc[]> {
  const snap = await credentials().where('scope', '==', 'shared').get();
  return snap.docs.map((d) => d.data() as LlmCredentialDoc);
}

export async function getCredential(credentialId: string): Promise<LlmCredentialDoc | null> {
  const snap = await credentials().doc(credentialId).get();
  return snap.exists ? (snap.data() as LlmCredentialDoc) : null;
}

export interface CreateCredentialInput {
  provider: LlmProviderId;
  label: string;
  scope: CredentialScope;
  ownerUid: string | null;
  apiKey: string;
  allowedModels: ModelRef[];
  verification: 'probed' | 'assumed';
  createdBy: string;
}

export async function createCredential(input: CreateCredentialInput): Promise<LlmCredentialDoc> {
  const ref = credentials().doc();
  // The id is generated BEFORE sealing because it is bound into the key
  // derivation and the AAD — the envelope is only valid on this document.
  const secret = sealSecret(input.apiKey, {
    credentialId: ref.id,
    provider: input.provider,
    scope: input.scope,
  });

  const doc = {
    credentialId: ref.id,
    provider: input.provider,
    label: input.label,
    scope: input.scope,
    ownerUid: input.ownerUid,
    secret,
    keyHint: keyHint(input.apiKey),
    allowedModels: input.allowedModels,
    verification: input.verification,
    modelsCheckedAt: FieldValue.serverTimestamp(),
    lastError: null,
    grantedProjectIds: [],
    grantAllProjects: false,
    status: 'active' as const,
    createdBy: input.createdBy,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(doc);
  return (await ref.get()).data() as LlmCredentialDoc;
}

export async function deleteCredential(credentialId: string): Promise<void> {
  await credentials().doc(credentialId).delete();
}

/** Set which projects may use a shared credential.
 *
 *  Grants live as an array on the credential rather than a subcollection: the
 *  document count is single digits, one read gets the key and its grants
 *  together, and revocation is a single atomic edit with no fan-out to miss. */
export async function setGrants(
  credentialId: string,
  grantedProjectIds: string[],
  grantAllProjects: boolean,
): Promise<void> {
  await credentials().doc(credentialId).update({
    grantedProjectIds,
    grantAllProjects,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** Refresh what a key can reach after a re-probe. */
export async function updateVerification(
  credentialId: string,
  patch: { allowedModels: ModelRef[]; verification: 'probed' | 'assumed'; lastError: string | null; status: CredentialStatus },
): Promise<void> {
  await credentials()
    .doc(credentialId)
    .update({ ...patch, modelsCheckedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
}

/** Decrypt. See the invariant at the top of server/crypto.ts — the return value
 *  goes to a provider HTTP client and nowhere else. */
export function decryptKey(d: LlmCredentialDoc): string {
  return openSecret(d.secret, { credentialId: d.credentialId, provider: d.provider, scope: d.scope });
}
