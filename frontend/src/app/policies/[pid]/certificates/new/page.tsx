"use client";

/**
 * /policies/[pid]/certificates/new — issue a Certificate of Insurance.
 *
 * Toggle for additional_insured surfaces the scope dropdown (the ISO
 * endorsement form mapping). On success, redirects back to policy detail.
 */
import React, { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { PlacementApiError, formatCurrency } from "@/lib/placement";
import { Policy, policiesApi, matchHolder, type CertificateHolder } from "@/lib/policies";
import { toastSuccess } from "@/lib/toast";


export default function IssueCertificatePage() {
  const params = useParams<{ pid: string }>();
  const router = useRouter();
  const pid = params?.pid;

  const [policy, setPolicy] = useState<Policy | null>(null);
  const [holder, setHolder] = useState("");
  const [holderAddress, setHolderAddress] = useState("");
  const [description, setDescription] = useState("Operations of the named insured");
  const [expiresOn, setExpiresOn] = useState("");
  const [ai, setAi] = useState(false);
  const [aiScope, setAiScope] = useState<"ongoing_operations" | "completed_operations" | "single_event">("ongoing_operations");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Auto-fill: prior holders across the broker's book. Picking one pre-fills the
  // recurring fields and reuses the canonical spelling (so the new COI supersedes
  // the prior one instead of minting a duplicate). Edited fields aren't clobbered.
  const [holders, setHolders] = useState<CertificateHolder[]>([]);
  const [addressTouched, setAddressTouched] = useState(false);
  const [descTouched, setDescTouched] = useState(false);
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);

  useEffect(() => {
    if (!pid) return;
    policiesApi.getPolicy(pid).then(p => {
      setPolicy(p);
      // Default the COI expiration to the policy's own expiration date.
      setExpiresOn(p.expiration_date);
    }).catch(e => {
      setError(e instanceof PlacementApiError ? e.message : "Failed to load policy");
    });
  }, [pid]);

  useEffect(() => {
    policiesApi.listCertificateHolders().then(setHolders).catch(() => {});
  }, []);

  function onHolderChange(value: string) {
    setHolder(value);
    const m = matchHolder(holders, value);
    if (!m) { setPrefilledFrom(null); return; }
    if (!addressTouched) setHolderAddress(m.certificate_holder_address);
    if (!descTouched) setDescription(m.description_of_operations);
    setAi(m.additional_insured);
    if (m.additional_insured_scope) setAiScope(m.additional_insured_scope as typeof aiScope);
    setPrefilledFrom(m.certificate_holder);
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pid) return;
    setError(null);
    setBusy(true);
    try {
      await policiesApi.issueCertificate(pid, {
        certificate_holder: holder,
        certificate_holder_address: holderAddress,
        description_of_operations: description,
        expires_on: expiresOn,
        additional_insured: ai,
        additional_insured_scope: ai ? aiScope : null,
      });
      toastSuccess(`Certificate issued${holder.trim() ? ` — for ${holder.trim()}` : ""}`);
      router.push(`/policies/${pid}`);
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "COI failed");
      setBusy(false);
    }
  };

  return (
    <div className="submission-wizard submission-wizard--wide">
      <PageHeader
        eyebrow="Policy"
        title="Issue Certificate of Insurance"
        subtitle={
          policy
            ? `For policy ${policy.policy_number ?? policy.id} · ${policy.venue_id}`
            : "Loading policy…"
        }
      />

      <div className="form-shell">
      <form id="coi-form" className="submission-wizard__form" onSubmit={submit}>
        {error && <div className="submission-wizard__error">{error}</div>}

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Certificate Holder</label>
          <input
            className="input-field"
            value={holder}
            onChange={e => onHolderChange(e.target.value)}
            placeholder="599 Johnson LLC"
            list="coi-holders"
            autoComplete="off"
            required
          />
          {holders.length > 0 && (
            <datalist id="coi-holders">
              {holders.map(h => (
                <option key={h.certificate_holder} value={h.certificate_holder} />
              ))}
            </datalist>
          )}
          {prefilledFrom && (
            <span className="text-xs text-secondary" style={{ marginTop: 4 }}>
              Pre-filled from a prior certificate to {prefilledFrom} — edit any field to override.
            </span>
          )}
        </div>

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Holder Address</label>
          <input
            className="input-field"
            value={holderAddress}
            onChange={e => { setHolderAddress(e.target.value); setAddressTouched(true); }}
            placeholder="599 Johnson Ave, Brooklyn, NY 11237"
            required
          />
        </div>

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Description of Operations</label>
          <textarea
            className="input-field"
            rows={2}
            value={description}
            onChange={e => { setDescription(e.target.value); setDescTouched(true); }}
            required
          />
        </div>

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Expires On</label>
          <input
            type="date"
            className="input-field"
            value={expiresOn}
            onChange={e => setExpiresOn(e.target.value)}
            required
          />
        </div>

        <div className="submission-wizard__field">
          <label
            className="submission-wizard__coverage-chip"
            style={{ width: "fit-content" }}
          >
            <input
              type="checkbox"
              checked={ai}
              onChange={e => setAi(e.target.checked)}
            />
            <span className="submission-wizard__coverage-chip-name">
              Add holder as Additional Insured
            </span>
          </label>
        </div>

        {ai && (
          <div className="submission-wizard__field">
            <label className="submission-wizard__label">
              Additional Insured Scope (ISO endorsement form)
            </label>
            <select
              className="input-field"
              value={aiScope}
              onChange={e => setAiScope(e.target.value as typeof aiScope)}
            >
              <option value="ongoing_operations">Ongoing Operations (CG 20 10)</option>
              <option value="completed_operations">Completed Operations (CG 20 26)</option>
              <option value="single_event">Single Event (CG 20 37)</option>
            </select>
          </div>
        )}

      </form>

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
          <button type="submit" form="coi-form" className="btn btn-primary btn-sm" disabled={busy}>
            {busy ? "Issuing…" : "Issue Certificate"}
          </button>
        </div>
        <div className="form-summary__title">Certificate</div>
        <dl style={{ margin: 0 }}>
          <div className="form-summary__row"><dt>Holder</dt><dd>{holder.trim() || "—"}</dd></div>
          <div className="form-summary__row"><dt>Expires</dt><dd>{expiresOn || "—"}</dd></div>
          <div className="form-summary__row"><dt>Add&apos;l insured</dt><dd>{ai ? aiScope.replace(/_/g, " ") : "No"}</dd></div>
        </dl>
        {policy && (
          <div className="form-summary__section">
            <div className="form-summary__title">Current policy</div>
            <dl style={{ margin: 0 }}>
              <div className="form-summary__row"><dt>Policy</dt><dd>{policy.policy_number || policy.id}</dd></div>
              <div className="form-summary__row"><dt>Venue</dt><dd>{policy.venue_id}</dd></div>
              <div className="form-summary__row"><dt>Coverage</dt><dd>{policy.coverage_lines.length ? policy.coverage_lines.join(", ") : "—"}</dd></div>
              <div className="form-summary__row"><dt>Premium</dt><dd>{formatCurrency(policy.annual_premium)}</dd></div>
              <div className="form-summary__row"><dt>Expires</dt><dd>{policy.expiration_date}</dd></div>
            </dl>
          </div>
        )}
      </aside>
      </div>
    </div>
  );
}
