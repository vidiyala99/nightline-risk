"use client";

import { useState } from "react";

import { ActionModal } from "@/components/claims/ActionModal";
import {
  PolicyRequestType,
  REQUEST_TYPE_LABEL,
  policyRequestsApi,
  type CoveragePolicy,
} from "@/lib/policyRequests";
import { PlacementApiError } from "@/lib/placement";

const REQUEST_TYPES: PolicyRequestType[] = [
  "renewal",
  "cancellation",
  "coi",
  "coverage_change",
];

/** One-line hint per type so operators know what they're asking for. */
const TYPE_HINT: Record<PolicyRequestType, string> = {
  renewal: "Ask your broker to re-quote this policy before it expires.",
  cancellation: "Request to end this policy early. Your broker confirms terms.",
  coi: "Request a certificate of insurance for a landlord, venue, or vendor.",
  coverage_change: "Ask to adjust limits, add a location, or change coverage.",
};

interface Props {
  policy: CoveragePolicy;
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}

/**
 * Operator-facing "Request action" form, rendered inside the shared
 * ActionModal shell. Collects a request type + a note, plus one
 * type-specific field (cancellation date / certificate holder) folded
 * into `payload`. The broker sees the result in their queue.
 */
export function PolicyRequestModal({ policy, open, onClose, onSubmitted }: Props) {
  const [type, setType] = useState<PolicyRequestType>("renewal");
  const [note, setNote] = useState("");
  const [cancellationDate, setCancellationDate] = useState("");
  const [certificateHolder, setCertificateHolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = note.trim() !== "" || cancellationDate !== "" || certificateHolder !== "";

  function reset() {
    setType("renewal");
    setNote("");
    setCancellationDate("");
    setCertificateHolder("");
    setError(null);
  }

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    const payload: Record<string, unknown> = {};
    if (type === "cancellation" && cancellationDate) payload.cancellation_date = cancellationDate;
    if (type === "coi" && certificateHolder.trim()) payload.certificate_holder = certificateHolder.trim();
    try {
      await policyRequestsApi.create(policy.id, { request_type: type, note: note.trim(), payload });
      reset();
      onSubmitted();
      onClose();
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Could not submit your request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionModal
      open={open}
      title="Request an action"
      subtitle={policy.policy_number ?? policy.id}
      onClose={onClose}
      busy={busy}
      guardDismiss={dirty}
    >
      <div className="preq-form">
        <label className="preq-field">
          <span className="preq-field__label">What do you need?</span>
          <select
            className="preq-field__control"
            value={type}
            onChange={(e) => setType(e.target.value as PolicyRequestType)}
            disabled={busy}
          >
            {REQUEST_TYPES.map((t) => (
              <option key={t} value={t}>{REQUEST_TYPE_LABEL[t]}</option>
            ))}
          </select>
          <span className="preq-field__hint">{TYPE_HINT[type]}</span>
        </label>

        {type === "cancellation" && (
          <label className="preq-field">
            <span className="preq-field__label">Preferred cancellation date</span>
            <input
              type="date"
              className="preq-field__control"
              value={cancellationDate}
              onChange={(e) => setCancellationDate(e.target.value)}
              disabled={busy}
            />
          </label>
        )}

        {type === "coi" && (
          <label className="preq-field">
            <span className="preq-field__label">Certificate holder</span>
            <input
              type="text"
              className="preq-field__control"
              placeholder="e.g. 123 Property LLC"
              value={certificateHolder}
              onChange={(e) => setCertificateHolder(e.target.value)}
              disabled={busy}
            />
          </label>
        )}

        <label className="preq-field">
          <span className="preq-field__label">
            Note <span className="preq-field__optional">(optional)</span>
          </span>
          <textarea
            className="preq-field__control preq-field__control--area"
            rows={3}
            placeholder="Anything your broker should know…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && (
          <p className="preq-form__error" role="alert">{error}</p>
        )}

        <div className="preq-form__actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleSubmit} disabled={busy}>
            {busy ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>
    </ActionModal>
  );
}
