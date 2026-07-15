'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
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
      <PageHeader
        title={`Welcome back, ${first}`}
        description="Multi-platform promotion and conversation engagement."
      />

      <div className="sections">
        <section className="grid-2">
          <div className="card">
            <p className="eyebrow-muted">Projects</p>
            <p className="stat">{projects === null ? '—' : projects.length}</p>
            <p className="text-dim small">
              {projects?.length === 1 ? 'client workspace' : 'client workspaces'} you can access
            </p>
            <Link href="/projects" className="link-row">
              View projects <ArrowRight size={13} />
            </Link>
          </div>

          <div className="card">
            <p className="eyebrow-muted">Platforms</p>
            <p className="stat">1</p>
            <p className="text-dim small">Reddit live · Quora and LinkedIn planned</p>
            <p className="text-faint small" style={{ marginTop: 12 }}>
              Modules are enabled per project
            </p>
          </div>
        </section>

        {projects && projects.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h3>Your projects</h3>
            </div>
            <ul className="list">
              {projects.slice(0, 5).map((p) => (
                <li key={p.projectId} className="list-row">
                  <div>
                    <Link href={`/projects/${p.projectId}`} className="strong-link">
                      {p.name}
                    </Link>
                    {p.clientWebsiteUrl && <div className="text-dim small">{p.clientWebsiteUrl}</div>}
                  </div>
                  <div className="row">
                    {p.enabledModules?.map((m) => (
                      <span key={m} className="badge badge-primary">
                        {m}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
