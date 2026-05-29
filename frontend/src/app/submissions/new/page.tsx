"use client";

/**
 * /submissions/new — wizard for opening a new placement.
 *
 * Single-step form for Phase 1 (multi-step wizard is overkill for the 4
 * inputs we actually need). On submit, redirects to the detail page so
 * the broker can pick carriers next.
 *
 * When opened with `?prospect=<venue-id>` (from the Market broker tool's
 * "Get a quote" CTA), the venue is locked to that prospect and its estimated
 * savings + likely carriers are surfaced for context. Binding a resulting
 * quote converts the prospect → book (backend convert_prospect_to_book).
 *
 * Coverage lines come from the seeded CoverageLine table — fetched via
 * a lightweight static list here since there's no /api/coverage-lines
 * endpoint yet (didn't want to bloat the placement router with a
 * reference-data endpoint until Phase 2 actually needs it). The eight
 * lines below match the seed data in app/seed_carriers.py.
 */
import React, { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { placementApi, PlacementApiError } from "@/lib/placement";
import { authHeaders } from "@/lib/authFetch";
import { money } from "@/lib/market";
import { X } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const COVERAGE_LINE_OPTIONS = [
  { id: "gl", name: "General Liability", required: true },
  { id: "liquor", name: "Liquor Liability", required: true },
  { id: "assault_battery", name: "Assault & Battery", required: false },
  { id: "property", name: "Property", required: false },
  { id: "wc", name: "Workers Comp", required: true },
  { id: "epli", name: "EPLI", required: false },
  { id: "cyber", name: "Cyber", required: false },
  { id: "umbrella", name: "Umbrella", required: false },
];

const VENUE_OPTIONS = [
  "elsewhere-brooklyn",
  "brooklyn-mirage",
  "house-of-yes",
  "nowadays",
  "market-hotel",
];

interface ProspectContext {
  name: string;
  savings_low?: string | null;
  savings_high?: string | null;
  likely_carriers?: { id: string; name: string; market_type: string }[];
}

export default function NewSubmissionPage() {
  return (
    <Suspense fallback={<div className="page" />}>
      <NewSubmissionInner />
    </Suspense>
  );
}

function NewSubmissionInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // A prospect id seeds the venue from the Market tool. Local state so the
  // broker can clear it (× on the chip) and fall back to the manual picker.
  const [prospectId, setProspectId] = useState<string | null>(searchParams.get("prospect"));
  const [prospect, setProspect] = useState<ProspectContext | null>(null);

  const [venueId, setVenueId] = useState(prospectId ?? VENUE_OPTIONS[0]);
  const [effectiveDate, setEffectiveDate] = useState(() => {
    // Default to 60 days from today — typical broker lead time.
    const d = new Date();
    d.setDate(d.getDate() + 60);
    return d.toISOString().slice(0, 10);
  });
  const [selectedLines, setSelectedLines] = useState<Set<string>>(
    new Set(COVERAGE_LINE_OPTIONS.filter(l => l.required).map(l => l.id)),
  );
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch the prospect's pitch context so the locked venue chip can show its
  // estimated savings + likely carriers. Non-fatal if it fails — the id is
  // still a valid venue_id for submission.
  useEffect(() => {
    if (!prospectId) {
      setProspect(null);
      return;
    }
    let cancelled = false;
    setVenueId(prospectId);
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/venues/${prospectId}`, { headers: authHeaders() });
        if (!res.ok) return;
        const v = await res.json();
        if (!cancelled) {
          setProspect({
            name: v.name ?? prospectId,
            savings_low: v.savings_low,
            savings_high: v.savings_high,
            likely_carriers: v.likely_carriers ?? [],
          });
        }
      } catch {
        // non-fatal — keep the locked id, just no pitch context
      }
    })();
    return () => { cancelled = true; };
  }, [prospectId]);

  const clearProspect = () => {
    setProspectId(null);
    setProspect(null);
    setVenueId(VENUE_OPTIONS[0]);
  };

  const toggleLine = (id: string) => {
    const next = new Set(selectedLines);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedLines(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (selectedLines.size === 0) {
      setError("Select at least one coverage line.");
      return;
    }
    setBusy(true);
    try {
      const sub = await placementApi.createSubmission({
        venue_id: venueId,
        effective_date: effectiveDate,
        coverage_lines: Array.from(selectedLines),
        requested_limits: {},
        notes: notes.trim(),
      });
      router.push(`/submissions/${sub.id}`);
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Create failed");
      setBusy(false);
    }
  };

  const hasSavings = prospect && (prospect.savings_low || prospect.savings_high);

  return (
    <div className="submission-wizard">
      <PageHeader
        eyebrow="Placement"
        title="New Submission"
        subtitle={prospectId ? "Open a placement for this prospect." : "Open a new coverage placement for a venue."}
      />

      <form className="submission-wizard__form" onSubmit={submit}>
        {error && <div className="submission-wizard__error">{error}</div>}

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Venue</label>
          {prospectId ? (
            <div
              style={{
                display: "flex", flexDirection: "column", gap: 8,
                padding: "var(--space-md)", border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{prospect?.name ?? prospectId}</span>
                <button
                  type="button"
                  onClick={clearProspect}
                  aria-label="Clear prospect and choose a venue manually"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4, minHeight: 32,
                    padding: "4px 8px", border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm)", background: "none",
                    color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.75rem",
                  }}
                >
                  <X size={12} aria-hidden /> Change
                </button>
              </div>
              {hasSavings && (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--accent-ink)", fontWeight: 700 }}>
                  Est. savings {money(prospect!.savings_low ?? "0")}–{money(prospect!.savings_high ?? "0")}/yr
                </span>
              )}
              {prospect?.likely_carriers && prospect.likely_carriers.length > 0 && (
                <div className="market-card__chips">
                  {prospect.likely_carriers.slice(0, 3).map((c) => (
                    <span
                      key={c.id}
                      className={`market-chip market-chip--${c.market_type === "admitted" ? "admitted" : "es"}`}
                    >
                      {c.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <select
              className="input-field"
              value={venueId}
              onChange={e => setVenueId(e.target.value)}
              required
            >
              {VENUE_OPTIONS.map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          )}
        </div>

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Effective Date</label>
          <input
            type="date"
            className="input-field"
            value={effectiveDate}
            onChange={e => setEffectiveDate(e.target.value)}
            required
          />
        </div>

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Coverage Lines</label>
          <div className="submission-wizard__coverage-grid">
            {COVERAGE_LINE_OPTIONS.map(line => (
              <label key={line.id} className="submission-wizard__coverage-chip">
                <input
                  type="checkbox"
                  checked={selectedLines.has(line.id)}
                  onChange={() => toggleLine(line.id)}
                />
                <span className="submission-wizard__coverage-chip-name">
                  {line.name}
                  {line.required && (
                    <span style={{ color: "var(--text-tertiary)", fontSize: 10, marginLeft: 4 }}>
                      (req.)
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Notes (optional)</label>
          <textarea
            className="input-field"
            rows={3}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Anything the carrier should know — security upgrades, prior loss context, renewal story…"
          />
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => router.push("/submissions")}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={busy}
          >
            {busy ? "Creating…" : "Create Submission"}
          </button>
        </div>
      </form>
    </div>
  );
}
