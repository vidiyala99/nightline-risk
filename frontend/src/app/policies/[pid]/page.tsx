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
import toast from "react-hot-toast";
import { PlacementApiError, formatCurrency, formatPct, placementApi } from "@/lib/placement";
import {
  CertificateOfInsurance,
  ENDORSEMENT_TYPE_LABEL,
  Endorsement,
  POLICY_STATUS_LABEL,
  POLICY_STATUS_TONE,
  PolicyDetail,
  policiesApi,
  downloadCoiPdf,
} from "@/lib/policies";
import { renewalsApi } from "@/lib/renewals";
import { ClaimStatusPill } from "@/components/claims/ClaimStatusPill";
import { claimsApi, totalPaidFromClaim, type Claim } from "@/lib/claims";
import { toastError, toastSuccess } from "@/lib/toast";
import { formatLedgerMoney } from "@/lib/claim-tokens";
import { PromptDialog, type PromptField } from "@/components/ui/PromptDialog";

type PromptKind = "assign" | "cancel" | "nonrenew" | "lapse";

const PROMPT_CONFIG: Record<PromptKind, { title: string; subtitle?: string; submitLabel: string; fields: PromptField[] }> = {
  assign: {
    title: "Assign policy number",
    submitLabel: "Assign",
    fields: [{ name: "number", label: "Carrier-issued policy number", type: "text", required: true, placeholder: "BW-2026-00123" }],
  },
  cancel: {
    title: "Cancel policy",
    subtitle: "Mid-term cancellation — captures the refund basis for the audit trail.",
    submitLabel: "Cancel policy",
    fields: [
      { name: "method", label: "Cancellation method", type: "select", required: true,
        options: [
          { value: "pro_rata", label: "Pro-rata (friendly — full unearned refund)" },
          { value: "short_rate", label: "Short-rate (carrier penalty — 10%)" },
        ] },
      { name: "reason", label: "Reason", type: "textarea", required: true },
      { name: "cancellation_date", label: "Cancellation date", type: "date", required: true },
    ],
  },
  nonrenew: {
    title: "Non-renew policy",
    submitLabel: "Non-renew",
    fields: [{ name: "reason", label: "Reason for non-renewal", type: "textarea", required: true }],
  },
  lapse: {
    title: "Lapse policy",
    subtitle: "Premium not paid — a lapsed policy can be reinstated later.",
    submitLabel: "Mark lapsed",
    fields: [{ name: "reason", label: "Reason for lapse", type: "textarea", required: true }],
  },
};


