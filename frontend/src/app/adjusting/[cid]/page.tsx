"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, AlertTriangle, ShieldCheck, ShieldOff, ShieldAlert } from "lucide-react";

import { useAuth, useIsCarrier } from "@/contexts/AuthContext";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  fetchAdjusterClaim,
  decideCoverage,
  adjustReserve,
  approvePayment,
  closeClaim,
  type CoverageDecision,
  type ReserveHint,
} from "@/lib/adjusting";
import {
  CLAIM_STATUS_LABEL,
  PAYMENT_TYPE_LABEL,
  PAYMENT_TYPE_TONE,
  formatLedgerMoney,
  reserveAdequacy,
} from "@/lib/claim-tokens";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTitleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  minHeight: 44,
  padding: "var(--space-xs) var(--space-sm)",
  width: "100%",
  fontSize: "var(--text-sm)",
  fontFamily: "inherit",
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: 72,
  resize: "vertical",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
};

const cardLabel: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-subtle)",
  paddingBottom: "var(--space-sm)",
  marginBottom: "var(--space-md)",
};

const accordionSummaryStyle: React.CSSProperties = {
  cursor: "pointer",
  fontSize: "var(--text-xs)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--text-secondary)",
  userSelect: "none" as const,
  listStyle: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

// ---------------------------------------------------------------------------
// Coverage decision chip
// ---------------------------------------------------------------------------

const DECISION_CONFIG: Record<
  CoverageDecision,
  { label: string; color: string; bg: string }
> = {
  covered: {
    label: "Covered",
    color: "var(--state-success)",
    bg: "color-mix(in srgb, var(--state-success) 12%, transparent)",
  },
  reservation_of_rights: {
    label: "Reservation of Rights",
    color: "var(--state-warning)",
    bg: "color-mix(in srgb, var(--state-warning) 12%, transparent)",
  },
  denied: {
    label: "Denied",
    color: "var(--state-error)",
    bg: "color-mix(in srgb, var(--state-error) 12%, transparent)",
  },
};

function CoverageChip({ decision }: { decision: CoverageDecision }) {
  const cfg = DECISION_CONFIG[decision];
  return (
    <span
      style={{
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        border: `1px solid ${cfg.color}`,
        color: cfg.color,
        background: cfg.bg,
        borderRadius: "var(--radius-sm)",
        padding: "2px 8px",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      {cfg.label}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const label =
    CLAIM_STATUS_LABEL[status as keyof typeof CLAIM_STATUS_LABEL] ??
    toTitleCase(status);
  return (
    <span
      style={{
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        border: "1px solid var(--border-subtle)",
        color: "var(--text-secondary)",
        borderRadius: "var(--radius-sm)",
        padding: "2px 8px",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Reserve hint banner
// ---------------------------------------------------------------------------

function ReserveHintBanner({ hint }: { hint: ReserveHint }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-xs)",
        padding: "var(--space-sm) var(--space-md)",
        background: "color-mix(in srgb, var(--state-warning) 8%, var(--bg-surface))",
        border: "1px solid color-mix(in srgb, var(--state-warning) 30%, transparent)",
        borderRadius: "var(--radius-sm)",
        fontSize: "var(--text-xs)",
        color: "var(--text-secondary)",
        lineHeight: 1.5,
      }}
    >
      <AlertTriangle
        size={13}
        style={{ color: "var(--state-warning)", flexShrink: 0, marginTop: 1 }}
        aria-hidden
      />
      <span>
        <strong style={{ color: "var(--text-primary)" }}>Advisory suggestion</strong>{" "}
        {formatLedgerMoney(hint.low)}–{formatLedgerMoney(hint.high)} ·{" "}
        <em>{hint.severity_band}</em> · {hint.basis} — does not auto-fill.
        {hint.chain_ladder_mean && (
          <>
            {" "}
            <strong style={{ color: "var(--text-primary)" }}>
              Chain-ladder estimate
            </strong>{" "}
            {formatLedgerMoney(hint.chain_ladder_mean)} (IBNR-aware).
          </>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment ledger (inline — adapted from broker detail)
// ---------------------------------------------------------------------------

interface Payment {
  id: string;
  amount: string;
  payment_type: string;
  paid_on: string;
  description?: string;
}

function PaymentLedger({ payments }: { payments: Payment[] }) {
  if (!payments || payments.length === 0) {
    return (
      <p
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--text-muted)",
          margin: 0,
          fontStyle: "italic",
        }}
      >
        No payments recorded yet.
      </p>
    );
  }
  const sorted = payments
    .slice()
    .sort((a, b) => new Date(b.paid_on).getTime() - new Date(a.paid_on).getTime());

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "var(--text-sm)",
        }}
        aria-label="Payment ledger"
      >
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
            <th
              style={{
                textAlign: "left",
                padding: "var(--space-xs) var(--space-sm) var(--space-xs) 0",
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
                fontWeight: 500,
              }}
            >
              Paid on
            </th>
            <th
              style={{
                textAlign: "left",
                padding: "var(--space-xs)",
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
                fontWeight: 500,
              }}
            >
              Type
            </th>
            <th
              style={{
                textAlign: "right",
                padding: "var(--space-xs)",
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
                fontWeight: 500,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              Amount
            </th>
            <th
              style={{
                textAlign: "left",
                padding: "var(--space-xs) 0 var(--space-xs) var(--space-sm)",
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
                fontWeight: 500,
              }}
            >
              Description
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const tone =
              PAYMENT_TYPE_TONE[p.payment_type as keyof typeof PAYMENT_TYPE_TONE];
            const toneColor =
              tone === "success"
                ? "var(--state-success)"
                : tone === "warning"
                ? "var(--state-warning)"
                : "var(--state-info, var(--text-secondary))";
            const label =
              PAYMENT_TYPE_LABEL[p.payment_type as keyof typeof PAYMENT_TYPE_LABEL] ??
              toTitleCase(p.payment_type);
            return (
              <tr key={p.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                <td
                  style={{
                    padding: "var(--space-xs) var(--space-sm) var(--space-xs) 0",
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "var(--text-xs)",
                  }}
                >
                  {new Date(p.paid_on).toLocaleDateString()}
                </td>
                <td style={{ padding: "var(--space-xs)" }}>
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      fontWeight: 600,
                      border: `1px solid ${toneColor}`,
                      color: toneColor,
                      borderRadius: "var(--radius-sm)",
                      padding: "1px 6px",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {label}
                  </span>
                </td>
                <td
                  style={{
                    textAlign: "right",
                    padding: "var(--space-xs)",
                    fontFamily: "var(--font-mono, monospace)",
                    fontVariantNumeric: "tabular-nums",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  {formatLedgerMoney(p.amount)}
                </td>
                <td
                  style={{
                    padding: "var(--space-xs) 0 var(--space-xs) var(--space-sm)",
                    fontSize: "var(--text-sm)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {p.description || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reserve history table (inline — adapted from broker detail)
// ---------------------------------------------------------------------------

interface ReserveHistoryRow {
  id: string;
  from_amount: string;
  to_amount: string;
  change_reason: string;
  changed_at?: string;
  received_at?: string;
}

function ReserveHistoryTable({ history }: { history: ReserveHistoryRow[] }) {
  if (!history || history.length === 0) {
    return (
      <p
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--text-muted)",
          margin: 0,
          fontStyle: "italic",
        }}
      >
        No reserve changes recorded yet.
      </p>
    );
  }
  const sorted = history
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.changed_at ?? a.received_at ?? 0).getTime();
      const tb = new Date(b.changed_at ?? b.received_at ?? 0).getTime();
      return tb - ta;
    });

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}
        aria-label="Reserve change history"
      >
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
            {["Date", "From → To", "Reason"].map((h, i) => (
              <th
                key={h}
                style={{
                  textAlign: i === 1 ? "right" : "left",
                  padding: "var(--space-xs) var(--space-sm) var(--space-xs) 0",
                  fontSize: "var(--text-xs)",
                  color: "var(--text-secondary)",
                  fontWeight: 500,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const ts = r.changed_at ?? r.received_at;
            return (
              <tr key={r.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                <td
                  style={{
                    padding: "var(--space-xs) var(--space-sm) var(--space-xs) 0",
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "var(--text-xs)",
                  }}
                >
                  {ts ? new Date(ts).toLocaleDateString() : "—"}
                </td>
                <td
                  style={{
                    textAlign: "right",
                    padding: "var(--space-xs) var(--space-sm) var(--space-xs) 0",
                    fontFamily: "var(--font-mono, monospace)",
                    fontVariantNumeric: "tabular-nums",
                    fontSize: "var(--text-sm)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatLedgerMoney(r.from_amount)} → {formatLedgerMoney(r.to_amount)}
                </td>
                <td
                  style={{
                    padding: "var(--space-xs) 0 var(--space-xs) var(--space-sm)",
                    fontSize: "var(--text-sm)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {r.change_reason || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type ActionPanel = "reserve" | "payment" | "close" | null;

export default function AdjusterClaimDetailPage() {
  const { cid } = useParams<{ cid: string }>();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const isCarrier = useIsCarrier();

  // Claim data
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Track whether the initial load has completed so that reload-after-mutation
  // does NOT flip `loading` back to true (which would unmount the content DOM
  // and reset scrollTop to 0 — the scroll-jump bug).
  const initialLoadDone = useRef(false);

  // Coverage decision form
  const [decisionChoice, setDecisionChoice] = useState<CoverageDecision>("covered");
  const [decisionRationale, setDecisionRationale] = useState("");

  // Reserve form
  const [reserveAmount, setReserveAmount] = useState("");
  const [reserveReason, setReserveReason] = useState("");

  // Payment form
  const [paymentType, setPaymentType] = useState("indemnity");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [paymentDesc, setPaymentDesc] = useState("");

  // Close form
  const [closeDisposition, setCloseDisposition] = useState<"paid" | "denied" | "dropped">("paid");
  const [closeFinalIndemnity, setCloseFinalIndemnity] = useState("");

  // Shared action state
  const [activePanel, setActivePanel] = useState<ActionPanel>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Auth guards
  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (isLoaded && isSignedIn && !isCarrier) router.replace("/dashboard");
  }, [isLoaded, isSignedIn, isCarrier, router]);

  // Load claim.
  // Only show the full-page spinner on the very first fetch. Subsequent calls
  // (after mutations) silently refresh `data` in the background so the content
  // stays mounted and scroll position is preserved.
  const load = useCallback(async () => {
    if (!cid) return;
    setLoadError(null);
    const isRefresh = initialLoadDone.current;
    if (!isRefresh) setLoading(true);
    try {
      const result = await fetchAdjusterClaim(cid);
      setData(result);
      initialLoadDone.current = true;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load claim.");
    } finally {
      if (!isRefresh) setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isCarrier) return;
    load();
  }, [isLoaded, isSignedIn, isCarrier, load]);

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  async function handleDecideCoverage() {
    setFormError(null);
    if (!decisionRationale.trim()) {
      setFormError("A rationale is required — it is recorded on the claim.");
      return;
    }
    setSubmitting(true);
    try {
      await decideCoverage(cid, decisionChoice, decisionRationale.trim());
      toastSuccess(
        `Coverage ${DECISION_CONFIG[decisionChoice].label.toLowerCase()} recorded.`,
      );
      await load();
      setDecisionRationale("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not record coverage decision.";
      setFormError(msg);
      toastError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdjustReserve() {
    setFormError(null);
    const n = parseFloat(reserveAmount);
    if (!reserveAmount || !Number.isFinite(n) || n < 0) {
      setFormError("Enter a valid reserve amount (≥ 0).");
      return;
    }
    if (!reserveReason.trim()) {
      setFormError("A change reason is required.");
      return;
    }
    setSubmitting(true);
    try {
      await adjustReserve(cid, reserveAmount, reserveReason.trim());
      toastSuccess(`Reserve set to ${formatLedgerMoney(reserveAmount)}.`);
      await load();
      setReserveAmount("");
      setReserveReason("");
      setActivePanel(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not adjust reserve.";
      setFormError(msg);
      toastError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprovePayment() {
    setFormError(null);
    const n = parseFloat(paymentAmount);
    if (!paymentAmount || !Number.isFinite(n) || n <= 0) {
      setFormError("Amount must be greater than zero.");
      return;
    }
    if (!paymentDate) {
      setFormError("A payment date is required.");
      return;
    }
    setSubmitting(true);
    try {
      await approvePayment(cid, paymentAmount, paymentType, paymentDate, paymentDesc.trim());
      toastSuccess(`Payment of ${formatLedgerMoney(paymentAmount)} recorded.`);
      await load();
      setPaymentAmount("");
      setPaymentDesc("");
      setActivePanel(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not approve payment.";
      setFormError(msg);
      toastError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCloseClaim() {
    setFormError(null);
    if (closeDisposition === "paid" && !closeFinalIndemnity) {
      setFormError("Final indemnity is required when disposition is paid.");
      return;
    }
    setSubmitting(true);
    try {
      await closeClaim(
        cid,
        closeDisposition,
        closeDisposition === "paid" ? closeFinalIndemnity : undefined,
      );
      toastSuccess(`Claim closed — ${closeDisposition}.`);
      await load();
      setCloseFinalIndemnity("");
      setActivePanel(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not close claim.";
      setFormError(msg);
      toastError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function openPanel(panel: ActionPanel) {
    setFormError(null);
    setActivePanel(panel);
  }

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

  if (loadError || !data) {
    return (
      <div
        className="lc-shell min-h-screen"
        style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}
      >
        <div className="lc-card" style={{ marginTop: "clamp(40px, 12vh, 120px)" }}>
          <div
            className="lc-card__inner"
            style={{ textAlign: "center", padding: "var(--space-xl)" }}
          >
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              {loadError ?? "Claim not found or you do not have access."}
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: "var(--space-md)", minHeight: 44 }}
              onClick={() => router.push("/adjusting")}
            >
              <ArrowLeft size={16} /> Back to queue
            </button>
          </div>
        </div>
      </div>
    );
  }

  const claim = data.claim;
  const venueName: string = data.venue_name ?? data.venue_id ?? "—";
  const incidentReport: {
    packet_id?: string;
    severity?: string | null;
    confidence?: number | null;
    explanation?: string | null;
    memo_summary?: string | null;
    recommendation?: {
      should_file: boolean;
      probability: number;
      expected_payout: { low_usd: number; median_usd: number; high_usd: number };
      net_expected_value_usd: number;
      carrier_payout?: number;
      confidence: number;
    } | null;
    citation_count?: number;
    corroboration_status?: string | null;
  } | null = data.incident_report ?? null;
  const dateOfLoss = data.date_of_loss
    ? new Date(data.date_of_loss).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";
  const payments: Payment[] = data.payments ?? [];
  const reserveHistory: ReserveHistoryRow[] = data.reserve_history ?? [];
  const reserveHint: ReserveHint | null = data.reserve_hint ?? null;

  // Compute total incurred: indemnity + expense − recoveries
  const indemnityPaid = parseFloat(claim.indemnity_paid_to_date ?? "0") || 0;
  const expensePaid = parseFloat(claim.expense_paid_to_date ?? "0") || 0;
  const recoveries = parseFloat(claim.recoveries_to_date ?? "0") || 0;
  const totalIncurred = indemnityPaid + expensePaid - recoveries;

  const adequacy = reserveAdequacy(
    claim.current_reserve,
    String(totalIncurred),
    reserveHint,
  );

  const hasCoverageDecision = claim.coverage_decision !== null;
  const indemnityGated =
    claim.coverage_decision !== "covered" &&
    claim.coverage_decision !== "reservation_of_rights";

  const isClosed =
    claim.status === "closed_paid" ||
    claim.status === "closed_denied" ||
    claim.status === "closed_dropped";

  return (
    <div
      className="lc-shell min-h-screen"
      style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* 1. Back link                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ paddingTop: "var(--space-lg)", marginBottom: "var(--space-sm)" }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => router.push("/adjusting")}
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
          Back to adjuster queue
        </button>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 2. Hero header                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section className="lc-hero" style={{ marginBottom: "var(--space-lg)" }}>
        <div>
          <span className="lc-eyebrow">
            CARRIER
            <span className="lc-eyebrow__sep" />
            CLAIM ADJUDICATION
          </span>
          <h1 className="lc-display">
            {venueName}
          </h1>
          <p
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "var(--text-xs)",
              color: "var(--text-muted)",
              margin: "2px 0 0",
              letterSpacing: "0.03em",
            }}
          >
            {claim.id}
          </p>
          <p className="lc-sub">
            {toTitleCase(claim.coverage_line)} · {venueName} · {dateOfLoss}
          </p>
        </div>

        {/* KPI band */}
        <div className="lc-hero__meta">
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Status</span>
            <StatusChip status={claim.status} />
          </div>

          <div className="lc-meta-cell">
            <span className="lc-stat-label">Coverage</span>
            {hasCoverageDecision ? (
              <CoverageChip decision={claim.coverage_decision} />
            ) : (
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--text-muted)",
                  fontStyle: "italic",
                }}
              >
                Pending
              </span>
            )}
          </div>

          <div className="lc-meta-cell">
            <span className="lc-stat-label">Current reserve</span>
            <strong className="font-mono">
              {formatLedgerMoney(claim.current_reserve)}
            </strong>
          </div>

          <div className="lc-meta-cell">
            <span className="lc-stat-label">Total incurred</span>
            <strong className="font-mono">
              {formatLedgerMoney(String(totalIncurred))}
            </strong>
          </div>

          {adequacy && (
            <div className="lc-meta-cell">
              <span className="lc-stat-label">Reserve adequacy</span>
              <strong
                style={{
                  fontSize: "var(--text-sm)",
                  color:
                    adequacy.tone === "danger"
                      ? "var(--state-error)"
                      : adequacy.tone === "success"
                      ? "var(--state-success)"
                      : "var(--text-secondary)",
                }}
              >
                {adequacy.label}
              </strong>
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 3. AI Incident Report — decision support, placed ABOVE coverage    */}
      {/* ------------------------------------------------------------------ */}
      {incidentReport ? (() => {
        const sev = (incidentReport.severity ?? "").toLowerCase();
        const sevColor =
          sev === "critical" || sev === "high"
            ? "var(--state-error)"
            : sev === "medium"
            ? "var(--state-warning)"
            : sev === "low"
            ? "var(--accent-ink)"
            : "var(--text-muted)";
        const confPct = incidentReport.confidence != null
          ? Math.round(incidentReport.confidence * 100)
          : null;
        const rec = incidentReport.recommendation ?? null;
        const exposureEV =
          rec != null && rec.carrier_payout != null
            ? Math.round(rec.carrier_payout * rec.probability)
            : null;
        const exposureStr = exposureEV != null ? "$" + exposureEV.toLocaleString() : "—";
        // Carrier exposure is a loss figure: positive = warning/error, zero = neutral.
        const exposureColor =
          exposureEV == null || exposureEV === 0
            ? "var(--text-secondary)"
            : "var(--state-error)";
        return (
          <div
            className="lc-card"
            style={{
              marginBottom: "var(--space-xl)",
              borderLeft: `3px solid ${sev ? sevColor : "var(--border-subtle)"}`,
              position: "relative",
            }}
          >
            <div className="lc-card__inner">
              {/* Header row */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "var(--space-sm)",
                  borderBottom: "1px solid var(--border-subtle)",
                  paddingBottom: "var(--space-sm)",
                  marginBottom: "var(--space-md)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Incident report
                  </span>
                  {sev && (
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        fontWeight: 600,
                        border: `1px solid ${sevColor}`,
                        color: sevColor,
                        background: `color-mix(in srgb, ${sevColor} 10%, transparent)`,
                        borderRadius: "var(--radius-sm)",
                        padding: "2px 8px",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {sev}
                    </span>
                  )}
                </div>
                {confPct != null && (
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      fontFamily: "var(--font-mono, monospace)",
                      color: sevColor || "var(--text-secondary)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    {confPct}% confidence
                  </span>
                )}
              </div>

              {/* Memo summary */}
              {incidentReport.memo_summary && (
                <p
                  style={{
                    fontSize: "var(--text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-secondary)",
                    margin: "0 0 var(--space-xs) 0",
                  }}
                >
                  Insured&apos;s defense posture
                </p>
              )}
              {incidentReport.memo_summary && (
                <p
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--text-secondary)",
                    lineHeight: 1.55,
                    margin: "0 0 var(--space-md) 0",
                  }}
                >
                  {incidentReport.memo_summary}
                </p>
              )}

              {/* Expected payout numbers — only when recommendation present */}
              {rec && (
                <div
                  style={{
                    background: "var(--bg-elevated, var(--bg-surface))",
                    padding: "var(--space-md)",
                    borderRadius: "var(--radius-sm)",
                    marginBottom: "var(--space-md)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-sm)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Expected payout
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontVariantNumeric: "tabular-nums",
                        fontSize: "var(--text-sm)",
                      }}
                    >
                      ${rec.expected_payout.low_usd.toLocaleString()}
                      <span style={{ color: "var(--text-secondary)" }}> – </span>
                      ${rec.expected_payout.high_usd.toLocaleString()}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Median
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontVariantNumeric: "tabular-nums",
                        fontSize: "var(--text-sm)",
                        fontWeight: 700,
                        color: "var(--accent-ink)",
                      }}
                    >
                      ${rec.expected_payout.median_usd.toLocaleString()}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      borderTop: "1px solid var(--border-subtle)",
                      paddingTop: "var(--space-sm)",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Indemnity exposure (EV)
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontVariantNumeric: "tabular-nums",
                        fontSize: "var(--text-sm)",
                        fontWeight: 700,
                        color: exposureColor,
                      }}
                    >
                      {exposureStr}
                    </span>
                  </div>
                </div>
              )}
              {rec && (
                <p
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-secondary)",
                    margin: "0 0 var(--space-md) 0",
                    fontFamily: "var(--font-mono, monospace)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {Math.round(rec.probability * 100)}% pay-out likelihood
                </p>
              )}

              {/* Footer: citation count + corroboration */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-sm)",
                  flexWrap: "wrap",
                  borderTop: "1px solid var(--border-subtle)",
                  paddingTop: "var(--space-sm)",
                }}
              >
                {(incidentReport.citation_count ?? 0) > 0 && (
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono, monospace)",
                    }}
                  >
                    {incidentReport.citation_count} citation
                    {incidentReport.citation_count !== 1 ? "s" : ""}
                  </span>
                )}
                {incidentReport.corroboration_status && (
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      fontWeight: 600,
                      border: `1px solid ${
                        incidentReport.corroboration_status === "CONSISTENT"
                          ? "var(--state-success)"
                          : incidentReport.corroboration_status === "CONTRADICTED"
                          ? "var(--state-error)"
                          : "var(--state-warning)"
                      }`,
                      color:
                        incidentReport.corroboration_status === "CONSISTENT"
                          ? "var(--state-success)"
                          : incidentReport.corroboration_status === "CONTRADICTED"
                          ? "var(--state-error)"
                          : "var(--state-warning)",
                      borderRadius: "var(--radius-sm)",
                      padding: "1px 6px",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {incidentReport.corroboration_status}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })() : (
        <p
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--text-muted)",
            fontStyle: "italic",
            marginBottom: "var(--space-xl)",
          }}
        >
          No AI incident report linked to this claim.
        </p>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 4. Hero action: Decide coverage (only when pending)                */}
      {/* ------------------------------------------------------------------ */}
      {!hasCoverageDecision && (
        <div className="lc-card" style={{ marginBottom: "var(--space-xl)" }}>
          <div className="lc-card__inner">
            <h2 style={cardLabel}>Coverage determination</h2>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "var(--space-xl)",
                alignItems: "start",
              }}
            >
              {/* Left: choices */}
              <div className="flex flex-col gap-md">
                <p
                  className="text-sm"
                  style={{ margin: 0, color: "var(--text-secondary)" }}
                >
                  Select coverage determination and provide a rationale. This is
                  recorded on the claim&apos;s audit trail and forwarded to the broker.
                </p>

                <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
                  <legend
                    style={{
                      fontSize: "var(--text-xs)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--text-secondary)",
                      marginBottom: "var(--space-sm)",
                    }}
                  >
                    Decision
                  </legend>
                  {(
                    [
                      { value: "covered", icon: ShieldCheck, label: "Covered" },
                      {
                        value: "reservation_of_rights",
                        icon: ShieldAlert,
                        label: "Reservation of Rights",
                      },
                      { value: "denied", icon: ShieldOff, label: "Denied" },
                    ] as const
                  ).map(({ value, icon: Icon, label }) => {
                    const cfg = DECISION_CONFIG[value];
                    const selected = decisionChoice === value;
                    return (
                      <label
                        key={value}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--space-sm)",
                          padding: "var(--space-sm) var(--space-md)",
                          borderRadius: "var(--radius-sm)",
                          border: `1px solid ${selected ? cfg.color : "var(--border-subtle)"}`,
                          background: selected ? cfg.bg : "transparent",
                          cursor: "pointer",
                          marginBottom: "var(--space-xs)",
                          minHeight: 44,
                          transition: "border-color 120ms, background 120ms",
                        }}
                      >
                        <input
                          type="radio"
                          name="coverage-decision"
                          value={value}
                          checked={selected}
                          onChange={() => setDecisionChoice(value)}
                          disabled={submitting}
                          style={{ accentColor: cfg.color }}
                        />
                        <Icon size={15} style={{ color: cfg.color }} aria-hidden />
                        <span
                          style={{
                            fontSize: "var(--text-sm)",
                            fontWeight: selected ? 600 : 400,
                            color: selected ? cfg.color : "var(--text-primary)",
                          }}
                        >
                          {label}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              </div>

              {/* Right: rationale + submit */}
              <div className="flex flex-col gap-md">
                <div>
                  <label
                    htmlFor="coverage-rationale"
                    style={{
                      display: "block",
                      fontSize: "var(--text-xs)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--text-secondary)",
                      marginBottom: "var(--space-xs)",
                    }}
                  >
                    Rationale <span aria-hidden>*</span>
                  </label>
                  <textarea
                    id="coverage-rationale"
                    rows={4}
                    placeholder="Cite the policy language and findings that support this determination…"
                    value={decisionRationale}
                    onChange={(e) => setDecisionRationale(e.target.value)}
                    disabled={submitting}
                    style={textareaStyle}
                  />
                </div>

                {formError && (
                  <p
                    role="alert"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--state-error)",
                      margin: 0,
                    }}
                  >
                    {formError}
                  </p>
                )}

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleDecideCoverage}
                  disabled={submitting || !decisionRationale.trim()}
                  style={{ minHeight: 44 }}
                >
                  {submitting ? "Recording…" : "Record Coverage Determination"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Coverage determination banner — shown once decided */}
      {hasCoverageDecision && (
        <div
          className="lc-card"
          style={{
            marginBottom: "var(--space-xl)",
            borderLeft: `3px solid ${DECISION_CONFIG[claim.coverage_decision as CoverageDecision]?.color ?? "var(--border-subtle)"}`,
          }}
        >
          <div
            className="lc-card__inner"
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-sm)",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--text-secondary)",
                }}
              >
                Coverage determination
              </span>
              <CoverageChip decision={claim.coverage_decision} />
            </div>
            {claim.coverage_rationale && (
              <p
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--text-secondary)",
                  margin: 0,
                  lineHeight: 1.55,
                  fontStyle: "italic",
                }}
              >
                &ldquo;{claim.coverage_rationale}&rdquo;
              </p>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 5. Adjudication action cards                                       */}
      {/* ------------------------------------------------------------------ */}
      {!isClosed && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "var(--space-md)",
              marginBottom: "var(--space-xl)",
            }}
          >
          {/* Set reserve */}
          <div className="lc-card">
            <div className="lc-card__inner">
              <h2 style={cardLabel}>Set reserve</h2>

              {reserveHint && <ReserveHintBanner hint={reserveHint} />}

              <div
                className="flex flex-col gap-sm"
                style={{ marginTop: reserveHint ? "var(--space-md)" : 0 }}
              >
                <label
                  htmlFor="adj-reserve-amount"
                  style={{
                    fontSize: "var(--text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-secondary)",
                  }}
                >
                  New reserve (USD)
                </label>
                <input
                  id="adj-reserve-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder="25000.00"
                  value={reserveAmount}
                  onChange={(e) =>
                    setReserveAmount(e.target.value.replace(/[^0-9.]/g, ""))
                  }
                  disabled={submitting && activePanel === "reserve"}
                  style={inputStyle}
                />

                <label
                  htmlFor="adj-reserve-reason"
                  style={{
                    fontSize: "var(--text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-secondary)",
                  }}
                >
                  Change reason
                </label>
                <input
                  id="adj-reserve-reason"
                  type="text"
                  placeholder="e.g. post-investigation adjustment"
                  value={reserveReason}
                  onChange={(e) => setReserveReason(e.target.value)}
                  disabled={submitting && activePanel === "reserve"}
                  style={inputStyle}
                />

                {activePanel === "reserve" && formError && (
                  <p
                    role="alert"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--state-error)",
                      margin: 0,
                    }}
                  >
                    {formError}
                  </p>
                )}

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    openPanel("reserve");
                    handleAdjustReserve();
                  }}
                  disabled={submitting || !reserveAmount.trim() || !reserveReason.trim()}
                  style={{ minHeight: 44 }}
                >
                  {submitting && activePanel === "reserve"
                    ? "Adjusting…"
                    : "Adjust Reserve"}
                </button>
              </div>
            </div>
          </div>

          {/* Approve payment */}
          <div className="lc-card">
            <div className="lc-card__inner">
              <h2 style={cardLabel}>Approve payment</h2>

              <div className="flex flex-col gap-sm">
                <label
                  htmlFor="adj-pay-type"
                  style={{
                    fontSize: "var(--text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-secondary)",
                  }}
                >
                  Payment type
                </label>
                <select
                  id="adj-pay-type"
                  value={paymentType}
                  onChange={(e) => setPaymentType(e.target.value)}
                  disabled={submitting && activePanel === "payment"}
                  style={selectStyle}
                  title={
                    indemnityGated && paymentType === "indemnity"
                      ? "Coverage must be Covered or Reservation of Rights before indemnity payments can be approved."
                      : undefined
                  }
                >
                  <option
                    value="indemnity"
                    disabled={indemnityGated}
                    title={
                      indemnityGated
                        ? "Coverage must be Covered or Reservation of Rights"
                        : undefined
                    }
                  >
                    {PAYMENT_TYPE_LABEL.indemnity}
                    {indemnityGated ? " (coverage required)" : ""}
                  </option>
                  <option value="expense">{PAYMENT_TYPE_LABEL.expense}</option>
                  <option value="recovery">{PAYMENT_TYPE_LABEL.recovery}</option>
                </select>
                {indemnityGated && paymentType === "indemnity" && (
                  <p
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--state-warning)",
                      margin: 0,
                    }}
                  >
                    Indemnity payments require coverage to be Covered or Reservation of
                    Rights.
                  </p>
                )}

                <label
                  htmlFor="adj-pay-amount"
                  style={{
                    fontSize: "var(--text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-secondary)",
                  }}
                >
                  Amount (USD)
                </label>
                <input
                  id="adj-pay-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder="5000.00"
                  value={paymentAmount}
                  onChange={(e) =>
                    setPaymentAmount(e.target.value.replace(/[^0-9.]/g, ""))
                  }
                  disabled={submitting && activePanel === "payment"}
                  style={inputStyle}
                />

                <label
                  htmlFor="adj-pay-date"
                  style={{
                    fontSize: "var(--text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-secondary)",
                  }}
                >
                  Paid on
                </label>
                <input
                  id="adj-pay-date"
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  disabled={submitting && activePanel === "payment"}
                  style={inputStyle}
                />

                <label
                  htmlFor="adj-pay-desc"
                  style={{
                    fontSize: "var(--text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-secondary)",
                  }}
                >
                  Description
                </label>
                <input
                  id="adj-pay-desc"
                  type="text"
                  placeholder="e.g. settlement to claimant"
                  value={paymentDesc}
                  onChange={(e) => setPaymentDesc(e.target.value)}
                  disabled={submitting && activePanel === "payment"}
                  style={inputStyle}
                />

                {activePanel === "payment" && formError && (
                  <p
                    role="alert"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--state-error)",
                      margin: 0,
                    }}
                  >
                    {formError}
                  </p>
                )}

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    openPanel("payment");
                    handleApprovePayment();
                  }}
                  disabled={
                    submitting ||
                    !paymentAmount.trim() ||
                    (indemnityGated && paymentType === "indemnity")
                  }
                  style={{ minHeight: 44 }}
                  title={
                    indemnityGated && paymentType === "indemnity"
                      ? "Coverage must be Covered or Reservation of Rights"
                      : undefined
                  }
                >
                  {submitting && activePanel === "payment"
                    ? "Recording…"
                    : "Record Payment"}
                </button>
              </div>
            </div>
          </div>

          {/* Close claim */}
          <div className="lc-card">
            <div className="lc-card__inner">
              <h2 style={cardLabel}>Close claim</h2>

              <div className="flex flex-col gap-sm">
                <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
                  <legend
                    style={{
                      fontSize: "var(--text-xs)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--text-secondary)",
                      marginBottom: "var(--space-sm)",
                    }}
                  >
                    Disposition
                  </legend>
                  {(
                    [
                      { value: "paid", label: "Paid — settled in claimant's favor" },
                      { value: "denied", label: "Denied — coverage not triggered" },
                      { value: "dropped", label: "Dropped — claimant withdrew" },
                    ] as const
                  ).map(({ value, label }) => (
                    <label
                      key={value}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-sm)",
                        fontSize: "var(--text-sm)",
                        cursor: "pointer",
                        marginBottom: "var(--space-xs)",
                        minHeight: 44,
                        padding: "0 var(--space-xs)",
                      }}
                    >
                      <input
                        type="radio"
                        name="close-disposition"
                        value={value}
                        checked={closeDisposition === value}
                        onChange={() => setCloseDisposition(value)}
                        disabled={submitting}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>

                {closeDisposition === "paid" && (
                  <>
                    <label
                      htmlFor="adj-close-indemnity"
                      style={{
                        fontSize: "var(--text-xs)",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Final indemnity (USD) <span aria-hidden>*</span>
                    </label>
                    <input
                      id="adj-close-indemnity"
                      type="text"
                      inputMode="decimal"
                      placeholder="10000.00"
                      value={closeFinalIndemnity}
                      onChange={(e) =>
                        setCloseFinalIndemnity(e.target.value.replace(/[^0-9.]/g, ""))
                      }
                      disabled={submitting}
                      style={inputStyle}
                    />
                  </>
                )}

                {activePanel === "close" && formError && (
                  <p
                    role="alert"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--state-error)",
                      margin: 0,
                    }}
                  >
                    {formError}
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => {
                    openPanel("close");
                    handleCloseClaim();
                  }}
                  disabled={submitting}
                  style={{
                    minHeight: 44,
                    border: "1px solid var(--state-error)",
                    color: "var(--state-error)",
                    background: "none",
                    borderRadius: "var(--radius-sm)",
                    cursor: submitting ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                    fontSize: "var(--text-sm)",
                    fontWeight: 500,
                    transition: "opacity 120ms",
                    opacity: submitting ? 0.6 : 1,
                  }}
                >
                  {submitting && activePanel === "close" ? "Closing…" : "Close Claim"}
                </button>
              </div>
            </div>
          </div>
          </div>
        </>
      )}

      {/* Closed state notice */}
      {isClosed && (
        <div
          className="lc-card"
          style={{ marginBottom: "var(--space-xl)" }}
        >
          <div
            className="lc-card__inner"
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-sm)",
            }}
          >
            <StatusChip status={claim.status} />
            <span>
              This claim is closed. Adjudication actions are no longer available.
            </span>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 6. History accordions — secondary                                  */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-col gap-md">
        {/* Payment ledger */}
        <details className="lc-card">
          <summary className="lc-card__inner" style={accordionSummaryStyle}>
            <span>
              Payment ledger
              {payments.length > 0 && (
                <span
                  style={{
                    marginLeft: 8,
                    fontStyle: "normal",
                    textTransform: "none",
                    letterSpacing: 0,
                    fontSize: "var(--text-xs)",
                    color: "var(--text-muted)",
                  }}
                >
                  ({payments.length})
                </span>
              )}
            </span>
            <span style={{ fontSize: 10, opacity: 0.5 }}>▼</span>
          </summary>
          <div className="lc-card__inner" style={{ paddingTop: 0 }}>
            <PaymentLedger payments={payments} />
          </div>
        </details>

        {/* Reserve history */}
        <details className="lc-card">
          <summary className="lc-card__inner" style={accordionSummaryStyle}>
            <span>
              Reserve history
              {reserveHistory.length > 0 && (
                <span
                  style={{
                    marginLeft: 8,
                    fontStyle: "normal",
                    textTransform: "none",
                    letterSpacing: 0,
                    fontSize: "var(--text-xs)",
                    color: "var(--text-muted)",
                  }}
                >
                  ({reserveHistory.length})
                </span>
              )}
            </span>
            <span style={{ fontSize: 10, opacity: 0.5 }}>▼</span>
          </summary>
          <div className="lc-card__inner" style={{ paddingTop: 0 }}>
            <ReserveHistoryTable history={reserveHistory} />
          </div>
        </details>
      </div>
    </div>
  );
}
