"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useIsCarrier } from "@/contexts/AuthContext";
import {
  fetchAdjusterQueue,
  type AdjusterQueueRow,
  type CoverageDecision,
} from "@/lib/adjusting";
import {
  CLAIM_STATUS_LABEL,
  CLAIM_STATUS_TONE,
  formatLedgerMoney,
  type ClaimStatus,
} from "@/lib/claim-tokens";

// ─── Coverage chip ────────────────────────────────────────────────────────

type CoverageMeta = { label: string; color: string; bg: string };

const COVERAGE_META: Record<string, CoverageMeta> = {
  covered: {
    label: "Covered",
    color: "var(--state-success)",
    bg: "color-mix(in srgb, var(--state-success) 14%, transparent)",
  },
  reservation_of_rights: {
    label: "Res. of rights",
    color: "var(--state-warning)",
    bg: "color-mix(in srgb, var(--state-warning) 14%, transparent)",
  },
  denied: {
    label: "Denied",
    color: "var(--state-error)",
    bg: "color-mix(in srgb, var(--state-error) 14%, transparent)",
  },
  __null__: {
    label: "Coverage —",
    color: "var(--text-muted)",
    bg: "color-mix(in srgb, var(--text-muted) 10%, transparent)",
  },
};

function CoverageChip({ decision }: { decision: CoverageDecision | null }) {
  const meta = COVERAGE_META[decision ?? "__null__"] ?? COVERAGE_META.__null__;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 99,
        fontSize: "var(--text-xs, 11px)",
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: meta.color,
        background: meta.bg,
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

// ─── Status chip ──────────────────────────────────────────────────────────

const TONE_COLOR: Record<string, { color: string; bg: string }> = {
  success: {
    color: "var(--state-success)",
    bg: "color-mix(in srgb, var(--state-success) 14%, transparent)",
  },
  warning: {
    color: "var(--state-warning)",
    bg: "color-mix(in srgb, var(--state-warning) 14%, transparent)",
  },
  danger: {
    color: "var(--state-error)",
    bg: "color-mix(in srgb, var(--state-error) 14%, transparent)",
  },
  info: {
    color: "var(--state-info, var(--text-secondary))",
    bg: "color-mix(in srgb, var(--text-secondary) 10%, transparent)",
  },
  neutral: {
    color: "var(--text-muted)",
    bg: "color-mix(in srgb, var(--text-muted) 10%, transparent)",
  },
};

function StatusChip({ status }: { status: string }) {
  const label = CLAIM_STATUS_LABEL[status as ClaimStatus] ?? status;
  const tone = CLAIM_STATUS_TONE[status as ClaimStatus] ?? "neutral";
  const colors = TONE_COLOR[tone] ?? TONE_COLOR.neutral;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 99,
        fontSize: "var(--text-xs, 11px)",
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: colors.color,
        background: colors.bg,
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function Row({ row, onOpen }: { row: AdjusterQueueRow; onOpen: (id: string) => void }) {
  const statusLabel = CLAIM_STATUS_LABEL[row.status as ClaimStatus] ?? row.status;
  return (
    <button
      type="button"
      className="wq-row"
      onClick={() => onOpen(row.claim_id)}
      aria-label={`Adjust claim for ${row.venue_name ?? "unknown venue"}, ${statusLabel}`}
    >
      {/* Venue + claim number */}
      <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: 2 }}>
        <span
          className="font-display"
          style={{
            fontWeight: 600,
            fontSize: "var(--text-sm)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.venue_name ?? "—"}
        </span>
        {row.carrier_claim_number && (
          <span
            className="text-xs text-muted"
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs, 11px)" }}
          >
            {row.carrier_claim_number}
          </span>
        )}
      </span>

      {/* Coverage line */}
      <span
        className="text-xs text-muted hide-on-phone"
        style={{ flexShrink: 0, fontFamily: "var(--font-mono)" }}
      >
        {row.coverage_line || "—"}
      </span>

      {/* Status chip */}
      <StatusChip status={row.status} />

      {/* Coverage decision chip */}
      <CoverageChip decision={row.coverage_decision} />

      {/* Reserve */}
      <span
        className="font-mono"
        style={{ flexShrink: 0, fontSize: "var(--text-sm)", minWidth: 92, textAlign: "right" }}
        title="Current reserve"
      >
        {formatLedgerMoney(row.current_reserve)}
      </span>

      {/* Total paid */}
      <span
        className="font-mono text-muted"
        style={{ flexShrink: 0, fontSize: "var(--text-sm)", minWidth: 80, textAlign: "right" }}
        title="Total paid"
      >
        {formatLedgerMoney(row.total_paid)}
      </span>
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function AdjustingQueuePage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const isCarrier = useIsCarrier();
  const [rows, setRows] = useState<AdjusterQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  // Carrier-only desk. Brokers/operators bounce to their own home.
  useEffect(() => {
    if (isLoaded && isSignedIn && !isCarrier) router.replace("/dashboard");
  }, [isLoaded, isSignedIn, isCarrier, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isCarrier) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await fetchAdjusterQueue();
        if (!cancelled) setRows(data);
      } catch {
        if (!cancelled) setError("Couldn't load the claims queue.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, isCarrier, reloadKey]);

  const open = (cid: string) => router.push(`/adjusting/${cid}`);

  // KPI strip — derived from loaded rows.
  const awaitingAdjudication = rows.length;
  const coveragePending = rows.filter((r) => r.coverage_decision === null).length;
  const openReservesRaw = rows.reduce((sum, r) => sum + (Number(r.current_reserve) || 0), 0);
  const openReservesLabel = `$${openReservesRaw.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

  if (!isLoaded || loading || !isCarrier) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
        <div className="lc-card" style={{ marginTop: "clamp(40px, 12vh, 120px)" }}>
          <div className="lc-card__inner" style={{ textAlign: "center", padding: "var(--space-xl)" }}>
            <p className="text-sm" style={{ color: "var(--state-error)", margin: 0 }}>{error}</p>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: "var(--space-md)", minHeight: 44 }}
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            CARRIER
            <span className="lc-eyebrow__sep" />
            CLAIMS
          </span>
          <h1 className="lc-display">
            Claims <em>Desk</em>
          </h1>
          <p className="lc-sub">
            Losses awaiting your adjudication.
          </p>
        </div>
        <div className="lc-hero__meta">
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Awaiting adjudication</span>
            <strong
              className="font-mono"
              style={{ color: awaitingAdjudication > 0 ? "var(--state-warning)" : undefined }}
            >
              {String(awaitingAdjudication).padStart(2, "0")}
            </strong>
          </div>
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Coverage pending</span>
            <strong
              className="font-mono"
              style={{ color: coveragePending > 0 ? "var(--state-warning)" : undefined }}
            >
              {String(coveragePending).padStart(2, "0")}
            </strong>
          </div>
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Open reserves</span>
            <strong className="font-mono">{openReservesLabel}</strong>
          </div>
        </div>
      </section>

      {rows.length === 0 ? (
        <div className="lc-card">
          <div className="lc-card__inner" style={{ textAlign: "center", padding: "var(--space-xl)" }}>
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              Desk clear — no claims awaiting adjudication.
            </p>
          </div>
        </div>
      ) : (
        <div className="lc-card mb-xl">
          <div className="lc-card__inner">
            <div
              className="flex items-center justify-between mb-md"
              style={{ flexWrap: "wrap", gap: "var(--space-sm)" }}
            >
              <div className="flex items-center" style={{ gap: "var(--space-sm)" }}>
                <h2 className="text-sm font-semibold" style={{ margin: 0 }}>
                  Open claims
                </h2>
                <span className="text-xs text-muted">venue · line · status · coverage · reserve · paid</span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
              {rows.map((r) => (
                <Row key={r.claim_id} row={r} onOpen={open} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
