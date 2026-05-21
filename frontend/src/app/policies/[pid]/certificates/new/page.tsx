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
import { PlacementApiError } from "@/lib/placement";
import { Policy, policiesApi } from "@/lib/policies";


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
      router.push(`/policies/${pid}`);
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "COI failed");
      setBusy(false);
    }
  };

  return (
    <div className="submission-wizard">
      <PageHeader
        eyebrow="Policy"
        title="Issue Certificate of Insurance"
        subtitle={
          policy
            ? `For policy ${policy.policy_number ?? policy.id} · ${policy.venue_id}`
            : "Loading policy…"
        }
      />

      <form className="submission-wizard__form" onSubmit={submit}>
        {error && <div className="submission-wizard__error">{error}</div>}

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Certificate Holder</label>
          <input
            className="input-field"
            value={holder}
            onChange={e => setHolder(e.target.value)}
            placeholder="599 Johnson LLC"
            required
          />
        </div>

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Holder Address</label>
          <input
            className="input-field"
            value={holderAddress}
            onChange={e => setHolderAddress(e.target.value)}
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
            onChange={e => setDescription(e.target.value)}
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

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => router.push(`/policies/${pid}`)}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            {busy ? "Issuing…" : "Issue Certificate"}
          </button>
        </div>
      </form>
    </div>
  );
}
