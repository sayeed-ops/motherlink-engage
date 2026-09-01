'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, ShieldCheck } from 'lucide-react';
import { apiGet, apiFetch, ApiError } from '@/lib/api';
import { COMPLIANCE_DECISIONS } from '@/modules/covers/onboarding';
import { DIMENSIONS, DIMENSION_ASKS, DIMENSION_LABEL, isInverted } from '@/modules/covers/score';

// Covers policy — who this client may talk to, and what a reply may say.
//
// ════════════════════════════════════════════════════════════════════════════
// THIS SCREEN EXISTS SO NOBODY EVER OPENS FIRESTORE
//
// Everything on it is either derived at project creation or has a defensible
// default. Two things are neither — the prohibited jurisdictions and the
// disclosure wording — and those come from a licence and a lawyer. They are the
// only fields that require a person, and the CONFIRM button at the bottom is
// what says a person has looked.
//
// ⚠️ CONFIRMING IS NOT A FORMALITY. Until it happens the client-drawing
// variants are withheld and only the community reply is written, because an
// unconfirmed prohibited-jurisdiction list does not mean there are none — it
// means nobody has said, and offering a sportsbook to somebody it cannot
// legally serve is the one mistake here that editing a draft cannot undo.
// ════════════════════════════════════════════════════════════════════════════

interface Policy {
  jurisdiction: { prohibited: string[]; licensed: string[] };
  variants: { brandMentioned: boolean; brandInformed: boolean; communityOnly: boolean };
  brandNames: string[];
  disclosureWording: string;
  floors: Record<string, number>;
  complianceConfirmed: boolean;
  confirmedByName: string | null;
  brandNamesDerived: boolean;
}

interface PolicyView {
  policy: Policy;
  derived: { brandNames: string[] };
  needsSetup: boolean;
  outstanding: string[];
}

const list = (v: string) =>
  v
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

