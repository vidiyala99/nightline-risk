/**
 * Mobile typed API client for Phase 3 carrier-side claims.
 *
 * MIRROR OF frontend/src/lib/claims.ts — same wire shapes, same call
 * signatures. Routed through the existing `api.request` helper in
 * client.ts, so auth + JSON envelope handling is shared.
 *
 * Money values come back as STRINGS — parse only at render time via
 * formatLedgerMoney / formatClaimMoney from claim-tokens.ts.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { api, API_URL, getToken } from './client';
import type { ClaimStatus, PaymentType } from './claim-tokens';

// ─── Wire types ─────────────────────────────────────────────────────────

export interface Claim {
  id: string;
  policy_id: string;
  incident_id: string | null;
  proposal_id: string | null;
  carrier_claim_number: string | null;
  coverage_line: string;
  status: ClaimStatus;
  date_of_loss: string;
  fnol_submitted_at: string;
  current_reserve: string;
  indemnity_paid_to_date: string;
  expense_paid_to_date: string;
  recoveries_to_date: string;
  final_indemnity: string | null;
  total_incurred: string | null;
  closed_at: string | null;
  reopened_at: string | null;
  reopen_count: number;
  adjuster_name: string | null;
  adjuster_email: string | null;
  defense_package_id: string | null;
  snapshot_hash: string;
}

export interface ClaimPayment {
  id: string;
  claim_id: string;
  payment_type: PaymentType;
  amount: string;
  paid_on: string;
  description: string;
  recorded_by: string;
  recorded_at: string;
}

export interface ReserveChange {
  id: string;
  claim_id: string;
  from_amount: string;
  to_amount: string;
  change_reason: string;
  received_from: string;
  received_at: string;
  recorded_by: string;
  recorded_at: string;
}

export interface ClaimDetail extends Claim {
  payments: ClaimPayment[];
  reserve_changes: ReserveChange[];
}

// ─── Request bodies ─────────────────────────────────────────────────────

export interface FileFnolBody {
  coverage_line: string;
  date_of_loss: string;
  incident_id?: string | null;
  proposal_id?: string | null;
  defense_package_id?: string | null;
  carrier_claim_number?: string | null;
  adjuster_name?: string | null;
  adjuster_email?: string | null;
}

export interface RecordReserveBody {
  new_reserve: string;
  change_reason: string;
  received_from: string;
  received_at: string;
}

export interface RecordPaymentBody {
  amount: string;
  payment_type: PaymentType;
  paid_on: string;
  description?: string;
}

export interface CloseClaimBody {
  disposition: 'paid' | 'denied' | 'dropped';
  final_indemnity?: string | null;
}

export interface ReopenClaimBody {
  reason: string;
}

export interface AttachDefensePackageBody {
  defense_package_id: string;
}

// ─── Endpoints ──────────────────────────────────────────────────────────

export const claimsApi = {
  fileFnol: (pid: string, body: FileFnolBody) =>
    api.request<Claim>(`/api/policies/${pid}/claims`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listClaims: (params: {
    status?: string;
    venue_id?: string;
    carrier_id?: string;
    open_only?: boolean;
  } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== false) q.set(k, String(v));
    }
    const qs = q.toString();
    return api.request<Claim[]>(`/api/claims${qs ? `?${qs}` : ''}`);
  },

  claimsForPolicy: (pid: string, status?: string) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return api.request<Claim[]>(`/api/policies/${pid}/claims${qs}`);
  },

  claimDetail: (cid: string) =>
    api.request<ClaimDetail>(`/api/claims/${cid}`),

  recordCarrierReserve: (cid: string, body: RecordReserveBody) =>
    api.request<Claim>(`/api/claims/${cid}/carrier-reserve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  reserveHistory: (cid: string) =>
    api.request<ReserveChange[]>(`/api/claims/${cid}/reserve-history`),

  recordPayment: (cid: string, body: RecordPaymentBody) =>
    api.request<ClaimPayment>(`/api/claims/${cid}/payments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  paymentsForClaim: (cid: string) =>
    api.request<ClaimPayment[]>(`/api/claims/${cid}/payments`),

  closeClaim: (cid: string, body: CloseClaimBody) =>
    api.request<Claim>(`/api/claims/${cid}/close`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  reopenClaim: (cid: string, body: ReopenClaimBody) =>
    api.request<Claim>(`/api/claims/${cid}/reopen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  attachDefensePackage: (cid: string, body: AttachDefensePackageBody) =>
    api.request<Claim>(`/api/claims/${cid}/defense-package`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ─── Derived helpers ────────────────────────────────────────────────────

export function totalIncurredFromClaim(c: Claim): number {
  const ind = parseFloat(c.indemnity_paid_to_date) || 0;
  const exp = parseFloat(c.expense_paid_to_date) || 0;
  const rec = parseFloat(c.recoveries_to_date) || 0;
  return ind + exp - rec;
}

export function totalPaidFromClaim(c: Claim): number {
  const ind = parseFloat(c.indemnity_paid_to_date) || 0;
  const exp = parseFloat(c.expense_paid_to_date) || 0;
  return ind + exp;
}

/**
 * Download a packet's defense-package PDF and hand it to the OS share
 * sheet. Mobile counterpart of web downloadDefensePackagePdf (lib/claims.ts).
 *
 * The endpoint (GET /api/packets/{id}/defense-package.pdf) is keyed by
 * packet id — which is exactly `claim.defense_package_id` — and is tenant
 * gated, so the request must carry the bearer token. A plain Linking.openURL
 * can't send headers, so we stream the authed response to a file via
 * FileSystem.downloadAsync, then share it.
 *
 * @param packetId the claim's defense_package_id
 */
export async function downloadDefensePackagePdf(packetId: string): Promise<void> {
  const token = await getToken();
  const fileUri = `${FileSystem.documentDirectory}defense-${packetId}.pdf`;
  const { uri, status } = await FileSystem.downloadAsync(
    `${API_URL}/api/packets/${packetId}/defense-package.pdf`,
    fileUri,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (status !== 200) {
    throw new Error(`Failed to download defense package (HTTP ${status})`);
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: 'Defense package',
    });
  }
}
