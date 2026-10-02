'use client';

import PageHeader from '@/components/PageHeader';
import DraftingInstructions from '@/components/DraftingInstructions';
import { useAuth } from '@/lib/context/AuthContext';

// House style for every Reddit reply the platform writes.
//
// Platform-wide on purpose. This is how *we* write, not what one client sells,
// and a style guide re-pasted into thirty projects is a style guide that drifts
// into thirty slightly different ones. Client-specific rules go on that
// project's Reddit settings page and are read after this.

export default function DraftingSettingsPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';

  return (
    <>
      <PageHeader
        title="Drafting instructions"
        description="How replies are written, above the built-in rules."
        crumbs={[{ label: 'Settings' }, { label: 'Drafting' }]}
      />
      {!isAdmin && (
        <div className="card">
          <p className="text-dim small">
            Read-only. Changing the house style changes every client&rsquo;s replies at once, so it is admin-only.
          </p>
        </div>
      )}
      <DraftingInstructions scope="platform" canEdit={isAdmin} />
    </>
  );
}
