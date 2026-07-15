import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// Client-side Firebase.
//
// NEXT_PUBLIC_* values are compiled into the browser bundle and are public by
// design — the API key is an identifier, not a secret. What protects the data
// is security rules, which for Engage deny every client write and scope reads
// to project membership.
//
// Note what is NOT exported here: Storage. ML Studio exports a `storage`
// handle that no file imports. Engage adds it when something needs it.

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

if (!config.apiKey || !config.projectId) {
  throw new Error(
    'Firebase client config is missing. Copy apps/web/.env.example to .env.local and fill in the NEXT_PUBLIC_FIREBASE_* values.',
  );
}

const app = getApps().length === 0 ? initializeApp(config) : getApp();

export const auth = getAuth(app);
export const db = getFirestore(app);

/**
 * Google is the primary sign-in route.
 *
 * This replaces ML Studio's invitation-token flow entirely. There, signup
 * hinged on a Math.random() token generated in the browser, stored in
 * plaintext, and readable by anyone. Here an admin provisions a user by email,
 * the user signs in with Google, and the server matches their *verified*
 * email. There is no token to leak.
 */
export const googleProvider = new GoogleAuthProvider();

export default app;
