'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db, googleProvider } from '@/lib/firebase/config';
import type { UserProfile } from '@/lib/types';

// Client auth state.
//
// The important difference from ML Studio: authentication and authorization are
// separate here. Signing in with Google proves who you are. It grants nothing.
// Access requires a users/{uid} document that only an admin (or the provisioning
// CLI) can create — the server writes it; the client cannot, and the rules tests
// prove that.
//
// So `status` has a third state ML Studio has no concept of: authenticated but
// not provisioned. That is a normal, expected outcome now that anyone with a
// Google account can reach the sign-in button, and it deserves a real screen
// rather than an empty dashboard.

export type AuthStatus = 'loading' | 'signed-out' | 'not-provisioned' | 'ready';

interface AuthValue {
  status: AuthStatus;
  firebaseUser: User | null;
  profile: UserProfile | null;
  signInWithGoogle: () => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Bearer token for calls to our own API. Every route handler requires it. */
  getToken: () => Promise<string | null>;
  error: string | null;
}

const Ctx = createContext<AuthValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);

      if (!user) {
        setProfile(null);
        setStatus('signed-out');
        return;
      }

      try {
        // Rules allow a user to read their own profile and nothing else.
        // Absence means "not provisioned", not "error".
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) {
          setProfile(null);
          setStatus('not-provisioned');
          return;
        }

        const data = snap.data() as UserProfile;
        if (data.status === 'disabled') {
          setProfile(null);
          setStatus('not-provisioned');
          return;
        }

        setProfile(data);
        setStatus('ready');
      } catch {
        // A rules denial lands here too. Treat it the same as unprovisioned
        // rather than leaking why.
        setProfile(null);
        setStatus('not-provisioned');
      }
    });
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      setError('Could not sign in with Google. Try again.');
    }
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch {
      // Deliberately vague: a precise error tells an attacker which half was
      // right, turning the form into an account-enumeration oracle.
      setError('Incorrect email or password.');
    }
  }, []);

  const signOut = useCallback(async () => {
    await fbSignOut(auth);
    setProfile(null);
    setStatus('signed-out');
  }, []);

  const getToken = useCallback(async () => {
    return auth.currentUser ? auth.currentUser.getIdToken() : null;
  }, []);

  return (
    <Ctx.Provider
      value={{ status, firebaseUser, profile, signInWithGoogle, signInWithPassword, signOut, getToken, error }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
