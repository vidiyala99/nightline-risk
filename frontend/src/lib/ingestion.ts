/**
 * Typed client for the ingestion-spine run log (GET /api/ingestion/runs).
 *
 * Broker/admin observability over the operational-data connectors: each row
 * is one connector run with extract/load/skip/reject counts, status, and the
 * incremental watermark. Sibling to lib/tasks.ts.
 */
import { authHeaders } from "@/lib/authFetch";
import { PlacementApiError } from "@/lib/placement";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export type IngestionStatus = "running" | "success" | "error";

export interface IngestionRun {
  id: string;
  source_system: string;
  status: IngestionStatus;
  started_at: string | null;
  finished_at: string | null;
  extracted: number;
  loaded: number;
  skipped: number;
  rejected: number;
  rejected_reasons: Record<string, number>;
  watermark: string | null;
  error: string | null;
}

// Human labels for the quality-gate rejection codes the backend emits.
export const REJECTION_REASON_LABEL: Record<string, string> = {
  out_of_range: "Out of range",
  non_finite: "Non-finite value",
  unknown_metric: "Unknown metric",
  rejected: "Rejected",
};

export const STATUS_TONE: Record<IngestionStatus, "success" | "danger" | "info"> = {
  success: "success",
  error: "danger",
  running: "info",
};

export const SOURCE_LABEL: Record<string, string> = {
  nyc_open_data: "NY State Open Data",
  pos: "Point of Sale",
  id_scanner: "ID Scanner",
  staffing: "Staffing",
};

export const ingestionApi = {
  listRuns: async (limit = 50): Promise<IngestionRun[]> => {
    const res = await fetch(`${API_URL}/api/ingestion/runs?limit=${limit}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      throw new PlacementApiError(res.status, "Failed to load ingestion runs");
    }
    return (await res.json()) as IngestionRun[];
  },
};
