'use client';

import AuthGate from '@/components/AuthGate';
import Projects from '@/components/Projects';
import UsersAdmin from '@/components/UsersAdmin';
import { useAuth } from '@/lib/context/AuthContext';

function Dashboard() {
  const { profile, signOut } = useAuth();
  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';

  return (
    <div className="shell">
      <header className="topbar">
        <strong>Motherlink Engage</strong>
        <div className="topbar-right">
          <span className="muted">{profile?.email}</span>
          <span className="pill">{profile?.role}</span>
          <button className="btn small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        <h1>Signed in</h1>
        <p className="muted">
          Authentication, the permission model, and the server tier are in place. Projects and the Reddit
          module come next.
        </p>

        <div className="card stack">
          <h2>Your account</h2>
          <dl className="kv">
            <dt>Email</dt>
            <dd>{profile?.email}</dd>
            <dt>Name</dt>
            <dd>{profile?.displayName}</dd>
            <dt>Global role</dt>
            <dd>{profile?.role}</dd>
            <dt>Status</dt>
            <dd>{profile?.status}</dd>
          </dl>
          <p className="muted small">
            Your global role governs platform-wide actions. Access to a client&apos;s data is granted
            separately, per project.
          </p>
        </div>

        <Projects />

        {isAdmin && <UsersAdmin />}
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}
