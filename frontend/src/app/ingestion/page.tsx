"use client";

/**
 * /ingestion — broker run-history view for the operational-data ingestion
 * spine. Each row is one connector run: what it pulled, what loaded, what the
 * quality gate rejected, and the incremental watermark. Read-only observability
 * over the feeds (POS, ID scanner, staffing, NY State open data) that move
 * venue risk scores.
 *
 * "Paper & Ink" — migrated to the ds/ primitives. PageHeader/StatusPill are
 * replaced inline (the shared legacy components still serve un-migrated pages);
 * every text element carries an explicit colour (the migration rule).
 */
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ds/badge";
import { useAuth } from "@/contexts/AuthContext";
import {
  IngestionRun,
  REJECTION_REASON_LABEL,
  SOURCE_LABEL,
  STATUS_TONE,
  ingestionApi,
} from "@/lib/ingestion";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;

// StatusPill tone → ds Badge variant.
const TONE_VARIANT = {
  neutral: "muted",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "destructive",
} as const;

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function IngestionPage() {
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const [runs, setRuns] = useState<IngestionRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns(await ingestionApi.listRuns());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load ingestion runs");
    }
  }, []);

  useEffect(() => {
    if (!isLoaded || !isBroker) return;
    load();
  }, [isLoaded, isBroker, load]);

  if (!isLoaded) return null;

  if (!isBroker) {
    return (
      <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-20 text-center">
          <h3 className="text-lg font-semibold text-foreground">Ingestion is a broker surface.</h3>
          <p className="text-sm text-muted-foreground">Operational-data feeds are managed by your broker.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <section className="py-10">
        <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-[#5A6E00]">
          <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
          Broker · Data
        </span>
        <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
          Ingestion
        </h1>
        <p className="mt-2 max-w-[68ch] text-[15px] text-muted-foreground">
          Operational-data connector runs — what each feed pulled, loaded, and rejected. The signals
          here move venue risk scores.
        </p>
      </section>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {runs === null ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl border border-border bg-muted/40" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border py-20 text-center">
          <p className="text-sm text-muted-foreground">
            No ingestion runs yet. Run{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">python -m scripts.run_ingest all</code>{" "}
            to populate.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px] text-sm" data-testid="ingestion-runs-table">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 text-left font-medium">Source</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Extracted</th>
                <th className="px-4 py-3 text-left font-medium">Loaded</th>
                <th className="px-4 py-3 text-left font-medium">Skipped</th>
                <th className="px-4 py-3 text-left font-medium">Rejected</th>
                <th className="px-4 py-3 text-left font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0 transition-colors hover:bg-muted/40">
                  <td className="px-4 py-3 text-foreground">{SOURCE_LABEL[r.source_system] ?? r.source_system}</td>
                  <td className="px-4 py-3">
                    <Badge variant={TONE_VARIANT[STATUS_TONE[r.status] ?? "info"]}>{r.status}</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-foreground">{r.extracted}</td>
                  <td className="px-4 py-3 font-mono text-foreground">{r.loaded}</td>
                  <td className="px-4 py-3 font-mono text-foreground">{r.skipped}</td>
                  <td className={`px-4 py-3 font-mono ${r.rejected > 0 ? "text-destructive" : "text-foreground"}`}>
                    {r.rejected}
                    {r.rejected > 0 && Object.keys(r.rejected_reasons ?? {}).length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {Object.entries(r.rejected_reasons).map(([code, count]) => (
                          <span key={code} className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {REJECTION_REASON_LABEL[code] ?? code} ×{count}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-muted-foreground">{fmtTime(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
