'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FolderKanban, MessagesSquare, ArrowRight } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useAuth } from '@/lib/context/AuthContext';
import { apiGet } from '@/lib/api';
import type { Project } from '@/lib/types';

export default function DashboardPage() {
  const { profile } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    apiGet<{ projects: Project[] }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch(() => setProjects([]));
  }, []);

  const first = profile?.displayName?.split(' ')[0] ?? 'there';

  return (
    <>
      <PageHeader title={`Welcome back, ${first}`} description="Multi-platform promotion and conversation engagement." />

      <section className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <FolderKanban size={15} />
            <h2>Projects</h2>
          </div>
          <p className="stat">{projects === null ? '—' : projects.length}</p>
          <p className="muted small">
            {projects?.length === 1 ? 'client workspace' : 'client workspaces'} you can access
          </p>
          <Link href="/projects" className="link-row">
            View projects <ArrowRight size={13} />
          </Link>
        </div>

        <div className="panel">
          <div className="panel-head">
            <MessagesSquare size={15} />
            <h2>Platforms</h2>
          </div>
          <p className="stat">1</p>
          <p className="muted small">Reddit live · Quora and LinkedIn planned</p>
          <span className="muted small dim">Modules are enabled per project</span>
        </div>
      </section>

      {projects && projects.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Your projects</h2>
          </div>
          <ul className="list">
            {projects.slice(0, 5).map((p) => (
              <li key={p.projectId} className="list-row">
                <div>
                  <Link href={`/projects/${p.projectId}`} className="strong-link">
                    {p.name}
                  </Link>
                  {p.clientWebsiteUrl && <div className="muted small">{p.clientWebsiteUrl}</div>}
                </div>
                <div className="row">
                  {p.enabledModules?.map((m) => (
                    <span key={m} className="pill">
                      {m}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
