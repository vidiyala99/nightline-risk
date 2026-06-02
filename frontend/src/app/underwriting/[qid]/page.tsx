"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Landmark, ShieldCheck, XCircle } from "lucide-react";
import { useAuth, useIsCarrier } from "@/contexts/AuthContext";
import { TierBadge, Tier as UiTier } from "@/components/ui/TierBadge";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  fetchUnderwritingQueue,
  fmtMoney,
  lineLabel,
  rescaleBreakdownToTotal,
  underwriteQuote,
  type QueueRow,
} from "@/lib/underwriting";

export default function UnderwriteDecisionPage() {
  const { qid } = useParams<{ qid: string }>();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const isCarrier = useIsCarrier();

  const [row, setRow] = useState<QueueRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notInQueue, setNotInQueue] = useState(false);

  // Decision form state
  const [totalInput, setTotalInput] = useState("");
  const [declineReason, setDeclineReason] = useState("");
  const [submitting, setSubmitting] = useState<"quote" | "decline" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (isLoaded && isSignedIn && !isCarrier) router.replace("/dashboard");
  }, [isLoaded, isSignedIn, isCarrier, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isCarrier || !qid) return;
    let cancelled = false;
    (async () => {
      try {
        const queue = await fetchUnderwritingQueue();
        if (cancelled) return;
        const found = queue.find((r) => r.quote_id === qid) ?? null;
        setRow(found);
        setNotInQueue(!found);
        if (found?.suggested_premium_breakdown) {
          setTotalInput(found.suggested_premium_breakdown.total);
        }
      } catch {
        if (!cancelled) setFormError("Couldn't load this submission.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, isCarrier, qid]);

  const suggested = row?.suggested_premium_breakdown ?? null;
  const feeFloor = useMemo(() => {
    if (!suggested) return 0;
    return Number(suggested.fees.policy_fee) + Number(suggested.fees.surplus_lines_tax);
  }, [suggested]);

  async function handleQuote() {
    if (!suggested) return;
    setFormError(null);
    const target = Number(totalInput);
    if (!Number.isFinite(target) || target <= 0) {
      setFormError("Enter a valid premium total.");
      return;
    }
    // Keep the breakdown internally consistent: if the underwriter changed the
    // total, rescale the line premiums proportionally so the carrier's stored
    // quote still sums correctly (the engine suggestion is sent verbatim when
    // unchanged).
    const unchanged = Math.round(target * 100) === Math.round(Number(suggested.total) * 100);
    const breakdown = unchanged ? suggested : rescaleBreakdownToTotal(suggested, target);
    if (!breakdown) {
      setFormError(`Total must be above the fixed fees (${fmtMoney(feeFloor, true)}).`);
      return;
    }
    setSubmitting("quote");
    try {
      await underwriteQuote(qid, { decision: "quote", premium_breakdown: breakdown });
      toastSuccess(`Quoted ${row?.venue_name ?? "submission"} at ${fmtMoney(breakdown.total)}.`);
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
      toastSuccess(`Declined ${row?.venue_name ?? "submission"}.`);
      router.push("/underwriting");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not record the decline.";
      setFormError(message);
      toastError(message);
    } finally {
      setSubmitting(null);
    }
  }

  if (!isLoaded || loading || !isCarrier) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (notInQueue || !row) {
    return (
      <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
        <div className="lc-card" style={{ marginTop: "clamp(40px, 12vh, 120px)" }}>
          <div className="lc-card__inner" style={{ textAlign: "center", padding: "var(--space-xl)" }}>
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              This submission is no longer awaiting a decision — it may already have been quoted or declined.
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

  const cardLabel = {
    fontSize: "var(--text-xs)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    color: "var(--text-secondary)",
    borderBottom: "1px solid var(--border-subtle)",
    paddingBottom: "var(--space-sm)",
    marginBottom: "var(--space-md)",
  };

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ marginBottom: "var(--space-md)" }}
        onClick={() => router.push("/underwriting")}
      >
        <ArrowLeft size={16} /> Desk
      </button>

      <section className="lc-hero" style={{ marginBottom: "var(--space-lg)" }}>
        <div>
          <span className="lc-eyebrow">
            CARRIER
            <span className="lc-eyebrow__sep" />
            UNDERWRITING DECISION
          </span>
          <h1 className="lc-display">{row.venue_name}</h1>
          <p className="lc-sub">
            {row.coverage_lines.map(lineLabel).join(" · ") || "Coverage TBD"}
            {row.effective_date ? ` · effective ${new Date(row.effective_date).toLocaleDateString()}` : ""}
          </p>
        </div>
        <div className="lc-hero__meta">
          <div className="lc-meta-cell" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
            <span className="lc-stat-label">Risk tier</span>
            <span className="flex items-center" style={{ gap: 8 }}>
              <TierBadge tier={row.risk.tier as UiTier} />
              <strong className="font-mono">{row.risk.total_score}</strong>
            </span>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-xl" style={{ alignItems: "start" }}>
        {/* Left: engine-suggested breakdown */}
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
                    <span className="text-base font-mono font-bold" style={{ color: "var(--accent-ink)" }}>
                      {fmtMoney(suggested.total, true)}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-tertiary" style={{ marginTop: "var(--space-md)", fontStyle: "italic", lineHeight: 1.5 }}>
                  Risk-adjusted by the calibrated tier ({row.risk.tier}) and this carrier&apos;s appetite. Editing the
                  total below rescales the lines proportionally.
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

        {/* Right: decision */}
        <div className="lc-card">
          <div className="lc-card__inner">
            <h2 style={cardLabel}>Decision</h2>

            {/* Quote */}
            <div className="flex flex-col gap-sm">
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
                Issues the carrier&apos;s quote and escalates the submission for the broker to bind.
              </p>
            </div>

            <div
              className="text-xs text-muted"
              style={{ textAlign: "center", margin: "var(--space-md) 0", letterSpacing: "0.1em" }}
            >
              — OR —
            </div>

            {/* Decline */}
            <div className="flex flex-col gap-sm">
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

            {formError && (
              <p className="text-xs" style={{ color: "var(--state-error)", marginTop: "var(--space-md)" }}>
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
    </div>
  );
}
