"use client";

/**
 * /policies/[pid]/claims/new — file a carrier claim (FNOL).
 *
 * "Paper & Ink" — migrated to ds/ token chrome. The a11y wiring is preserved
 * verbatim (refs, aria-invalid/-describedby, error ids, data-field focus
 * management, fieldset/legend, noValidate inline validation); only the visual
 * classes changed.
 */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FileWarning } from "lucide-react";

import { usePageBack } from "@/components/layout/BackNavContext";
import { ClaimsApiError, claimsApi, type FileFnolBody } from "@/lib/claims";
import { policiesApi, type PolicyDetail } from "@/lib/policies";
import { toastSuccess } from "@/lib/toast";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;
const controlClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50";
const labelCls = "text-sm font-medium text-foreground";
const hintCls = "text-xs text-muted-foreground";
const errCls = "text-xs text-destructive";

interface FieldErrors {
  coverage_line?: string;
  date_of_loss?: string;
  adjuster_email?: string;
}

function Row({ dt, dd }: { dt: string; dd: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{dt}</dt>
      <dd className="text-right font-medium text-foreground">{dd}</dd>
    </div>
  );
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
      router.replace(`/claims/${claim.id}`);
    } catch (err) {
      const msg = err instanceof ClaimsApiError ? err.message : "Failed to file FNOL.";
      setSubmitError(msg);
      setTimeout(() => errorSummaryRef.current?.focus(), 0);
    } finally {
      setSubmitting(false);
    }
  }

  // Single contextual back, rendered once by AppShell (see BackNavContext).
  usePageBack("Back to policy", () => router.push(`/policies/${pid}`));

  if (loading) {
    return <div className="px-[clamp(20px,4vw,56px)] py-16 text-sm text-muted-foreground" aria-busy="true">Loading policy context…</div>;
  }

  if (loadError || !policy) {
    return (
      <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] py-10">
        <div role="alert" className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError ?? "Policy not found"}
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
          FNOL
        </span>
        <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
          File a carrier claim
        </h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          Against policy {policy.policy_number ?? policy.id} · {policy.venue_id}
        </p>
        <nav className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground" aria-label="Breadcrumb">
          <Link href="/policies" className="hover:text-foreground hover:underline">Policies</Link>
          <span aria-hidden>/</span>
          <Link href={`/policies/${pid}`} className="hover:text-foreground hover:underline">{policy.policy_number ?? policy.id}</Link>
          <span aria-hidden>/</span>
          <span aria-current="page" className="text-foreground">File FNOL</span>
        </nav>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* ── form ─────────────────────────────────────────────────────── */}
        <Card className="gap-6 p-6">
          <form id="fnol-form" className="flex flex-col gap-6" onSubmit={submit} noValidate>
            <fieldset className="flex flex-col gap-4 rounded-xl border border-border p-4">
              <legend className="px-1 text-sm font-semibold text-foreground">Loss details</legend>

              <label className="grid gap-2" data-field="coverage_line">
                <span className={labelCls}>Coverage line <span className="text-destructive" aria-hidden>*</span></span>
                <select
                  ref={firstFieldRef}
                  required
                  value={coverageLine}
                  onChange={(e) => { setCoverageLine(e.target.value); setErrors((s) => ({ ...s, coverage_line: undefined })); }}
                  onBlur={() => setErrors((s) => ({ ...s, ...validate() }))}
                  aria-invalid={!!errors.coverage_line}
                  aria-describedby={errors.coverage_line ? "err-coverage_line" : "hint-coverage_line"}
                  className={controlClass}
                >
                  <option value="">— Pick a coverage line —</option>
                  {policy.coverage_lines.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
                </select>
                <span id="hint-coverage_line" className={hintCls}>
                  The policy covers: {policy.coverage_lines.join(", ").toUpperCase()}.
                </span>
                {errors.coverage_line && <span id="err-coverage_line" role="alert" className={errCls}>{errors.coverage_line}</span>}
              </label>

              <label className="grid gap-2" data-field="date_of_loss">
                <span className={labelCls}>Date of loss <span className="text-destructive" aria-hidden>*</span></span>
                <input
                  type="date"
                  required
                  min={policy.effective_date}
                  max={policy.expiration_date}
                  value={dateOfLoss}
                  onChange={(e) => { setDateOfLoss(e.target.value); setErrors((s) => ({ ...s, date_of_loss: undefined })); }}
                  onBlur={() => setErrors((s) => ({ ...s, ...validate() }))}
                  aria-invalid={!!errors.date_of_loss}
                  aria-describedby={errors.date_of_loss ? "err-date_of_loss" : "hint-date_of_loss"}
                  className={controlClass}
                />
                <span id="hint-date_of_loss" className={hintCls}>
                  Must be within the policy term: {policy.effective_date} – {policy.expiration_date}.
                </span>
                {errors.date_of_loss && <span id="err-date_of_loss" role="alert" className={errCls}>{errors.date_of_loss}</span>}
              </label>
            </fieldset>

            <fieldset className="flex flex-col gap-4 rounded-xl border border-border p-4">
              <legend className="px-1 text-sm font-semibold text-foreground">Linkages (optional)</legend>

              <label className="grid gap-2">
                <span className={labelCls}>Originating incident</span>
                <input type="text" value={incidentId} onChange={(e) => setIncidentId(e.target.value)} placeholder="inc-… (paste from incident detail)" className={controlClass} />
                <span className={hintCls}>Optional — links the operator-reported incident that triggered this loss.</span>
              </label>

              <label className="grid gap-2">
                <span className={labelCls}>Origin proposal</span>
                <input type="text" value={proposalId} onChange={(e) => setProposalId(e.target.value)} placeholder="clp-… (paste from claim proposal)" className={controlClass} />
                <span className={hintCls}>Optional — links the ClaimProposal (operator recommendation) that became this FNOL.</span>
              </label>

              <label className="grid gap-2">
                <span className={labelCls}>Defense package</span>
                <input type="text" value={defensePackageId} onChange={(e) => setDefensePackageId(e.target.value)} placeholder="pkt-… (paste from underwriter detail)" className={controlClass} />
                <span className={hintCls}>Optional — links a frozen underwriting packet as this claim&apos;s defense story. You can attach later.</span>
              </label>
            </fieldset>

            <fieldset className="flex flex-col gap-4 rounded-xl border border-border p-4">
              <legend className="px-1">
                <button
                  type="button"
                  className="text-sm font-semibold text-foreground"
                  aria-expanded={showCarrierDetails}
                  onClick={() => setShowCarrierDetails((s) => !s)}
                >
                  Carrier contact {showCarrierDetails ? "▾" : "▸"}
                </button>
              </legend>

              {showCarrierDetails && (
                <>
                  <label className="grid gap-2">
                    <span className={labelCls}>Carrier claim number</span>
                    <input type="text" value={carrierClaimNumber} onChange={(e) => setCarrierClaimNumber(e.target.value)} placeholder="As issued by the carrier; often arrives later" className={controlClass} />
                  </label>

                  <label className="grid gap-2">
                    <span className={labelCls}>Adjuster name</span>
                    <input type="text" autoComplete="name" value={adjusterName} onChange={(e) => setAdjusterName(e.target.value)} className={controlClass} />
                  </label>

                  <label className="grid gap-2" data-field="adjuster_email">
                    <span className={labelCls}>Adjuster email</span>
                    <input
                      type="email"
                      autoComplete="email"
                      value={adjusterEmail}
                      onChange={(e) => { setAdjusterEmail(e.target.value); setErrors((s) => ({ ...s, adjuster_email: undefined })); }}
                      onBlur={() => setErrors((s) => ({ ...s, ...validate() }))}
                      aria-invalid={!!errors.adjuster_email}
                      aria-describedby={errors.adjuster_email ? "err-adjuster_email" : undefined}
                      className={controlClass}
                    />
                    {errors.adjuster_email && <span id="err-adjuster_email" role="alert" className={errCls}>{errors.adjuster_email}</span>}
                  </label>
                </>
              )}
            </fieldset>

            {submitError && (
              <div ref={errorSummaryRef} tabIndex={-1} role="alert" className="flex items-center gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <FileWarning size={14} aria-hidden /> {submitError}
              </div>
            )}
          </form>
        </Card>

        {/* ── action + summary ─────────────────────────────────────────── */}
        <Card className="h-fit gap-4 p-6 lg:sticky lg:top-6">
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm" className="flex-1 text-foreground">
              <Link href={`/policies/${pid}`}>Cancel</Link>
            </Button>
            <Button type="submit" form="fnol-form" size="sm" className="flex-1 border border-foreground/15" disabled={submitting}>
              {submitting ? "Filing…" : "File FNOL"}
            </Button>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Claim</div>
            <dl className="flex flex-col gap-1.5">
              <Row dt="Coverage" dd={coverageLine ? coverageLine.toUpperCase() : "—"} />
              <Row dt="Date of loss" dd={dateOfLoss || "—"} />
            </dl>
          </div>
          <div className="border-t border-border pt-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Against policy</div>
            <dl className="flex flex-col gap-1.5">
              <Row dt="Policy" dd={policy.policy_number ?? policy.id} />
              <Row dt="Venue" dd={policy.venue_id} />
              <Row dt="Coverage" dd={policy.coverage_lines.join(", ").toUpperCase()} />
              <Row dt="Term" dd={`${policy.effective_date} – ${policy.expiration_date}`} />
            </dl>
          </div>
        </Card>
      </div>
    </div>
  );
}
