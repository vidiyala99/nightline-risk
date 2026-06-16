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
 *
 * "Paper & Ink" — migrated to the ds/ primitives. PageHeader/StatusPill are
 * replaced inline (shared legacy components still serve un-migrated pages);
 * every text element carries an explicit colour (the migration rule). Shared
 * PromptDialog + ClaimStatusPill are kept as-is.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import toast from "react-hot-toast";
import { PlacementApiError, formatCurrency, formatPct, placementApi } from "@/lib/placement";
import {
  ENDORSEMENT_TYPE_LABEL,
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
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ds/button";
import { Badge } from "@/components/ds/badge";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;

// StatusPill tone → ds Badge variant.
const TONE_VARIANT = {
  neutral: "muted",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "destructive",
} as const;

const thCls = "px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground";
const tdCls = "px-4 py-3 text-foreground";
const monoCls = "px-4 py-3 font-mono text-foreground";

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
  const [confirmAction, setConfirmAction] = useState<"expire" | "reinstate" | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

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

  // expire is a benign yes/no (term ended) → ConfirmDialog. non-renew / lapse
  // capture a reason, so they open the PromptDialog.
  const handleEndOfLife = (action: "expire" | "non-renew" | "lapse") => {
    if (!policy) return;
    if (action === "expire") { setConfirmAction("expire"); return; }
    setPrompt(action === "non-renew" ? "nonrenew" : "lapse");
  };

  // expire / reinstate confirmation (was two window.confirm calls).
  const runConfirm = async () => {
    if (!policy || !confirmAction) return;
    setConfirmBusy(true);
    try {
      if (confirmAction === "expire") await policiesApi.expirePolicy(policy.id);
      else await policiesApi.reinstatePolicy(policy.id);
      setConfirmAction(null);
      await load();
    } catch (e) {
      toastError(e instanceof PlacementApiError ? e.message : "Action failed");
    } finally {
      setConfirmBusy(false);
    }
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
      toastError(e instanceof PlacementApiError ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const handleReinstate = () => {
    if (!policy) return;
    setConfirmAction("reinstate");
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
              className="rounded-md border border-foreground/20 px-2 py-1 text-xs font-medium"
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
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!policy) {
    return (
      <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] py-10">
        <div role="alert" className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error ?? "Policy not found"}
        </div>
      </div>
    );
  }

  const isActive = policy.status === "active" || policy.status === "bound_pending_number";

  return (
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <section className="flex flex-wrap items-start justify-between gap-4 py-10">
        <div>
          <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-[#5A6E00]">
            <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
            Policy · {policy.id}
          </span>
          <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
            {policy.venue_id}
          </h1>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            {policy.policy_number
              ? `${policy.carrier_id} · ${policy.policy_number}`
              : `${policy.carrier_id} · policy # pending`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={TONE_VARIANT[POLICY_STATUS_TONE[policy.status]]}>
            {POLICY_STATUS_LABEL[policy.status]}
          </Badge>
          {/* The page's one primary action — state-driven (renew / assign # / reinstate). */}
          {policy.status === "active" && (
            <Button size="sm" onClick={handleRenew} disabled={busy} className="border border-foreground/15">Renew</Button>
          )}
          {policy.status === "bound_pending_number" && (
            <Button size="sm" onClick={handleAssignNumber} disabled={busy} className="border border-foreground/15">+ Assign policy number</Button>
          )}
          {policy.status === "lapsed" && (
            <Button size="sm" onClick={handleReinstate} disabled={busy} className="border border-foreground/15">Reinstate</Button>
          )}
        </div>
      </section>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* ── summary strip ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Annual Premium</div>
          <div className="mt-1 text-lg font-semibold text-foreground">{formatCurrency(policy.annual_premium)}</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Commission</div>
          <div className="mt-1 text-lg font-semibold text-foreground">
            {formatCurrency(policy.commission_amount)}{" "}
            <span className="text-xs font-normal text-muted-foreground">@ {formatPct(policy.commission_rate)}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Effective</div>
          <div className="mt-1 font-mono text-sm text-foreground">{policy.effective_date} → {policy.expiration_date}</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Coverage Lines</div>
          <div className="mt-1 text-sm text-foreground">{policy.coverage_lines.length ? policy.coverage_lines.join(", ") : "—"}</div>
        </div>
      </div>

      {/* Snapshot integrity — audit metadata, collapsed by default. */}
      <details className="mt-4 rounded-xl border border-border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">
          Snapshot integrity
        </summary>
        <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
          <code className="font-mono text-xs text-foreground" title={policy.snapshot_hash}>
            {policy.snapshot_hash.slice(0, 16)}…{policy.snapshot_hash.slice(-8)}
          </code>
          <span className="text-xs text-muted-foreground">
            Anchors defense packages to this policy version. Re-computed on
            endorse + policy-number assignment; unchanged on status transitions.
          </span>
        </div>
      </details>

      {/* Cancellation block (only when cancelled) */}
      {policy.status === "cancelled" && policy.refund_amount && (
        <div className="mt-4 rounded-xl border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Cancellation</div>
          <div className="mt-1 text-sm text-foreground">
            {policy.cancellation_method} refund of{" "}
            <strong className="font-semibold">{formatCurrency(policy.refund_amount)}</strong>
            {policy.cancelled_at && (
              <span className="text-muted-foreground"> · {policy.cancelled_at.slice(0, 10)}</span>
            )}
          </div>
          {policy.cancellation_reason && (
            <div className="mt-1 text-xs text-muted-foreground">{policy.cancellation_reason}</div>
          )}
        </div>
      )}

      {/* Inline servicing toolbar — primary CTA lives in the header; rare
          lifecycle/admin actions live behind the Manage menu. */}
      {isActive && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm" className="text-foreground">
              <Link href={`/policies/${policy.id}/endorse`}>+ Endorse</Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="text-foreground">
              <Link href={`/policies/${policy.id}/certificates/new`}>+ Issue COI</Link>
            </Button>
          </div>
          <div
            className="relative"
            onKeyDown={(e) => { if (e.key === "Escape") setManageOpen(false); }}
          >
            <Button
              variant="outline"
              size="sm"
              className="text-foreground"
              aria-haspopup="menu"
              aria-expanded={manageOpen}
              onClick={() => setManageOpen((o) => !o)}
              disabled={busy}
            >
              Manage ▾
            </Button>
            {manageOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setManageOpen(false)} />
                <div className="absolute right-0 z-50 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-border bg-card py-1 shadow-md" role="menu">
                  {policy.status === "active" && (
                    <>
                      <button
                        type="button" role="menuitem"
                        className="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-muted disabled:opacity-50"
                        onClick={() => { setManageOpen(false); handleEndOfLife("expire"); }}
                        disabled={busy}
                      >
                        Mark expired
                      </button>
                      <button
                        type="button" role="menuitem"
                        className="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-muted disabled:opacity-50"
                        onClick={() => { setManageOpen(false); handleEndOfLife("non-renew"); }}
                        disabled={busy}
                      >
                        Non-renew
                      </button>
                      <button
                        type="button" role="menuitem"
                        className="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-muted disabled:opacity-50"
                        onClick={() => { setManageOpen(false); handleEndOfLife("lapse"); }}
                        disabled={busy}
                      >
                        Mark lapsed
                      </button>
                      <div className="my-1 border-t border-border" />
                    </>
                  )}
                  <button
                    type="button" role="menuitem"
                    className="block w-full px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
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
      )}

      {/* ── Endorsements ───────────────────────────────────────────────── */}
      <h2 className="mb-3 mt-10 text-base font-semibold text-foreground">
        Endorsements ({policy.endorsements.length})
      </h2>
      {policy.endorsements.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">No endorsements issued.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={thCls}>Type</th>
                <th className={thCls}>Effective</th>
                <th className={thCls}>Description</th>
                <th className={thCls}>Premium Δ</th>
              </tr>
            </thead>
            <tbody>
              {policy.endorsements.map(e => (
                <tr key={e.id} className="border-b border-border last:border-0">
                  <td className={tdCls}>{ENDORSEMENT_TYPE_LABEL[e.endorsement_type] ?? e.endorsement_type}</td>
                  <td className={monoCls}>{e.effective_date}</td>
                  <td className={tdCls}>{e.description}</td>
                  <td className={monoCls}>
                    {formatCurrency(e.premium_change)}
                    {parseFloat(e.tax_change) !== 0 && (
                      <span className="text-[10px] text-muted-foreground"> (tax {formatCurrency(e.tax_change)})</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Certificates of Insurance ──────────────────────────────────── */}
      <div className="mb-3 mt-10 flex items-center gap-3">
        <h2 className="text-base font-semibold text-foreground">Certificates of Insurance ({visibleCois.length})</h2>
        {policy.certificates.some(c => c.status === "superseded") && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showSupersededCois}
              onChange={e => setShowSupersededCois(e.target.checked)}
              className="size-4 accent-primary"
            />
            Show superseded
          </label>
        )}
      </div>
      {visibleCois.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">No certificates issued.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={thCls}>Holder</th>
                <th className={thCls}>Description</th>
                <th className={thCls}>Additional Insured</th>
                <th className={thCls}>Expires</th>
                <th className={thCls}>Status</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {visibleCois.map(c => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className={tdCls}>
                    <div className="text-foreground">{c.certificate_holder}</div>
                    <div className="text-[10px] text-muted-foreground">{c.certificate_holder_address}</div>
                  </td>
                  <td className={tdCls}>{c.description_of_operations}</td>
                  <td className={tdCls}>
                    {c.additional_insured ? (
                      <span className="text-foreground">✓ {c.additional_insured_scope?.replace(/_/g, " ")}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className={monoCls}>{c.expires_on}</td>
                  <td className="px-4 py-3">
                    <Badge variant={c.status === "active" ? "success" : c.status === "superseded" ? "muted" : "destructive"}>
                      {c.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-[#5A6E00]"
                      onClick={() => downloadCoiPdf(c.id).catch(() => toastError("Could not download the certificate PDF"))}
                    >
                      Download PDF
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Claims (carrier-side) ──────────────────────────────────────── */}
      <div className="mb-3 mt-10 flex items-center gap-3">
        <h2 className="text-base font-semibold text-foreground">Claims ({claims?.length ?? 0})</h2>
        <Button asChild variant="outline" size="sm" className="ml-auto text-foreground">
          <Link href={`/policies/${policy.id}/claims/new`}>+ File FNOL</Link>
        </Button>
      </div>
      {claims === null && !claimsError ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl border border-border bg-muted/40" />)}
        </div>
      ) : claimsError ? (
        <div role="alert" className="flex items-center gap-3 rounded-xl border border-dashed border-border py-6 px-4 text-sm text-muted-foreground">
          <span>Couldn&apos;t load claims — {claimsError}</span>
          <Button variant="outline" size="sm" onClick={loadClaims} className="text-foreground">Retry</Button>
        </div>
      ) : claims!.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">No claims filed against this policy.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px] text-sm" aria-label="Carrier claims on this policy">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={thCls}>Claim</th>
                <th scope="col" className={thCls}>Coverage line</th>
                <th scope="col" className={thCls}>Status</th>
                <th scope="col" className={thCls}>Date of loss</th>
                <th scope="col" className={`${thCls} text-right`}>Reserve</th>
                <th scope="col" className={`${thCls} text-right`}>Paid (ind + exp)</th>
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
                  className="cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-muted/40"
                >
                  <td className={monoCls}>{c.carrier_claim_number ?? c.id}</td>
                  <td className={tdCls}>{c.coverage_line.toUpperCase()}</td>
                  <td className="px-4 py-3"><ClaimStatusPill status={c.status} reopenCount={c.reopen_count} /></td>
                  <td className={monoCls}>{new Date(c.date_of_loss).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-foreground">{formatLedgerMoney(c.current_reserve)}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-foreground">{formatLedgerMoney(totalPaidFromClaim(c))}</td>
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

      {confirmAction && (
        <ConfirmDialog
          open
          title={confirmAction === "expire" ? "Mark policy expired" : "Reinstate policy"}
          body={confirmAction === "expire"
            ? "Mark this policy expired at end of term? This is terminal."
            : "Reinstate this lapsed policy back to active?"}
          confirmLabel={confirmAction === "expire" ? "Mark expired" : "Reinstate"}
          destructive={confirmAction === "expire"}
          busy={confirmBusy}
          onConfirm={runConfirm}
          onClose={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