export default function PolicyDetailPage() {
  const params = useParams<{ pid: string }>();
  const router = useRouter();
  const pid = params?.pid;

  const [loading, setLoading] = useState(true);
  const [policy, setPolicy] = useState<PolicyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSupersededCois, setShowSupersededCois] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptKind | null>(null);

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

  // Claims attached to this policy. Fetched independently of the policy
  // detail so a transient claims API failure doesn't break the page.
  const loadClaims = async () => {
    if (!pid) return;
    setClaimsError(null);
    try {
      const rows = await claimsApi.claimsForPolicy(pid);
      setClaims(rows);
    } catch (e) {
      setClaimsError(e instanceof Error ? e.message : "Failed to load claims");
    }
  };
  useEffect(() => { loadClaims(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [pid]);

  const visibleCois = useMemo(() => {
    if (!policy) return [];
    if (showSupersededCois) return policy.certificates;
    return policy.certificates.filter(c => c.status === "active");
  }, [policy, showSupersededCois]);

  // Lifecycle data-entry now runs through a single PromptDialog (was a chain of
  // native window.prompt() dialogs). The button handlers just open it; runPrompt
  // performs the API call for whichever action is pending.
  const handleAssignNumber = () => setPrompt("assign");
  const handleCancel = () => setPrompt("cancel");

  // expire is a benign yes/no (term ended) — a confirm is fine. non-renew / lapse
  // capture a reason, so they open the dialog.
  const handleEndOfLife = async (action: "expire" | "non-renew" | "lapse") => {
    if (!policy) return;
    if (action === "expire") {
      if (!window.confirm("Mark this policy expired at end of term? This is terminal.")) return;
      setBusy(true);
      try {
        await policiesApi.expirePolicy(policy.id);
        await load();
      } catch (e) {
        alert(e instanceof PlacementApiError ? e.message : "expire failed");
      } finally {
        setBusy(false);
      }
      return;
    }
    setPrompt(action === "non-renew" ? "nonrenew" : "lapse");
  };

  async function runPrompt(values: Record<string, string>) {
    if (!policy || !prompt) return;
    setBusy(true);
    try {
      if (prompt === "assign") {
        await policiesApi.assignPolicyNumber(policy.id, values.number.trim());
      } else if (prompt === "cancel") {
        await policiesApi.cancelPolicy(policy.id, {
          method: values.method as "pro_rata" | "short_rate",
          reason: values.reason.trim(),
          cancellation_date: values.cancellation_date,
        });
      } else if (prompt === "nonrenew") {
        await policiesApi.nonRenewPolicy(policy.id, values.reason.trim());
      } else if (prompt === "lapse") {
        await policiesApi.lapsePolicy(policy.id, values.reason.trim());
      }
      setPrompt(null);
      await load();
    } catch (e) {
      alert(e instanceof PlacementApiError ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const handleReinstate = async () => {
    if (!policy) return;
    if (!window.confirm("Reinstate this lapsed policy back to active?")) return;
    setBusy(true);
    try {
      await policiesApi.reinstatePolicy(policy.id);
      await load();
    } catch (e) {
      alert(e instanceof PlacementApiError ? e.message : "Reinstate failed");
    } finally {
      setBusy(false);
    }
  };

  // One-click renewal: create the renewal submission (effective = the prior
  // term's expiration date, so coverage is continuous) and drop the broker on
  // the submission to continue re-placement. A mis-click is recoverable via the
  // Undo toast, which withdraws the just-created submission.
  const handleRenew = async () => {
    if (!policy) return;
    setBusy(true);
    try {
      const res = await renewalsApi.renew(policy.id, policy.expiration_date);
      const sid = res.submission.id;
      const pid_ = policy.id;
      router.push(`/submissions/${sid}`);
      toast(
        (t) => (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
            Renewal started — sent to placement.
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                toast.dismiss(t.id);
                try {
                  await placementApi.withdrawSubmission(sid, "Renewal undone by broker");
                  toastSuccess("Renewal undone.");
                  router.push(`/policies/${pid_}`);
                } catch (e) {
                  toastError(e instanceof PlacementApiError ? e.message : "Couldn't undo the renewal");
                }
              }}
            >
              Undo
            </button>
          </span>
        ),
        { duration: 8000 },
      );
    } catch (e) {
      toastError(e instanceof PlacementApiError ? e.message : "Renewal failed");
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
            {/* The page's one primary action lives here, right-most: the thing a
                broker came to do. State-driven — renew / assign # / reinstate. */}
            {policy.status === "active" && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleRenew}
                disabled={busy}
              >
                Renew
              </button>
            )}
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
            {policy.status === "lapsed" && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleReinstate}
                disabled={busy}
              >
                Reinstate
              </button>
            )}
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
            {policy.coverage_lines.length ? policy.coverage_lines.join(", ") : "—"}
          </div>
        </div>
      </div>

      {/* Snapshot integrity — audit metadata, collapsed by default. A broker
          doesn't need the SHA-256 at eye level; it anchors defense packages,
          so keep it one disclosure away rather than a prominent strip. */}
      <details className="policy-integrity">
        <summary className="policy-integrity__summary">
          Snapshot integrity
        </summary>
        <div className="policy-integrity__body">
          <code className="policy-hash__value" title={policy.snapshot_hash}>
            {policy.snapshot_hash.slice(0, 16)}…{policy.snapshot_hash.slice(-8)}
          </code>
          <span className="policy-hash__note">
            Anchors defense packages to this policy version. Re-computed on
            endorse + policy-number assignment; unchanged on status transitions.
          </span>
        </div>
      </details>

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

      {/* Inline servicing toolbar — the day-to-day actions on an in-force
          policy. The page's primary CTA (renew / assign # / reinstate) lives in
          the header; rare lifecycle/admin actions live in the Manage menu. */}
      {isActive && (
        <div className="policy-actions">
          <div className="policy-actions__group">
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
          </div>
          {/* Lifecycle/admin actions live behind an overflow menu — they're
              rare and mostly outcomes (a broker doesn't proactively "expire" a
              policy), so they shouldn't sit at the same weight as servicing.
              Only 'active' policies can expire/non-renew/lapse per the matrix. */}
          <div className="policy-actions__group policy-actions__group--end">
            <div
              className="policy-menu"
              onKeyDown={(e) => { if (e.key === "Escape") setManageOpen(false); }}
            >
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-haspopup="menu"
                aria-expanded={manageOpen}
                onClick={() => setManageOpen((o) => !o)}
                disabled={busy}
              >
                Manage ▾
              </button>
              {manageOpen && (
                <>
                  <div
                    className="policy-menu__backdrop"
                    onClick={() => setManageOpen(false)}
                  />
                  <div className="policy-menu__list" role="menu">
                    {policy.status === "active" && (
                      <>
                        <button
                          type="button" role="menuitem" className="policy-menu__item"
                          onClick={() => { setManageOpen(false); handleEndOfLife("expire"); }}
                          disabled={busy}
                        >
                          Mark expired
                        </button>
                        <button
                          type="button" role="menuitem" className="policy-menu__item"
                          onClick={() => { setManageOpen(false); handleEndOfLife("non-renew"); }}
                          disabled={busy}
                        >
                          Non-renew
                        </button>
                        <button
                          type="button" role="menuitem" className="policy-menu__item"
                          onClick={() => { setManageOpen(false); handleEndOfLife("lapse"); }}
                          disabled={busy}
                        >
                          Mark lapsed
                        </button>
                        <div className="policy-menu__divider" />
                      </>
                    )}
                    <button
                      type="button" role="menuitem"
                      className="policy-menu__item policy-menu__item--danger"
                      onClick={() => { setManageOpen(false); handleCancel(); }}
                      disabled={busy}
                    >
                      Cancel policy
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
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
                <th />
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
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => downloadCoiPdf(c.id).catch(() => toastError("Could not download the certificate PDF"))}
                    >
                      Download PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Claims (carrier-side) */}
      <div className="submission-detail__section-title" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span>Claims ({claims?.length ?? 0})</span>
        <Link
          href={`/policies/${policy.id}/claims/new`}
          className="btn btn-secondary btn-sm"
          style={{ marginLeft: "auto" }}
        >
          + File FNOL
        </Link>
      </div>
      {claims === null && !claimsError ? (
        <div className="claims-section__skeleton" aria-busy="true">
          <div /><div /><div />
        </div>
      ) : claimsError ? (
        <div className="policies-empty" role="alert" style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span>Couldn&apos;t load claims — {claimsError}</span>
          <button type="button" className="btn btn-sm" onClick={loadClaims}>Retry</button>
        </div>
      ) : claims!.length === 0 ? (
        <div className="policies-empty">
          No claims filed against this policy.
        </div>
      ) : (
        <div className="policies-table-wrap">
          <table className="policies-table" aria-label="Carrier claims on this policy">
            <thead>
              <tr>
                <th scope="col">Claim</th>
                <th scope="col">Coverage line</th>
                <th scope="col">Status</th>
                <th scope="col">Date of loss</th>
                <th scope="col" style={{ textAlign: "right" }}>Reserve</th>
                <th scope="col" style={{ textAlign: "right" }}>Paid (ind + exp)</th>
              </tr>
            </thead>
            <tbody>
              {claims!.map(c => (
                <tr
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => router.push(`/claims/${c.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(`/claims/${c.id}`);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td className="policies-table__mono">{c.carrier_claim_number ?? c.id}</td>
                  <td>{c.coverage_line.toUpperCase()}</td>
                  <td><ClaimStatusPill status={c.status} reopenCount={c.reopen_count} /></td>
                  <td className="policies-table__mono">{new Date(c.date_of_loss).toLocaleDateString()}</td>
                  <td
                    className="policies-table__mono"
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatLedgerMoney(c.current_reserve)}
                  </td>
                  <td
                    className="policies-table__mono"
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatLedgerMoney(totalPaidFromClaim(c))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {prompt && (
        <PromptDialog
          open
          title={PROMPT_CONFIG[prompt].title}
          subtitle={PROMPT_CONFIG[prompt].subtitle}
          submitLabel={PROMPT_CONFIG[prompt].submitLabel}
          fields={PROMPT_CONFIG[prompt].fields}
          busy={busy}
          onSubmit={runPrompt}
          onClose={() => setPrompt(null)}
        />
      )}
    </div>
  );
}
