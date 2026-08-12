'use client';

import PageHeader from '@/components/PageHeader';
import LlmCredentialsAdmin from '@/components/LlmCredentialsAdmin';
import LlmSharedKeysAdmin from '@/components/LlmSharedKeysAdmin';
import WarmupModelSetting from '@/components/WarmupModelSetting';
import { useAuth } from '@/lib/context/AuthContext';

// Settings → API keys.
//
// Everyone manages their own key here. Admins additionally manage the shared
// organisation keys and which projects may spend them.
//
// Client-side gating is presentation only, as everywhere else in this app — the
// routes enforce it. The shared card's data comes from a response field the
// server only populates for admins, so hiding it removes an empty card rather
// than concealing anything.

export default function ApiKeysPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';
  // Warm-up design is gated on accounts.manage, which a non-admin may hold —
  // same rule the Accounts nav link uses.
  const canManageAccounts = isAdmin || !!profile?.globalPermissions?.includes('accounts.manage');

  return (
    <>
      <PageHeader
        title="API keys"
        description="Which AI provider key runs analysis, drafting and warm-up. A key granted to your project is used first; otherwise your own."
      />
      <div className="sections">
        {isAdmin && <LlmSharedKeysAdmin />}
        <LlmCredentialsAdmin />
        {canManageAccounts && <WarmupModelSetting />}
      </div>
    </>
  );
}
