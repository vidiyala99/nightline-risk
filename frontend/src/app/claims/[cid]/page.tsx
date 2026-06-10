"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Copy } from "lucide-react";

import { ActionModal } from "@/components/claims/ActionModal";
import { ClaimActionToolbar } from "@/components/claims/ClaimActionToolbar";
import { ClaimLifecycleStrip } from "@/components/claims/ClaimLifecycleStrip";
import { ClaimStatusPill } from "@/components/claims/ClaimStatusPill";
import { ReserveDeltaBadge } from "@/components/claims/ReserveDeltaBadge";
import { ReserveSparkline } from "@/components/claims/ReserveSparkline";
import { PageHeader } from "@/components/ui/PageHeader";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { toastSuccess } from "@/lib/toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  ClaimsApiError,
  claimsApi,
  downloadDefensePackagePdf,
  totalIncurredFromClaim,
  type ClaimDetail,
} from "@/lib/claims";
import {
  CLAIM_STATUS_LABEL,
  PAYMENT_TYPE_LABEL,
  PAYMENT_TYPE_TONE,
  formatClaimMoney,
  formatLedgerMoney,
  isClosedStatus,
  type PaymentType,
} from "@/lib/claim-tokens";

type ActionKind =
  | "record_reserve"
  | "record_payment"
  | "close_claim"
  | "reopen_claim"
  | "attach_defense_package"
  | null;

