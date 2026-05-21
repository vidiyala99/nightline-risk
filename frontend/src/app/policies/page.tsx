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
 */
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { PlacementApiError, formatCurrency } from "@/lib/placement";
import {
  Policy,
  POLICY_STATUS_LABEL,
  POLICY_STATUS_TONE,
  policiesApi,
} from "@/lib/policies";


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
    <div className="placement-page">
      <PageHeader
        eyebrow="Placement"
        title="Policies"
        subtitle="Bound coverage. Endorse, certify, renew, or cancel."
        actions={
          <label className="placement-page__toggle">
            <input
              type="checkbox"
              checked={showAll}
              onChange={e => setShowAll(e.target.checked)}
            />
            Show all (incl. cancelled / expired)
          </label>
        }
      />

      {error && <div className="placement-page__error">{error}</div>}

      {loading ? (
        <div className="placement-page__loading">Loading…</div>
      ) : policies.length === 0 ? (
        <div className="policies-empty">
          <p>No policies yet.</p>
          <p style={{ color: "var(--text-tertiary)", fontSize: 11, marginTop: 4 }}>
            Bind a quote from a submission to create one.
          </p>
        </div>
      ) : (
        <div className="policies-table-wrap">
          <table className="policies-table" data-testid="policies-table">
            <thead>
              <tr>
                <th>Venue</th>
                <th>Carrier</th>
                <th>Policy #</th>
                <th>Annual Premium</th>
                <th>Effective</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {policies.map(p => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/policies/${p.id}`} className="policies-table__link">
                      {p.venue_id}
                    </Link>
                  </td>
                  <td className="policies-table__mono">{p.carrier_id}</td>
                  <td className="policies-table__mono">
                    {p.policy_number ?? <span style={{ color: "var(--text-tertiary)" }}>pending</span>}
                  </td>
                  <td className="policies-table__mono">
                    {formatCurrency(p.annual_premium)}
                  </td>
                  <td className="policies-table__mono">
                    {p.effective_date} → {p.expiration_date}
                  </td>
                  <td>
                    <StatusPill tone={POLICY_STATUS_TONE[p.status]}>
                      {POLICY_STATUS_LABEL[p.status]}
                    </StatusPill>
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
