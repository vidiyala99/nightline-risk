"use client";

/**
 * /coverage — venue operator's read-only "My Coverage" surface.
 *
 * Operators can't transact policy lifecycle (bind/cancel/renew/COI are
 * broker-gated), and until now had no way to even see their policy. This
 * page shows their venue's coverage and lets them *ask* — raising a
 * PolicyRequest that lands in the broker's queue (the propose→decide
 * pattern, same shape as claim proposals).
 *
 * Broker/admin land here too but are pointed at the queue instead.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { useAuth } from "@/contexts/AuthContext";
import { PolicyRequestModal } from "@/components/PolicyRequestModal";
import {
  CoveragePolicy,
  PolicyRequest,
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TONE,
  REQUEST_TYPE_LABEL,
  policyRequestsApi,
} from "@/lib/policyRequests";

function fmtMoney(s: string): string {
  const n = parseFloat(s);
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(n);
}

const POLICY_STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  active: "success",
  bound_pending_number: "info",
  cancelled: "danger",
  non_renewed: "warning",
  lapsed: "warning",
  expired: "neutral",
};

export default function CoveragePage() {
  const router = useRouter();
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const venueIds = useMemo(() => {
    if (!user) return [] as string[];
    const ids = new Set<string>();
    if (user.tenant_id) ids.add(user.tenant_id);
    (user.extra_venue_ids || []).forEach((v) => ids.add(v));
    return [...ids];
  }, [user]);

  const [policies, setPolicies] = useState<CoveragePolicy[] | null>(null);
  const [requests, setRequests] = useState<PolicyRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modalPolicy, setModalPolicy] = useState<CoveragePolicy | null>(null);

  const load = useCallback(async () => {
    if (venueIds.length === 0) {
      setPolicies([]);
      return;
    }
    setError(null);
    try {
      const [policyLists, requestLists] = await Promise.all([
        Promise.all(venueIds.map((v) => policyRequestsApi.coverageForVenue(v))),
        Promise.all(venueIds.map((v) => policyRequestsApi.list({ venue_id: v }))),
      ]);
      setPolicies(policyLists.flat());
      setRequests(requestLists.flat());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load coverage");
    }
  }, [venueIds]);

  useEffect(() => {
    if (!isLoaded || isBroker) return;
    load();
  }, [isLoaded, isBroker, load]);

  async function onCancelRequest(id: string) {
    if (!window.confirm("Withdraw this request?")) return;
    try {
      await policyRequestsApi.cancel(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not withdraw the request");
    }
  }

  if (!isLoaded) return null;

  if (isBroker) {
    return (
      <div className="page page-empty">
        <h3>Coverage is the operator&rsquo;s view.</h3>
        <p className="text-secondary">
          Operators see and manage their own policy here. Head to{" "}
          <button className="link-button" onClick={() => router.push("/policy-requests")}>
            Policy Requests
          </button>{" "}
          to action what they&rsquo;ve asked for.
        </p>
      </div>
    );
  }

  return (
    <div className="claims-portfolio">
      <PageHeader
        eyebrow="VENUE · COVERAGE"
        title="My coverage"
        subtitle="Your active policy and anything you've asked your broker to action."
      />

      {error && (
        <div className="policies-empty" role="alert" style={{ borderColor: "var(--state-error)", color: "var(--state-error)" }}>
          {error}
        </div>
      )}

      {policies === null ? (
        <div className="claims-section__skeleton" aria-busy="true"><div /><div /></div>
      ) : policies.length === 0 ? (
        <div className="policies-empty">
          No coverage on file yet. Once your broker binds a policy for your
          venue, it&rsquo;ll show up here.
        </div>
      ) : (
        <div className="coverage-grid">
          {policies.map((p) => (
            <article key={p.id} className="coverage-card">
              <div className="coverage-card__top">
                <div>
                  <div className="coverage-card__eyebrow">{p.carrier_id}</div>
                  <div className="coverage-card__number">{p.policy_number ?? p.id}</div>
                </div>
                <StatusPill tone={POLICY_STATUS_TONE[p.status] ?? "neutral"}>
                  {p.status.replace(/_/g, " ")}
                </StatusPill>
              </div>
              <dl className="coverage-card__facts">
                <div><dt>Annual premium</dt><dd className="coverage-card__mono">{fmtMoney(p.annual_premium)}</dd></div>
                <div><dt>Effective</dt><dd className="coverage-card__mono">{p.effective_date}</dd></div>
                <div><dt>Expires</dt><dd className="coverage-card__mono">{p.expiration_date}</dd></div>
                <div><dt>Lines</dt><dd>{p.coverage_lines.map((l) => l.toUpperCase()).join(", ") || "—"}</dd></div>
              </dl>
              <button
                type="button"
                className="btn btn-primary btn-sm coverage-card__cta"
                onClick={() => setModalPolicy(p)}
              >
                Request an action
              </button>
            </article>
          ))}
        </div>
      )}

      {/* Request history */}
      {requests.length > 0 && (
        <section className="coverage-requests">
          <h2 className="coverage-requests__title">Your requests</h2>
          <div className="policies-table-wrap">
            <table className="policies-table" aria-label="Your policy requests">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Note</th>
                  <th scope="col">Sent</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td>{REQUEST_TYPE_LABEL[r.request_type]}</td>
                    <td><StatusPill tone={REQUEST_STATUS_TONE[r.status]}>{REQUEST_STATUS_LABEL[r.status]}</StatusPill></td>
                    <td className="coverage-requests__note">{r.decision_note || r.note || "—"}</td>
                    <td className="policies-table__mono">{r.created_at.slice(0, 10)}</td>
                    <td style={{ textAlign: "right" }}>
                      {r.status === "pending" && (
                        <button type="button" className="link-button link-button--danger" onClick={() => onCancelRequest(r.id)}>
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {modalPolicy && (
        <PolicyRequestModal
          policy={modalPolicy}
          open={modalPolicy !== null}
          onClose={() => setModalPolicy(null)}
          onSubmitted={load}
        />
      )}
    </div>
  );
}
