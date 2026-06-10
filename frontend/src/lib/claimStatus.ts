/**
 * Canonical operator claim-journey status — the SINGLE source of truth for
 * "where this stands" across every operator surface (claim-status page,
 * decision page, incident detail). Mirrors the RN app's shared deriveClaimStatus.
 *
 * The authority for "sent to broker?" is **persisted state** — a ClaimProposal
 * or carrier Claim actually exists — NEVER a recomputed routing verdict
 * (`routing_status`), which is only a prediction ("would this auto-route") and
 * can outrun the proposal record (fraud hold / rollback / never ran). Honours
 * ADR-0004: a routed ClaimProposal is NOT yet a Claim.
 *
 * Previously this ladder was duplicated inline in three pages and drifted —
 * the decision screen showed "Sent to broker for review" off `routing_status`
 * while claim-status correctly showed "Not sent yet". One helper kills the drift.
 */

export type ClaimTone = "info" | "success" | "warning" | "error" | "neutral";

export interface ClaimStatusResponse {
  incident_status: string;
  proposal: { exists: boolean; state: string | null };
  claim: { exists: boolean; status: string | null };
}

/** The helper only needs the claim's status; callers may pass a richer row. */
export interface ClaimStatusRef {
  status?: string | null;
}

/** The five-step operator claim journey, in order. */
export const CLAIM_JOURNEY_STEPS = ["Reported", "Sent to broker", "Approved", "Filed", "Resolved"] as const;

export interface ClaimStatusView {
  tone: ClaimTone;
  headline: string;
  detail: string;
  next: string;
  /** Index into CLAIM_JOURNEY_STEPS (0..4). */
  currentIndex: number;
  /** True iff a proposal or carrier claim actually exists (persisted "sent"). */
  sent: boolean;
}

export function deriveClaimStatus(cs: ClaimStatusResponse, claim: ClaimStatusRef | null): ClaimStatusView {
  const ps = cs.proposal.state;
  const claimStatus = claim?.status ?? cs.claim.status ?? null;

  // Terminal claim outcomes first.
  if (ps === "paid" || claimStatus === "closed_paid") {
    return { tone: "success", headline: "Claim paid", detail: "The carrier settled this claim. Nothing more is needed from you.", next: "Resolved — no action required.", currentIndex: 4, sent: true };
  }
  if (ps === "denied" || claimStatus === "closed_denied") {
    return { tone: "error", headline: "Claim denied by carrier", detail: "The carrier declined this claim. Your broker can advise on options.", next: "Talk to your broker if you want to dispute or appeal.", currentIndex: 4, sent: true };
  }
  if (claimStatus === "closed_dropped") {
    return { tone: "neutral", headline: "Claim withdrawn", detail: "This claim was dropped before settlement.", next: "Resolved — no action required.", currentIndex: 4, sent: true };
  }
  // Broker declined the recommendation outright — never became a claim.
  if (ps === "rejected_by_broker") {
    return { tone: "error", headline: "Declined by your broker", detail: "Your broker reviewed the recommendation and decided not to file. It never became a carrier claim.", next: "Review the recommendation, or talk to your broker about next steps.", currentIndex: 1, sent: true };
  }
  // Filed with the carrier — a real Claim now exists (linked via cs, or matched
  // directly by the caller).
  if (ps === "filed_with_carrier" || cs.claim.exists || claim != null) {
    return { tone: "info", headline: "Filed with the carrier", detail: "Your broker filed this as a carrier claim. It's now in the carrier's hands.", next: "Awaiting the carrier's decision — we'll update this when it settles.", currentIndex: 3, sent: true };
  }
  // Approved by broker, claim being opened.
  if (ps === "approved") {
    return { tone: "success", headline: "Approved — filing with the carrier", detail: "Your broker approved the recommendation. The carrier claim is being opened now.", next: "Your broker has the next move. No action needed from you.", currentIndex: 2, sent: true };
  }
  // Broker bounced it back for more evidence.
  if (ps === "needs_more_info") {
    return { tone: "warning", headline: "Your broker needs more information", detail: "Before filing, your broker asked for additional evidence on this incident.", next: "You have the next move — add the requested evidence on the incident.", currentIndex: 1, sent: true };
  }
  // Default: a proposal exists, sitting in the broker's queue.
  if (cs.proposal.exists) {
    return { tone: "info", headline: "Awaiting your broker's decision", detail: "We sent the recommendation to your broker. They'll approve it as a claim, ask for more info, or decline.", next: "Your broker has the next move. We'll update this when they respond.", currentIndex: 1, sent: true };
  }
  // No proposal and no claim — genuinely not sent. This is the ONLY "not sent" case.
  return { tone: "neutral", headline: "Not sent to your broker yet", detail: "This incident is still a recommendation — nothing has been filed.", next: "Review the recommendation to decide whether to send it to your broker.", currentIndex: 0, sent: false };
}
