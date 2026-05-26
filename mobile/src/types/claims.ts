import { Colors } from "../theme/colors";
export interface ClaimRecommendation {
  should_file: boolean;
  probability: number;
  expected_payout: { low_usd: number; median_usd: number; high_usd: number };
  expected_premium_impact: { annual_delta_usd: number; duration_years: number; cumulative_usd: number };
  net_expected_value_usd: number;
  reasons: string[];
  confidence: number;
  rubric_version: string;
}

export type ClaimState =
  | 'pending_broker_review'
  | 'approved'
  | 'rejected_by_broker'
  | 'filed_with_carrier'
  | 'paid'
  | 'denied';

export type OverrideReason =
  | 'additional_evidence'
  | 'legal_counsel'
  | 'prior_pattern'
  | 'other';

export interface ClaimProposal {
  id: string;
  packet_id: string;
  venue_id: string;
  proposed_by: string;
  proposed_at: string;
  override_recommendation: boolean;
  override_reason: OverrideReason | null;
  override_freetext: string | null;
  state: ClaimState;
  broker_decided_by: string | null;
  broker_decided_at: string | null;
  broker_notes: string | null;
}

export interface OverrideStats {
  override_total: number;
  override_approved: number;
  override_rejected: number;
  override_pending: number;
  override_right_rate: number | null;
  non_override_total: number;
  non_override_approved: number;
  non_override_rejected: number;
  non_override_pending: number;
  non_override_right_rate: number | null;
  by_reason: Record<string, { total: number; approved: number; rejected: number; pending: number }>;
}

export const STATE_LABEL: Record<ClaimState, string> = {
  pending_broker_review: 'Pending review',
  approved: 'Approved',
  rejected_by_broker: 'Rejected',
  filed_with_carrier: 'Filed',
  paid: 'Paid',
  denied: 'Denied',
};

export const STATE_COLOR: Record<ClaimState, string> = {
  pending_broker_review: Colors.warning,
  approved: Colors.success,
  rejected_by_broker: Colors.error,
  filed_with_carrier: Colors.info,
  paid: Colors.success,
  denied: Colors.error,
};

export const OVERRIDE_REASON_LABELS: Record<OverrideReason, { title: string; hint: string }> = {
  additional_evidence: {
    title: 'Additional evidence available',
    hint: 'You have evidence the recommender did not see.',
  },
  legal_counsel: {
    title: 'Legal counsel advised filing',
    hint: 'External counsel or insurer instructions require filing.',
  },
  prior_pattern: {
    title: 'Pattern with prior incidents',
    hint: 'Documented prior-incident pattern at this venue.',
  },
  other: {
    title: 'Other',
    hint: 'Explain below — broker will see your reason.',
  },
};
