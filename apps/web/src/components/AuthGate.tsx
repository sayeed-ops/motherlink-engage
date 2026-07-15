'use client';

import Image from 'next/image';
import { useAuth } from '@/lib/context/AuthContext';

// Renders children only for a signed-in, provisioned user.
//
// ML Studio's RouteGuard has a bug worth not repeating: it renders {children}
// unconditionally once loading is false and merely fires router.push() as a
// side effect, so protected content paints for at least one frame. It also
// pushes a suspended user to /login WITHOUT signing them out, leaving
// firebaseUser set, which bounces them back to / — an infinite loop.
//
// This returns early instead. Nothing protected renders unless the user is
// genuinely allowed to see it. Real enforcement is server-side regardless;
// this is UX, and it should be honest UX.

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
          <div className="brand-wordmark" style={{ width: 132 }}>
            <Image src="/logo/dark.svg" alt="Motherlink" width={132} height={22} className="logo-dark" priority />
            <Image src="/logo/light.svg" alt="Motherlink" width={132} height={22} className="logo-light" priority />
          </div>
          <div>
            <h2>Engage</h2>
            <p className="text-muted">Multi-platform promotion and conversation engagement.</p>
          </div>
          <button className="btn btn-primary" onClick={signInWithGoogle}>
            Sign in with Google
          </button>
          {error && <p className="text-error small">{error}</p>}
        </div>
      </main>
    );
  }

  if (status === 'not-provisioned') {
    return (
      <main className="center">
        <div className="card">
          <div className="brand-wordmark" style={{ width: 132 }}>
            <Image src="/logo/dark.svg" alt="Motherlink" width={132} height={22} className="logo-dark" priority />
            <Image src="/logo/light.svg" alt="Motherlink" width={132} height={22} className="logo-light" priority />
          </div>
          <div>
            <h2>Not set up yet</h2>
            <p className="text-muted">
              <span className="text-mono">{firebaseUser?.email}</span> doesn&apos;t have access to Engage.
              An administrator needs to add you before you can do anything here.
            </p>
          </div>
          <button className="btn btn-secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
