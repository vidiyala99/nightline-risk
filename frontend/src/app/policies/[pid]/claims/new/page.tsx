"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FileWarning } from "lucide-react";

import { PageHeader } from "@/components/ui/PageHeader";
import { usePageBack } from "@/components/layout/BackNavContext";
import { ClaimsApiError, claimsApi, type FileFnolBody } from "@/lib/claims";
import { policiesApi, type PolicyDetail } from "@/lib/policies";
import { toastSuccess } from "@/lib/toast";

interface FieldErrors {
  coverage_line?: string;
  date_of_loss?: string;
  adjuster_email?: string;
}

export default function FileFnolPage() {
  const { pid } = useParams<{ pid: string }>();
  const router = useRouter();

  const [policy, setPolicy] = useState<PolicyDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [coverageLine, setCoverageLine] = useState("");
  const [dateOfLoss, setDateOfLoss] = useState("");
  const [incidentId, setIncidentId] = useState("");
  const [proposalId, setProposalId] = useState("");
  const [defensePackageId, setDefensePackageId] = useState("");
  const [carrierClaimNumber, setCarrierClaimNumber] = useState("");
  const [adjusterName, setAdjusterName] = useState("");
  const [adjusterEmail, setAdjusterEmail] = useState("");
  const [showCarrierDetails, setShowCarrierDetails] = useState(false);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const errorSummaryRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    policiesApi
      .getPolicy(pid)
      .then((p) => {
        if (cancelled) return;
        setPolicy(p);
        // Default coverage line to first one available if there's only one.
        if (p.coverage_lines.length === 1) setCoverageLine(p.coverage_lines[0]);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load policy");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pid]);

  useEffect(() => {
    if (!loading && policy) {
      // autofocus first field on mount
      firstFieldRef.current?.focus();
    }
  }, [loading, policy]);

  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!coverageLine) e.coverage_line = "Pick a coverage line from the policy.";
    if (!dateOfLoss) {
      e.date_of_loss = "Date of loss is required.";
    } else if (policy) {
      if (dateOfLoss < policy.effective_date)
        e.date_of_loss = `Before policy effective date (${policy.effective_date}).`;
      else if (dateOfLoss > policy.expiration_date)
        e.date_of_loss = `After policy expiration (${policy.expiration_date}).`;
    }
    if (adjusterEmail && !/^\S+@\S+\.\S+$/.test(adjusterEmail)) {
      e.adjuster_email = "Enter a valid email.";
    }
    return e;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const fe = validate();
    setErrors(fe);
    if (Object.keys(fe).length > 0) {
      // Focus the first invalid field's nearest input.
      const order = ["coverage_line", "date_of_loss", "adjuster_email"] as const;
      const firstInvalid = order.find((k) => fe[k]);
      if (firstInvalid) {
        const el = document.querySelector<HTMLElement>(`[data-field="${firstInvalid}"]`);
        el?.focus();
      }
      return;
    }

    const body: FileFnolBody = {
      coverage_line: coverageLine,
      date_of_loss: dateOfLoss,
      incident_id: incidentId.trim() || undefined,
      proposal_id: proposalId.trim() || undefined,
      defense_package_id: defensePackageId.trim() || undefined,
      carrier_claim_number: carrierClaimNumber.trim() || undefined,
      adjuster_name: adjusterName.trim() || undefined,
      adjuster_email: adjusterEmail.trim() || undefined,
    };

    setSubmitting(true);
    try {
      const claim = await claimsApi.fileFnol(pid, body);
      toastSuccess(`FNOL filed — ${claim.coverage_line.toUpperCase()} claim opened`);
      // router.replace so back from the new claim goes to the policy, not the form
      router.replace(`/claims/${claim.id}`);
    } catch (err) {
      const msg =
        err instanceof ClaimsApiError ? err.message : "Failed to file FNOL.";
      setSubmitError(msg);
      // Focus the error summary so screen readers pick it up immediately.
      setTimeout(() => errorSummaryRef.current?.focus(), 0);
    } finally {
      setSubmitting(false);
    }
  }

  // Single contextual back, rendered once by AppShell (see BackNavContext).
  usePageBack("Back to policy", () => router.push(`/policies/${pid}`));

  if (loading) {
    return (
      <div className="claim-fnol">
        <div className="claim-fnol__loading" aria-busy="true">
          Loading policy context…
        </div>
      </div>
    );
  }

  if (loadError || !policy) {
    return (
      <div className="claim-fnol">
        <div className="claim-detail__error" role="alert">
          <p>{loadError ?? "Policy not found"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="claim-fnol" style={{ maxWidth: 960 }}>
      <PageHeader
        eyebrow="FNOL"
        title="File a carrier claim"
        subtitle={`Against policy ${policy.policy_number ?? policy.id} · ${policy.venue_id}`}
      />

      <nav className="claim-fnol__breadcrumb" aria-label="Breadcrumb">
        <Link href="/policies">Policies</Link>
        <span aria-hidden> / </span>
        <Link href={`/policies/${pid}`}>{policy.policy_number ?? policy.id}</Link>
        <span aria-hidden> / </span>
        <span aria-current="page">File FNOL</span>
      </nav>

      <div className="form-shell">
      <form id="fnol-form" className="claim-form claim-fnol__form" onSubmit={submit} noValidate>
        <fieldset className="claim-form__group">
          <legend className="claim-form__group-title">Loss details</legend>

          <label className="claim-form__field" data-field="coverage_line">
            <span className="claim-form__label">
              Coverage line <span className="claim-form__required" aria-hidden>*</span>
            </span>
            <select
              ref={firstFieldRef}
              required
              value={coverageLine}
              onChange={(e) => {
                setCoverageLine(e.target.value);
                setErrors((s) => ({ ...s, coverage_line: undefined }));
              }}
              onBlur={() => setErrors((s) => ({ ...s, ...validate() }))}
              aria-invalid={!!errors.coverage_line}
              aria-describedby={errors.coverage_line ? "err-coverage_line" : "hint-coverage_line"}
              className="claim-form__input"
            >
              <option value="">— Pick a coverage line —</option>
              {policy.coverage_lines.map((l) => (
                <option key={l} value={l}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
            <span id="hint-coverage_line" className="claim-form__hint">
              The policy covers: {policy.coverage_lines.join(", ").toUpperCase()}.
            </span>
            {errors.coverage_line && (
              <span id="err-coverage_line" role="alert" className="claim-form__error">
                {errors.coverage_line}
              </span>
            )}
          </label>

          <label className="claim-form__field" data-field="date_of_loss">
            <span className="claim-form__label">
              Date of loss <span className="claim-form__required" aria-hidden>*</span>
            </span>
            <input
              type="date"
              required
              min={policy.effective_date}
              max={policy.expiration_date}
              value={dateOfLoss}
              onChange={(e) => {
                setDateOfLoss(e.target.value);
                setErrors((s) => ({ ...s, date_of_loss: undefined }));
              }}
              onBlur={() => setErrors((s) => ({ ...s, ...validate() }))}
              aria-invalid={!!errors.date_of_loss}
              aria-describedby={errors.date_of_loss ? "err-date_of_loss" : "hint-date_of_loss"}
              className="claim-form__input"
            />
            <span id="hint-date_of_loss" className="claim-form__hint">
              Must be within the policy term: {policy.effective_date} – {policy.expiration_date}.
            </span>
            {errors.date_of_loss && (
              <span id="err-date_of_loss" role="alert" className="claim-form__error">
                {errors.date_of_loss}
              </span>
            )}
          </label>
        </fieldset>

        <fieldset className="claim-form__group">
          <legend className="claim-form__group-title">Linkages (optional)</legend>

          <label className="claim-form__field">
            <span className="claim-form__label">Originating incident</span>
            <input
              type="text"
              value={incidentId}
              onChange={(e) => setIncidentId(e.target.value)}
              placeholder="inc-… (paste from incident detail)"
              className="claim-form__input"
            />
            <span className="claim-form__hint">
              Optional — links the operator-reported incident that triggered this loss.
            </span>
          </label>

          <label className="claim-form__field">
            <span className="claim-form__label">Origin proposal</span>
            <input
              type="text"
              value={proposalId}
              onChange={(e) => setProposalId(e.target.value)}
              placeholder="clp-… (paste from claim proposal)"
              className="claim-form__input"
            />
            <span className="claim-form__hint">
              Optional — links the ClaimProposal (operator recommendation) that became this FNOL.
            </span>
          </label>

          <label className="claim-form__field">
            <span className="claim-form__label">Defense package</span>
            <input
              type="text"
              value={defensePackageId}
              onChange={(e) => setDefensePackageId(e.target.value)}
              placeholder="pkt-… (paste from underwriter detail)"
              className="claim-form__input"
            />
            <span className="claim-form__hint">
              Optional — links a frozen underwriting packet as this claim's defense story. You can attach later.
            </span>
          </label>
        </fieldset>

        <fieldset className="claim-form__group">
          <legend className="claim-form__group-title">
            <button
              type="button"
              className="claim-form__disclosure"
              aria-expanded={showCarrierDetails}
              onClick={() => setShowCarrierDetails((s) => !s)}
            >
              Carrier contact {showCarrierDetails ? "▾" : "▸"}
            </button>
          </legend>

          {showCarrierDetails && (
            <>
              <label className="claim-form__field">
                <span className="claim-form__label">Carrier claim number</span>
                <input
                  type="text"
                  value={carrierClaimNumber}
                  onChange={(e) => setCarrierClaimNumber(e.target.value)}
                  placeholder="As issued by the carrier; often arrives later"
                  className="claim-form__input"
                />
              </label>

              <label className="claim-form__field">
                <span className="claim-form__label">Adjuster name</span>
                <input
                  type="text"
                  autoComplete="name"
                  value={adjusterName}
                  onChange={(e) => setAdjusterName(e.target.value)}
                  className="claim-form__input"
                />
              </label>

              <label className="claim-form__field" data-field="adjuster_email">
                <span className="claim-form__label">Adjuster email</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={adjusterEmail}
                  onChange={(e) => {
                    setAdjusterEmail(e.target.value);
                    setErrors((s) => ({ ...s, adjuster_email: undefined }));
                  }}
                  onBlur={() => setErrors((s) => ({ ...s, ...validate() }))}
                  aria-invalid={!!errors.adjuster_email}
                  aria-describedby={errors.adjuster_email ? "err-adjuster_email" : undefined}
                  className="claim-form__input"
                />
                {errors.adjuster_email && (
                  <span id="err-adjuster_email" role="alert" className="claim-form__error">
                    {errors.adjuster_email}
                  </span>
                )}
              </label>
            </>
          )}
        </fieldset>

        {submitError && (
          <div
            ref={errorSummaryRef}
            tabIndex={-1}
            role="alert"
            className="claim-form__submit-error"
          >
            <FileWarning size={14} aria-hidden style={{ marginRight: 6, verticalAlign: "-2px" }} />
            {submitError}
          </div>
        )}

      </form>

      <aside className="form-summary">
        <div className="form-summary__actions">
          <Link href={`/policies/${pid}`} className="btn btn-sm btn-secondary">
            Cancel
          </Link>
          <button type="submit" form="fnol-form" className="btn btn-primary btn-sm" disabled={submitting}>
            {submitting ? "Filing…" : "File FNOL"}
          </button>
        </div>
        <div className="form-summary__title">Claim</div>
        <dl style={{ margin: 0 }}>
          <div className="form-summary__row"><dt>Coverage</dt><dd>{coverageLine ? coverageLine.toUpperCase() : "—"}</dd></div>
          <div className="form-summary__row"><dt>Date of loss</dt><dd>{dateOfLoss || "—"}</dd></div>
        </dl>
        <div className="form-summary__section">
          <div className="form-summary__title">Against policy</div>
          <dl style={{ margin: 0 }}>
            <div className="form-summary__row"><dt>Policy</dt><dd>{policy.policy_number ?? policy.id}</dd></div>
            <div className="form-summary__row"><dt>Venue</dt><dd>{policy.venue_id}</dd></div>
            <div className="form-summary__row"><dt>Coverage</dt><dd>{policy.coverage_lines.join(", ").toUpperCase()}</dd></div>
            <div className="form-summary__row"><dt>Term</dt><dd>{policy.effective_date} – {policy.expiration_date}</dd></div>
          </dl>
        </div>
      </aside>
      </div>
    </div>
  );
}
