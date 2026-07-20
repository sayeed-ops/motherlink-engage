'use client';

import {
  PERMISSION_META,
  PERMISSION_GROUP_LABELS,
  type Permission,
  type PermissionGroup,
} from '@/lib/types';

// A grouped checkbox editor for a set of permissions.
//
// Shared by the role builder (/roles) and the per-member editor (project page),
// so "what actions can this cover" is defined once. Grouped by the boundary that
// actually matters — free / spends money / touches the public internet — because
// that is the distinction worth seeing while granting. Each row is a full-width
// hit target that highlights when selected.

const GROUP_ORDER: PermissionGroup[] = ['free', 'spend', 'publish'];

export default function PermissionCheckboxes({
  value,
  onChange,
  disabled = false,
}: {
  value: Permission[];
  onChange: (next: Permission[]) => void;
  disabled?: boolean;
}) {
  const held = new Set(value);

  function toggle(id: Permission, on: boolean) {
    const next = new Set(held);
    if (on) next.add(id);
    else next.delete(id);
    onChange(PERMISSION_META.filter((p) => next.has(p.id)).map((p) => p.id));
  }

  return (
    <div className="perm-groups">
      {GROUP_ORDER.map((group) => (
        <div key={group} className="perm-group">
          <p className="perm-group-title">{PERMISSION_GROUP_LABELS[group]}</p>
          <div className="perm-list">
            {PERMISSION_META.filter((p) => p.group === group).map((p) => {
              const on = held.has(p.id);
              return (
                <label
                  key={p.id}
                  className={`perm-item${on ? ' selected' : ''}${disabled ? ' disabled' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={disabled}
                    onChange={(e) => toggle(p.id, e.target.checked)}
                  />
                  <span className="perm-item-text">
                    <span className="perm-item-label">{p.label}</span>
                    <span className="perm-item-help">{p.help}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
