'use client';

import PageHeader from '@/components/PageHeader';
import RolesAdmin from '@/components/RolesAdmin';

export default function RolesPage() {
  return (
    <>
      <PageHeader
        title="Roles"
        description="Named permission sets for granting project access. Grant one to a member and its permissions are copied onto them — editing the role later never changes anyone's existing access."
      />
      <RolesAdmin />
    </>
  );
}