export default function CarrierClaimDetailPage() {
  const { cid } = useParams<{ cid: string }>();
  const router = useRouter();
  const { user } = useAuth();

  const isBroker = user?.role === "broker" || user?.role === "admin";

  const [claim, setClaim] = useState<ClaimDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openAction, setOpenAction] = useState<ActionKind>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!cid) return;
    setLoadError(null);
    try {
      const data = await claimsApi.claimDetail(cid);
      setClaim(data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load claim");
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    load();
  }, [load]);

  // Keyboard shortcuts: R, P, C, O, D — only when not in an input/textarea
  // and the corresponding action is available for the current status.
  useEffect(() => {
    if (!claim || !isBroker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const key = e.key.toLowerCase();
      if (key === "r") setOpenAction((curr) => curr ?? "record_reserve");
      else if (key === "p") setOpenAction((curr) => curr ?? "record_payment");
      else if (key === "c") setOpenAction((curr) => curr ?? "close_claim");
      else if (key === "o") setOpenAction((curr) => curr ?? "reopen_claim");
      else if (key === "d") setOpenAction((curr) => curr ?? "attach_defense_package");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [claim, isBroker]);

  if (loading) {
    return (
      <div className="claim-detail">
        <ClaimDetailSkeleton />
      </div>
    );
  }

  if (loadError || !claim) {
    return (
      <div className="claim-detail">
        <div className="claim-detail__error" role="alert">
          <p>{loadError ?? "Claim not found"}</p>
          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <button type="button" className="btn btn-sm" onClick={load}>
              Retry
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => router.back()}
            >
              <ArrowLeft size={14} aria-hidden style={{ marginRight: 4, verticalAlign: "-2px" }} />
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  const incurred = totalIncurredFromClaim(claim);
  const headline = formatClaimMoney(incurred);
  const masthead = claim.carrier_claim_number ?? claim.id;
  const closed = isClosedStatus(claim.status);

  function closeModal() {
    setOpenAction(null);
  }

  async function afterMutation() {
    setOpenAction(null);
    await load();
  }

  return (
    <div className="claim-detail">
      <PageHeader
        eyebrow="CARRIER CLAIM"
        title={masthead}
        subtitle={`${claim.coverage_line.toUpperCase()} · ${new Date(claim.date_of_loss).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} · ${claim.policy_id}`}
        actions={<ClaimStatusPill status={claim.status} announce reopenCount={claim.reopen_count} />}
      />

      <div className="claim-detail__breadcrumb">
        <Link href={`/policies/${claim.policy_id}`} className="claim-detail__back">
          <ArrowLeft size={12} aria-hidden /> Policy {claim.policy_id}
        </Link>
        <span className="claim-detail__masthead-rule" aria-hidden />
        <button
          type="button"
          className="claim-detail__masthead-id"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(claim.id);
            } catch {
              /* ignore — clipboard may be denied; the id is also visible */
            }
          }}
          aria-label={`Copy claim ID ${claim.id} to clipboard`}
          title="Copy claim ID"
        >
          {claim.id}
          <Copy size={11} aria-hidden style={{ marginLeft: 6, opacity: 0.6 }} />
        </button>
      </div>

      <section className="claim-detail__headline" aria-label="Total incurred">
        <span className="claim-detail__headline-label">Total incurred</span>
        <span className={`claim-detail__headline-value claim-detail__headline-value--${headline.sign}`}>
          <span className="claim-detail__headline-unit">$</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{headline.digits}</span>
        </span>
        <span className="claim-detail__headline-delta">
          <ReserveDeltaBadge currentReserve={claim.current_reserve} totalIncurred={incurred} />
        </span>
      </section>

      <ClaimLifecycleStrip status={claim.status} reopenCount={claim.reopen_count} />

      <section className="claim-detail__summary" aria-label="Claim financial summary">
        <div className="claim-detail__summary-tile">
          <span className="claim-detail__summary-label">Current reserve</span>
          <div className="claim-detail__summary-row">
            <span className="claim-detail__summary-value">{formatLedgerMoney(claim.current_reserve)}</span>
            <ReserveSparkline
              changes={claim.reserve_changes}
              currentReserve={claim.current_reserve}
            />
          </div>
        </div>
        <div className="claim-detail__summary-tile">
          <span className="claim-detail__summary-label">Indemnity paid</span>
          <span className="claim-detail__summary-value">{formatLedgerMoney(claim.indemnity_paid_to_date)}</span>
        </div>
        <div className="claim-detail__summary-tile">
          <span className="claim-detail__summary-label">Expense paid</span>
          <span className="claim-detail__summary-value">{formatLedgerMoney(claim.expense_paid_to_date)}</span>
        </div>
        <div className="claim-detail__summary-tile">
          <span className="claim-detail__summary-label">Recoveries</span>
          <span className="claim-detail__summary-value">{formatLedgerMoney(claim.recoveries_to_date)}</span>
        </div>
      </section>

      {isBroker && (
        <ClaimActionToolbar
          status={claim.status}
          busy={busy}
          onRecordReserve={() => setOpenAction("record_reserve")}
          onRecordPayment={() => setOpenAction("record_payment")}
          onCloseClaim={() => setOpenAction("close_claim")}
          onReopenClaim={() => setOpenAction("reopen_claim")}
          onAttachDefensePackage={() => setOpenAction("attach_defense_package")}
        />
      )}

      <h2 className="claim-detail__section-title">Payments</h2>
      <PaymentLedger payments={claim.payments} />

      <h2 className="claim-detail__section-title">Reserve history</h2>
      <ReserveHistoryTable changes={claim.reserve_changes} />

      <section className="claim-detail__meta" aria-label="Claim metadata">
        <dl className="claim-detail__meta-list">
          <div>
            <dt>FNOL filed</dt>
            <dd>{new Date(claim.fnol_submitted_at).toLocaleString()}</dd>
          </div>
          {claim.adjuster_name && (
            <div>
              <dt>Adjuster</dt>
              <dd>
                {claim.adjuster_name}
                {claim.adjuster_email && (
                  <>
                    {" — "}
                    <a href={`mailto:${claim.adjuster_email}`}>{claim.adjuster_email}</a>
                  </>
                )}
              </dd>
            </div>
          )}
          {claim.defense_package_id && (
            <div>
              <dt>Defense package</dt>
              <dd className="claim-detail__meta-mono">
                {claim.defense_package_id}
                {" · "}
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => downloadDefensePackagePdf(claim.defense_package_id!).catch(() => {})}
                >
                  Download PDF
                </button>
              </dd>
            </div>
          )}
          {claim.incident_id && (
            <div>
              <dt>Linked incident</dt>
              <dd className="claim-detail__meta-mono">
                <Link href={`/incidents/${claim.incident_id}`}>{claim.incident_id}</Link>
              </dd>
            </div>
          )}
          {claim.proposal_id && (
            <div>
              <dt>Origin proposal</dt>
              <dd className="claim-detail__meta-mono">{claim.proposal_id}</dd>
            </div>
          )}
          {closed && claim.final_indemnity && (
            <div>
              <dt>Final indemnity</dt>
              <dd>{formatLedgerMoney(claim.final_indemnity)}</dd>
            </div>
          )}
          {closed && claim.closed_at && (
            <div>
              <dt>Closed</dt>
              <dd>
                {new Date(claim.closed_at).toLocaleString()} ·{" "}
                {CLAIM_STATUS_LABEL[claim.status]}
              </dd>
            </div>
          )}
          {claim.reopened_at && (
            <div>
              <dt>Reopened</dt>
              <dd>
                {new Date(claim.reopened_at).toLocaleString()} · {claim.reopen_count}×
              </dd>
            </div>
          )}
          <div>
            <dt>Snapshot hash</dt>
            <dd className="claim-detail__meta-mono claim-detail__meta-hash">{claim.snapshot_hash}</dd>
          </div>
        </dl>
      </section>

      <RecordReserveModal
        cid={claim.id}
        open={openAction === "record_reserve"}
        onClose={closeModal}
        onSuccess={afterMutation}
        setBusy={setBusy}
      />
      <RecordPaymentModal
        cid={claim.id}
        open={openAction === "record_payment"}
        onClose={closeModal}
        onSuccess={afterMutation}
        setBusy={setBusy}
      />
      <CloseClaimModal
        cid={claim.id}
        open={openAction === "close_claim"}
        onClose={closeModal}
        onSuccess={afterMutation}
        setBusy={setBusy}
      />
      <ReopenClaimModal
        cid={claim.id}
        open={openAction === "reopen_claim"}
        onClose={closeModal}
        onSuccess={afterMutation}
        setBusy={setBusy}
      />
      <AttachDefensePackageModal
        cid={claim.id}
        existing={claim.defense_package_id}
        open={openAction === "attach_defense_package"}
        onClose={closeModal}
        onSuccess={afterMutation}
        setBusy={setBusy}
      />
    </div>
  );
}

