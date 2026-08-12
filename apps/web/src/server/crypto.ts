import 'server-only';

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

// Envelope encryption for third-party API keys — the first and, so far, only
// secret this app stores in Firestore.
//
// ════════════════════════════════════════════════════════════════════════════
// THE INVARIANT
//
// The plaintext returned by openSecret() may ONLY be passed to a provider HTTP
// client. Never into a response body, never console.log, never an activity-log
// `metadata` field, never an error message. Shared keys belong to a paid
// account someone else is billed for; one route that echoes a decrypted key is
// a full compromise, and it would look like an ordinary debug line in review.
// ════════════════════════════════════════════════════════════════════════════
//
// Why envelope encryption at all, when the collection is `allow read: if false`?
// Because rules are not the only way out of Firestore. tools/backup.mjs walks
// every collection with the Admin SDK and writes plaintext JSON to a laptop;
// the Firebase console shows documents to anyone with project access; a restore
// can move documents between projects. Rules protect the client path only. This
// protects the document itself, so what leaks is ciphertext.

/** What gets stored on the credential document in place of the key. */
export interface SecretEnvelope {
  v: 1;
  alg: 'A256GCM';
  /** Which master key sealed this — lets a rotation decrypt old records. */
  kid: string;
  /** Per-record HKDF salt, base64. */
  salt: string;
  /** GCM nonce, base64, 12 bytes. */
  iv: string;
  /** GCM authentication tag, base64, 16 bytes. */
  tag: string;
  /** Ciphertext, base64. */
  ct: string;
}

/** Binds an envelope to the document it belongs on. Any change to these fields
 *  makes the envelope fail authentication rather than decrypt. */
export interface SecretContext {
  credentialId: string;
  provider: string;
  scope: string;
}

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

const KEY_BYTES = 32;

interface MasterKey {
  kid: string;
  key: Buffer;
}

/** `kid` is a fingerprint, not a secret — it only says WHICH key sealed a
 *  record so a rotation knows what it can still open. */
const fingerprint = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

function parseMasterKey(raw: string | undefined, varName: string): MasterKey | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let key: Buffer;
  try {
    key = Buffer.from(trimmed, 'base64');
  } catch {
    throw new SecretError(`${varName} is not valid base64.`);
  }
  if (key.length !== KEY_BYTES) {
    throw new SecretError(
      `${varName} must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return { kid: fingerprint(key), key };
}

/** The key new records are sealed with. */
function activeKey(): MasterKey {
  const k = parseMasterKey(process.env.LLM_ENCRYPTION_KEY, 'LLM_ENCRYPTION_KEY');
  if (!k) {
    throw new SecretError(
      'LLM_ENCRYPTION_KEY is not set, so API keys cannot be stored. Generate one with `openssl rand -base64 32` and set it in the environment.',
    );
  }
  return k;
}

/** Every key we can still DECRYPT with. Rotation is: set the new key as
 *  LLM_ENCRYPTION_KEY, move the old one to LLM_ENCRYPTION_KEY_PREVIOUS, re-seal
 *  every record, then drop the previous var. Supporting this from day one costs
 *  a few lines; retrofitting it once records exist means downtime. */
function decryptionKeys(): MasterKey[] {
  const keys: MasterKey[] = [];
  const active = parseMasterKey(process.env.LLM_ENCRYPTION_KEY, 'LLM_ENCRYPTION_KEY');
  if (active) keys.push(active);
  const previous = parseMasterKey(process.env.LLM_ENCRYPTION_KEY_PREVIOUS, 'LLM_ENCRYPTION_KEY_PREVIOUS');
  if (previous) keys.push(previous);
  return keys;
}

/** Derive the per-record AES key.
 *
 *  The master key is never used directly. The per-record salt plus the
 *  credentialId in the `info` string means an envelope lifted into a different
 *  document derives a different key and fails — so a backup restore cannot
 *  shuffle a shared key onto someone's personal credential. */
function deriveKey(master: Buffer, salt: Buffer, credentialId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, `llmcred:${credentialId}`, KEY_BYTES));
}

/** Additional authenticated data — covered by the GCM tag but not encrypted.
 *
 *  Putting `scope` in here is the point: flipping a document from
 *  scope:'personal' to scope:'shared' in the Firebase console is the exact
 *  privilege-escalation move, and it now breaks authentication instead of
 *  silently widening who the key serves. */
const aad = (ctx: SecretContext) => Buffer.from(`${ctx.credentialId}|${ctx.provider}|${ctx.scope}`, 'utf8');

export function sealSecret(plaintext: string, ctx: SecretContext): SecretEnvelope {
  if (!plaintext) throw new SecretError('Refusing to store an empty secret.');
  const { kid, key: master } = activeKey();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(master, salt, ctx.credentialId), iv);
  cipher.setAAD(aad(ctx));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    alg: 'A256GCM',
    kid,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** Returns the plaintext key. Read the invariant at the top of this file before
 *  doing anything with the return value.
 *
 *  Failure is deliberately opaque: the caller is a route that returns its
 *  message to the browser, and "wrong key" vs "tampered AAD" vs "corrupt
 *  ciphertext" is an oracle we gain nothing from exposing. */
export function openSecret(env: SecretEnvelope, ctx: SecretContext): string {
  if (env?.v !== 1 || env.alg !== 'A256GCM') {
    throw new SecretError('That credential is stored in a format this build does not understand.');
  }
  const candidates = decryptionKeys().filter((k) => k.kid === env.kid);
  // If no kid matches, still try every key we hold — a record sealed before a
  // kid scheme change should not be unreadable just because the label moved.
  const tryKeys = candidates.length ? candidates : decryptionKeys();
  if (!tryKeys.length) {
    throw new SecretError('LLM_ENCRYPTION_KEY is not set, so stored API keys cannot be read.');
  }

  for (const { key: master } of tryKeys) {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        deriveKey(master, Buffer.from(env.salt, 'base64'), ctx.credentialId),
        Buffer.from(env.iv, 'base64'),
      );
      decipher.setAAD(aad(ctx));
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, or the document was edited. Try the next one.
    }
  }
  throw new SecretError('That credential could not be decrypted. It may need to be entered again.');
}

/** True when the environment can store secrets at all. Routes check this to
 *  give "the platform is not configured" rather than a confusing 500. */
export function encryptionConfigured(): boolean {
  try {
    activeKey();
    return true;
  } catch {
    return false;
  }
}

/** The only fragment of a key that may ever reach a browser. */
export function keyHint(plaintext: string): string {
  return plaintext.length <= 4 ? '••••' : `••••${plaintext.slice(-4)}`;
}
