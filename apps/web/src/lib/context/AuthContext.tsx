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
  /** Re-read the profile after the server changes it (e.g. editing your name). */
  refresh: () => Promise<void>;
  error: string | null;
}

const Ctx = createContext<AuthValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Read users/{uid}. Rules allow a user their own profile and nothing else. */
  const loadProfile = useCallback(async (user: User): Promise<AuthStatus> => {
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      // Absence means "not provisioned", not "error".
      if (!snap.exists()) {
        setProfile(null);
        return 'not-provisioned';
      }

      const data = snap.data() as UserProfile;
      if (data.status === 'disabled') {
        setProfile(null);
        return 'not-provisioned';
      }

      setProfile(data);
      return 'ready';
    } catch {
      // A rules denial lands here too. Treat it as unprovisioned rather than
      // leaking why.
      setProfile(null);
      return 'not-provisioned';
    }
  }, []);

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);

      if (!user) {
        setProfile(null);
        setStatus('signed-out');
        return;
      }

      const next = await loadProfile(user);
      setStatus(next);

      if (next === 'ready') {
        // Stamp the sign-in. This has to be a server call: clients cannot write,
        // by design. ML Studio writes lastLoginAt straight from the browser,
        // which only works because its rules let any signed-in user write any
        // user document — the same opening that let anyone edit anyone's role.
        //
        // Fire-and-forget: a failed timestamp must never block signing in.
        try {
          const token = await user.getIdToken();
          await fetch('/api/auth/session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch {
          // Non-fatal.
        }
      }
    });
  }, [loadProfile]);

  const refresh = useCallback(async () => {
    if (auth.currentUser) {
      const next = await loadProfile(auth.currentUser);
      setStatus(next);
    }
  }, [loadProfile]);

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
      value={{
        status,
        firebaseUser,
        profile,
        signInWithGoogle,
        signInWithPassword,
        signOut,
        getToken,
        refresh,
        error,
      }}
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
