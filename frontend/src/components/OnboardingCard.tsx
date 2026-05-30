"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { authHeaders } from "@/lib/authFetch";
import {
  CoverageLine,
  fetchCoverageLines,
  isProfileComplete,
  saveCoverageProfile,
} from "@/lib/coverageProfile";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

type Status = "have_policy" | "uninsured" | "unsure";

const STATUS_OPTIONS: [Status, string][] = [
  ["have_policy", "I have a current policy"],
  ["uninsured", "Currently uninsured / between policies"],
  ["unsure", "Not sure"],
];

/** Operator nudge: capture the insurance "knowns" so a broker can shop coverage.
 * Self-contained — fetches its own venue profile + the CoverageLine catalog.
 * Collapses to a confirmation once the profile is complete. Never gates anything
 * the operator does elsewhere (incident logging stays open). */
export default function OnboardingCard({
  venueId,
  onSaved,
}: {
  venueId: string;
  onSaved?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [complete, setComplete] = useState(false);
  const [lines, setLines] = useState<CoverageLine[]>([]);
  const [status, setStatus] = useState<Status>("have_policy");
  const [carrier, setCarrier] = useState("");
  const [renewal, setRenewal] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [vRes, catalog] = await Promise.all([
        fetch(`${API_URL}/api/venues/${venueId}`, { headers: authHeaders() }),
        fetchCoverageLines(),
      ]);
      if (cancelled) return;
      setLines(catalog);
      const requiredDefaults = catalog.filter((l) => l.is_required_by_default).map((l) => l.id);
      if (vRes.ok) {
        const v = await vRes.json();
        setComplete(isProfileComplete(v));
        const cc: string | null = v.current_carrier ?? null;
        if (cc === "uninsured" || cc === "unsure") setStatus(cc);
        else if (cc) {
          setStatus("have_policy");
          setCarrier(cc);
        }
        if (v.renewal_date) setRenewal(v.renewal_date);
        const ci: string[] = Array.isArray(v.coverage_interest) ? v.coverage_interest : [];
        setSelected(new Set(ci.length ? ci : requiredDefaults));
      } else {
        setSelected(new Set(requiredDefaults));
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [venueId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setError(null);
    if (status === "have_policy" && !carrier.trim()) {
      setError("Enter your current carrier.");
      return;
    }
    if (status === "have_policy" && !renewal) {
      setError("Enter your renewal date.");
      return;
    }
    if (selected.size === 0) {
      setError("Select at least one coverage line.");
      return;
    }
    setSaving(true);
    try {
      const res = await saveCoverageProfile(venueId, {
        current_carrier: status === "have_policy" ? carrier.trim() : status,
        renewal_date: status === "have_policy" ? renewal : null,
        coverage_interest: [...selected],
      });
      if (res.ok) {
        setComplete(true);
        onSaved?.();
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.detail?.message ?? "Could not save. Please try again.");
      }
    } catch {
      setError("Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  if (complete) {
    return (
      <div className="card flex items-center gap-sm">
        <CheckCircle2 size={18} aria-hidden style={{ color: "var(--state-success)", flexShrink: 0 }} />
        <span className="text-sm">Profile complete — ready for quotes.</span>
      </div>
    );
  }

  return (
    <div className="card" aria-labelledby="onboarding-title">
      <div className="flex items-center gap-sm mb-sm">
        <ShieldCheck size={18} aria-hidden style={{ color: "var(--accent-ink)", flexShrink: 0 }} />
        <h2 id="onboarding-title" className="text-sm font-semibold" style={{ margin: 0 }}>
          Complete your profile to get quoted
        </h2>
      </div>
      <p className="text-sm text-secondary mb-md">
        Tell your broker what you have today so they can shop the right coverage. You can keep
        logging incidents either way.
      </p>

      <fieldset className="mb-md" style={{ border: "none", padding: 0, margin: 0 }}>
        <legend className="text-xs uppercase tracking-wide text-secondary mb-sm">
          Current insurance
        </legend>
        {STATUS_OPTIONS.map(([val, label]) => (
          <label key={val} className="flex items-center gap-sm" style={{ minHeight: 44, cursor: "pointer" }}>
            <input
              type="radio"
              name="ins-status"
              value={val}
              checked={status === val}
              onChange={() => setStatus(val)}
            />
            <span className="text-sm">{label}</span>
          </label>
        ))}
      </fieldset>

      {status === "have_policy" && (
        <div className="mb-md">
          <div className="input-wrapper" style={{ marginBottom: "var(--space-sm)" }}>
            <label className="input-label" htmlFor="ob-carrier">Current carrier</label>
            <input
              id="ob-carrier"
              className="input-field"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              placeholder="e.g. Hiscox"
            />
          </div>
          <div className="input-wrapper">
            <label className="input-label" htmlFor="ob-renewal">
              Renewal date <span aria-hidden className="text-error">*</span>
            </label>
            <input
              id="ob-renewal"
              className="input-field"
              type="date"
              value={renewal}
              onChange={(e) => setRenewal(e.target.value)}
            />
          </div>
        </div>
      )}

      <fieldset className="mb-md" style={{ border: "none", padding: 0, margin: 0 }}>
        <legend className="text-xs uppercase tracking-wide text-secondary mb-sm">
          Coverage you want
        </legend>
        <div className="flex flex-col gap-xs">
          {lines.map((l) => (
            <label key={l.id} className="flex items-start gap-sm" style={{ minHeight: 44, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selected.has(l.id)}
                onChange={() => toggle(l.id)}
                style={{ marginTop: 4 }}
              />
              <span>
                <span className="text-sm">{l.name}</span>
                <span className="text-xs text-secondary" style={{ display: "block" }}>{l.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {error && (
        <p className="text-sm text-error mb-sm" role="alert">
          {error}
        </p>
      )}

      <button type="button" className="btn btn-primary" onClick={save} disabled={saving} style={{ minHeight: 44 }}>
        {saving ? "Saving…" : "Save & get quoted"}
      </button>
    </div>
  );
}
