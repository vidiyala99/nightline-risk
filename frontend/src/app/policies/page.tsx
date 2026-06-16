"use client";

/**
 * /policies — active policy list.
 *
 * Table view (not kanban — policies don't move through columns the way
 * submissions do; they sit in 'active' until cancellation or expiration).
 * Columns: venue, carrier, policy number, premium, effective range, status.
 *
 * Default filter is 'active'. Toggle for "Show all" includes
 * cancelled/expired/non_renewed history.
 *
 * "Paper & Ink" — migrated to the ds/ primitives. PageHeader/StatusPill are
 * replaced inline (the shared legacy components still serve un-migrated pages);
 * every text element carries an explicit colour (the migration rule).
 */
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { PlacementApiError, formatCurrency } from "@/lib/placement";
import {
  Policy,
  POLICY_STATUS_LABEL,
  POLICY_STATUS_TONE,
  policiesApi,
} from "@/lib/policies";
import { Badge } from "@/components/ds/badge";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;
const SCRIPT = { fontFamily: "var(--font-caveat)" } as const;

// StatusPill tone → ds Badge variant.
const TONE_VARIANT = {
  neutral: "muted",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "destructive",
} as const;

export default function PoliciesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [showAll, setShowAll] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await policiesApi.listPolicies(
        showAll ? { status: "all" } : {},
      );
      setPolicies(rows);
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [showAll]);

  return (
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <section className="flex flex-wrap items-end justify-between gap-4 py-10">
        <div>
          <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-[#5A6E00]">
            <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
            Placement
          </span>
          <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
            Policies{" "}
            <span className="text-[#5A6E00]" style={SCRIPT}>on the books</span>
          </h1>
          <p className="mt-2 text-[15px] text-muted-foreground">
            Bound coverage. Endorse, certify, renew, or cancel.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showAll}
            onChange={e => setShowAll(e.target.checked)}
            className="size-4 accent-primary"
          />
          Show all (incl. cancelled / expired)
        </label>
      </section>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      ) : policies.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border py-20 text-center">
          <p className="text-sm font-medium text-foreground">No policies yet.</p>
          <p className="text-xs text-muted-foreground">Bind a quote from a submission to create one.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[680px] text-sm" data-testid="policies-table">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 text-left font-medium">Venue</th>
                <th className="px-4 py-3 text-left font-medium">Carrier</th>
                <th className="px-4 py-3 text-left font-medium">Policy #</th>
                <th className="px-4 py-3 text-left font-medium">Annual Premium</th>
                <th className="px-4 py-3 text-left font-medium">Effective</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {policies.map(p => (
                <tr key={p.id} className="border-b border-border last:border-0 transition-colors hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link href={`/policies/${p.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                      {p.venue_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-foreground">{p.carrier_id}</td>
                  <td className="px-4 py-3 font-mono text-foreground">
                    {p.policy_number ?? <span className="text-muted-foreground">pending</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-foreground">{formatCurrency(p.annual_premium)}</td>
                  <td className="px-4 py-3 font-mono text-muted-foreground">
                    {p.effective_date} → {p.expiration_date}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={TONE_VARIANT[POLICY_STATUS_TONE[p.status]]}>
                      {POLICY_STATUS_LABEL[p.status]}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
