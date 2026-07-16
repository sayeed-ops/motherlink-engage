'use client';

import { useEffect, useState } from 'react';
import { getDoc, doc } from 'firebase/firestore';
import { db } from '@/lib/firebase/config';
import { subscribeMyProjectIds } from '@/lib/data';
import { useAuth } from '@/lib/context/AuthContext';
import type { Project } from '@/lib/types';

// The projects the current user can see, live.
//
// A platform admin can see every project, but there is no cheap client query
// for "all projects" that rules would allow — that is exactly what membership
// gates. So admins fall back to the cached server list; everyone else reads
// their own memberships directly and resolves each project doc. Members are the
// common case and the one that must feel instant.

export function useProjects(): { projects: Project[] | null; error: string | null } {
  const { profile } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = profile?.role === 'owner' || profile?.role === 'admin';
  const uid = profile?.uid;

  useEffect(() => {
    if (!uid) return;

    if (isAdmin) {
      import('@/lib/api').then(({ apiGet }) =>
        apiGet<{ projects: Project[] }>('/api/projects')
          .then((r) => setProjects(r.projects))
          .catch((e) => {
            setError(e.message);
            setProjects([]);
          }),
      );
      return;
    }

    return subscribeMyProjectIds(
      uid,
      async (projectIds) => {
        const docs = await Promise.all(
          projectIds.map((pid) => getDoc(doc(db, 'projects', pid)).catch(() => null)),
        );
        setProjects(
          docs
            .filter((d): d is NonNullable<typeof d> => Boolean(d?.exists()))
            .map((d) => ({ projectId: d.id, ...d.data() }) as Project)
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      },
      (e) => {
        setError(e.message);
        setProjects([]);
      },
    );
  }, [uid, isAdmin]);

  return { projects, error };
}
