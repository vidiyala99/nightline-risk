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
import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { policiesApi, bindPolicyNumberArg } from "@/lib/policies";
import { authHeaders } from "@/lib/authFetch";
import { PromptDialog } from "@/components/ui/PromptDialog";
import { toastError } from "@/lib/toast";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";


// ─── Carrier quote card (per-carrier comparison cell) ───────────────────

function CarrierQuoteCardComponent({
  quote,
  carrierName,
  marketType,
  onSelect,
  onRecordResponse,
  onBind,
  onInfoResponse,
}: {
  quote: CarrierQuote;
  carrierName: string;
  marketType: string;
  onSelect: () => void;
  onRecordResponse: (status: "quoted" | "declined") => void;
  onBind: () => void;
  onInfoResponse: (note: string) => Promise<void>;
}) {
  const breakdown = quote.premium_breakdown as PremiumBreakdown | undefined;
  const total = breakdown?.total;
  const lines = breakdown?.lines ?? {};
  const fees = breakdown?.fees;

  const [infoNote, setInfoNote] = useState("");
  const [submittingInfo, setSubmittingInfo] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);

  const handleInfoResponse = async () => {
    if (!infoNote.trim()) return;
    setSubmittingInfo(true);
    setInfoError(null);
    try {
      await onInfoResponse(infoNote.trim());
      setInfoNote("");
    } catch (e) {
      setInfoError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmittingInfo(false);
    }
  };

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
          quote.status === "withdrawn" ? "neutral" :
          quote.status === "info_requested" ? "warning" : "info"
        }>
          {quote.status === "info_requested" ? "info requested" : quote.status}
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

      {/* Carrier info-request respond surface */}
      {quote.status === "info_requested" && (
        <div
          style={{
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: "var(--space-md)",
            marginTop: "var(--space-sm)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-sm)",
          }}
        >
          {quote.info_request_note && (
            <p className="text-xs text-secondary" style={{ margin: 0 }}>
              <span className="text-xs uppercase tracking-wide" style={{ color: "var(--state-warning)" }}>
                Carrier asked:{" "}
              </span>
              <span style={{ fontStyle: "italic" }}>
                &ldquo;{quote.info_request_note}&rdquo;
              </span>
            </p>
          )}
          <textarea
            className="input-field"
            rows={2}
            placeholder="Your response to the carrier…"
            value={infoNote}
            onChange={(e) => setInfoNote(e.target.value)}
            disabled={submittingInfo}
            style={{ resize: "none" }}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            style={{ minHeight: 44 }}
            disabled={submittingInfo || !infoNote.trim()}
            onClick={handleInfoResponse}
          >
            {submittingInfo ? "Sending…" : "Respond & re-queue"}
          </button>
          {infoError && (
            <p className="text-xs" style={{ color: "var(--state-error)", margin: 0 }}>
              {infoError}
            </p>
          )}
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
  const [pullingAll, setPullingAll] = useState(false);
  const [selectedCarriers, setSelectedCarriers] = useState<Set<string>>(new Set());
  // carrier_id -> appetite match for this submission's venue + coverage profile.
  const [appetite, setAppetite] = useState<Record<string, { in_appetite: boolean; reasons: string[] }>>({});
  const autoSelectedRef = useRef(false);

  // Editable draft terms (only while the submission is 'open').
  const [editNotes, setEditNotes] = useState("");
  const [editEffective, setEditEffective] = useState("");
  const [editLines, setEditLines] = useState<string[]>([]);
  const [savingTerms, setSavingTerms] = useState(false);
  const [bindTarget, setBindTarget] = useState<CarrierQuote | null>(null);
  const [binding, setBinding] = useState(false);
  const [declineTarget, setDeclineTarget] = useState<CarrierQuote | null>(null);
  const [declining, setDeclining] = useState(false);

  const carriersById = useMemo(
    () => new Map(carriers.map(c => [c.id, c])),
    [carriers],
  );

  const load = async () => {
    if (!sid) return;
    setLoading(true);
    setError(null);
    try {
      const [sub, cars, app] = await Promise.all([
        placementApi.getSubmission(sid),
        placementApi.listCarriers(),
        placementApi.carrierAppetite(sid).catch(() => []),
      ]);
      setSubmission(sub);
      setCarriers(cars);
      setAppetite(Object.fromEntries(
        app.map(a => [a.carrier_id, { in_appetite: a.in_appetite, reasons: a.reasons }]),
      ));
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Failed to load submission");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [sid]);

  // Seed the edit fields from the loaded submission — keyed on identity (id),
  // NOT the whole `submission` object. A background re-fetch returns a new object
  // reference with the same id; re-seeding on that would clobber edits the broker
  // is mid-typing. The narrow dep is intentional (hence the disable below).
  useEffect(() => {
    if (submission) {
      setEditNotes(submission.notes ?? "");
      setEditEffective(submission.effective_date ?? "");
      setEditLines(submission.coverage_lines ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- id-keyed re-seed is deliberate
  }, [submission?.id]);

  // Default-select the carriers that fit this venue (once), so the broker starts
  // from "the markets that will actually quote this" instead of a blank slate.
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (submission?.status === "open" && carriers.length && Object.keys(appetite).length) {
      setSelectedCarriers(new Set(carriers.filter(c => appetite[c.id]?.in_appetite).map(c => c.id)));
      autoSelectedRef.current = true;
    }
  }, [submission?.status, carriers, appetite]);

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
      // Persist any unsaved term edits first, so we never submit stale terms
      // (editing then forgetting to "Save terms" used to silently submit the
      // previously-saved coverage lines / effective date).
      await placementApi.updateSubmission(submission.id, {
        notes: editNotes,
        effective_date: editEffective,
        coverage_lines: editLines,
      });
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
      // Decline opens an in-app PromptDialog with a REQUIRED reason
      // (was a native window.prompt).
      setDeclineTarget(quote);
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
      toastError(e instanceof PlacementApiError ? e.message : "Record failed");
    }
  };

  const runDecline = async (values: Record<string, string>) => {
    if (!declineTarget) return;
    setDeclining(true);
    try {
      await placementApi.recordQuoteResponse(declineTarget.id, {
        status: "declined",
        decline_reason: values.decline_reason.trim(),
      });
      setDeclineTarget(null);
      await load();
    } catch (e) {
      toastError(e instanceof PlacementApiError ? e.message : "Record failed");
    } finally {
      setDeclining(false);
    }
  };

  // One-click: fill every still-pending carrier with its indicative quote at
  // once, instead of clicking "Record quote" on each card. The model already
  // produces these — this just stops making the broker pull them one by one.
  const handlePullAllQuotes = async () => {
    if (!submission) return;
    const pending = submission.quotes.filter(
      (q) => q.status === "requested" || q.status === "pending",
    );
    if (pending.length === 0) return;
    setPullingAll(true);
    setError(null);
    try {
      for (const q of pending) {
        const indicative = await placementApi.buildIndicativeQuote(q.id);
        await placementApi.recordQuoteResponse(q.id, {
          status: "quoted",
          premium_breakdown: indicative,
        });
      }
      await load();
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Couldn't pull quotes");
    } finally {
      setPullingAll(false);
    }
  };

  const handleSelect = async (quote: CarrierQuote) => {
    try {
      await placementApi.selectQuote(quote.id);
      await load();
    } catch (e) {
      toastError(e instanceof PlacementApiError ? e.message : "Select failed");
    }
  };

  const handleInfoResponse = async (quote: CarrierQuote, note: string) => {
    const res = await fetch(`${API_URL}/api/quotes/${quote.id}/info-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ note }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = typeof err?.detail === "string"
        ? err.detail
        : (err?.message ?? `Request failed (${res.status})`);
      throw new Error(msg);
    }
    await load();
  };

  // Bind opens an in-app PromptDialog (was a native window.prompt). Cancelling
  // the dialog makes no API call (the old `null` path); submitting blank binds
  // with no policy number ("assign later"), per bindPolicyNumberArg.
  const handleBind = (quote: CarrierQuote) => setBindTarget(quote);

  const runBind = async (values: Record<string, string>) => {
    if (!bindTarget) return;
    setBinding(true);
    try {
      const policy = await policiesApi.bindQuote(bindTarget.id, {
        policy_number: bindPolicyNumberArg(values.policy_number),
      });
      setBindTarget(null);
      router.push(`/policies/${policy.id}`);
    } catch (e) {
      toastError(e instanceof PlacementApiError ? e.message : "Bind failed");
    } finally {
      setBinding(false);
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
  const pendingQuotes = submission.quotes.filter(
    (q) => q.status === "requested" || q.status === "pending",
  );

  return (
    <div className="submission-detail">
      <PageHeader
        eyebrow={`Submission · ${submission.id}`}
        title={submission.venue_id}
        subtitle={`Effective ${submission.effective_date}`}
        actions={
          <StatusPill tone={STATUS_TONE[submission.status]}>
            {STATUS_LABEL[submission.status]}
          </StatusPill>
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

          {/* Carrier picker — only while submission is open. Carriers that fit
              this venue + coverage (in appetite) are sorted first and
              pre-selected; out-of-appetite ones are dimmed with the reason on
              hover, so the broker isn't choosing blind. */}
          <div className="submission-detail__section-title">
            Carriers to Submit To
          </div>
          <div className="submission-wizard__coverage-grid">
            {[...carriers]
              .sort((a, b) =>
                Number(appetite[b.id]?.in_appetite ?? true) -
                Number(appetite[a.id]?.in_appetite ?? true))
              .map(c => {
                const app = appetite[c.id];
                const fits = app?.in_appetite ?? true; // default to "fits" until appetite loads
                const reason = app && !fits ? app.reasons.join("; ") : undefined;
                return (
                  <label
                    key={c.id}
                    className="submission-wizard__coverage-chip"
                    style={!fits ? { opacity: 0.55 } : undefined}
                    title={reason}
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
                      {app && (fits ? (
                        <span style={{ color: "var(--accent-ink, var(--text-secondary))", marginLeft: 6, fontSize: 10 }}>
                          ✓ in appetite
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-tertiary)", marginLeft: 6, fontSize: 10 }}>
                          out of appetite
                        </span>
                      ))}
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
          <div className="submission-detail__section-title" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span>Quote Comparison</span>
            {pendingQuotes.length > 0 && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ marginLeft: "auto" }}
                onClick={handlePullAllQuotes}
                disabled={pullingAll}
              >
                {pullingAll ? "Pulling…" : `Pull indicative quotes (${pendingQuotes.length})`}
              </button>
            )}
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
                  onInfoResponse={(note) => handleInfoResponse(q, note)}
                />
              );
            })}
          </div>
        </>
      )}

      {bindTarget && (
        <PromptDialog
          open
          title="Bind policy"
          subtitle="Issue coverage on the selected quote."
          submitLabel="Bind policy"
          busy={binding}
          fields={[{
            name: "policy_number",
            label: "Carrier-issued policy number",
            type: "text",
            placeholder: "BW-2026-00123",
            help: "Optional — leave blank to assign later.",
          }]}
          onSubmit={runBind}
          onClose={() => setBindTarget(null)}
        />
      )}

      {declineTarget && (
        <PromptDialog
          open
          title="Record carrier decline"
          subtitle="Logged against the quote for the placement audit trail."
          submitLabel="Record decline"
          busy={declining}
          fields={[{
            name: "decline_reason",
            label: "Decline reason",
            type: "textarea",
            required: true,
          }]}
          onSubmit={runDecline}
          onClose={() => setDeclineTarget(null)}
        />
      )}
    </div>
  );
}
