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

import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { PromptDialog } from "@/components/ui/PromptDialog";
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
      <div className="page page-empty">
        <h3>Policy Requests is a broker surface.</h3>
        <p className="text-secondary">
          Raise renewal, cancellation, or certificate requests from your{" "}
          <button className="link-button" onClick={() => router.push("/coverage")}>
            Coverage
          </button>{" "}
          page instead.
        </p>
      </div>
    );
  }

  return (
    <div className="claims-portfolio">
      <PageHeader
        eyebrow="BROKER · REQUESTS"
        title="Policy requests"
        subtitle="What your venues have asked you to action — renewals, cancellations, certificates, coverage changes."
      />

      {error && (
        <div className="policies-empty" role="alert" style={{ borderColor: "var(--state-error)", color: "var(--state-error)" }}>
          {error}
        </div>
      )}

      <div className="filter-bar">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`filter-chip${filter === f ? " filter-chip--active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f[0].toUpperCase() + f.slice(1)}
            <span className="filter-chip__count">{counts[f] ?? 0}</span>
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="claims-section__skeleton" aria-busy="true"><div /><div /><div /></div>
      ) : visible.length === 0 ? (
        <div className="policies-empty">
          {filter === "pending" ? "No pending requests. You're all caught up." : "Nothing here for this filter."}
        </div>
      ) : (
        <div className="policies-table-wrap">
          <table className="policies-table" aria-label="Policy requests">
            <thead>
              <tr>
                <th scope="col">Venue</th>
                <th scope="col">Type</th>
                <th scope="col">Detail</th>
                <th scope="col">Status</th>
                <th scope="col">Sent</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const detail = payloadSummary(r);
                return (
                  <tr key={r.id}>
                    <td>{r.venue_id}</td>
                    <td>{REQUEST_TYPE_LABEL[r.request_type]}</td>
                    <td className="coverage-requests__note">
                      {r.note || detail || "—"}
                      {r.note && detail && <span className="preq-detail-sub"> · {detail}</span>}
                      <button
                        className="link-button preq-policy-link"
                        onClick={() => router.push(`/policies/${r.policy_id}`)}
                      >
                        View policy
                      </button>
                    </td>
                    <td><StatusPill tone={REQUEST_STATUS_TONE[r.status]}>{REQUEST_STATUS_LABEL[r.status]}</StatusPill></td>
                    <td className="policies-table__mono">{r.created_at.slice(0, 10)}</td>
                    <td style={{ textAlign: "right" }}>
                      {r.status === "pending" ? (
                        <div className="preq-actions">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm preq-actions__decline"
                            disabled={busyId === r.id}
                            onClick={() => decide(r, "declined")}
                          >
                            Decline
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={busyId === r.id}
                            onClick={() => decide(r, "approved")}
                          >
                            {busyId === r.id ? "…" : "Approve"}
                          </button>
                        </div>
                      ) : (
                        <div className="preq-decided">
                          {r.decided_by && (
                            <span className="preq-decided-by">by {r.decided_by}</span>
                          )}
                          {(() => {
                            const link = approvalResultLink(r);
                            return link ? (
                              <button
                                type="button"
                                className="link-button preq-result-link"
                                onClick={() => router.push(link.href)}
                              >
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
