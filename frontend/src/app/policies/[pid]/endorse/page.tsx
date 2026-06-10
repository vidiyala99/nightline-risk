"use client";

/**
 * /policies/[pid]/endorse — new endorsement form.
 *
 * The endorsement_type dropdown drives which payload-specific fields
 * appear. Each combination maps to one of the Pydantic shapes in
 * app/schemas/policy.py. The backend re-validates on POST; this form
 * provides the right UX scaffolding per type so the broker doesn't have
 * to remember which fields each type needs.
 */
import React, { useState, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { PlacementApiError, formatCurrency } from "@/lib/placement";
import { policiesApi, PolicyDetail } from "@/lib/policies";


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
  // (what's currently in force) — fills the width with information, not stretched
  // fields. Tolerates a missing policy (stale link) without blocking the form.
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
        return {
          coverage_line: coverageLine,
          field: limitField,
          before: limitBefore,
          after: limitAfter,
        };
      case "add_insured":
        return {
          insured_name: insuredName,
          insured_address: insuredAddress,
          relationship,
          scope: aiScope,
        };
      case "add_coverage":
        return {
          coverage_line: coverageLine,
          per_occurrence_limit: perOccLimit,
          aggregate_limit: aggLimit || null,
          deductible: deductible,
        };
      case "remove_coverage":
        return {
          coverage_line: coverageLine,
          reason,
        };
      case "add_location":
        return {
          location_name: locationName,
          location_address: locationAddress,
          venue_type: venueType,
        };
      case "change_class":
        return {
          coverage_line: coverageLine,
          before_class: beforeClass,
          after_class: afterClass,
          reason,
        };
      case "correction":
        return {
          field_corrected: fieldCorrected,
          before: valueBefore,
          after: valueAfter,
          explanation,
        };
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
      router.push(`/policies/${pid}`);
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Endorsement failed");
      setBusy(false);
    }
  };

  return (
    <div className="submission-wizard">
      <PageHeader
        eyebrow="Policy"
        title="New Endorsement"
        subtitle="Mid-term change. Re-hashes the policy snapshot."
      />

      <div className="form-shell">
      <form id="endorse-form" className="submission-wizard__form" onSubmit={submit}>
        {isCoverageGap && (
          <div className="endorse-context">
            Closing coverage gap — adding required line{" "}
            <strong>{COVERAGE_LINE_LABEL[coverageLine] ?? coverageLine}</strong> to this policy.
          </div>
        )}
        {error && <div className="submission-wizard__error">{error}</div>}

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Endorsement Type</label>
          <select
            className="input-field"
            value={endorsementType}
            onChange={e => setEndorsementType(e.target.value as EndorsementType)}
          >
            <option value="change_limit">Change Limit</option>
            <option value="add_insured">Add Insured (additional insured)</option>
            <option value="add_coverage">Add Coverage Line</option>
            <option value="remove_coverage">Remove Coverage Line</option>
            <option value="add_location">Add Location</option>
            <option value="change_class">Change Class</option>
            <option value="correction">Correction</option>
          </select>
        </div>

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Effective Date</label>
          <input
            type="date"
            className="input-field"
            value={effectiveDate}
            onChange={e => setEffectiveDate(e.target.value)}
            required
          />
        </div>

        {/* Per-type field blocks */}
        {endorsementType === "change_limit" && (
          <>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Coverage Line</label>
              <input className="input-field" value={coverageLine} onChange={e => setCoverageLine(e.target.value)} />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Field</label>
              <select className="input-field" value={limitField} onChange={e => setLimitField(e.target.value as typeof limitField)}>
                <option value="per_occurrence">Per Occurrence</option>
                <option value="aggregate">Aggregate</option>
                <option value="deductible">Deductible</option>
              </select>
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Before</label>
              <input className="input-field" value={limitBefore} onChange={e => setLimitBefore(e.target.value)} />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">After</label>
              <input className="input-field" value={limitAfter} onChange={e => setLimitAfter(e.target.value)} />
            </div>
          </>
        )}

        {endorsementType === "add_insured" && (
          <>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Insured Name</label>
              <input className="input-field" value={insuredName} onChange={e => setInsuredName(e.target.value)} required />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Insured Address</label>
              <input className="input-field" value={insuredAddress} onChange={e => setInsuredAddress(e.target.value)} required />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Relationship</label>
              <select className="input-field" value={relationship} onChange={e => setRelationship(e.target.value)}>
                <option value="landlord">Landlord</option>
                <option value="event_client">Event Client</option>
                <option value="contract_counterparty">Contract Counterparty</option>
              </select>
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Scope (ISO CG endorsement form)</label>
              <select className="input-field" value={aiScope} onChange={e => setAiScope(e.target.value as typeof aiScope)}>
                <option value="ongoing_operations">Ongoing Operations (CG 20 10)</option>
                <option value="completed_operations">Completed Operations (CG 20 26)</option>
                <option value="single_event">Single Event (CG 20 37)</option>
              </select>
            </div>
          </>
        )}

        {endorsementType === "add_coverage" && (
          <>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Coverage Line</label>
              <input className="input-field" value={coverageLine} onChange={e => setCoverageLine(e.target.value)} />
              {COVERAGE_LINE_LABEL[coverageLine] && (
                <span className="endorse-hint">{COVERAGE_LINE_LABEL[coverageLine]}</span>
              )}
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Per-Occurrence Limit</label>
              <input className="input-field" value={perOccLimit} onChange={e => setPerOccLimit(e.target.value)} />
              {fmtMoney(perOccLimit) && <span className="endorse-hint">{fmtMoney(perOccLimit)}</span>}
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Aggregate Limit (blank for property)</label>
              <input className="input-field" value={aggLimit} onChange={e => setAggLimit(e.target.value)} />
              {fmtMoney(aggLimit) && <span className="endorse-hint">{fmtMoney(aggLimit)}</span>}
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Deductible</label>
              <input className="input-field" value={deductible} onChange={e => setDeductible(e.target.value)} />
              {fmtMoney(deductible) && <span className="endorse-hint">{fmtMoney(deductible)}</span>}
            </div>
          </>
        )}

        {endorsementType === "remove_coverage" && (
          <>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Coverage Line</label>
              <input className="input-field" value={coverageLine} onChange={e => setCoverageLine(e.target.value)} />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Reason</label>
              <input className="input-field" value={reason} onChange={e => setReason(e.target.value)} required />
            </div>
          </>
        )}

        {endorsementType === "add_location" && (
          <>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Location Name</label>
              <input className="input-field" value={locationName} onChange={e => setLocationName(e.target.value)} required />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Address</label>
              <input className="input-field" value={locationAddress} onChange={e => setLocationAddress(e.target.value)} required />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Venue Type</label>
              <input className="input-field" value={venueType} onChange={e => setVenueType(e.target.value)} />
            </div>
          </>
        )}

        {endorsementType === "change_class" && (
          <>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Coverage Line</label>
              <input className="input-field" value={coverageLine} onChange={e => setCoverageLine(e.target.value)} />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Before Class</label>
              <input className="input-field" value={beforeClass} onChange={e => setBeforeClass(e.target.value)} required />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">After Class</label>
              <input className="input-field" value={afterClass} onChange={e => setAfterClass(e.target.value)} required />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Reason</label>
              <input className="input-field" value={reason} onChange={e => setReason(e.target.value)} required />
            </div>
          </>
        )}

        {endorsementType === "correction" && (
          <>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Field Corrected</label>
              <input className="input-field" value={fieldCorrected} onChange={e => setFieldCorrected(e.target.value)} required />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Before</label>
              <input className="input-field" value={valueBefore} onChange={e => setValueBefore(e.target.value)} required />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">After</label>
              <input className="input-field" value={valueAfter} onChange={e => setValueAfter(e.target.value)} required />
            </div>
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Explanation</label>
              <input className="input-field" value={explanation} onChange={e => setExplanation(e.target.value)} required />
            </div>
          </>
        )}

        {/* Premium / tax / description are usually left at defaults for a
            pre-filled flow (e.g. closing a coverage gap) — tuck them behind a
            disclosure so the form is short for the common case. */}
        <details className="endorse-advanced">
          <summary className="endorse-advanced__summary">
            Advanced — premium, tax, description
          </summary>
          <div className="endorse-advanced__body">
            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Premium Change ($)</label>
              <input
                type="text"
                className="input-field"
                value={premiumChange}
                onChange={e => setPremiumChange(e.target.value)}
                placeholder="0.00 (signed; negative for refund)"
              />
            </div>

            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Tax Change ($) — E&S only</label>
              <input
                type="text"
                className="input-field"
                value={taxChange}
                onChange={e => setTaxChange(e.target.value)}
                placeholder="0.00"
              />
            </div>

            <div className="submission-wizard__field">
              <label className="submission-wizard__label">Description</label>
              <input
                type="text"
                className="input-field"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Short description for the audit trail"
              />
            </div>
          </div>
        </details>

      </form>

      {/* Right pane = action + live summary. Actions sit at the top (sticky, so
          always in view while the broker fills the form on the left); the
          summary confirms what they're about to issue, just below. */}
      <aside className="form-summary">
        <div className="form-summary__actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => router.push(`/policies/${pid}`)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="endorse-form"
            className="btn btn-primary btn-sm"
            disabled={busy}
          >
            {busy ? "Issuing…" : "Issue Endorsement"}
          </button>
        </div>
        <div className="form-summary__title">Summary</div>
        <dl style={{ margin: 0 }}>
          <div className="form-summary__row"><dt>Type</dt><dd>{ENDORSEMENT_TYPE_LABEL[endorsementType]}</dd></div>
          <div className="form-summary__row"><dt>Effective</dt><dd>{effectiveDate}</dd></div>
          {["add_coverage", "remove_coverage", "change_limit", "change_class"].includes(endorsementType) && (
            <div className="form-summary__row"><dt>Line</dt><dd>{COVERAGE_LINE_LABEL[coverageLine] ?? coverageLine}</dd></div>
          )}
          {endorsementType === "add_coverage" && (
            <>
              <div className="form-summary__row"><dt>Per-occ</dt><dd>{fmtMoney(perOccLimit) ?? "—"}</dd></div>
              <div className="form-summary__row"><dt>Aggregate</dt><dd>{fmtMoney(aggLimit) ?? "—"}</dd></div>
              <div className="form-summary__row"><dt>Deductible</dt><dd>{fmtMoney(deductible) ?? "—"}</dd></div>
            </>
          )}
          {fmtMoney(premiumChange) && Number(premiumChange) !== 0 && (
            <div className="form-summary__row"><dt>Premium Δ</dt><dd>{fmtMoney(premiumChange)}</dd></div>
          )}
        </dl>
        {policy && (
          <div className="form-summary__section">
            <div className="form-summary__title">Current policy</div>
            <dl style={{ margin: 0 }}>
              <div className="form-summary__row"><dt>Policy</dt><dd>{policy.policy_number || policy.id}</dd></div>
              <div className="form-summary__row"><dt>Venue</dt><dd>{policy.venue_id}</dd></div>
              <div className="form-summary__row"><dt>Carrier</dt><dd>{policy.carrier_id}</dd></div>
              <div className="form-summary__row"><dt>Coverage</dt><dd>{policy.coverage_lines.length ? policy.coverage_lines.join(", ") : "—"}</dd></div>
              <div className="form-summary__row"><dt>Premium</dt><dd>{formatCurrency(policy.annual_premium)}</dd></div>
              <div className="form-summary__row"><dt>Expires</dt><dd>{policy.expiration_date}</dd></div>
            </dl>
          </div>
        )}
        <div className="form-summary__note">
          Issuing re-hashes the policy snapshot for the audit trail.
        </div>
      </aside>
      </div>
    </div>
  );
}