// ─── Loading skeleton ────────────────────────────────────────────────────

function ClaimDetailSkeleton() {
  return (
    <div className="claim-detail__skeleton" aria-busy="true" aria-label="Loading claim">
      <div className="claim-detail__skeleton-pill" />
      <div className="claim-detail__skeleton-headline" />
      <div className="claim-detail__skeleton-strip" />
      <div className="claim-detail__skeleton-summary">
        <div /><div /><div /><div />
      </div>
      <div className="claim-detail__skeleton-table" />
    </div>
  );
}

// ─── Subtables ──────────────────────────────────────────────────────────

function PaymentLedger({ payments }: { payments: ClaimDetail["payments"] }) {
  if (payments.length === 0) {
    return (
      <p className="claim-detail__empty">
        No payments recorded yet. Record the first indemnity, expense, or recovery from the toolbar above.
      </p>
    );
  }
  const sorted = payments
    .slice()
    .sort((a, b) => new Date(b.paid_on).getTime() - new Date(a.paid_on).getTime());
  return (
    <div className="policies-table-wrap">
      <table className="policies-table" aria-label="Payment ledger">
        <thead>
          <tr>
            <th scope="col">Paid on</th>
            <th scope="col">Type</th>
            <th scope="col" style={{ textAlign: "right" }}>Amount</th>
            <th scope="col">Description</th>
            <th scope="col">Recorded by</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.id}>
              <td className="policies-table__mono">{new Date(p.paid_on).toLocaleDateString()}</td>
              <td>
                <span
                  className={`payment-type-badge payment-type-badge--${PAYMENT_TYPE_TONE[p.payment_type]}`}
                >
                  {PAYMENT_TYPE_LABEL[p.payment_type]}
                </span>
              </td>
              <td
                className="policies-table__mono"
                style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
              >
                {formatLedgerMoney(p.amount)}
              </td>
              <td>{p.description || "—"}</td>
              <td className="policies-table__mono">{p.recorded_by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReserveHistoryTable({ changes }: { changes: ClaimDetail["reserve_changes"] }) {
  if (changes.length === 0) {
    return (
      <p className="claim-detail__empty">
        No reserve changes recorded yet. The first reserve communication from the carrier will appear here.
      </p>
    );
  }
  const sorted = changes
    .slice()
    .sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime());
  return (
    <div className="policies-table-wrap">
      <table className="policies-table" aria-label="Reserve change history">
        <thead>
          <tr>
            <th scope="col">Received</th>
            <th scope="col" style={{ textAlign: "right" }}>From → To</th>
            <th scope="col">Reason</th>
            <th scope="col">Source</th>
            <th scope="col">Recorded by</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.id}>
              <td className="policies-table__mono">{new Date(c.received_at).toLocaleString()}</td>
              <td
                className="policies-table__mono"
                style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
              >
                {formatLedgerMoney(c.from_amount)} → {formatLedgerMoney(c.to_amount)}
              </td>
              <td>{c.change_reason}</td>
              <td>{c.received_from}</td>
              <td className="policies-table__mono">{c.recorded_by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Action modals ──────────────────────────────────────────────────────

interface ModalProps {
  cid: string;
  open: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void>;
  setBusy: (b: boolean) => void;
}

function RecordReserveModal(p: ModalProps) {
  const [reserve, setReserve] = useState("");
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!p.open) {
      setReserve(""); setReason(""); setSource(""); setError(null);
    }
  }, [p.open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!reserve || parseFloat(reserve) < 0) {
      setError("Enter the carrier's new reserve amount.");
      return;
    }
    if (!reason.trim() || !source.trim()) {
      setError("Reason and source are both required.");
      return;
    }
    setSubmitting(true);
    p.setBusy(true);
    try {
      await claimsApi.recordCarrierReserve(p.cid, {
        new_reserve: reserve,
        change_reason: reason.trim(),
        received_from: source.trim(),
        received_at: new Date().toISOString(),
      });
      toastSuccess("Reserve updated");
      await p.onSuccess();
    } catch (err) {
      setError(err instanceof ClaimsApiError ? err.message : "Failed to record reserve.");
    } finally {
      setSubmitting(false);
      p.setBusy(false);
    }
  }

  const dirty = reserve.length > 0 || reason.length > 0 || source.length > 0;

  return (
    <ActionModal
      open={p.open}
      title="Record carrier reserve"
      subtitle="The carrier set or adjusted this claim's reserve. Record the new amount and the source."
      onClose={p.onClose}
      guardDismiss={dirty}
      busy={submitting}
    >
      <form onSubmit={submit} className="claim-form">
        <label className="claim-form__field">
          <span className="claim-form__label">
            New reserve <span className="claim-form__required" aria-hidden>*</span>
          </span>
          <span className="claim-form__money-wrap">
            <span className="claim-form__money-prefix">$</span>
            <input
              type="text"
              inputMode="decimal"
              required
              value={reserve}
              onChange={(e) => setReserve(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="25000.00"
              className="claim-form__input claim-form__input--money"
            />
            <span className="claim-form__money-suffix">USD</span>
          </span>
        </label>
        <label className="claim-form__field">
          <span className="claim-form__label">
            Reason <span className="claim-form__required" aria-hidden>*</span>
          </span>
          <input
            type="text"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. initial reserve, post-investigation adjustment"
            className="claim-form__input"
          />
          <span className="claim-form__hint">As communicated by the carrier or adjuster.</span>
        </label>
        <label className="claim-form__field">
          <span className="claim-form__label">
            Received from <span className="claim-form__required" aria-hidden>*</span>
          </span>
          <input
            type="text"
            required
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Adjuster name or carrier letter reference"
            className="claim-form__input"
          />
        </label>
        {error && (
          <p role="alert" className="claim-form__error">
            {error}
          </p>
        )}
        <div className="claim-form__actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={p.onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
            {submitting ? "Recording…" : "Record reserve"}
          </button>
        </div>
      </form>
    </ActionModal>
  );
}

function RecordPaymentModal(p: ModalProps) {
  const [paymentType, setPaymentType] = useState<PaymentType>("indemnity");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!p.open) {
      setPaymentType("indemnity");
      setAmount("");
      setPaidOn(new Date().toISOString().slice(0, 10));
      setDescription("");
      setError(null);
    }
  }, [p.open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const n = parseFloat(amount);
    if (!amount || Number.isNaN(n) || n <= 0) {
      setError("Amount must be greater than zero.");
      return;
    }
    setSubmitting(true);
    p.setBusy(true);
    try {
      await claimsApi.recordPayment(p.cid, {
        amount,
        payment_type: paymentType,
        paid_on: paidOn,
        description: description.trim(),
      });
      toastSuccess("Payment recorded");
      await p.onSuccess();
    } catch (err) {
      setError(err instanceof ClaimsApiError ? err.message : "Failed to record payment.");
    } finally {
      setSubmitting(false);
      p.setBusy(false);
    }
  }

  const dirty = amount.length > 0 || description.length > 0;

  return (
    <ActionModal
      open={p.open}
      title="Record carrier payment"
      subtitle="What the carrier disbursed — indemnity to claimant, expense to defense, or a recovery (subrogation / salvage)."
      onClose={p.onClose}
      guardDismiss={dirty}
      busy={submitting}
    >
      <form onSubmit={submit} className="claim-form">
        <label className="claim-form__field">
          <span className="claim-form__label">
            Type <span className="claim-form__required" aria-hidden>*</span>
          </span>
          <select
            value={paymentType}
            onChange={(e) => setPaymentType(e.target.value as PaymentType)}
            className="claim-form__input"
          >
            <option value="indemnity">{PAYMENT_TYPE_LABEL.indemnity}</option>
            <option value="expense">{PAYMENT_TYPE_LABEL.expense}</option>
            <option value="recovery">{PAYMENT_TYPE_LABEL.recovery}</option>
          </select>
          <span className="claim-form__hint">
            Recoveries (subrogation, salvage) are stored as positive amounts and subtracted from total incurred at close.
          </span>
        </label>
        <label className="claim-form__field">
          <span className="claim-form__label">
            Amount <span className="claim-form__required" aria-hidden>*</span>
          </span>
          <span className="claim-form__money-wrap">
            <span className="claim-form__money-prefix">$</span>
            <input
              type="text"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="5000.00"
              className="claim-form__input claim-form__input--money"
            />
            <span className="claim-form__money-suffix">USD</span>
          </span>
        </label>
        <label className="claim-form__field">
          <span className="claim-form__label">
            Paid on <span className="claim-form__required" aria-hidden>*</span>
          </span>
          <input
            type="date"
            required
            value={paidOn}
            onChange={(e) => setPaidOn(e.target.value)}
            className="claim-form__input"
          />
        </label>
        <label className="claim-form__field">
          <span className="claim-form__label">Description</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. settlement to claimant, defense counsel invoice"
            className="claim-form__input"
          />
        </label>
        {error && (
          <p role="alert" className="claim-form__error">
            {error}
          </p>
        )}
        <div className="claim-form__actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={p.onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
            {submitting ? "Recording…" : "Record payment"}
          </button>
        </div>
      </form>
    </ActionModal>
  );
}

