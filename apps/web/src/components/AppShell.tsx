'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  FolderKanban,
  Users,
  ShieldCheck,
  KeyRound,
  ScrollText,
  UserCircle,
  LogOut,
  Menu,
  X,
  Sun,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useAuth } from '@/lib/context/AuthContext';
import { useTheme } from '@/lib/context/ThemeContext';
import SidebarAgentControl from '@/components/SidebarAgentControl';

// The application shell, built on ML Studio's design system: Vercel structure,
// Motherlink indigo. Every class here (.sidebar, .nav-item, .btn-ghost,
// .app-container) comes from the shared globals.css, so Engage and ML Studio
// stay visually identical without a component library between them.
//
// Navigation is filtered by role, but that is presentation only — every route
// behind these links enforces its own permissions server-side. Hiding a link
// is not a control. ML Studio lost that distinction: its admin pages redirect
// in a useEffect while the writes underneath stayed open to anyone signed in.

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const WORKSPACE: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { profile, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Restore the persisted collapse preference on mount. Rendering the default
  // (expanded) first keeps SSR and hydration in agreement; this corrects it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(localStorage.getItem('motherlink-engage:sidebar-collapsed') === '1');
  }, []);

  function toggleCollapsed() {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem('motherlink-engage:sidebar-collapsed', next ? '1' : '0');
      return next;
    });
  }

  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';
  // accounts.manage is a global permission a non-admin may hold, so the Accounts
  // link is shown for it too — while People and Activity stay admin-only.
  const canManageAccounts = isAdmin || !!profile?.globalPermissions?.includes('accounts.manage');
  const adminItems: NavItem[] = [
    ...(isAdmin ? [{ href: '/people', label: 'People', icon: Users }] : []),
    ...(isAdmin ? [{ href: '/roles', label: 'Roles', icon: ShieldCheck }] : []),
    ...(canManageAccounts ? [{ href: '/accounts', label: 'Accounts', icon: KeyRound }] : []),
    ...(isAdmin ? [{ href: '/activity', label: 'Activity', icon: ScrollText }] : []),
  ];
  const active = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  const renderNav = (items: NavItem[]) =>
    items.map(({ href, label, icon: Icon }) => (
      <Link
        key={href}
        href={href}
        className={`nav-item ${active(href) ? 'active' : ''}`}
        onClick={() => setOpen(false)}
      >
        <Icon size={15} />
        <span>{label}</span>
      </Link>
    ));

  return (
    <div className={`app-container ${collapsed ? 'collapsed' : ''}`}>
      <button className="mobile-nav-toggle btn btn-secondary btn-icon" onClick={() => setOpen((v) => !v)} aria-label="Toggle navigation">
        {open ? <X size={16} /> : <Menu size={16} />}
      </button>

      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="logo-section">
          <Link href="/" className="brand-wordmark" style={{ width: 106 }} aria-label="Motherlink Engage">
            <Image src="/logo/dark.svg" alt="Motherlink Engage" width={83} height={24} className="logo-dark" priority />
            <Image src="/logo/light.svg" alt="Motherlink Engage" width={83} height={24} className="logo-light" priority />
          </Link>
          <Link href="/" className="brand-mark" aria-label="Motherlink Engage">
            <Image src="/logo/mark.svg" alt="Motherlink Engage" width={26} height={26} priority />
          </Link>
          <button
            className="sidebar-collapse-btn"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <div className="nav-section">
          <p className="nav-title">Workspace</p>
          {renderNav(WORKSPACE)}
        </div>

        {adminItems.length > 0 && (
          <div className="nav-section">
            <p className="nav-title">Administration</p>
            {renderNav(adminItems)}
          </div>
        )}

        <SidebarAgentControl />

        <div className="sidebar-foot">
          <button className="nav-item as-button" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <Link
            href="/profile"
            className={`nav-item ${active('/profile') ? 'active' : ''}`}
            onClick={() => setOpen(false)}
          >
            <UserCircle size={15} />
            <span className="truncate">{profile?.displayName ?? 'Profile'}</span>
          </Link>
          <button className="nav-item as-button" onClick={signOut}>
            <LogOut size={15} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {open && <div className="scrim" onClick={() => setOpen(false)} />}

      <div className="main-content">
        <div className="content-body">{children}</div>
      </div>
    </div>
  );
}
