"use client";

/**
 * /policies/[pid]/endorse — new endorsement form.
 *
 * The endorsement_type dropdown drives which payload-specific fields
 * appear. Each combination maps to one of the Pydantic shapes in
 * app/schemas/policy.py. The backend re-validates on POST; this form
 * provides the right UX scaffolding per type so the broker doesn't have
 * to remember which fields each type needs.
 *
 * "Paper & Ink" — migrated to ds/ primitives via a local Field helper;
 * explicit colours on every text element. PageHeader replaced inline.
 */
import React, { useState, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { PlacementApiError, formatCurrency } from "@/lib/placement";
import { policiesApi, PolicyDetail } from "@/lib/policies";
import { toastSuccess } from "@/lib/toast";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Input } from "@/components/ds/input";
import { Label } from "@/components/ds/label";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;

// Field chrome for the <select>s (matches the ds/ Input look).
const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50";

// Label + control + optional hint, the repeated unit of this form.
function Field({ label, hint, children }: { label: string; hint?: string | null; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label className="text-foreground">{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Row({ dt, dd }: { dt: string; dd: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{dt}</dt>
      <dd className="text-right font-medium text-foreground">{dd}</dd>
    </div>
  );
}

type EndorsementType =
  | "change_limit"
  | "add_insured"
  | "add_coverage"
  | "remove_coverage"
  | "add_location"
  | "change_class"
  | "correction";

const ENDORSEMENT_TYPES: ReadonlySet<string> = new Set<EndorsementType>([
  "change_limit", "add_insured", "add_coverage", "remove_coverage",
  "add_location", "change_class", "correction",
]);

const ENDORSEMENT_TYPE_LABEL: Record<EndorsementType, string> = {
  change_limit: "Change Limit",
  add_insured: "Add Insured",
  add_coverage: "Add Coverage Line",
  remove_coverage: "Remove Coverage Line",
  add_location: "Add Location",
  change_class: "Change Class",
  correction: "Correction",
};

// Friendly names so a broker reads "Workers' Comp", not the raw id "wc".
const COVERAGE_LINE_LABEL: Record<string, string> = {
  gl: "General Liability",
  liquor: "Liquor Liability",
  assault_battery: "Assault & Battery",
  property: "Property",
  wc: "Workers' Comp",
  epli: "Employment Practices (EPLI)",
  cyber: "Cyber",
  umbrella: "Umbrella",
};

// "$1,000,000" preview for a raw numeric string (null when not a number).
function fmtMoney(v: string): string | null {
  const n = Number(v);
  if (!v.trim() || Number.isNaN(n)) return null;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}


export default function EndorsePage() {
  const params = useParams<{ pid: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const pid = params?.pid;

  const [endorsementType, setEndorsementType] = useState<EndorsementType>("change_limit");
  const [effectiveDate, setEffectiveDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [description, setDescription] = useState("");
  const [premiumChange, setPremiumChange] = useState("0.00");
  const [taxChange, setTaxChange] = useState("0.00");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<PolicyDetail | null>(null);

  // Per-type fields.
  const [coverageLine, setCoverageLine] = useState("gl");
  const [limitField, setLimitField] = useState<"per_occurrence" | "aggregate" | "deductible">("per_occurrence");
  const [limitBefore, setLimitBefore] = useState("1000000");
  const [limitAfter, setLimitAfter] = useState("2000000");
  const [insuredName, setInsuredName] = useState("");
  const [insuredAddress, setInsuredAddress] = useState("");
  const [relationship, setRelationship] = useState("landlord");
  const [aiScope, setAiScope] = useState<"ongoing_operations" | "completed_operations" | "single_event">("ongoing_operations");
  const [perOccLimit, setPerOccLimit] = useState("1000000");
  const [aggLimit, setAggLimit] = useState("2000000");
  const [deductible, setDeductible] = useState("2500");
  const [reason, setReason] = useState("");
  const [locationName, setLocationName] = useState("");
  const [locationAddress, setLocationAddress] = useState("");
  const [venueType, setVenueType] = useState("music_venue");
  const [beforeClass, setBeforeClass] = useState("");
  const [afterClass, setAfterClass] = useState("");
  const [fieldCorrected, setFieldCorrected] = useState("");
  const [valueBefore, setValueBefore] = useState("");
  const [valueAfter, setValueAfter] = useState("");
  const [explanation, setExplanation] = useState("");

  // Deep-link support: a finding CTA (e.g. coverage_gap_eo) can pre-select the
  // endorsement type and pre-fill the coverage line via query params so the
  // broker lands on exactly the action the card promised. Run once on mount.
  useEffect(() => {
    const t = search.get("type");
    if (t && ENDORSEMENT_TYPES.has(t)) setEndorsementType(t as EndorsementType);
    const cl = search.get("coverage_line");
    if (cl) setCoverageLine(cl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arrived from the coverage_gap_eo card → show why we're here, so the broker
  // can confirm the pre-filled line and submit without second-guessing.
  const isCoverageGap =
    search.get("type") === "add_coverage" && !!search.get("coverage_line");

  // Load the policy being endorsed so the right rail can show its context
  // (what's currently in force). Tolerates a missing policy (stale link).
  useEffect(() => {
    if (!pid) return;
    let cancelled = false;
    policiesApi.getPolicy(pid).then(
      (p) => { if (!cancelled) setPolicy(p); },
      () => { /* form still works; context panel just stays empty */ },
    );
    return () => { cancelled = true; };
  }, [pid]);

  const buildTermsDiff = (): Record<string, unknown> => {
    switch (endorsementType) {
      case "change_limit":
        return { coverage_line: coverageLine, field: limitField, before: limitBefore, after: limitAfter };
      case "add_insured":
        return { insured_name: insuredName, insured_address: insuredAddress, relationship, scope: aiScope };
      case "add_coverage":
        return { coverage_line: coverageLine, per_occurrence_limit: perOccLimit, aggregate_limit: aggLimit || null, deductible: deductible };
      case "remove_coverage":
        return { coverage_line: coverageLine, reason };
      case "add_location":
        return { location_name: locationName, location_address: locationAddress, venue_type: venueType };
      case "change_class":
        return { coverage_line: coverageLine, before_class: beforeClass, after_class: afterClass, reason };
      case "correction":
        return { field_corrected: fieldCorrected, before: valueBefore, after: valueAfter, explanation };
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pid) return;
    setError(null);
    setBusy(true);
    try {
      await policiesApi.issueEndorsement(pid, {
        endorsement_type: endorsementType,
        effective_date: effectiveDate,
        terms_diff: buildTermsDiff(),
        premium_change: premiumChange || "0.00",
        tax_change: taxChange || "0.00",
        description: description.trim(),
      });
      const lineLabel = COVERAGE_LINE_LABEL[coverageLine] ?? coverageLine;
      toastSuccess(
        isCoverageGap ? `Coverage gap closed — ${lineLabel} added` : "Endorsement issued",
      );
      router.push(isCoverageGap ? "/dashboard" : `/policies/${pid}`);
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Endorsement failed");
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <section className="py-10">
        <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-[#5A6E00]">
          <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
          Policy
        </span>
        <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
          New endorsement
        </h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          Mid-term change. Re-hashes the policy snapshot.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* ── form ─────────────────────────────────────────────────────── */}
        <Card className="gap-4 p-6">
          <form id="endorse-form" className="flex flex-col gap-4" onSubmit={submit}>
            {isCoverageGap && (
              <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
                Closing coverage gap — adding required line{" "}
                <strong className="font-semibold">{COVERAGE_LINE_LABEL[coverageLine] ?? coverageLine}</strong> to this policy.
              </div>
            )}
            {error && (
              <div role="alert" className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <Field label="Endorsement Type">
              <select className={selectClass} value={endorsementType} onChange={e => setEndorsementType(e.target.value as EndorsementType)}>
                <option value="change_limit">Change Limit</option>
                <option value="add_insured">Add Insured (additional insured)</option>
                <option value="add_coverage">Add Coverage Line</option>
                <option value="remove_coverage">Remove Coverage Line</option>
                <option value="add_location">Add Location</option>
                <option value="change_class">Change Class</option>
                <option value="correction">Correction</option>
              </select>
            </Field>

            <Field label="Effective Date">
              <Input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} required />
            </Field>

            {endorsementType === "change_limit" && (
              <>
                <Field label="Coverage Line"><Input value={coverageLine} onChange={e => setCoverageLine(e.target.value)} /></Field>
                <Field label="Field">
                  <select className={selectClass} value={limitField} onChange={e => setLimitField(e.target.value as typeof limitField)}>
                    <option value="per_occurrence">Per Occurrence</option>
                    <option value="aggregate">Aggregate</option>
                    <option value="deductible">Deductible</option>
                  </select>
                </Field>
                <Field label="Before"><Input value={limitBefore} onChange={e => setLimitBefore(e.target.value)} /></Field>
                <Field label="After"><Input value={limitAfter} onChange={e => setLimitAfter(e.target.value)} /></Field>
              </>
            )}

            {endorsementType === "add_insured" && (
              <>
                <Field label="Insured Name"><Input value={insuredName} onChange={e => setInsuredName(e.target.value)} required /></Field>
                <Field label="Insured Address"><Input value={insuredAddress} onChange={e => setInsuredAddress(e.target.value)} required /></Field>
                <Field label="Relationship">
                  <select className={selectClass} value={relationship} onChange={e => setRelationship(e.target.value)}>
                    <option value="landlord">Landlord</option>
                    <option value="event_client">Event Client</option>
                    <option value="contract_counterparty">Contract Counterparty</option>
                  </select>
                </Field>
                <Field label="Scope (ISO CG endorsement form)">
                  <select className={selectClass} value={aiScope} onChange={e => setAiScope(e.target.value as typeof aiScope)}>
                    <option value="ongoing_operations">Ongoing Operations (CG 20 10)</option>
                    <option value="completed_operations">Completed Operations (CG 20 26)</option>
                    <option value="single_event">Single Event (CG 20 37)</option>
                  </select>
                </Field>
              </>
            )}

            {endorsementType === "add_coverage" && (
              <>
                <Field label="Coverage Line" hint={COVERAGE_LINE_LABEL[coverageLine]}>
                  <Input value={coverageLine} onChange={e => setCoverageLine(e.target.value)} />
                </Field>
                <Field label="Per-Occurrence Limit" hint={fmtMoney(perOccLimit)}>
                  <Input value={perOccLimit} onChange={e => setPerOccLimit(e.target.value)} />
                </Field>
                <Field label="Aggregate Limit (blank for property)" hint={fmtMoney(aggLimit)}>
                  <Input value={aggLimit} onChange={e => setAggLimit(e.target.value)} />
                </Field>
                <Field label="Deductible" hint={fmtMoney(deductible)}>
                  <Input value={deductible} onChange={e => setDeductible(e.target.value)} />
                </Field>
              </>
            )}

            {endorsementType === "remove_coverage" && (
              <>
                <Field label="Coverage Line"><Input value={coverageLine} onChange={e => setCoverageLine(e.target.value)} /></Field>
                <Field label="Reason"><Input value={reason} onChange={e => setReason(e.target.value)} required /></Field>
              </>
            )}

            {endorsementType === "add_location" && (
              <>
                <Field label="Location Name"><Input value={locationName} onChange={e => setLocationName(e.target.value)} required /></Field>
                <Field label="Address"><Input value={locationAddress} onChange={e => setLocationAddress(e.target.value)} required /></Field>
                <Field label="Venue Type"><Input value={venueType} onChange={e => setVenueType(e.target.value)} /></Field>
              </>
            )}

            {endorsementType === "change_class" && (
              <>
                <Field label="Coverage Line"><Input value={coverageLine} onChange={e => setCoverageLine(e.target.value)} /></Field>
                <Field label="Before Class"><Input value={beforeClass} onChange={e => setBeforeClass(e.target.value)} required /></Field>
                <Field label="After Class"><Input value={afterClass} onChange={e => setAfterClass(e.target.value)} required /></Field>
                <Field label="Reason"><Input value={reason} onChange={e => setReason(e.target.value)} required /></Field>
              </>
            )}

            {endorsementType === "correction" && (
              <>
                <Field label="Field Corrected"><Input value={fieldCorrected} onChange={e => setFieldCorrected(e.target.value)} required /></Field>
                <Field label="Before"><Input value={valueBefore} onChange={e => setValueBefore(e.target.value)} required /></Field>
                <Field label="After"><Input value={valueAfter} onChange={e => setValueAfter(e.target.value)} required /></Field>
                <Field label="Explanation"><Input value={explanation} onChange={e => setExplanation(e.target.value)} required /></Field>
              </>
            )}

            {/* Premium / tax / description tucked behind a disclosure. */}
            <details className="rounded-md border border-border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-foreground">
                Advanced — premium, tax, description
              </summary>
              <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
                <Field label="Premium Change ($)">
                  <Input type="text" value={premiumChange} onChange={e => setPremiumChange(e.target.value)} placeholder="0.00 (signed; negative for refund)" />
                </Field>
                <Field label="Tax Change ($) — E&S only">
                  <Input type="text" value={taxChange} onChange={e => setTaxChange(e.target.value)} placeholder="0.00" />
                </Field>
                <Field label="Description">
                  <Input type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder="Short description for the audit trail" />
                </Field>
              </div>
            </details>
          </form>
        </Card>

        {/* ── action + live summary ────────────────────────────────────── */}
        <Card className="h-fit gap-4 p-6 lg:sticky lg:top-6">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="flex-1 text-foreground" onClick={() => router.push(`/policies/${pid}`)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="endorse-form" size="sm" className="flex-1 border border-foreground/15" disabled={busy}>
              {busy ? "Issuing…" : "Issue Endorsement"}
            </Button>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</div>
            <dl className="flex flex-col gap-1.5">
              <Row dt="Type" dd={ENDORSEMENT_TYPE_LABEL[endorsementType]} />
              <Row dt="Effective" dd={effectiveDate} />
              {["add_coverage", "remove_coverage", "change_limit", "change_class"].includes(endorsementType) && (
                <Row dt="Line" dd={COVERAGE_LINE_LABEL[coverageLine] ?? coverageLine} />
              )}
              {endorsementType === "add_coverage" && (
                <>
                  <Row dt="Per-occ" dd={fmtMoney(perOccLimit) ?? "—"} />
                  <Row dt="Aggregate" dd={fmtMoney(aggLimit) ?? "—"} />
                  <Row dt="Deductible" dd={fmtMoney(deductible) ?? "—"} />
                </>
              )}
              {fmtMoney(premiumChange) && Number(premiumChange) !== 0 && (
                <Row dt="Premium Δ" dd={fmtMoney(premiumChange)} />
              )}
            </dl>
          </div>
          {policy && (
            <div className="border-t border-border pt-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current policy</div>
              <dl className="flex flex-col gap-1.5">
                <Row dt="Policy" dd={policy.policy_number || policy.id} />
                <Row dt="Venue" dd={policy.venue_id} />
                <Row dt="Carrier" dd={policy.carrier_id} />
                <Row dt="Coverage" dd={policy.coverage_lines.length ? policy.coverage_lines.join(", ") : "—"} />
                <Row dt="Premium" dd={formatCurrency(policy.annual_premium)} />
                <Row dt="Expires" dd={policy.expiration_date} />
              </dl>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Issuing re-hashes the policy snapshot for the audit trail.
          </p>
        </Card>
      </div>
    </div>
  );
}
