'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

// Chip input for string[]. Ported in behaviour from ML Studio's ArrayInput:
// commit on Enter, comma, or blur; Backspace on an empty draft pops the last
// chip; duplicates are dropped silently.
//
// The blur commit matters — without it, typing a value and clicking Save
// silently loses it, which is the kind of bug people quietly work around
// forever instead of reporting.

export default function ArrayInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  const commit = (raw: string) => {
    const v = raw.trim().replace(/,$/, '');
    if (!v) return;
    if (!value.includes(v)) onChange([...value, v]);
    setDraft('');
  };

  return (
    <div className="chips">
      {value.map((v) => (
        <span key={v} className="chip">
          {v}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="chip-input"
        value={draft}
        placeholder={value.length === 0 ? placeholder : ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(',')) commit(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
      />
    </div>
  );
}