function CloseClaimModal(p: ModalProps) {
  const [disposition, setDisposition] = useState<"paid" | "denied" | "dropped">("paid");
  const [finalIndemnity, setFinalIndemnity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!p.open) {
      setDisposition("paid");
      setFinalIndemnity("");
      setError(null);
    }
  }, [p.open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (disposition === "paid" && !finalIndemnity) {
      setError("Final indemnity is required when disposition is paid.");
      return;
    }
    setSubmitting(true);
    p.setBusy(true);
    try {
      await claimsApi.closeClaim(p.cid, {
        disposition,
        final_indemnity: disposition === "paid" ? finalIndemnity : null,
      });
      toastSuccess("Claim closed");
      await p.onSuccess();
    } catch (err) {
      setError(err instanceof ClaimsApiError ? err.message : "Failed to close claim.");
    } finally {
      setSubmitting(false);
      p.setBusy(false);
    }
  }

  const dirty = disposition !== "paid" || finalIndemnity.length > 0;

  return (
    <ActionModal
      open={p.open}
      title="Close claim"
      subtitle="Disposition becomes part of the claim's frozen record. You can reopen later if needed."
      onClose={p.onClose}
      guardDismiss={dirty}
      busy={submitting}
    >
      <form onSubmit={submit} className="claim-form">
        <fieldset className="claim-form__field claim-form__field--radios">
          <legend className="claim-form__label">
            Disposition <span className="claim-form__required" aria-hidden>*</span>
          </legend>
          <label className="claim-form__radio">
            <input
              type="radio"
              name="disposition"
              value="paid"
              checked={disposition === "paid"}
              onChange={() => setDisposition("paid")}
            />
            Paid — settled in claimant's favor
          </label>
          <label className="claim-form__radio">
            <input
              type="radio"
              name="disposition"
              value="denied"
              checked={disposition === "denied"}
              onChange={() => setDisposition("denied")}
            />
            Denied — coverage not triggered
          </label>
          <label className="claim-form__radio">
            <input
              type="radio"
              name="disposition"
              value="dropped"
              checked={disposition === "dropped"}
              onChange={() => setDisposition("dropped")}
            />
            Dropped — claimant withdrew
          </label>
        </fieldset>
        {disposition === "paid" && (
          <label className="claim-form__field">
            <span className="claim-form__label">
              Final indemnity <span className="claim-form__required" aria-hidden>*</span>
            </span>
            <span className="claim-form__money-wrap">
              <span className="claim-form__money-prefix">$</span>
              <input
                type="text"
                inputMode="decimal"
                required
                value={finalIndemnity}
                onChange={(e) => setFinalIndemnity(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="10000.00"
                className="claim-form__input claim-form__input--money"
              />
              <span className="claim-form__money-suffix">USD</span>
            </span>
            <span className="claim-form__hint">
              The settlement amount paid. Total incurred is computed as indemnity + expense − recoveries.
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className="claim-form__error">
            {error}
          </p>
        )}
        <div className="claim-form__actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={p.onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-sm claim-form__danger"
            disabled={submitting}
          >
            {submitting ? "Closing…" : "Close claim"}
          </button>
        </div>
      </form>
    </ActionModal>
  );
}

function ReopenClaimModal(p: ModalProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!p.open) {
      setReason("");
      setError(null);
    }
  }, [p.open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!reason.trim()) {
      setError("Provide a reason — this is logged on the claim's audit trail.");
      return;
    }
    setSubmitting(true);
    p.setBusy(true);
    try {
      await claimsApi.reopenClaim(p.cid, { reason: reason.trim() });
      toastSuccess("Claim reopened");
      await p.onSuccess();
    } catch (err) {
      setError(err instanceof ClaimsApiError ? err.message : "Failed to reopen claim.");
    } finally {
      setSubmitting(false);
      p.setBusy(false);
    }
  }

  return (
    <ActionModal
      open={p.open}
      title="Reopen claim"
      subtitle="Used for subrogation, late-discovered information, or fraud investigation. The original close stays in the audit trail."
      onClose={p.onClose}
      guardDismiss={reason.length > 0}
      busy={submitting}
    >
      <form onSubmit={submit} className="claim-form">
        <label className="claim-form__field">
          <span className="claim-form__label">
            Reason <span className="claim-form__required" aria-hidden>*</span>
          </span>
          <textarea
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. subrogation potential identified, fraud investigation opened"
            className="claim-form__input"
          />
        </label>
        {error && (
          <p role="alert" className="claim-form__error">
            {error}
          </p>
        )}
        <div className="claim-form__actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={p.onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
            {submitting ? "Reopening…" : "Reopen claim"}
          </button>
        </div>
      </form>
    </ActionModal>
  );
}

