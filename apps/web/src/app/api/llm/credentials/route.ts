import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { isPlatformAdmin, mayUseSharedKeys, type Caller } from '@/server/auth';
import { adminDb } from '@/server/admin';
import { encryptionConfigured } from '@/server/crypto';
import { grantedToProject } from '@/server/llm/select';
import { writeActivityLog } from '@/server/activityLog';
import { PROVIDER_BY_ID } from '@/lib/llm/catalog';
import type { LlmProviderId } from '@/lib/llm/types';
import {
  createCredential,
  listPersonalCredentials,
  listSharedCredentials,
  maskCredential,
} from '@/server/llm/credentials';
import { probeCredential } from '@/server/llm/probe';
import { invalidateLlmCache } from '@/server/llm/resolve';

// Third-party LLM API keys.
//
// GET exists because the credential document is `allow read: if false` — the
// settings page cannot read its own data the way every other page in this app
// does. It returns masked metadata only: provider, label, last four characters,
// how many models the key reaches. Never the envelope, never the key.
//
// Two scopes:
//   personal — anyone may add one for themselves
//   shared   — platform admins only; granted to projects via ./[id]/grants
//
// Credential ADMINISTRATION gates on requirePlatformAdmin rather than a new
// GlobalPermission, deliberately: `globalPermissions` is derived from role at
// both of its write sites (api/users/route.ts, api/users/[uid]/route.ts), so a
// new permission would be unsettable and silently held by every admin anyway.

// A probe is a real round-trip to the provider, and Vercel's default is 10s.
export const maxDuration = 30;

/**
 * Does an organisation key already cover this person, and for what?
 *
 * Provider and model counts ONLY — no label, no key hint, no grant list, not
 * even how many keys there are. A non-admin needs exactly one fact from this
 * page ("do I have to bring my own key?"), and everything beyond that fact is
 * org configuration they cannot act on.
 *
 * Coverage is per-project, so answering it needs the caller's projects. A
 * shared key granted to one client counts as covering them only if they are
 * actually on that client's project.
 */
async function coverageFor(
  caller: Caller,
  sharedDocs: Awaited<ReturnType<typeof listSharedCredentials>>,
): Promise<{ provider: LlmProviderId; modelCount: number }[]> {
  const anyProjectScoped = sharedDocs.some((c) => c.status === 'active' && !c.grantAllProjects);

  // Skip the membership read when every shared key is all-projects — the answer
  // cannot depend on which projects they are on.
  let projectIds: string[] = [];
  if (anyProjectScoped) {
    const members = await adminDb().collectionGroup('members').where('uid', '==', caller.uid).get();
    projectIds = members.docs.map((d) => d.ref.parent.parent!.id);
  }

  const modelsByProvider = new Map<LlmProviderId, Set<string>>();
  for (const c of sharedDocs) {
    // grantAllProjects keys pass with a null projectId; the rest need a match
    // against one of theirs. Reusing grantedToProject keeps this consistent with
    // the resolver rather than reimplementing the grant rule.
    const usable = c.grantAllProjects
      ? grantedToProject(c, null)
      : projectIds.some((pid) => grantedToProject(c, pid));
    if (!usable) continue;
    const set = modelsByProvider.get(c.provider) ?? new Set<string>();
    for (const ref of c.allowedModels ?? []) set.add(ref);
    modelsByProvider.set(c.provider, set);
  }

  return [...modelsByProvider].map(([provider, models]) => ({ provider, modelCount: models.size }));
}

