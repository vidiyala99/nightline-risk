"use client";

/**
 * /ingestion — broker run-history view for the operational-data ingestion
 * spine. Each row is one connector run: what it pulled, what loaded, what the
 * quality gate rejected, and the incremental watermark. Read-only observability
 * over the feeds (POS, ID scanner, staffing, NY State open data) that move
 * venue risk scores.
 */
import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { useAuth } from "@/contexts/AuthContext";
import {
  IngestionRun,
  REJECTION_REASON_LABEL,
  SOURCE_LABEL,
  STATUS_TONE,
  ingestionApi,
} from "@/lib/ingestion";

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
      <div className="page page-empty">
        <h3>Ingestion is a broker surface.</h3>
        <p className="text-secondary">Operational-data feeds are managed by your broker.</p>
      </div>
    );
  }

  return (
    <div className="claims-portfolio">
      <PageHeader
        eyebrow="BROKER · DATA"
        title="Ingestion"
        subtitle="Operational-data connector runs — what each feed pulled, loaded, and rejected. The signals here move venue risk scores."
      />

      {error && (
        <div
          className="policies-empty"
          role="alert"
          style={{ borderColor: "var(--state-error)", color: "var(--state-error)" }}
        >
          {error}
        </div>
      )}

      {runs === null ? (
        <div className="claims-section__skeleton" aria-busy="true">
          <div />
          <div />
          <div />
        </div>
      ) : runs.length === 0 ? (
        <div className="policies-empty">
          No ingestion runs yet. Run <code>python -m scripts.run_ingest all</code> to populate.
        </div>
      ) : (
        <div className="policies-table-wrap">
          <table className="policies-table" data-testid="ingestion-runs-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Extracted</th>
                <th>Loaded</th>
                <th>Skipped</th>
                <th>Rejected</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{SOURCE_LABEL[r.source_system] ?? r.source_system}</td>
                  <td>
                    <StatusPill tone={STATUS_TONE[r.status] ?? "info"}>{r.status}</StatusPill>
                  </td>
                  <td className="policies-table__mono">{r.extracted}</td>
                  <td className="policies-table__mono">{r.loaded}</td>
                  <td className="policies-table__mono">{r.skipped}</td>
                  <td
                    className="policies-table__mono"
                    style={r.rejected > 0 ? { color: "var(--state-error)" } : undefined}
                  >
                    {r.rejected}
                    {r.rejected > 0 && Object.keys(r.rejected_reasons ?? {}).length > 0 && (
                      <span className="ingestion-reasons">
                        {Object.entries(r.rejected_reasons).map(([code, count]) => (
                          <span key={code} className="ingestion-reason">
                            {REJECTION_REASON_LABEL[code] ?? code} ×{count}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="policies-table__mono">{fmtTime(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
