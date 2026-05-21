"use client";

/**
 * /submissions/new — wizard for opening a new placement.
 *
 * Single-step form for Phase 1 (multi-step wizard is overkill for the 4
 * inputs we actually need). On submit, redirects to the detail page so
 * the broker can pick carriers next.
 *
 * Coverage lines come from the seeded CoverageLine table — fetched via
 * a lightweight static list here since there's no /api/coverage-lines
 * endpoint yet (didn't want to bloat the placement router with a
 * reference-data endpoint until Phase 2 actually needs it). The eight
 * lines below match the seed data in app/seed_carriers.py.
 */
import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { placementApi, PlacementApiError } from "@/lib/placement";


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


export default function NewSubmissionPage() {
  const router = useRouter();
  const [venueId, setVenueId] = useState(VENUE_OPTIONS[0]);
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

  return (
    <div className="submission-wizard">
      <PageHeader
        eyebrow="Placement"
        title="New Submission"
        subtitle="Open a new coverage placement for a venue."
      />

      <form className="submission-wizard__form" onSubmit={submit}>
        {error && <div className="submission-wizard__error">{error}</div>}

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Venue</label>
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