export const GET = withAuth(async (_req: Request, caller: Caller) => {
  if (!encryptionConfigured()) {
    // Not an error — the page renders a setup notice rather than an empty list
    // that looks like "you have no keys".
    return NextResponse.json({
      personal: [],
      shared: [],
      canManageShared: false,
      mayUseSharedKeys: mayUseSharedKeys(caller),
      orgCoverage: [],
      encryptionConfigured: false,
    });
  }

  const admin = isPlatformAdmin(caller);
  const mayShare = mayUseSharedKeys(caller);

  // Read shared keys when EITHER the caller administers them or could spend
  // them. The two reasons are independent: an admin who has been cut off from
  // org spend still manages the keys, and an ordinary member who has not been
  // cut off still needs to know they are covered.
  const [personal, sharedDocs] = await Promise.all([
    listPersonalCredentials(caller.uid),
    admin || mayShare ? listSharedCredentials() : Promise.resolve([]),
  ]);

  return NextResponse.json({
    personal: personal.map(maskCredential),
    // Still admin-only, and still the full masked document. A non-admin gets the
    // orgCoverage summary below instead — enough to know whether to add a key of
    // their own, without the grant map they cannot change.
    shared: admin ? sharedDocs.map(maskCredential) : [],
    canManageShared: admin,
    /** False when an admin has unchecked this person's org-spend entitlement. */
    mayUseSharedKeys: mayShare,
    orgCoverage: mayShare ? await coverageFor(caller, sharedDocs) : [],
    encryptionConfigured: true,
  });
});

interface CreateBody {
  provider?: string;
  label?: string;
  apiKey?: string;
  scope?: string;
}

export const POST = withAuth(async (req: Request, caller: Caller) => {
  if (!encryptionConfigured()) {
    // Deliberately says what to DO, not "ask an admin". This is a server
    // environment variable, so no amount of admin rights fixes it from inside
    // the app — and a master key that encrypts the database cannot itself be
    // stored in that database. Whoever hits this needs the deploy, not a role.
    return NextResponse.json(
      {
        error:
          'API keys cannot be stored yet: the server has no LLM_ENCRYPTION_KEY. Generate one with `openssl rand -base64 32`, set it in the deployment environment (and in apps/web/.env.local for local dev), then restart. This is a deploy-time setting, not a permission.',
      },
      { status: 503 },
    );
  }

  const body = await jsonBody<CreateBody>(req);
  const provider = String(body.provider ?? '').trim();
  const label = String(body.label ?? '').trim();
  const apiKey = String(body.apiKey ?? '').trim();
  const scope = body.scope === 'shared' ? 'shared' : 'personal';

  if (!PROVIDER_BY_ID[provider]) return badRequest('Pick a provider we support.');
  if (!label) return badRequest('Give the key a label so you can tell it apart later.');
  if (!apiKey) return badRequest('Paste the API key.');

  if (scope === 'shared' && !isPlatformAdmin(caller)) {
    return NextResponse.json({ error: 'Only an admin can add a shared key.' }, { status: 403 });
  }

  // Probe BEFORE storing. A key that cannot make a call is not worth keeping,
  // and finding out now beats finding out during someone's analysis run.
  const probe = await probeCredential(provider as LlmProviderId, apiKey);
  if (!probe.ok) {
    return NextResponse.json({ error: probe.error ?? 'That key did not work.' }, { status: 400 });
  }

  const created = await createCredential({
    provider: provider as LlmProviderId,
    label,
    scope,
    // ownerUid is what makes a personal key personal. A shared key has none, so
    // no single user's deletion or departure can strand it.
    ownerUid: scope === 'personal' ? caller.uid : null,
    apiKey,
    allowedModels: probe.allowedModels,
    verification: probe.verification,
    createdBy: caller.uid,
  });

  if (scope === 'shared') {
    // A shared key spends org money. Personal keys spend the user's own, so
    // they are not audited — this is about org spend, not surveillance.
    await writeActivityLog({
      caller,
      action: 'llm.credential_created',
      targetType: 'llmCredential',
      targetId: created.credentialId,
      targetName: label,
      metadata: { provider, scope, modelCount: probe.allowedModels.length },
    });
  }

  invalidateLlmCache(scope === 'personal' ? caller.uid : undefined);
  return NextResponse.json({ credential: maskCredential(created) }, { status: 201 });
});
