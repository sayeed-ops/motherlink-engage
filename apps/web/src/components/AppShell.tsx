'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  LayoutDashboard,
  FolderKanban,
  Users,
  UserCircle,
  LogOut,
  Menu,
  X,
  MessagesSquare,
} from 'lucide-react';
import { useAuth } from '@/lib/context/AuthContext';

// The application shell.
//
// Navigation is filtered by role, but that is presentation only — every route
// behind these links enforces its own permissions server-side. Hiding a link
// has never been a security control, and in ML Studio that distinction was
// lost: its admin pages redirect in a useEffect while the underlying writes
// stayed open to anyone signed in.

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/people', label: 'People', icon: Users, adminOnly: true },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { profile, signOut } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';
  const items = NAV.filter((i) => !i.adminOnly || isAdmin);

  const active = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <div className="app">
      <button className="nav-toggle" onClick={() => setOpen((v) => !v)} aria-label="Toggle navigation">
        {open ? <X size={18} /> : <Menu size={18} />}
      </button>

      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <MessagesSquare size={18} strokeWidth={2.2} />
          <span>Engage</span>
        </div>

        <nav className="nav">
          {items.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`nav-item ${active(href) ? 'active' : ''}`}
              onClick={() => setOpen(false)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>

        <div className="sidebar-foot">
          <Link href="/profile" className={`nav-item ${active('/profile') ? 'active' : ''}`}>
            <UserCircle size={16} />
            <span className="truncate">{profile?.displayName ?? 'Profile'}</span>
          </Link>
          <button className="nav-item as-button" onClick={signOut}>
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {open && <div className="scrim" onClick={() => setOpen(false)} />}

      <main className="main">{children}</main>
    </div>
  );
}
