"use client";

/**
 * /policies/[pid] — policy detail.
 *
 * Three sections:
 *   1. Summary strip — premium, effective range, status, snapshot_hash
 *      (truncated for display; the full hash anchors any future defense
 *      package against this policy).
 *   2. Endorsement history table — every mid-term change with its
 *      premium impact.
 *   3. Certificate of Insurance table — active by default; superseded
 *      hidden behind a toggle.
 *
 * Actions live inline:
 *   - PATCH policy-number when status='bound_pending_number'
 *   - "+ Endorse" → /policies/[pid]/endorse
 *   - "+ Issue COI" → /policies/[pid]/certificates/new
 *   - "Cancel" → opens a prompt for method + reason
 */
import React, { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { PlacementApiError, formatCurrency, formatPct } from "@/lib/placement";
import {
  CertificateOfInsurance,
  ENDORSEMENT_TYPE_LABEL,
  Endorsement,
  POLICY_STATUS_LABEL,
  POLICY_STATUS_TONE,
  PolicyDetail,
  policiesApi,
} from "@/lib/policies";


export default function PolicyDetailPage() {
  const params = useParams<{ pid: string }>();
  const router = useRouter();
  const pid = params?.pid;

  const [loading, setLoading] = useState(true);
  const [policy, setPolicy] = useState<PolicyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSupersededCois, setShowSupersededCois] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    try {
      const p = await policiesApi.getPolicy(pid);
      setPolicy(p);
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Failed to load policy");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [pid]);

  const visibleCois = useMemo(() => {
    if (!policy) return [];
    if (showSupersededCois) return policy.certificates;
    return policy.certificates.filter(c => c.status === "active");
  }, [policy, showSupersededCois]);

  const handleAssignNumber = async () => {
    if (!policy) return;
    const number = window.prompt("Carrier-issued policy number:");
    if (!number || !number.trim()) return;
    setBusy(true);
    try {
      await policiesApi.assignPolicyNumber(policy.id, number.trim());
      await load();
    } catch (e) {
      alert(e instanceof PlacementApiError ? e.message : "Assign failed");
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!policy) return;
    const method = window.prompt(
      "Cancellation method? Type 'pro_rata' for friendly refund or 'short_rate' for carrier penalty (10%):",
      "pro_rata",
    );
    if (!method || !["pro_rata", "short_rate"].includes(method.trim())) return;
    const reason = window.prompt("Cancellation reason:");
    if (!reason || !reason.trim()) return;
    const date = window.prompt("Cancellation date (YYYY-MM-DD):");
    if (!date) return;
    setBusy(true);
    try {
      await policiesApi.cancelPolicy(policy.id, {
        method: method.trim() as "pro_rata" | "short_rate",
        reason: reason.trim(),
        cancellation_date: date,
      });
      await load();
    } catch (e) {
      alert(e instanceof PlacementApiError ? e.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="placement-page__loading">Loading…</div>;
  }
  if (!policy) {
    return (
      <div className="submission-detail">
        <div className="placement-page__error">{error ?? "Policy not found"}</div>
      </div>
    );
  }

  const isActive = policy.status === "active" || policy.status === "bound_pending_number";

  return (
    <div className="submission-detail">
      <PageHeader
        eyebrow={`Policy · ${policy.id}`}
        title={policy.venue_id}
        subtitle={
          policy.policy_number
            ? `${policy.carrier_id} · ${policy.policy_number}`
            : `${policy.carrier_id} · policy # pending`
        }
        actions={
          <>
            <StatusPill tone={POLICY_STATUS_TONE[policy.status]}>
              {POLICY_STATUS_LABEL[policy.status]}
            </StatusPill>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => router.push("/policies")}
            >
              ← Back
            </button>
          </>
        }
      />

      {error && <div className="placement-page__error">{error}</div>}

      {/* Summary strip */}
      <div className="submission-detail__summary">
        <div>
          <div className="submission-detail__summary-label">Annual Premium</div>
          <div className="submission-detail__summary-value">
            {formatCurrency(policy.annual_premium)}
          </div>
        </div>
        <div>
          <div className="submission-detail__summary-label">Commission</div>
          <div className="submission-detail__summary-value">
            {formatCurrency(policy.commission_amount)}{" "}
            <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>
              @ {formatPct(policy.commission_rate)}
            </span>
          </div>
        </div>
        <div>
          <div className="submission-detail__summary-label">Effective</div>
          <div className="submission-detail__summary-value" style={{ fontSize: 12 }}>
            {policy.effective_date} → {policy.expiration_date}
          </div>
        </div>
        <div>
          <div className="submission-detail__summary-label">Coverage Lines</div>
          <div className="submission-detail__summary-value" style={{ fontSize: 12 }}>
            {policy.coverage_lines.join(", ")}
          </div>
        </div>
      </div>

      {/* Snapshot hash — tamper-evident anchor */}
      <div className="policy-hash">
        <span className="submission-detail__summary-label">Snapshot Hash</span>
        <code className="policy-hash__value" title={policy.snapshot_hash}>
          {policy.snapshot_hash.slice(0, 16)}…{policy.snapshot_hash.slice(-8)}
        </code>
        <span className="policy-hash__note">
          Anchors defense packages to this policy version. Re-computed on
          endorse + policy-number assignment; unchanged on status transitions.
        </span>
      </div>

      {/* Cancellation block (only when cancelled) */}
      {policy.status === "cancelled" && policy.refund_amount && (
        <div className="policy-cancel-block">
          <div className="submission-detail__summary-label">Cancellation</div>
          <div>
            {policy.cancellation_method} refund of{" "}
            <strong>{formatCurrency(policy.refund_amount)}</strong>
            {policy.cancelled_at && (
              <span style={{ color: "var(--text-tertiary)" }}>
                {" "}· {policy.cancelled_at.slice(0, 10)}
              </span>
            )}
          </div>
          {policy.cancellation_reason && (
            <div style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 4 }}>
              {policy.cancellation_reason}
            </div>
          )}
        </div>
      )}

      {/* Action toolbar */}
      {isActive && (
        <div className="policy-actions">
          {policy.status === "bound_pending_number" && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleAssignNumber}
              disabled={busy}
            >
              + Assign policy number
            </button>
          )}
          <Link
            href={`/policies/${policy.id}/endorse`}
            className="btn btn-secondary btn-sm"
          >
            + Endorse
          </Link>
          <Link
            href={`/policies/${policy.id}/certificates/new`}
            className="btn btn-secondary btn-sm"
          >
            + Issue COI
          </Link>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={handleCancel}
            disabled={busy}
            style={{ marginLeft: "auto" }}
          >
            Cancel Policy
          </button>
        </div>
      )}

      {/* Endorsements */}
      <div className="submission-detail__section-title">
        Endorsements ({policy.endorsements.length})
      </div>
      {policy.endorsements.length === 0 ? (
        <div className="policies-empty">No endorsements issued.</div>
      ) : (
        <div className="policies-table-wrap">
          <table className="policies-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Effective</th>
                <th>Description</th>
                <th>Premium Δ</th>
              </tr>
            </thead>
            <tbody>
              {policy.endorsements.map(e => (
                <tr key={e.id}>
                  <td>
                    {ENDORSEMENT_TYPE_LABEL[e.endorsement_type] ?? e.endorsement_type}
                  </td>
                  <td className="policies-table__mono">{e.effective_date}</td>
                  <td>{e.description}</td>
                  <td className="policies-table__mono">
                    {formatCurrency(e.premium_change)}
                    {parseFloat(e.tax_change) !== 0 && (
                      <span style={{ color: "var(--text-tertiary)", fontSize: 10 }}>
                        {" "}(tax {formatCurrency(e.tax_change)})
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Certificates of Insurance */}
      <div className="submission-detail__section-title" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span>Certificates of Insurance ({visibleCois.length})</span>
        {policy.certificates.some(c => c.status === "superseded") && (
          <label className="placement-page__toggle">
            <input
              type="checkbox"
              checked={showSupersededCois}
              onChange={e => setShowSupersededCois(e.target.checked)}
            />
            Show superseded
          </label>
        )}
      </div>
      {visibleCois.length === 0 ? (
        <div className="policies-empty">No certificates issued.</div>
      ) : (
        <div className="policies-table-wrap">
          <table className="policies-table">
            <thead>
              <tr>
                <th>Holder</th>
                <th>Description</th>
                <th>Additional Insured</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleCois.map(c => (
                <tr key={c.id}>
                  <td>
                    <div>{c.certificate_holder}</div>
                    <div style={{ color: "var(--text-tertiary)", fontSize: 10 }}>
                      {c.certificate_holder_address}
                    </div>
                  </td>
                  <td>{c.description_of_operations}</td>
                  <td>
                    {c.additional_insured ? (
                      <span>
                        ✓ {c.additional_insured_scope?.replace(/_/g, " ")}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-tertiary)" }}>—</span>
                    )}
                  </td>
                  <td className="policies-table__mono">{c.expires_on}</td>
                  <td>
                    <StatusPill tone={
                      c.status === "active" ? "success" :
                      c.status === "superseded" ? "neutral" : "danger"
                    }>
                      {c.status}
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
