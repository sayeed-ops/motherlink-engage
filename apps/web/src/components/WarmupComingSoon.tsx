'use client';

import type { ReactNode } from 'react';
import { Construction } from 'lucide-react';

// Placeholder for a warm-up component that is designed but not built.
//
// Deliberately has NO controls. A tab with dead sliders behind it is worse than
// an empty one — the package designer's real failure was that six of its
// fourteen actions had no primitive, so a plan could report success having done
// a fraction of what it said. Nothing here should suggest a capability that does
// not exist yet.
//
// It says what the component WILL do, what it depends on, and what it must not
// be confused with, because those are the questions someone opening this tab in
// three months actually has.

export default function WarmupComingSoon({
  title,
  summary,
  depends,
  notYet,
}: {
  title: string;
  summary: ReactNode;
  /** What has to exist before this can be built. */
  depends: string[];
  /** What this is deliberately NOT, where confusion is likely. */
  notYet?: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <Construction size={15} style={{ verticalAlign: '-2px' }} /> {title}
        </h3>
        <span className="badge badge-no-dot">Not built</span>
      </div>

      <p className="text-dim small" style={{ marginTop: 0 }}>
        {summary}
      </p>

      {notYet && (
        <p className="text-dim small" style={{ marginTop: 0 }}>
          {notYet}
        </p>
      )}

      <div className="bordered" style={{ padding: 12 }}>
        <span className="eyebrow-muted">Blocked on</span>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {depends.map((d) => (
            <li key={d} className="text-dim small" style={{ marginBottom: 2 }}>
              {d}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
