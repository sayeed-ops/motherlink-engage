'use client';

import { useAuth } from '@/lib/context/AuthContext';

// Renders children only for a signed-in, provisioned user.
//
// ML Studio's RouteGuard has a real bug worth not repeating: it renders
// {children} unconditionally once loading is false, and merely fires a
// router.push() as a side effect. Protected content paints for at least one
// frame — longer if the redirect is slow. It also pushes a suspended user to
// /login without signing them out, so firebaseUser stays set, which bounces
// them back to / and into an infinite loop.
//
// This gate returns early instead of redirecting. Nothing protected renders
// unless the user is genuinely allowed to see it. The real enforcement is
// server-side anyway; this is UX, and it should be honest UX.

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, firebaseUser, signInWithGoogle, signOut, error } = useAuth();

  if (status === 'loading') {
    return (
      <main className="center">
        <div className="spinner" aria-label="Loading" />
      </main>
    );
  }

  if (status === 'signed-out') {
    return (
      <main className="center">
        <div className="card">
          <h1>Motherlink Engage</h1>
          <p className="muted">Multi-platform promotion and conversation engagement.</p>
          <button className="btn primary" onClick={signInWithGoogle}>
            Sign in with Google
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      </main>
    );
  }

  if (status === 'not-provisioned') {
    return (
      <main className="center">
        <div className="card">
          <h1>You&apos;re signed in, but not set up yet</h1>
          <p className="muted">
            {firebaseUser?.email} doesn&apos;t have access to Engage. An administrator needs to add you
            before you can do anything here.
          </p>
          <button className="btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
