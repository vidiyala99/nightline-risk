"use client";

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

/**
 * The four structured override reasons mirror the vocabulary fixed in the
 * backend (`ALLOWED_OVERRIDE_REASONS` in `app/claim_proposals.py`). Keeping
 * the labels here in sync with that frozenset is a manual contract — if a
 * fifth reason ever lands, both files must change together.
 */
export type OverrideReason =
  | "additional_evidence"
  | "legal_counsel"
  | "prior_pattern"
  | "other";

const REASON_LABELS: Record<OverrideReason, { title: string; hint: string }> = {
  additional_evidence: {
    title: "Additional evidence available",
    hint: "You have evidence the recommender didn't see (CCTV, witness statement, medical report).",
  },
  legal_counsel: {
    title: "Legal counsel advised filing",
    hint: "External counsel or insurer instructions require you to file regardless of the EV math.",
  },
  prior_pattern: {
    title: "Pattern with prior incidents",
    hint: "This isn't isolated — there's a documented prior-incident pattern at this venue.",
  },
  other: {
    title: "Other",
    hint: "Explain in your own words below. The broker will see this reason inline on the proposal.",
  },
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: {
    override_recommendation: boolean;
    override_reason: OverrideReason;
    override_freetext: string | null;
  }) => Promise<void>;
  recommenderVerdict: "file" | "do_not_file";
  submitting: boolean;
}

export default function ClaimProposeModal({
  isOpen,
  onClose,
  onSubmit,
  recommenderVerdict,
  submitting,
}: Props) {
  const [reason, setReason] = useState<OverrideReason>("additional_evidence");
  const [freetext, setFreetext] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const otherRequiresFreetext = reason === "other" && !freetext.trim();

  async function handleSubmit() {
    if (otherRequiresFreetext) {
      setError("'Other' requires a written explanation.");
      return;
    }
    setError(null);
    await onSubmit({
      override_recommendation: true,
      override_reason: reason,
      override_freetext: freetext.trim() ? freetext.trim() : null,
    });
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.6)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-lg)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          maxWidth: 560,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          border: "1px solid var(--state-warning)",
        }}
      >
        <div
          className="flex items-center justify-between mb-lg"
          style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}
        >
          <div className="flex items-center gap-sm">
            <AlertTriangle size={16} style={{ color: "var(--state-warning)" }} />
            <h2 className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>
              {recommenderVerdict === "do_not_file"
                ? "Override recommendation"
                : "Propose claim with reason"}
            </h2>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <p className="text-sm text-secondary mb-md">
          {recommenderVerdict === "do_not_file"
            ? "The recommender suggested not filing. Tell the broker why you disagree — this reason goes into the proposal and is visible in their queue."
            : "Add an optional structured reason for filing. The broker will see this with your proposal."}
        </p>

        <div className="flex flex-col gap-sm mb-lg">
          {(Object.keys(REASON_LABELS) as OverrideReason[]).map((key) => {
            const { title, hint } = REASON_LABELS[key];
            const isSelected = reason === key;
            return (
              <label
                key={key}
                className="flex gap-md items-start p-md cursor-pointer"
                style={{
                  border: `1px solid ${isSelected ? "var(--brand-primary)" : "var(--border-subtle)"}`,
                  borderRadius: "var(--radius-sm)",
                  background: isSelected ? "rgba(200,240,0,0.04)" : "transparent",
                }}
              >
                <input
                  type="radio"
                  name="override_reason"
                  value={key}
                  checked={isSelected}
                  onChange={() => setReason(key)}
                  className="mt-xs"
                />
                <div>
                  <p className="text-sm font-semibold" style={{ margin: 0 }}>
                    {title}
                  </p>
                  <p className="text-xs text-secondary mt-xs" style={{ margin: 0 }}>
                    {hint}
                  </p>
                </div>
              </label>
            );
          })}
        </div>

        <div className="mb-lg">
          <label className="text-xs uppercase tracking-wide text-secondary block mb-xs">
            Additional context{reason === "other" ? " (required)" : " (optional)"}
          </label>
          <textarea
            className="w-full text-sm p-sm"
            rows={3}
            placeholder={
              reason === "other"
                ? "Explain why you want to file against the recommendation."
                : "Anything the broker should know? (optional)"
            }
            value={freetext}
            onChange={(e) => setFreetext(e.target.value)}
            disabled={submitting}
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-primary)",
              resize: "none",
              width: "100%",
            }}
          />
        </div>

        {error && (
          <p className="text-xs mb-md" style={{ color: "var(--state-error)" }}>
            {error}
          </p>
        )}

        <div className="flex gap-sm">
          <button
            className="btn btn-primary flex-1"
            onClick={handleSubmit}
            disabled={submitting || otherRequiresFreetext}
          >
            {submitting ? "Submitting…" : "Submit proposal"}
          </button>
          <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