function AttachDefensePackageModal(
  p: ModalProps & { existing: string | null },
) {
  const [packageId, setPackageId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!p.open) {
      setPackageId("");
      setError(null);
    }
  }, [p.open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!packageId.trim()) {
      setError("Enter the UnderwritingPacket id to attach.");
      return;
    }
    setSubmitting(true);
    p.setBusy(true);
    try {
      await claimsApi.attachDefensePackage(p.cid, {
        defense_package_id: packageId.trim(),
      });
      toastSuccess("Defense package attached");
      await p.onSuccess();
    } catch (err) {
      setError(err instanceof ClaimsApiError ? err.message : "Failed to attach defense package.");
    } finally {
      setSubmitting(false);
      p.setBusy(false);
    }
  }

  return (
    <ActionModal
      open={p.open}
      title={p.existing ? "Replace defense package" : "Attach defense package"}
      subtitle={
        p.existing
          ? `Currently attached: ${p.existing}. Attaching a new packet supersedes it on the claim snapshot.`
          : "Link a frozen underwriting packet so the defense story is anchored at this moment."
      }
      onClose={p.onClose}
      guardDismiss={packageId.length > 0}
      busy={submitting}
    >
      <form onSubmit={submit} className="claim-form">
        <label className="claim-form__field">
          <span className="claim-form__label">
            Packet ID <span className="claim-form__required" aria-hidden>*</span>
          </span>
          <input
            type="text"
            required
            value={packageId}
            onChange={(e) => setPackageId(e.target.value)}
            placeholder="pkt-… (paste from underwriter detail)"
            className="claim-form__input"
          />
          <span className="claim-form__hint">
            ON DELETE RESTRICT: once attached, the packet cannot be deleted while this claim exists.
          </span>
        </label>
        {error && (
          <p role="alert" className="claim-form__error">
            {error}
          </p>
        )}
        <div className="claim-form__actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={p.onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
            {submitting ? "Attaching…" : p.existing ? "Replace" : "Attach"}
          </button>
        </div>
      </form>
    </ActionModal>
  );
}
