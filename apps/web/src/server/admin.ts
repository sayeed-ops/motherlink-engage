import 'server-only';

import { initializeApp, getApps, getApp, cert, type App, type ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

// Firebase Admin SDK initialisation.
//
// This is the tier ML Studio never had. There, every write happened in the
// browser under the user's own credentials, which meant firestore.rules was the
// only authority in the system — and it was `allow read, write: if true`.
//
// The Admin SDK BYPASSES security rules entirely. That is deliberate and it is
// the whole design: rules deny all client writes (`allow write: if false`), and
// every mutation arrives here instead, after the caller's ID token has been
// verified and their permission checked. Rules become defence-in-depth rather
// than the only defence.
//
// Because this module holds rule-bypassing authority, it must never reach the
// browser. `server-only` turns an accidental client import into a build error
// rather than a silent credential leak.

let cached: App | null = null;

/**
 * Credentials come from one of two places:
 *
 *  - FIREBASE_SERVICE_ACCOUNT — the key JSON inline. Used on Vercel, where
 *    there is no filesystem to read a key from.
 *  - FIREBASE_ADMIN_KEY_PATH — a path to the key file. Used locally, so the
 *    key stays outside the repo (~/.config/motherlink-engage/) and can never
 *    be committed.
 *
 * Never both. Never a key file inside the repo.
 *
 * Exported parsed, because Firestore is no longer the only thing this key
 * signs for: the Google Sheet a project logs to is reached with this SAME
 * account, which is what makes "share the sheet with this address" the entire
 * setup step. One credential, one rotation, nothing extra on the posting Mac.
 */
export function loadServiceAccount(): { client_email: string; private_key: string; project_id: string } {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON. Paste the whole service-account key, including surrounding braces.',
      );
    }
  }

  const path = process.env.FIREBASE_ADMIN_KEY_PATH?.trim();
  if (path) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(
        `FIREBASE_ADMIN_KEY_PATH is set to "${path}" but the file could not be read as a service-account key: ${
          (err as Error).message
        }`,
      );
    }
  }

  throw new Error(
    'No Firebase Admin credential. Set FIREBASE_ADMIN_KEY_PATH (local, path to a key outside the repo) or FIREBASE_SERVICE_ACCOUNT (deployed, key JSON inline).',
  );
}

function loadCredential() {
  // `cert()` types its argument as ServiceAccount (camelCase) but accepts the
  // key file's own snake_case shape at runtime, which is what a downloaded key
  // is. This used to typecheck only because JSON.parse returns `any`.
  return cert(loadServiceAccount() as unknown as ServiceAccount);
}

export function adminApp(): App {
  if (cached) return cached;
  cached = getApps().length ? getApp() : initializeApp({ credential: loadCredential() });
  return cached;
}

export function adminAuth() {
  return getAuth(adminApp());
}

export function adminDb() {
  return getFirestore(adminApp());
}
