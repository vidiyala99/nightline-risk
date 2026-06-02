"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Landmark, MessageSquarePlus, ShieldCheck, XCircle } from "lucide-react";

// Map raw backend enums to human-readable labels
const SUBJECTIVITY_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  met: "Met",
  waived: "Waived",
};

const SEVERITY_LABELS: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

function toTitleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const MONEY_KEY_PATTERNS = ["incurred", "reserve", "paid", "premium", "amount", "value"];
import { useAuth, useIsCarrier } from "@/contexts/AuthContext";
import { TierBadge, Tier as UiTier } from "@/components/ui/TierBadge";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  fetchDossier,
  requestInfo,
  fmtMoney,
  lineLabel,
  rescaleBreakdownToTotal,
  underwriteQuote,
  type CoverageTerms,
  type Dossier,
  type ScheduleMod,
  type Subjectivity,
} from "@/lib/underwriting";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  minHeight: 36,
  padding: "var(--space-xs) var(--space-sm)",
  width: "100%",
  fontSize: "var(--text-sm)",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: 36,
};

function SubjectivityStatusChip({ status }: { status: Subjectivity["status"] }) {
  const color =
    status === "met"
      ? "var(--state-success)"
      : status === "waived"
      ? "var(--text-muted)"
      : "var(--state-warning)";
  return (
    <span
      style={{
        fontSize: "var(--text-xs)",
        border: `1px solid ${color}`,
        color,
        borderRadius: "var(--radius-sm)",
        padding: "1px 6px",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      {SUBJECTIVITY_STATUS_LABELS[status] ?? toTitleCase(status)}
    </span>
  );
}

const cardLabel: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-subtle)",
  paddingBottom: "var(--space-sm)",
  marginBottom: "var(--space-md)",
};

