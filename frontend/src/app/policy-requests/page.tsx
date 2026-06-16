"use client";

/**
 * /policy-requests — broker queue of operator-raised requests.
 *
 * The decide half of the propose→decide loop: operators raise renewal /
 * cancellation / COI / coverage-change requests from /coverage; brokers
 * approve or decline them here. Mirrors the claim-proposals broker surface.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { PromptDialog } from "@/components/ui/PromptDialog";
import { Button } from "@/components/ds/button";
import { Badge } from "@/components/ds/badge";
import { useAuth } from "@/contexts/AuthContext";
import {
  PolicyRequest,
  PolicyRequestStatus,
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TONE,
  REQUEST_TYPE_LABEL,
  approvalResultLink,
  policyRequestsApi,
} from "@/lib/policyRequests";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;
const TONE_VARIANT = {
  neutral: "muted", info: "info", success: "success", warning: "warning", danger: "destructive",
} as const;

type Filter = "pending" | "approved" | "declined" | "all";
const FILTERS: Filter[] = ["pending", "approved", "declined", "all"];

function payloadSummary(r: PolicyRequest): string | null {
  const p = r.payload || {};
  if (r.request_type === "cancellation" && p.cancellation_date) return `Wants out by ${p.cancellation_date}`;
  if (r.request_type === "coi" && p.certificate_holder) return `Holder: ${p.certificate_holder}`;
  return null;
}

export default function PolicyRequestsPage() {
  const router = useRouter();
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const [rows, setRows] = useState<PolicyRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [declineTarget, setDeclineTarget] = useState<PolicyRequest | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await policyRequestsApi.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load requests");
    }
  }, []);

  useEffect(() => {
    if (!isLoaded || !isBroker) return;
    load();
  }, [isLoaded, isBroker, load]);

  const visible = useMemo(() => {
    if (!rows) return [];
    if (filter === "all") return rows;
    return rows.filter((r) => r.status === (filter as PolicyRequestStatus));
  }, [rows, filter]);

  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, declined: 0, all: rows?.length ?? 0 };
    rows?.forEach((r) => {
      if (r.status in c) (c as Record<string, number>)[r.status] += 1;
    });
    return c as Record<Filter, number>;
  }, [rows]);

  async function runDecision(r: PolicyRequest, decision: "approved" | "declined", note?: string) {
    setBusyId(r.id);
    setError(null);
    try {
      await policyRequestsApi.decide(r.id, decision, note);
      setDeclineTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the decision");
    } finally {
      setBusyId(null);
    }
  }

  // Approve is a direct action; declining captures an OPTIONAL reason via an
  // in-app PromptDialog (was a native window.prompt). Blank reason → undefined.
  const decide = (r: PolicyRequest, decision: "approved" | "declined") => {
    if (decision === "declined") { setDeclineTarget(r); return; }
    runDecision(r, "approved");
  };

  const runDecline = (values: Record<string, string>) => {
    if (!declineTarget) return;
    runDecision(declineTarget, "declined", values.reason.trim() || undefined);
  };

  if (!isLoaded) return null;

  if (!isBroker) {
    return (
      <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
        <div className="mt-10 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-20 text-center">
          <h3 className="text-lg font-semibold text-foreground">Policy Requests is a broker surface.</h3>
          <p className="text-sm text-muted-foreground">
            Raise renewal, cancellation, or certificate requests from your{" "}
            <button className="text-[#5A6E00] hover:underline" onClick={() => router.push("/coverage")}>Coverage</button>{" "}
            page instead.
          </p>
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
          Broker · Requests
        </span>
        <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
          Policy requests
        </h1>
        <p className="mt-2 max-w-[68ch] text-[15px] text-muted-foreground">
          What your venues have asked you to action — renewals, cancellations, certificates, coverage changes.
        </p>
      </section>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              filter === f ? "border-foreground/30 bg-muted text-foreground" : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {f[0].toUpperCase() + f.slice(1)}
            <span className="text-muted-foreground">{counts[f] ?? 0}</span>
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl border border-border bg-muted/40" />)}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          {filter === "pending" ? "No pending requests. You're all caught up." : "Nothing here for this filter."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px] text-sm" aria-label="Policy requests">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-3 text-left font-medium">Venue</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Type</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Detail</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Status</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Sent</th>
                <th scope="col" className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const detail = payloadSummary(r);
                return (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-foreground">{r.venue_id}</td>
                    <td className="px-4 py-3 text-foreground">{REQUEST_TYPE_LABEL[r.request_type]}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.note || detail || "—"}
                      {r.note && detail && <span className="text-muted-foreground/70"> · {detail}</span>}
                      <button
                        className="ml-2 text-xs text-[#5A6E00] hover:underline"
                        onClick={() => router.push(`/policies/${r.policy_id}`)}
                      >
                        View policy
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={TONE_VARIANT[REQUEST_STATUS_TONE[r.status]]}>{REQUEST_STATUS_LABEL[r.status]}</Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">{r.created_at.slice(0, 10)}</td>
                    <td className="px-4 py-3 text-right">
                      {r.status === "pending" ? (
                        <div className="flex justify-end gap-2">
                          <Button type="button" variant="outline" size="sm" className="text-foreground" disabled={busyId === r.id} onClick={() => decide(r, "declined")}>
                            Decline
                          </Button>
                          <Button type="button" size="sm" className="border border-foreground/15" disabled={busyId === r.id} onClick={() => decide(r, "approved")}>
                            {busyId === r.id ? "…" : "Approve"}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                          {r.decided_by && <span>by {r.decided_by}</span>}
                          {(() => {
                            const link = approvalResultLink(r);
                            return link ? (
                              <button type="button" className="text-[#5A6E00] hover:underline" onClick={() => router.push(link.href)}>
                                {link.label}
                              </button>
                            ) : null;
                          })()}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {declineTarget && (
        <PromptDialog
          open
          title="Decline request"
          subtitle="Shown to the operator on their request."
          submitLabel="Decline request"
          busy={busyId === declineTarget.id}
          fields={[{
            name: "reason",
            label: "Reason for declining",
            type: "textarea",
            help: "Optional — shown to the operator.",
          }]}
          onSubmit={runDecline}
          onClose={() => setDeclineTarget(null)}
        />
      )}
    </div>
  );
}