export default function CoversPolicyTab({
  projectId,
  onSaved,
}: {
  projectId: string;
  onSaved?: () => void;
}) {
  const [view, setView] = useState<PolicyView | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [prohibited, setProhibited] = useState('');
  const [licensed, setLicensed] = useState('');
  const [brands, setBrands] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await apiGet<PolicyView>(`/api/projects/${projectId}/covers/policy`);
      setView(res);
      setDraft(res.policy);
      setProhibited(res.policy.jurisdiction.prohibited.join(', '));
      setLicensed(res.policy.jurisdiction.licensed.join(', '));
      setBrands(res.policy.brandNames.join(', '));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not read the policy.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (confirming: boolean) => {
    if (!draft) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await apiFetch(`/api/projects/${projectId}/covers/policy`, {
        method: 'PUT',
        body: JSON.stringify({
          policy: {
            ...draft,
            brandNames: list(brands),
            jurisdiction: { prohibited: list(prohibited), licensed: list(licensed) },
            complianceConfirmed: confirming || draft.complianceConfirmed,
            brandNamesDerived: false,
          },
        }),
      });
      setSaved(true);
      await load();
      onSaved?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  if (!draft || !view) {
    return <p className="text-dim small">{error || 'Loading…'}</p>;
  }

  const brandList = list(brands);

  return (
    <div className="sections">
      {/* ── the state of play, said first ──────────────────────────────── */}
      <section className={`card ${view.policy.complianceConfirmed ? '' : 'alert-warn'}`}>
        <div className="card-head">
          <h3>
            {view.policy.complianceConfirmed ? (
              <>
                <ShieldCheck size={16} aria-hidden /> Compliance confirmed
              </>
            ) : (
              <>
                <AlertTriangle size={16} aria-hidden /> Not confirmed yet
              </>
            )}
          </h3>
        </div>

        {view.policy.complianceConfirmed ? (
          <p className="small text-dim">
            Confirmed by {view.policy.confirmedByName || 'someone'}. All three reply variants are
            available, subject to the section roles and the claim ledger.
          </p>
        ) : (
          <>
            <p className="small">
              <strong>Only the community-only reply will be written until this is confirmed.</strong> The
              variants that draw on the client are withheld — an unconfirmed prohibited-jurisdiction list
              does not mean there are none, it means nobody has said.
            </p>
            <ul className="small text-dim">
              {view.outstanding.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </>
        )}

        {view.needsSetup && (
          <p className="small text-dim">
            This project predates automatic setup, so nothing is stored yet. The values below were worked
            out from the project name, the client website and the asset library — check them and press
            Save.
          </p>
        )}
      </section>

      {/* ── derived, and rarely touched ────────────────────────────────── */}
      <section className="card">
        <div className="card-head">
          <h3>Brand names</h3>
        </div>
        <p className="text-dim small">
          Every way this client gets written. Worked out from the project name, the website and the asset
          library — correct them if a real one is missing.
        </p>
        <p className="text-dim small">
          <strong>These are load-bearing in both directions.</strong> The brand-mentioned reply uses them to
          name the client, and the other two variants are checked against them.{' '}
          <strong>An empty list disables brand detection silently</strong> rather than failing, which is why
          it is filled in for you.
        </p>
        <input
          className="input"
          value={brands}
          onChange={(e) => setBrands(e.target.value)}
          placeholder="Northwind, Northwind Bet"
          style={{ width: '100%' }}
        />
        {brandList.length === 0 && (
          <p className="text-error small">
            ⚠️ With no brand names, a community-only reply could name the client and nothing would flag it.
          </p>
        )}
        {view.derived.brandNames.length > 0 && (
          <p className="text-dim small">derived: {view.derived.brandNames.join(', ')}</p>
        )}
      </section>

      {/* ── the two things nobody can derive ───────────────────────────── */}
      <section className="card">
        <div className="card-head">
          <h3>Jurisdictions — from the licence</h3>
        </div>
        <p className="text-dim small">
          Places the client <strong>cannot</strong> take customers. A thread asking for a sportsbook from
          one of these is not a weak opportunity, it is a prohibited one, and the reply that draws on the
          client is removed outright. Short codes are matched case-sensitively, so write{' '}
          <code>US</code> rather than <code>us</code>.
        </p>
        <label className="label">Prohibited</label>
        <input
          className="input"
          value={prohibited}
          onChange={(e) => setProhibited(e.target.value)}
          placeholder="US, Ontario, France"
          style={{ width: '100%' }}
        />
        <label className="label" style={{ marginTop: '0.5rem' }}>
          Licensed — for explaining a decision only
        </label>
        <input
          className="input"
          value={licensed}
          onChange={(e) => setLicensed(e.target.value)}
          placeholder="UK, Ireland"
          style={{ width: '100%' }}
        />
        <p className="text-dim small">
          Leaving prohibited empty is a legitimate answer for a client with no restrictions — but it has to
          be an answer somebody gave, which is what confirming below records.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Disclosure wording — from counsel</h3>
        </div>
        <p className="text-dim small">
          Attached as a <strong>flag</strong> when a reply names the client — never inserted into the text.
          You approve what gets posted, so the wording is yours to place. Empty means no flag is raised,
          and no standard wording is invented for you.
        </p>
        <input
          className="input"
          value={draft.disclosureWording}
          onChange={(e) => setDraft({ ...draft, disclosureWording: e.target.value })}
          placeholder="Posted on behalf of <client>."
          style={{ width: '100%' }}
        />
      </section>

      {/* ── switches with safe defaults ────────────────────────────────── */}
      <section className="card">
        <div className="card-head">
          <h3>Which replies may be written</h3>
        </div>
        <div style={{ display: 'grid', gap: '0.4rem' }}>
          {(
            [
              ['brandMentioned', 'Brand mentioned — names the client', 'Off by default. Also needs a section tagged “promote” and a live claim to cite.'],
              ['brandInformed', 'Brand informed — the knowledge, no name', 'On by default.'],
              ['communityOnly', 'Community only — an ordinary useful post', 'On by default.'],
            ] as const
          ).map(([key, label, note]) => (
            <label key={key} className="row small" style={{ gap: '0.4rem', alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={draft.variants[key]}
                onChange={(e) => setDraft({ ...draft, variants: { ...draft.variants, [key]: e.target.checked } })}
              />
              <span>
                <strong>{label}</strong>
                <div className="text-dim">{note}</div>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* ── floors, with the honest label ──────────────────────────────── */}
      <section className="card">
        <div className="card-head">
          <h3>Score floors</h3>
        </div>
        <p className="text-dim small">
          A variant below any of these is dropped before the critic. <strong>Uncalibrated</strong> — these
          are judgements made before a single human decision existed to compare them against. Move them
          from the Calibration panel once there are 20 decisions, not before.
        </p>
        <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
          {DIMENSIONS.map((d) => (
            <label key={d} className="small" title={DIMENSION_ASKS[d]}>
              <div className="label">
                {DIMENSION_LABEL[d]}
                {isInverted(d) && ' (max)'}
              </div>
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                value={draft.floors?.[d] ?? 0}
                onChange={(e) =>
                  setDraft({ ...draft, floors: { ...draft.floors, [d]: Number(e.target.value) } })
                }
                style={{ width: '5.5rem' }}
              />
            </label>
          ))}
        </div>
      </section>

      {error && <p className="text-error small">{error}</p>}
      {saved && <p className="small text-dim">Saved.</p>}

      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => void save(false)} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>

        {!view.policy.complianceConfirmed && (
          <button className="btn btn-primary btn-sm" onClick={() => void save(true)} disabled={busy}>
            <Check size={14} aria-hidden /> Save and confirm compliance
          </button>
        )}
      </div>

      {!view.policy.complianceConfirmed && (
        <p className="text-dim small">
          Confirming records that you have answered these, in your name:
          <br />
          {COMPLIANCE_DECISIONS.map((d) => (
            <span key={d}>
              — {d}
              <br />
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
