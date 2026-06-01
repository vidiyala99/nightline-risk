/**
 * Mobile typed client for the per-venue loss run + CSV export.
 * MIRROR OF frontend/src/lib/lossRun.ts. Money values are STRINGS.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { api, API_URL, getToken } from './client';

export interface LossRunClaim {
  claim_id: string;
  carrier_claim_number: string | null;
  policy_number: string | null;
  carrier_name: string;
  coverage_line: string;
  status: string;
  date_of_loss: string | null;
  current_reserve: string;
  indemnity_paid: string;
  expense_paid: string;
  recoveries: string;
  total_incurred: string;
}

export interface CoverageLineLoss {
  coverage_line: string;
  claim_count: number;
  reserve: string;
  paid: string;
  incurred: string;
}

export interface LossRunSummary {
  claim_count: number;
  open_count: number;
  total_reserve: string;
  total_paid: string;
  total_recoveries: string;
  total_incurred: string;
}

export interface LossRun {
  venue_id: string;
  claims: LossRunClaim[];
  by_coverage_line: CoverageLineLoss[];
  summary: LossRunSummary;
}

export const lossRunApi = {
  get: (venueId: string) => api.request<LossRun>(`/api/venues/${venueId}/loss-run`),
};

/** Download the CSV (auth-gated) and hand it to the OS share sheet. A plain
 * link can't send the bearer token, so stream the authed response to a file
 * via FileSystem.downloadAsync, then share — same pattern as the defense PDF. */
export async function shareLossRunCsv(venueId: string): Promise<void> {
  const token = await getToken();
  const fileUri = `${FileSystem.documentDirectory}loss-run-${venueId}.csv`;
  const { uri, status } = await FileSystem.downloadAsync(
    `${API_URL}/api/venues/${venueId}/loss-run.csv`,
    fileUri,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (status !== 200) {
    throw new Error(`Failed to download loss run (HTTP ${status})`);
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
      dialogTitle: 'Loss run',
    });
  }
}

export function fmtUsd(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}
