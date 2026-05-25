"use client";

/**
 * /submissions/[sid] — submission detail + quote comparison.
 *
 * Three sections:
 *   1. Summary strip — venue, status, effective date, lines requested.
 *   2. Carrier picker — shows carriers in appetite, broker selects N to
 *      submit (only shown while submission.status === 'open').
 *   3. Quote comparison grid — once submitted, one CarrierQuoteCard per
 *      carrier with premium, line breakdown, fees, and recommend/decline
 *      actions.
 *
 * Money values come back from the API as STRINGS (per the JSON storage
 * contract). They're displayed via formatCurrency() at render time only;
 * never parsed into floats in component state.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  Carrier,
  CarrierQuote,
  PlacementApiError,
  PremiumBreakdown,
  STATUS_LABEL,
  STATUS_TONE,
  SubmissionDetail,
  formatCurrency,
  formatPct,
  placementApi,
} from "@/lib/placement";
import { policiesApi } from "@/lib/policies";


// ─── Carrier quote card (per-carrier comparison cell) ───────────────────

function CarrierQuoteCardComponent({
  quote,
  carrierName,
  marketType,
  onSelect,
  onRecordResponse,
  onBind,
}: {
  quote: CarrierQuote;
  carrierName: string;
  marketType: string;
  onSelect: () => void;
  onRecordResponse: (status: "quoted" | "declined") => void;
  onBind: () => void;
}) {
  const breakdown = quote.premium_breakdown as PremiumBreakdown | undefined;
  const total = breakdown?.total;
  const lines = breakdown?.lines ?? {};
  const fees = breakdown?.fees;

  return (
    <div
      className={
        "carrier-quote-card" +
        (quote.is_selected ? " is-selected" : "") +
        (quote.status === "declined" ? " is-declined" : "")
      }
      data-testid="quote-comparison-row"
    >
      <div className="carrier-quote-card__head">
        <div>
          <div className="carrier-quote-card__carrier">{carrierName}</div>
          <div className="carrier-quote-card__market">{marketType}</div>
        </div>
        <StatusPill tone={
          quote.status === "quoted" ? "success" :
          quote.status === "declined" ? "warning" :
          quote.status === "bound" ? "success" :
          quote.status === "withdrawn" ? "neutral" : "info"
        }>
          {quote.status}
        </StatusPill>
      </div>

      {total ? (
        <div>
          <div className="carrier-quote-card__total-label">Total Annual</div>
          <div className="carrier-quote-card__total">{formatCurrency(total)}</div>
        </div>
      ) : (
        <div className="carrier-quote-card__market">
          Waiting on carrier response
        </div>
      )}

      {Object.keys(lines).length > 0 && (
        <div className="carrier-quote-card__lines">
          {Object.entries(lines).map(([line, info]) => (
            <div key={line} className="carrier-quote-card__line-row">
              <span className="carrier-quote-card__line-name">{line}</span>
              <span className="carrier-quote-card__line-value">
                {formatCurrency(info.premium)}
              </span>
            </div>
          ))}
        </div>
      )}

      {fees && (
        <div className="carrier-quote-card__fees">
          Policy fee {formatCurrency(fees.policy_fee)}
          {parseFloat(fees.surplus_lines_tax || "0") > 0 && (
            <> · Surplus lines tax {formatCurrency(fees.surplus_lines_tax)}</>
          )}
          {breakdown?.commission_rate && (
            <> · Commission {formatPct(breakdown.commission_rate)}</>
          )}
        </div>
      )}

      {quote.decline_reason && (
        <div className="carrier-quote-card__decline">
          {quote.decline_reason}
        </div>
      )}

      <div className="carrier-quote-card__actions">
        {quote.status === "requested" || quote.status === "pending" ? (
          <>
            <button
              type="button"
              className="submission-card__btn"
              onClick={() => onRecordResponse("quoted")}
            >
              Record quote
            </button>
            <button
              type="button"
              className="submission-card__btn submission-card__btn--danger"
              onClick={() => onRecordResponse("declined")}
            >
              Mark declined
            </button>
          </>
        ) : quote.status === "quoted" ? (
          <>
            <button
              type="button"
              className="submission-card__btn"
              onClick={onSelect}
              disabled={quote.is_selected}
            >
              {quote.is_selected ? "✓ Recommended" : "Recommend"}
            </button>
            {quote.is_selected && (
              <button
                type="button"
                className="submission-card__btn"
                style={{
                  background: "var(--brand-primary)",
                  color: "var(--text-inverse)",
                  borderColor: "var(--brand-primary)",
                }}
                onClick={onBind}
              >
                Bind →
              </button>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}


// Coverage lines a broker can toggle while editing a draft submission.
const COVERAGE_LINE_OPTIONS = [
  "gl", "liquor", "assault_battery", "property", "wc", "epli", "cyber", "umbrella",
];

// ─── Page component ─────────────────────────────────────────────────────

export default function SubmissionDetailPage() {
  const params = useParams<{ sid: string }>();
  const router = useRouter();
  const sid = params?.sid;

  const [loading, setLoading] = useState(true);
  const [submission, setSubmission] = useState<SubmissionDetail | null>(null);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [selectedCarriers, setSelectedCarriers] = useState<Set<string>>(new Set());

  // Editable draft terms (only while the submission is 'open').
  const [editNotes, setEditNotes] = useState("");
  const [editEffective, setEditEffective] = useState("");
  const [editLines, setEditLines] = useState<string[]>([]);
  const [savingTerms, setSavingTerms] = useState(false);

  const carriersById = useMemo(
    () => new Map(carriers.map(c => [c.id, c])),
    [carriers],
  );

  const load = async () => {
    if (!sid) return;
    setLoading(true);
    setError(null);
    try {
      const [sub, cars] = await Promise.all([
        placementApi.getSubmission(sid),
        placementApi.listCarriers(),
      ]);
      setSubmission(sub);
      setCarriers(cars);
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Failed to load submission");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [sid]);

  // Seed the edit fields from the loaded submission.
  useEffect(() => {
    if (submission) {
      setEditNotes(submission.notes ?? "");
      setEditEffective(submission.effective_date ?? "");
      setEditLines(submission.coverage_lines ?? []);
    }
  }, [submission?.id]);

  const handleSaveTerms = async () => {
    if (!submission) return;
    setSavingTerms(true);
    setError(null);
    try {
      await placementApi.updateSubmission(submission.id, {
        notes: editNotes,
        effective_date: editEffective,
        coverage_lines: editLines,
      });
      await load();
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Save failed");
    } finally {
      setSavingTerms(false);
    }
  };

  const handleSubmitToMarket = async () => {
    if (!submission || selectedCarriers.size === 0) return;
    setActionBusy(true);
    setError(null);
    try {
      await placementApi.submitToMarket(submission.id, {
        target_carriers: Array.from(selectedCarriers),
      });
      setSelectedCarriers(new Set());
      await load();
    } catch (e) {
      if (e instanceof PlacementApiError && e.structured?.error === "out_of_appetite") {
        setError(`All carriers out of appetite. ${e.structured.message}`);
      } else {
        setError(e instanceof PlacementApiError ? e.message : "Submit failed");
      }
    } finally {
      setActionBusy(false);
    }
  };

  const handleRecordResponse = async (
    quote: CarrierQuote,
    status: "quoted" | "declined",
  ) => {
    if (status === "declined") {
      const reason = window.prompt("Decline reason (required):");
      if (!reason || !reason.trim()) return;
      try {
        await placementApi.recordQuoteResponse(quote.id, {
          status: "declined",
          decline_reason: reason.trim(),
        });
        await load();
      } catch (e) {
        alert(e instanceof PlacementApiError ? e.message : "Record failed");
      }
      return;
    }
    // 'quoted' — fetch the indicative quote from the broker-path engine
    // and let the broker confirm/edit before persisting.
    try {
      const indicative = await placementApi.buildIndicativeQuote(quote.id);
      // For Phase 1 we accept the indicative number as-is (simulating the
      // carrier returning roughly what the model predicted). The broker
      // can adjust by re-recording the response. A full edit-form is a
      // future polish.
      await placementApi.recordQuoteResponse(quote.id, {
        status: "quoted",
        premium_breakdown: indicative,
      });
      await load();
    } catch (e) {
      alert(e instanceof PlacementApiError ? e.message : "Record failed");
    }
  };

  const handleSelect = async (quote: CarrierQuote) => {
    try {
      await placementApi.selectQuote(quote.id);
      await load();
    } catch (e) {
      alert(e instanceof PlacementApiError ? e.message : "Select failed");
    }
  };

  const handleBind = async (quote: CarrierQuote) => {
    const policyNumber = window.prompt(
      "Carrier-issued policy number (optional — leave blank to assign later):",
      "",
    );
    // null = cancelled prompt; empty string = explicit "assign later"
    if (policyNumber === null) return;
    try {
      const policy = await policiesApi.bindQuote(quote.id, {
        policy_number: policyNumber.trim() || undefined,
      });
      router.push(`/policies/${policy.id}`);
    } catch (e) {
      alert(e instanceof PlacementApiError ? e.message : "Bind failed");
    }
  };

  if (loading) {
    return <div className="placement-page__loading">Loading…</div>;
  }
  if (!submission) {
    return (
      <div className="submission-detail">
        <div className="placement-page__error">{error ?? "Submission not found"}</div>
      </div>
    );
  }

  const canSubmit = submission.status === "open";

  return (
    <div className="submission-detail">
      <PageHeader
        eyebrow={`Submission · ${submission.id}`}
        title={submission.venue_id}
        subtitle={`Effective ${submission.effective_date}`}
        actions={
          <>
            <StatusPill tone={STATUS_TONE[submission.status]}>
              {STATUS_LABEL[submission.status]}
            </StatusPill>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => router.push("/submissions")}
            >
              ← Back
            </button>
          </>
        }
      />

      {error && <div className="placement-page__error">{error}</div>}

      {/* Summary strip */}
      <div className="submission-detail__summary">
        <div>
          <div className="submission-detail__summary-label">Coverage Lines</div>
          <div className="submission-detail__summary-value">
            {submission.coverage_lines.join(", ") || "—"}
          </div>
        </div>
        <div>
          <div className="submission-detail__summary-label">Quotes Out</div>
          <div className="submission-detail__summary-value">
            {submission.quotes.length}
          </div>
        </div>
        <div>
          <div className="submission-detail__summary-label">Submitted</div>
          <div className="submission-detail__summary-value">
            {submission.submitted_at ? submission.submitted_at.slice(0, 10) : "—"}
          </div>
        </div>
      </div>

      {/* Edit terms — only while the submission is still a draft (open). */}
      {canSubmit && (
        <>
          <div className="submission-detail__section-title">Edit terms</div>
          <div className="submission-edit">
            <label className="submission-edit__field">
              <span className="submission-edit__label">Effective date</span>
              <input
                type="date"
                className="input-field"
                value={editEffective}
                onChange={(e) => setEditEffective(e.target.value)}
              />
            </label>
            <div className="submission-edit__field">
              <span className="submission-edit__label">Coverage lines</span>
              <div className="submission-wizard__coverage-grid">
                {COVERAGE_LINE_OPTIONS.map((l) => (
                  <label key={l} className="submission-wizard__coverage-chip">
                    <input
                      type="checkbox"
                      checked={editLines.includes(l)}
                      onChange={() =>
                        setEditLines((prev) =>
                          prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l],
                        )
                      }
                    />
                    <span className="submission-wizard__coverage-chip-name">
                      {l.replace(/_/g, " ")}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <label className="submission-edit__field">
              <span className="submission-edit__label">Notes</span>
              <textarea
                className="input-field"
                rows={2}
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleSaveTerms}
              disabled={savingTerms}
            >
              {savingTerms ? "Saving…" : "Save terms"}
            </button>
          </div>

          {/* Carrier picker — only while submission is open */}
          <div className="submission-detail__section-title">
            Carriers to Submit To
          </div>
          <div className="submission-wizard__coverage-grid">
            {carriers.map(c => {
              const inAppetite =
                (!c.appetite.venue_types ||
                  c.appetite.venue_types.length === 0) ||
                true; // server enforces appetite check at submit time
              return (
                <label
                  key={c.id}
                  className="submission-wizard__coverage-chip"
                  style={!inAppetite ? { opacity: 0.6 } : {}}
                >
                  <input
                    type="checkbox"
                    checked={selectedCarriers.has(c.id)}
                    onChange={() => {
                      const next = new Set(selectedCarriers);
                      if (next.has(c.id)) next.delete(c.id);
                      else next.add(c.id);
                      setSelectedCarriers(next);
                    }}
                  />
                  <span className="submission-wizard__coverage-chip-name">
                    {c.name}
                    <span style={{ color: "var(--text-tertiary)", marginLeft: 4, fontSize: 10 }}>
                      ({c.market_type})
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={actionBusy || selectedCarriers.size === 0}
              onClick={handleSubmitToMarket}
            >
              Submit to {selectedCarriers.size} {selectedCarriers.size === 1 ? "carrier" : "carriers"}
            </button>
          </div>
        </>
      )}

      {/* Quote comparison */}
      {submission.quotes.length > 0 && (
        <>
          <div className="submission-detail__section-title">
            Quote Comparison
          </div>
          <div className="quote-comparison">
            {submission.quotes.map(q => {
              const c = carriersById.get(q.carrier_id);
              return (
                <CarrierQuoteCardComponent
                  key={q.id}
                  quote={q}
                  carrierName={c?.name ?? q.carrier_id}
                  marketType={c?.market_type ?? "—"}
                  onSelect={() => handleSelect(q)}
                  onRecordResponse={(status) => handleRecordResponse(q, status)}
                  onBind={() => handleBind(q)}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
