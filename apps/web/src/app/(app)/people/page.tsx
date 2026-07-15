'use client';

import PageHeader from '@/components/PageHeader';
import UsersAdmin from '@/components/UsersAdmin';

export default function PeoplePage() {
  return (
    <>
      <PageHeader
        title="People"
        description="Who can sign in to Engage. Access to each client's data is granted separately, on that project."
      />
      <UsersAdmin />
    </>
  );
}