// Summary style for dossier accordions (reused in tailor details too)
const accordionSummaryStyle: React.CSSProperties = {
  cursor: "pointer",
  fontSize: "var(--text-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-secondary)",
  userSelect: "none",
  listStyle: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function UnderwriteDecisionPage() {
  const { qid } = useParams<{ qid: string }>();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const isCarrier = useIsCarrier();

  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notDecidable, setNotDecidable] = useState(false);

  // Decision form state
  const [totalInput, setTotalInput] = useState("");
  const [declineReason, setDeclineReason] = useState("");
  const [infoNote, setInfoNote] = useState("");
  const [submitting, setSubmitting] = useState<"quote" | "decline" | "info" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Structured coverage terms state
  const [coverageLines, setCoverageLines] = useState<
    Record<string, { limit: string; deductible: string; sublimit: string }>
  >({});
  const [subjectivities, setSubjectivities] = useState<Subjectivity[]>([]);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [endorsements, setEndorsements] = useState<string[]>([]);
  const [scheduleMods, setScheduleMods] = useState<ScheduleMod[]>([]);
  const [validUntil, setValidUntil] = useState("");

  // Controlled accordion open state — Set of open dossier section ids
  const [openAccordions, setOpenAccordions] = useState<Set<string>>(new Set());

  function toggleAccordion(id: string) {
    setOpenAccordions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function openAndScrollAccordion(id: string) {
    setOpenAccordions((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    // Allow React to flush the state update before scrolling
    setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  // Auth guards
  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (isLoaded && isSignedIn && !isCarrier) router.replace("/dashboard");
  }, [isLoaded, isSignedIn, isCarrier, router]);

  // Load dossier
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isCarrier || !qid) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const d = await fetchDossier(qid);
        if (cancelled) return;
        setDossier(d);
        if (!d.decidable) {
          setNotDecidable(true);
          return;
        }
        // Prefill total from suggested premium
        if (d.suggested_premium_breakdown) {
          setTotalInput(d.suggested_premium_breakdown.total);
        }
        // Prefill coverage line terms from requested_limits
        const initialLines: Record<string, { limit: string; deductible: string; sublimit: string }> = {};
        for (const line of d.submission.coverage_lines) {
          const req = d.submission.requested_limits?.[line] ?? {};
          initialLines[line] = {
            limit: req.limit ?? req.per_occurrence_limit ?? "",
            deductible: req.deductible ?? "",
            sublimit: req.sublimit ?? "",
          };
        }
        setCoverageLines(initialLines);
        // Prefill subjectivities/exclusions/endorsements/mods from existing coverage_terms if any
        const existing = d.quote?.coverage_terms;
        if (existing) {
          if (existing.subjectivities?.length) setSubjectivities(existing.subjectivities);
          if (existing.exclusions?.length) setExclusions(existing.exclusions);
          if (existing.endorsements?.length) setEndorsements(existing.endorsements);
          if (existing.schedule_mods?.length) setScheduleMods(existing.schedule_mods);
          if (existing.valid_until) setValidUntil(existing.valid_until);
        }
      } catch {
        if (!cancelled) setLoadError("Could not load this submission. It may have been decided already.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, isCarrier, qid]);

  const suggested = dossier?.suggested_premium_breakdown ?? null;
  const feeFloor = useMemo(() => {
    if (!suggested) return 0;
    return Number(suggested.fees.policy_fee) + Number(suggested.fees.surplus_lines_tax);
  }, [suggested]);

  // Compute whether any terms have been touched (for the "edited" hint)
  const termsEdited = useMemo(() => {
    const hasFilledLine = Object.values(coverageLines).some(
      (v) => v.limit || v.deductible || v.sublimit
    );
    return (
      hasFilledLine ||
      subjectivities.length > 0 ||
      exclusions.filter(Boolean).length > 0 ||
      endorsements.filter(Boolean).length > 0 ||
      scheduleMods.length > 0 ||
      !!validUntil
    );
  }, [coverageLines, subjectivities, exclusions, endorsements, scheduleMods, validUntil]);

  // ---------------------------------------------------------------------------
  // Assemble CoverageTerms from form state
  // ---------------------------------------------------------------------------
  function buildCoverageTerms(): CoverageTerms {
    const lines: CoverageTerms["lines"] = {};
    for (const [id, vals] of Object.entries(coverageLines)) {
      const entry: { limit?: string; deductible?: string; sublimit?: string | null } = {};
      if (vals.limit) entry.limit = vals.limit;
      if (vals.deductible) entry.deductible = vals.deductible;
      if (vals.sublimit) entry.sublimit = vals.sublimit;
      if (Object.keys(entry).length) lines[id] = entry;
    }
    return {
      lines: Object.keys(lines).length ? lines : undefined,
      subjectivities: subjectivities.length ? subjectivities : undefined,
      exclusions: exclusions.filter(Boolean).length ? exclusions.filter(Boolean) : undefined,
      endorsements: endorsements.filter(Boolean).length ? endorsements.filter(Boolean) : undefined,
      schedule_mods: scheduleMods.length ? scheduleMods : undefined,
      valid_until: validUntil || undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------
  async function handleQuote() {
    if (!suggested) return;
    setFormError(null);
    const target = Number(totalInput);
    if (!Number.isFinite(target) || target <= 0) {
      setFormError("Enter a valid premium total.");
      return;
    }
    const unchanged = Math.round(target * 100) === Math.round(Number(suggested.total) * 100);
    const breakdown = unchanged ? suggested : rescaleBreakdownToTotal(suggested, target);
    if (!breakdown) {
      setFormError(`Total must be above the fixed fees (${fmtMoney(feeFloor, true)}).`);
      return;
    }
    setSubmitting("quote");
    try {
      await underwriteQuote(qid, {
        decision: "quote",
        premium_breakdown: breakdown,
        coverage_terms: buildCoverageTerms(),
      });
      toastSuccess(`Quoted ${dossier?.venue.name ?? "submission"} at ${fmtMoney(breakdown.total)}.`);
      router.push("/underwriting");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not record the quote.";
      setFormError(message);
      toastError(message);
    } finally {
      setSubmitting(null);
    }
  }

  async function handleDecline() {
    setFormError(null);
    if (!declineReason.trim()) {
      setFormError("A decline needs a reason (the broker relays it to the insured).");
      return;
    }
    setSubmitting("decline");
    try {
      await underwriteQuote(qid, { decision: "decline", decline_reason: declineReason.trim() });
      toastSuccess(`Declined ${dossier?.venue.name ?? "submission"}.`);
      router.push("/underwriting");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not record the decline.";
      setFormError(message);
      toastError(message);
    } finally {
      setSubmitting(null);
    }
  }

  async function handleRequestInfo() {
    setFormError(null);
    if (!infoNote.trim()) {
      setFormError("Add a note describing what information you need.");
      return;
    }
    setSubmitting("info");
    try {
      await requestInfo(qid, infoNote.trim());
      toastSuccess("Info request sent to the broker.");
      router.push("/underwriting");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not send the info request.";
      setFormError(message);
      toastError(message);
    } finally {
      setSubmitting(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Subjectivity helpers
  // ---------------------------------------------------------------------------
  function addSubjectivity() {
    setSubjectivities((s) => [...s, { text: "", status: "open" }]);
  }
  function updateSubjectivity(i: number, patch: Partial<Subjectivity>) {
    setSubjectivities((s) => s.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function removeSubjectivity(i: number) {
    setSubjectivities((s) => s.filter((_, idx) => idx !== i));
  }

  function addExclusion() { setExclusions((e) => [...e, ""]); }
  function updateExclusion(i: number, v: string) { setExclusions((e) => e.map((x, idx) => idx === i ? v : x)); }
  function removeExclusion(i: number) { setExclusions((e) => e.filter((_, idx) => idx !== i)); }

  function addEndorsement() { setEndorsements((e) => [...e, ""]); }
  function updateEndorsement(i: number, v: string) { setEndorsements((e) => e.map((x, idx) => idx === i ? v : x)); }
  function removeEndorsement(i: number) { setEndorsements((e) => e.filter((_, idx) => idx !== i)); }

  function addScheduleMod() { setScheduleMods((m) => [...m, { category: "", kind: "credit", pct: "" }]); }
  function updateScheduleMod(i: number, patch: Partial<ScheduleMod>) {
    setScheduleMods((m) => m.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function removeScheduleMod(i: number) { setScheduleMods((m) => m.filter((_, idx) => idx !== i)); }

  // ---------------------------------------------------------------------------
  // Render gates
  // ---------------------------------------------------------------------------
  if (!isLoaded || loading || !isCarrier) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (loadError || notDecidable || !dossier) {
    return (
      <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
        <div className="lc-card" style={{ marginTop: "clamp(40px, 12vh, 120px)" }}>
          <div className="lc-card__inner" style={{ textAlign: "center", padding: "var(--space-xl)" }}>
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              {loadError ??
                "This submission is no longer awaiting a decision — it may already have been quoted or declined."}
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: "var(--space-md)", minHeight: 44 }}
              onClick={() => router.push("/underwriting")}
            >
              <ArrowLeft size={16} /> Back to desk
            </button>
          </div>
        </div>
      </div>
    );
  }

  const venueName = dossier.venue.name;
  const effectiveDate = dossier.submission.effective_date
    ? new Date(dossier.submission.effective_date).toLocaleDateString()
    : null;
  const coverageSummary = dossier.submission.coverage_lines.map(lineLabel).join(" · ") || "Coverage TBD";

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      {/* ------------------------------------------------------------------ */}
      {/* 0. Back link                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ paddingTop: "var(--space-lg)", marginBottom: "var(--space-sm)" }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => router.push("/underwriting")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-xs)",
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
            background: "none",
            border: "none",
            padding: 0,
            minHeight: 44,
          }}
        >
          <ArrowLeft size={14} aria-hidden />
          Desk
        </button>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 1. Header */}
      {/* ------------------------------------------------------------------ */}
      <section className="lc-hero" style={{ marginBottom: "var(--space-lg)" }}>
        <div>
          <span className="lc-eyebrow">
            CARRIER
            <span className="lc-eyebrow__sep" />
            UNDERWRITING DECISION
          </span>
          <h1 className="lc-display">{venueName}</h1>
          <p className="lc-sub">
            {coverageSummary}
            {effectiveDate ? ` · effective ${effectiveDate}` : ""}
          </p>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* 2. KPI band — Open incidents + Compliance cells are interactive  */}
        {/* ---------------------------------------------------------------- */}
        <div className="lc-hero__meta">
          {/* Risk tier — static */}
          <div
            className="lc-meta-cell"
            style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}
          >
            <span className="lc-stat-label">Risk tier</span>
            <span className="flex items-center" style={{ gap: 8 }}>
              <TierBadge tier={dossier.risk.tier as UiTier} />
              <strong className="font-mono">{dossier.risk.total_score}</strong>
            </span>
          </div>

          {/* Open incidents — interactive button */}
          <button
            type="button"
            className="lc-meta-cell"
            aria-label="View open incidents"
            onClick={() => openAndScrollAccordion("dossier-incidents")}
            style={{
              cursor: "pointer",
              background: "none",
              border: "none",
              padding: 0,
              textAlign: "left",
              fontFamily: "inherit",
            }}
          >
            <span className="lc-stat-label" style={{ pointerEvents: "none" }}>Open incidents</span>
            <strong
              className="font-mono"
              style={{
                color: dossier.incidents.open_count > 0 ? "var(--state-warning)" : "inherit",
                pointerEvents: "none",
              }}
            >
              {dossier.incidents.open_count}
            </strong>
          </button>

          {/* Compliance — interactive button */}
          <button
            type="button"
            className="lc-meta-cell"
            aria-label="View compliance items"
            onClick={() => openAndScrollAccordion("dossier-compliance")}
            style={{
              cursor: "pointer",
              background: "none",
              border: "none",
              padding: 0,
              textAlign: "left",
              fontFamily: "inherit",
            }}
          >
            <span className="lc-stat-label" style={{ pointerEvents: "none" }}>Compliance</span>
            <span className="flex items-center" style={{ gap: 6, pointerEvents: "none" }}>
              {dossier.compliance.status === "clear" ? (
                <strong
                  className="font-mono"
                  style={{ color: "var(--state-success, inherit)", whiteSpace: "nowrap" }}
                >
                  Clear
                </strong>
              ) : dossier.compliance.open_items.length > 0 ? (
                <span
                  className="text-xs font-mono"
                  style={{
                    color: "var(--state-warning)",
                    border: "1px solid var(--state-warning)",
                    borderRadius: "var(--radius-sm)",
                    padding: "1px 6px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {dossier.compliance.open_items.length} open
                </span>
              ) : (
                <strong className="font-mono" style={{ whiteSpace: "nowrap" }}>—</strong>
              )}
            </span>
          </button>

          {/* Total incurred — static */}
          {dossier.loss_run && (
            <div className="lc-meta-cell">
              <span className="lc-stat-label">Total incurred</span>
              <strong className="font-mono">
                {fmtMoney(String(dossier.loss_run.summary.total_incurred ?? ""))}
              </strong>
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 3. Decision row — Suggested premium (left) + Decision card (right) */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="grid grid-cols-2 gap-xl"
        style={{ alignItems: "start", marginBottom: "var(--space-xl)" }}
      >
        {/* LEFT: engine suggestion — unchanged */}
        <div className="lc-card">
          <div className="lc-card__inner">
            <h2 style={cardLabel}>Suggested premium · pricing engine</h2>
            {suggested ? (
              <>
                <div className="flex flex-col gap-sm">
                  {Object.entries(suggested.lines).map(([id, line]) => (
                    <div key={id} className="flex justify-between items-baseline">
                      <span className="text-sm">{lineLabel(id)}</span>
                      <span className="text-sm font-mono">{fmtMoney(line.premium, true)}</span>
                    </div>
                  ))}
                  <div
                    className="flex justify-between items-baseline"
                    style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-sm)" }}
                  >
                    <span className="text-xs uppercase tracking-wide text-secondary">Subtotal</span>
                    <span className="text-sm font-mono">{fmtMoney(suggested.subtotal, true)}</span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs uppercase tracking-wide text-secondary">Policy fee</span>
                    <span className="text-sm font-mono">{fmtMoney(suggested.fees.policy_fee, true)}</span>
                  </div>
                  {Number(suggested.fees.surplus_lines_tax) > 0 && (
                    <div className="flex justify-between items-baseline">
                      <span className="text-xs uppercase tracking-wide text-secondary">Surplus lines tax</span>
                      <span className="text-sm font-mono">{fmtMoney(suggested.fees.surplus_lines_tax, true)}</span>
                    </div>
                  )}
                  <div
                    className="flex justify-between items-baseline"
                    style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-sm)" }}
                  >
                    <span className="text-xs uppercase tracking-wide text-secondary">Suggested total</span>
                    <span
                      className="text-base font-mono font-bold"
                      style={{ color: "var(--accent-ink)" }}
                    >
                      {fmtMoney(suggested.total, true)}
                    </span>
                  </div>
                </div>
                <p
                  className="text-xs text-tertiary"
                  style={{ marginTop: "var(--space-md)", fontStyle: "italic", lineHeight: 1.5 }}
                >
                  Risk-adjusted by the calibrated tier ({dossier.risk.tier}) and this carrier&apos;s appetite.
                  Editing the total below rescales the lines proportionally.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted" style={{ margin: 0 }}>
                No engine suggestion is available for this venue (it&apos;s outside the rated set). You can still
                decline, or quote once the venue is rated.
              </p>
            )}
          </div>
        </div>

        {/* RIGHT: Decision card — the hero fast path */}
        <div className="lc-card">
          <div className="lc-card__inner">
            <h2 style={cardLabel}>Decision</h2>

            {/* Quote */}
            <div className="flex flex-col gap-sm" style={{ marginBottom: "var(--space-lg)" }}>
              <label htmlFor="uw-total" className="text-xs uppercase tracking-wide text-secondary">
                Annual premium (USD)
              </label>
              <input
                id="uw-total"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={totalInput}
                onChange={(e) => setTotalInput(e.target.value)}
                disabled={!suggested || submitting !== null}
                className="w-full text-sm p-sm font-mono"
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                  minHeight: 44,
                }}
              />
              <button
                type="button"
                className="btn btn-primary w-full flex items-center justify-center gap-sm"
                onClick={handleQuote}
                disabled={!suggested || submitting !== null}
                style={{ minHeight: 44 }}
              >
                <ShieldCheck size={16} />
                {submitting === "quote" ? "Recording…" : `Quote at ${fmtMoney(totalInput)}`}
              </button>
              <p className="text-xs text-secondary" style={{ margin: 0 }}>
                Issues the carrier&apos;s quote with the terms above and escalates the submission for the broker to bind.
              </p>
            </div>

            <div
              className="text-xs text-muted"
              style={{ textAlign: "center", margin: "var(--space-md) 0", letterSpacing: "0.1em" }}
            >
              — OR —
            </div>

            {/* Decline */}
            <div className="flex flex-col gap-sm" style={{ marginBottom: "var(--space-md)" }}>
              <label htmlFor="uw-decline" className="text-xs uppercase tracking-wide text-secondary">
                Decline reason
              </label>
              <textarea
                id="uw-decline"
                rows={2}
                placeholder="Why this risk is outside appetite…"
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                disabled={submitting !== null}
                className="w-full text-sm p-sm"
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                  resize: "none",
                }}
              />
              <button
                type="button"
                className="btn w-full flex items-center justify-center gap-sm"
                onClick={handleDecline}
                disabled={submitting !== null || !declineReason.trim()}
                style={{
                  border: "1px solid var(--state-error)",
                  color: "var(--state-error)",
                  background: "none",
                  minHeight: 44,
                }}
              >
                <XCircle size={16} />
                {submitting === "decline" ? "Recording…" : "Decline submission"}
              </button>
            </div>

            <div
              className="text-xs text-muted"
              style={{ textAlign: "center", margin: "var(--space-md) 0", letterSpacing: "0.1em" }}
            >
              — OR —
            </div>

            {/* Request info */}
            <div className="flex flex-col gap-sm">
              <label htmlFor="uw-info-note" className="text-xs uppercase tracking-wide text-secondary">
                Request additional information
              </label>
              <textarea
                id="uw-info-note"
                rows={2}
                placeholder="What information do you need from the broker?"
                value={infoNote}
                onChange={(e) => setInfoNote(e.target.value)}
                disabled={submitting !== null}
                className="w-full text-sm p-sm"
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                  resize: "none",
                }}
              />
              <button
                type="button"
                className="btn w-full flex items-center justify-center gap-sm"
                onClick={handleRequestInfo}
                disabled={submitting !== null || !infoNote.trim()}
                style={{
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-secondary)",
                  background: "none",
                  minHeight: 44,
                }}
              >
                <MessageSquarePlus size={16} />
                {submitting === "info" ? "Sending…" : "Request info"}
              </button>
            </div>

            {formError && (
              <p
                role="alert"
                className="text-xs"
                style={{ color: "var(--state-error)", marginTop: "var(--space-md)" }}
              >
                {formError}
              </p>
            )}

            <p
              className="text-xs text-tertiary flex items-center gap-xs"
              style={{ marginTop: "var(--space-md)", fontStyle: "italic", lineHeight: 1.5 }}
            >
              <Landmark size={12} aria-hidden="true" />
              Decided on Nightline&apos;s own desk — stamped as a carrier decision in the audit trail.
            </p>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 4. Tailor terms — collapsed opt-in details                         */}
      {/* ------------------------------------------------------------------ */}
      <details
        style={{ marginBottom: "var(--space-xl)" }}
        className="lc-card"
      >
        <summary
          className="lc-card__inner"
          style={{
            ...accordionSummaryStyle,
          }}
        >
          <span>
            Tailor terms &amp; conditions (limits, subjectivities, exclusions&hellip;) — optional
            {termsEdited && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: "var(--text-xs)",
                  color: "var(--accent-ink)",
                  fontStyle: "italic",
                  textTransform: "none",
                  letterSpacing: 0,
                }}
              >
                (edited)
              </span>
            )}
          </span>
          <span style={{ fontSize: 10, opacity: 0.5 }}>▼</span>
        </summary>

        <div className="lc-card__inner" style={{ paddingTop: 0 }}>
          {/* Per-line limits/deductibles */}
          {dossier.submission.coverage_lines.length > 0 && (
            <div className="flex flex-col gap-md" style={{ marginBottom: "var(--space-md)" }}>
              {dossier.submission.coverage_lines.map((line) => (
                <div key={line}>
                  <p
                    className="text-xs uppercase tracking-wide text-secondary"
                    style={{ margin: "0 0 var(--space-xs) 0" }}
                  >
                    {lineLabel(line)}
                  </p>
                  <div
                    style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--space-xs)" }}
                  >
                    <div>
                      <label
                        htmlFor={`uw-line-${line}-limit`}
                        className="text-xs text-muted"
                        style={{ display: "block", marginBottom: 2 }}
                      >
                        Limit
                      </label>
                      <input
                        id={`uw-line-${line}-limit`}
                        type="text"
                        placeholder="e.g. 1000000"
                        value={coverageLines[line]?.limit ?? ""}
                        onChange={(e) =>
                          setCoverageLines((cl) => ({
                            ...cl,
                            [line]: { ...cl[line], limit: e.target.value },
                          }))
                        }
                        disabled={submitting !== null}
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`uw-line-${line}-deductible`}
                        className="text-xs text-muted"
                        style={{ display: "block", marginBottom: 2 }}
                      >
                        Deductible
                      </label>
                      <input
                        id={`uw-line-${line}-deductible`}
                        type="text"
                        placeholder="e.g. 5000"
                        value={coverageLines[line]?.deductible ?? ""}
                        onChange={(e) =>
                          setCoverageLines((cl) => ({
                            ...cl,
                            [line]: { ...cl[line], deductible: e.target.value },
                          }))
                        }
                        disabled={submitting !== null}
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`uw-line-${line}-sublimit`}
                        className="text-xs text-muted"
                        style={{ display: "block", marginBottom: 2 }}
                      >
                        Sublimit
                      </label>
                      <input
                        id={`uw-line-${line}-sublimit`}
                        type="text"
                        placeholder="optional"
                        value={coverageLines[line]?.sublimit ?? ""}
                        onChange={(e) =>
                          setCoverageLines((cl) => ({
                            ...cl,
                            [line]: { ...cl[line], sublimit: e.target.value },
                          }))
                        }
                        disabled={submitting !== null}
                        style={inputStyle}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Subjectivities */}
          <div style={{ marginBottom: "var(--space-md)" }}>
            <div
              className="flex items-center justify-between"
              style={{ marginBottom: "var(--space-xs)" }}
            >
              <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>
                Subjectivities
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-sm text-xs"
                onClick={addSubjectivity}
                disabled={submitting !== null}
                aria-label="Add subjectivity"
                style={{ minHeight: 44, minWidth: 44, padding: "2px 8px" }}
              >
                + Add
              </button>
            </div>
            {subjectivities.length === 0 && (
              <p className="text-xs text-muted" style={{ margin: 0 }}>None</p>
            )}
            {subjectivities.map((sub, i) => (
              <div
                key={i}
                className="flex items-center gap-sm"
                style={{ marginBottom: "var(--space-xs)" }}
              >
                <input
                  type="text"
                  aria-label={`Subjectivity ${i + 1} description`}
                  placeholder="Describe the subjectivity…"
                  value={sub.text}
                  onChange={(e) => updateSubjectivity(i, { text: e.target.value })}
                  disabled={submitting !== null}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <select
                  value={sub.status}
                  aria-label={`Subjectivity ${i + 1} status`}
                  onChange={(e) =>
                    updateSubjectivity(i, { status: e.target.value as Subjectivity["status"] })
                  }
                  disabled={submitting !== null}
                  style={{ ...selectStyle, width: 90, flex: "none" }}
                >
                  <option value="open">Open</option>
                  <option value="met">Met</option>
                  <option value="waived">Waived</option>
                </select>
                <SubjectivityStatusChip status={sub.status} />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => removeSubjectivity(i)}
                  disabled={submitting !== null}
                  style={{ minHeight: 44, minWidth: 44, padding: "2px 6px", color: "var(--state-error)" }}
                  aria-label={`Remove subjectivity ${i + 1}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {/* Additional terms — exclusions, endorsements, schedule mods */}
          <details style={{ marginBottom: "var(--space-md)" }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: "var(--text-xs)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--text-secondary)",
                userSelect: "none",
                listStyle: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "var(--space-xs) 0",
                borderTop: "1px solid var(--border-subtle)",
                borderBottom: "1px solid var(--border-subtle)",
                marginBottom: "var(--space-sm)",
              }}
            >
              <span>Additional terms (exclusions, endorsements, schedule credits/debits)</span>
              <span style={{ fontSize: 10, opacity: 0.5 }}>▼</span>
            </summary>

            {/* Exclusions */}
            <div style={{ marginBottom: "var(--space-md)" }}>
              <div
                className="flex items-center justify-between"
                style={{ marginBottom: "var(--space-xs)" }}
              >
                <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>
                  Exclusions
                </p>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm text-xs"
                  onClick={addExclusion}
                  disabled={submitting !== null}
                  aria-label="Add exclusion"
                  style={{ minHeight: 44, minWidth: 44, padding: "2px 8px" }}
                >
                  + Add
                </button>
              </div>
              {exclusions.length === 0 && (
                <p className="text-xs text-muted" style={{ margin: 0 }}>None</p>
              )}
              {exclusions.map((ex, i) => (
                <div
                  key={i}
                  className="flex items-center gap-sm"
                  style={{ marginBottom: "var(--space-xs)" }}
                >
                  <input
                    type="text"
                    aria-label={`Exclusion ${i + 1}`}
                    placeholder="Exclusion description…"
                    value={ex}
                    onChange={(e) => updateExclusion(i, e.target.value)}
                    disabled={submitting !== null}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeExclusion(i)}
                    disabled={submitting !== null}
                    style={{ minHeight: 44, minWidth: 44, padding: "2px 6px", color: "var(--state-error)" }}
                    aria-label={`Remove exclusion ${i + 1}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {/* Endorsements */}
            <div style={{ marginBottom: "var(--space-md)" }}>
              <div
                className="flex items-center justify-between"
                style={{ marginBottom: "var(--space-xs)" }}
              >
                <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>
                  Endorsements
                </p>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm text-xs"
                  onClick={addEndorsement}
                  disabled={submitting !== null}
                  aria-label="Add endorsement"
                  style={{ minHeight: 44, minWidth: 44, padding: "2px 8px" }}
                >
                  + Add
                </button>
              </div>
              {endorsements.length === 0 && (
                <p className="text-xs text-muted" style={{ margin: 0 }}>None</p>
              )}
              {endorsements.map((en, i) => (
                <div
                  key={i}
                  className="flex items-center gap-sm"
                  style={{ marginBottom: "var(--space-xs)" }}
                >
                  <input
                    type="text"
                    aria-label={`Endorsement ${i + 1}`}
                    placeholder="Endorsement description…"
                    value={en}
                    onChange={(e) => updateEndorsement(i, e.target.value)}
                    disabled={submitting !== null}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeEndorsement(i)}
                    disabled={submitting !== null}
                    style={{ minHeight: 44, minWidth: 44, padding: "2px 6px", color: "var(--state-error)" }}
                    aria-label={`Remove endorsement ${i + 1}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {/* Schedule mods */}
            <div style={{ marginBottom: "var(--space-sm)" }}>
              <div
                className="flex items-center justify-between"
                style={{ marginBottom: "var(--space-xs)" }}
              >
                <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>
                  Schedule modifications
                </p>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm text-xs"
                  onClick={addScheduleMod}
                  disabled={submitting !== null}
                  aria-label="Add schedule modification"
                  style={{ minHeight: 44, minWidth: 44, padding: "2px 8px" }}
                >
                  + Add
                </button>
              </div>
              {scheduleMods.length === 0 && (
                <p className="text-xs text-muted" style={{ margin: 0 }}>None</p>
              )}
              {scheduleMods.map((mod, i) => (
                <div
                  key={i}
                  className="flex items-center gap-sm"
                  style={{ marginBottom: "var(--space-xs)" }}
                >
                  <input
                    type="text"
                    aria-label={`Schedule mod ${i + 1} category`}
                    placeholder="Category…"
                    value={mod.category}
                    onChange={(e) => updateScheduleMod(i, { category: e.target.value })}
                    disabled={submitting !== null}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <select
                    value={mod.kind}
                    aria-label={`Schedule mod ${i + 1} kind`}
                    onChange={(e) =>
                      updateScheduleMod(i, { kind: e.target.value as ScheduleMod["kind"] })
                    }
                    disabled={submitting !== null}
                    style={{ ...selectStyle, width: 80, flex: "none" }}
                  >
                    <option value="credit">Credit</option>
                    <option value="debit">Debit</option>
                  </select>
                  <input
                    type="number"
                    aria-label={`Schedule mod ${i + 1} percentage`}
                    placeholder="%"
                    min={0}
                    max={100}
                    step="0.1"
                    value={mod.pct}
                    onChange={(e) => updateScheduleMod(i, { pct: e.target.value })}
                    disabled={submitting !== null}
                    style={{ ...inputStyle, width: 64, flex: "none" }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeScheduleMod(i)}
                    disabled={submitting !== null}
                    style={{ minHeight: 44, minWidth: 44, padding: "2px 6px", color: "var(--state-error)" }}
                    aria-label={`Remove schedule mod ${i + 1}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </details>

          {/* Valid until */}
          <div>
            <label
              htmlFor="uw-valid-until"
              className="text-xs uppercase tracking-wide text-secondary"
              style={{ display: "block", marginBottom: 4 }}
            >
              Quote valid until
            </label>
            <input
              id="uw-valid-until"
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              disabled={submitting !== null}
              style={{ ...inputStyle, width: "auto" }}
            />
          </div>
        </div>
      </details>

      {/* ------------------------------------------------------------------ */}
      {/* 5. Risk dossier accordions — controlled open state                 */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-col gap-md">
        {/* Risk factors */}
        {Object.keys(dossier.risk.factors).length > 0 && (
          <div id="dossier-risk" className="lc-card">
            <button
              type="button"
              className="lc-card__inner"
              aria-expanded={openAccordions.has("dossier-risk")}
              onClick={() => toggleAccordion("dossier-risk")}
              style={{
                ...accordionSummaryStyle,
                width: "100%",
                background: "none",
                border: "none",
                fontFamily: "inherit",
              }}
            >
              <span>Risk factors</span>
              <span
                style={{
                  fontSize: 10,
                  opacity: 0.5,
                  transform: openAccordions.has("dossier-risk") ? "rotate(180deg)" : undefined,
                  transition: "transform 150ms ease",
                }}
              >
                ▼
              </span>
            </button>
            {openAccordions.has("dossier-risk") && (
              <div className="lc-card__inner" style={{ paddingTop: 0 }}>
                <div className="flex flex-col gap-sm">
                  {Object.entries(dossier.risk.factors).map(([name, factor]) => (
                    <div key={name} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "var(--space-sm)", alignItems: "center" }}>
                      <span className="text-sm">{name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</span>
                      <span className="text-xs font-mono text-secondary">
                        wt {(factor.weight * 100).toFixed(0)}%
                      </span>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, width: 120 }}>
                        <div
                          style={{
                            flex: 1,
                            height: 6,
                            background: "var(--border-subtle)",
                            borderRadius: 3,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.min(100, Math.max(0, (factor.score / 100) * 100))}%`,
                              height: "100%",
                              background: factor.score > 70 ? "var(--state-error)" : factor.score > 40 ? "var(--state-warning)" : "var(--state-success)",
                              borderRadius: 3,
                            }}
                          />
                        </div>
                        <span className="text-xs font-mono" style={{ minWidth: 24, textAlign: "right" }}>
                          {factor.score}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Loss run */}
        {dossier.loss_run && (
          <div id="dossier-loss-run" className="lc-card">
            <button
              type="button"
              className="lc-card__inner"
              aria-expanded={openAccordions.has("dossier-loss-run")}
              onClick={() => toggleAccordion("dossier-loss-run")}
              style={{
                ...accordionSummaryStyle,
                width: "100%",
                background: "none",
                border: "none",
                fontFamily: "inherit",
              }}
            >
              <span>Loss run</span>
              <span
                style={{
                  fontSize: 10,
                  opacity: 0.5,
                  transform: openAccordions.has("dossier-loss-run") ? "rotate(180deg)" : undefined,
                  transition: "transform 150ms ease",
                }}
              >
                ▼
              </span>
            </button>
            {openAccordions.has("dossier-loss-run") && (
              <div className="lc-card__inner" style={{ paddingTop: 0 }}>
                {/* Summary row */}
                <div
                  className="flex gap-lg"
                  style={{ marginBottom: "var(--space-md)", flexWrap: "wrap" }}
                >
                  {Object.entries(dossier.loss_run.summary).map(([k, v]) => {
                    const isMoneyKey = MONEY_KEY_PATTERNS.some((p) => k.includes(p));
                    return (
                      <div key={k}>
                        <span className="lc-stat-label">{toTitleCase(k)}</span>
                        <strong className="font-mono text-sm">
                          {isMoneyKey && (typeof v === "number" || typeof v === "string")
                            ? fmtMoney(String(v), true)
                            : String(v)}
                        </strong>
                      </div>
                    );
                  })}
                </div>
                {/* By-line table */}
                {Array.isArray(dossier.loss_run.by_coverage_line) &&
                  dossier.loss_run.by_coverage_line.length > 0 && (
                    <table
                      style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}
                    >
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                          <th className="text-xs text-secondary" style={{ textAlign: "left", padding: "var(--space-xs) var(--space-sm) var(--space-xs) 0", fontWeight: 500 }}>Line</th>
                          <th className="text-xs text-secondary font-mono" style={{ textAlign: "right", padding: "var(--space-xs)" }}>Claims</th>
                          <th className="text-xs text-secondary font-mono" style={{ textAlign: "right", padding: "var(--space-xs) 0 var(--space-xs) var(--space-sm)" }}>Incurred</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dossier.loss_run.by_coverage_line.map((row: Record<string, unknown>, i: number) => (
                          <tr key={i} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                            <td style={{ padding: "var(--space-xs) var(--space-sm) var(--space-xs) 0" }}>
                              {lineLabel(String(row.coverage_line ?? row.line ?? ""))}
                            </td>
                            <td className="font-mono" style={{ textAlign: "right", padding: "var(--space-xs)" }}>
                              {String(row.claim_count ?? row.claims ?? "—")}
                            </td>
                            <td className="font-mono" style={{ textAlign: "right", padding: "var(--space-xs) 0 var(--space-xs) var(--space-sm)" }}>
                              {fmtMoney(String(row.total_incurred ?? row.incurred ?? ""), true)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              </div>
            )}
          </div>
        )}

        {/* Incidents — stable id for KPI click wiring */}
        {dossier.incidents.recent.length > 0 && (
          <div id="dossier-incidents" className="lc-card">
            <button
              type="button"
              className="lc-card__inner"
              aria-expanded={openAccordions.has("dossier-incidents")}
              onClick={() => toggleAccordion("dossier-incidents")}
              style={{
                ...accordionSummaryStyle,
                width: "100%",
                background: "none",
                border: "none",
                fontFamily: "inherit",
              }}
            >
              <span>Recent incidents ({dossier.incidents.recent.length})</span>
              <span
                style={{
                  fontSize: 10,
                  opacity: 0.5,
                  transform: openAccordions.has("dossier-incidents") ? "rotate(180deg)" : undefined,
                  transition: "transform 150ms ease",
                }}
              >
                ▼
              </span>
            </button>
            {openAccordions.has("dossier-incidents") && (
              <div className="lc-card__inner" style={{ paddingTop: 0 }}>
                <div className="flex flex-col gap-sm">
                  {dossier.incidents.recent.map((inc) => (
                    <div
                      key={inc.id}
                      style={{
                        padding: "var(--space-sm)",
                        background: "var(--bg-inset)",
                        borderRadius: "var(--radius-sm)",
                      }}
                    >
                      <p className="text-sm" style={{ margin: "0 0 2px 0" }}>{inc.summary}</p>
                      <p className="text-xs text-muted" style={{ margin: 0 }}>
                        {new Date(inc.occurred_at).toLocaleDateString()}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Compliance — stable id for KPI click wiring */}
        {dossier.compliance.open_items.length > 0 && (
          <div id="dossier-compliance" className="lc-card">
            <button
              type="button"
              className="lc-card__inner"
              aria-expanded={openAccordions.has("dossier-compliance")}
              onClick={() => toggleAccordion("dossier-compliance")}
              style={{
                ...accordionSummaryStyle,
                width: "100%",
                background: "none",
                border: "none",
                fontFamily: "inherit",
              }}
            >
              <span>Compliance — open items ({dossier.compliance.open_items.length})</span>
              <span
                style={{
                  fontSize: 10,
                  opacity: 0.5,
                  transform: openAccordions.has("dossier-compliance") ? "rotate(180deg)" : undefined,
                  transition: "transform 150ms ease",
                }}
              >
                ▼
              </span>
            </button>
            {openAccordions.has("dossier-compliance") && (
              <div className="lc-card__inner" style={{ paddingTop: 0 }}>
                <div className="flex flex-col gap-sm">
                  {dossier.compliance.open_items.map((item, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-sm"
                      style={{
                        padding: "var(--space-sm)",
                        background: "var(--bg-inset)",
                        borderRadius: "var(--radius-sm)",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "var(--text-xs)",
                          color:
                            item.severity === "high"
                              ? "var(--state-error)"
                              : item.severity === "medium"
                              ? "var(--state-warning)"
                              : "var(--text-muted)",
                          border: `1px solid ${
                            item.severity === "high"
                              ? "var(--state-error)"
                              : item.severity === "medium"
                              ? "var(--state-warning)"
                              : "var(--border-subtle)"
                          }`,
                          borderRadius: "var(--radius-sm)",
                          padding: "1px 6px",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          whiteSpace: "nowrap",
                          flex: "none",
                        }}
                      >
                        {SEVERITY_LABELS[item.severity] ?? toTitleCase(item.severity)}
                      </span>
                      <p className="text-sm" style={{ margin: 0 }}>{item.title}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
