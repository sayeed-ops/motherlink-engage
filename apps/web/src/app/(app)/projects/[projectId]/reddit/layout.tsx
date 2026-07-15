'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { use } from 'react';

export default function RedditLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const pathname = usePathname();
  const base = `/projects/${projectId}/reddit`;

  const tabs = [
    { href: base, label: 'Opportunities' },
    { href: `${base}/knowledge`, label: 'Knowledge' },
    { href: `${base}/settings`, label: 'Settings' },
  ];

  return (
    <>
      <nav className="tabs">
        {tabs.map((t) => (
          <Link key={t.href} href={t.href} className={`tab ${pathname === t.href ? 'active' : ''}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
