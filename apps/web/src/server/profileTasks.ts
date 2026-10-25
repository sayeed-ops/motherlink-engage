import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { wakeAgent } from './agentWake';
import { encryptionConfigured, openSecret, sealSecret, type SecretEnvelope } from './crypto';
import { adsPowerCreateBody, type ProfileSpec } from '@/modules/accounts/profileSpec';
import type { ParsedProxy } from '@/modules/accounts/proxy';

// AdsPower work that Engage hands to the agent: testing a proxy, and creating a
// browser profile. Engage on Vercel cannot reach AdsPower — it answers only on
// the server it runs on — so, like posting, this goes through a queue the agent
// works through (`profileTasks`), and queueing wakes the server.
//
// A task carries a proxy password, and a create carries the comment that ends up
// in the AdsPower remark. Both are on the task only until the agent has used
// them: it deletes them when it finishes, success or not. The collection is
// closed to the browser (no rule matches it); everything the form needs comes
// back through readTask(), which never returns them.
//
// The comment is kept in Engage too, encrypted, in `accountSecrets` (also closed
// to the browser) — not on the account, which every signed-in user can read.
// Only the owner can open it (see /api/accounts/[accountId]/comment).

export type ProfileTaskKind = 'proxy-test' | 'create-profile';

export interface ProxyTestResult {
  ip: string;
  country: string;
  region: string;
  city: string;
  timezone: string;
  org: string;
  /** Profiles or accounts already going out through this proxy or exit IP. */
  usedBy: string[];
}

const tasks = () => adminDb().collection('profileTasks');

function proxyFields(p: ParsedProxy) {
  return { type: p.type, host: p.host, port: p.port, user: p.user, password: p.password };
}

export async function queueProxyTest(proxy: ParsedProxy, uid: string): Promise<string> {
  const ref = tasks().doc();
  await ref.set({
    kind: 'proxy-test',
    status: 'queued',
    proxy: proxyFields(proxy),
    rotating: proxy.rotating,
    createdBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  await wakeAgent('proxy test queued');
  return ref.id;
}

/** Queue the profile for an account and mark the account as being set up. */
export async function queueCreateProfile(
  accountId: string,
  spec: ProfileSpec,
  proxy: ParsedProxy,
  uid: string,
): Promise<string> {
  const ref = tasks().doc();
  await ref.set({
    kind: 'create-profile',
    status: 'queued',
    accountId,
    body: adsPowerCreateBody(spec, proxy),
    proxyKey: `${proxy.host}:${proxy.port}`.toLowerCase(),
    createdBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  await adminDb()
    .collection('accounts')
    .doc(accountId)
    .set(
      {
        provisioning: {
          state: 'creating',
          taskId: ref.id,
          error: '',
          browser: spec.browser,
          os: spec.os,
          proxy: { type: proxy.type, host: proxy.host, port: proxy.port, provider: proxy.provider, rotating: proxy.rotating },
          requestedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  await wakeAgent('profile creation queued');
  return ref.id;
}

export interface TaskView {
  kind: ProfileTaskKind;
  status: 'queued' | 'running' | 'done' | 'failed';
  error: string;
  result: ProxyTestResult | { profileId: string } | null;
}

/** What the form may see of a task — never the proxy password or the remark. */
export async function readTask(taskId: string): Promise<TaskView | null> {
  const snap = await tasks().doc(taskId).get();
  if (!snap.exists) return null;
  const d = snap.data() as Record<string, unknown>;
  return {
    kind: d.kind as ProfileTaskKind,
    status: d.status as TaskView['status'],
    error: typeof d.error === 'string' ? d.error : '',
    result: (d.result as TaskView['result']) ?? null,
  };
}

// ---- The account's comment, encrypted ----

const ctxFor = (accountId: string) => ({ credentialId: accountId, provider: 'adspower-remark', scope: 'account-comment' });

export function canStoreComment(): boolean {
  return encryptionConfigured();
}

export async function saveAccountComment(accountId: string, comment: string): Promise<void> {
  const text = comment.trim();
  const ref = adminDb().collection('accountSecrets').doc(accountId);
  if (!text) {
    await ref.delete();
    return;
  }
  await ref.set({ comment: sealSecret(text, ctxFor(accountId)), updatedAt: FieldValue.serverTimestamp() });
  await adminDb().collection('accounts').doc(accountId).set({ hasComment: true }, { merge: true });
}

/** Owner only — the route checks. Returns '' when there is none. */
export async function openAccountComment(accountId: string): Promise<string> {
  const snap = await adminDb().collection('accountSecrets').doc(accountId).get();
  const env = snap.exists ? (snap.get('comment') as SecretEnvelope | undefined) : undefined;
  return env ? openSecret(env, ctxFor(accountId)) : '';
}

// ---- Reading the form ----

export interface ProfileRequest {
  spec: ProfileSpec;
  proxy: ParsedProxy;
}

/** Validate the "new AdsPower profile" half of a form. A string is the reason
 *  it was refused, in words the form can show. */
export function readProfileRequest(
  raw: unknown,
  fallbackName: string,
  parse: (text: string) => { ok: true; proxy: ParsedProxy } | { ok: false; error: string },
): ProfileRequest | string {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const browser = b.browser === 'firefox' ? 'firefox' : b.browser === 'chrome' || b.browser === undefined ? 'chrome' : null;
  if (!browser) return 'Unknown browser.';
  const os = b.os === 'windows' || b.os === 'mac' || b.os === 'any' ? b.os : b.os === undefined ? 'any' : null;
  if (!os) return 'Unknown operating system.';
  const parsed = parse(String(b.proxy ?? ''));
  if (!parsed.ok) return parsed.error;
  const name = String(b.name ?? '').trim() || fallbackName;
  if (!name) return 'The profile needs a name.';
  return {
    spec: { name, groupId: String(b.groupId ?? '0') || '0', browser, os, remark: String(b.comment ?? '') },
    proxy: parsed.proxy,
  };
}
