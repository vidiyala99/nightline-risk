/**
 * Broker policy detail — mobile counterpart to /policies/[pid].
 *
 * Summary + read-only endorsements/COIs/linked claims, plus the core
 * actions: assign policy number, cancel, and file FNOL (reuses the FNOL
 * screen in the Claims tab). Endorsement/COI authoring stays on web.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { formatLedgerMoney } from '../api/claim-tokens';
import { CLAIM_STATUS_LABEL } from '../api/claim-tokens';
import { useAlert } from '../components/ThemedAlert';
import { PromptModal } from '../components/PromptModal';
import {
  policiesApi,
  POLICY_STATUS_LABEL,
  POLICY_STATUS_COLOR,
  type PolicyDetail,
} from '../api/policies';
import { formatRatePct } from '../api/submissions';
import { claimsApi, type Claim } from '../api/claims';

type PromptKind = { kind: 'assign' } | { kind: 'cancel'; method: 'pro_rata' | 'short_rate' } | null;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function PolicyDetailScreen({ route, navigation }: any) {
  const pid: string = route.params.pid;
  const alert = useAlert();

  const [detail, setDetail] = useState<PolicyDetail | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptKind>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, c] = await Promise.all([
        policiesApi.get(pid),
        claimsApi.claimsForPolicy(pid).catch(() => [] as Claim[]),
      ]);
      setDetail(d);
      setClaims(c);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load policy');
    }
  }, [pid]);

  useEffect(() => {
    load();
  }, [load]);

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, onDone?: () => void) => {
      setBusy(key);
      try {
        await fn();
        await load();
        onDone?.();
      } catch (e: any) {
        alert.show({ title: 'Action failed', message: e?.message ?? 'Try again.', variant: 'error' });
      } finally {
        setBusy(null);
      }
    },
    [load, alert],
  );

  const fileFnol = () => {
    if (!detail) return;
    navigation.navigate('Claims', {
      screen: 'FileFnol',
      params: {
        policyId: detail.id,
        policyNumber: detail.policy_number,
        coverageLines: detail.coverage_lines,
        effectiveDate: detail.effective_date,
        expirationDate: detail.expiration_date,
      },
    });
  };

  const startCancel = () =>
    alert.show({
      title: 'Cancel policy',
      message: 'Choose the cancellation basis. You will add a reason next.',
      variant: 'warning',
      buttons: [
        { label: 'Dismiss', style: 'cancel' },
        { label: 'Short-rate', onPress: () => setPrompt({ kind: 'cancel', method: 'short_rate' }) },
        { label: 'Pro-rata', style: 'primary', onPress: () => setPrompt({ kind: 'cancel', method: 'pro_rata' }) },
      ],
    });

  if (detail === null && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Pressable style={styles.backRow} onPress={() => navigation.goBack()}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backLabel}>Policies</Text>
        </Pressable>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={load} style={styles.retryBtn}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {detail && (
          <>
            <View style={styles.headerWrap}>
              <Text style={styles.eyebrow}>BROKER · POLICY</Text>
              <Text style={styles.title}>{detail.policy_number ?? detail.venue_id}</Text>
              <Text style={[styles.statusPill, { color: POLICY_STATUS_COLOR[detail.status] }]}>
                {POLICY_STATUS_LABEL[detail.status]}
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.summaryRow}>
                <SummaryCell label="PREMIUM" value={formatLedgerMoney(detail.annual_premium)} />
                <SummaryCell
                  label="COMMISSION"
                  value={`${formatLedgerMoney(detail.commission_amount)} · ${formatRatePct(detail.commission_rate)}`}
                />
              </View>
              <View style={[styles.summaryRow, { marginTop: 12 }]}>
                <SummaryCell label="EFFECTIVE" value={detail.effective_date} />
                <SummaryCell label="EXPIRES" value={detail.expiration_date} />
              </View>
              <View style={styles.lineChips}>
                {detail.coverage_lines.map((cl) => (
                  <Text key={cl} style={styles.lineChip}>{cl.toUpperCase()}</Text>
                ))}
              </View>
              <Text style={styles.hash} numberOfLines={1}>
                snapshot {detail.snapshot_hash.slice(0, 16)}…
              </Text>
            </View>

            {detail.status === 'cancelled' && (
              <View style={[styles.card, styles.cancelCard]}>
                <Text style={styles.sectionLabel}>CANCELLED</Text>
                <Text style={styles.cancelMeta}>
                  {detail.cancellation_method ?? '—'} · refund {formatLedgerMoney(detail.refund_amount)}
                </Text>
                {!!detail.cancellation_reason && (
                  <Text style={styles.cancelReason}>{detail.cancellation_reason}</Text>
                )}
              </View>
            )}

            {/* Actions */}
            <View style={styles.actionWrap}>
              {detail.status === 'bound_pending_number' && (
                <Pressable
                  style={[styles.primaryBtn, busy === 'assign' && styles.btnDisabled]}
                  disabled={busy === 'assign'}
                  onPress={() => setPrompt({ kind: 'assign' })}
                >
                  <Text style={styles.primaryBtnText}>Assign policy #</Text>
                </Pressable>
              )}
              <Pressable style={styles.ghostBtn} onPress={fileFnol}>
                <Text style={styles.ghostBtnText}>File FNOL</Text>
              </Pressable>
              {detail.status !== 'cancelled' && (
                <Pressable style={styles.dangerBtn} disabled={busy === 'cancel'} onPress={startCancel}>
                  <Text style={styles.dangerBtnText}>Cancel policy</Text>
                </Pressable>
              )}
            </View>

            {/* Endorsements */}
            <Text style={styles.heading}>ENDORSEMENTS</Text>
            {detail.endorsements.length === 0 ? (
              <Text style={styles.emptyText}>None.</Text>
            ) : (
              detail.endorsements.map((e) => (
                <View key={e.id} style={styles.listCard}>
                  <View style={styles.listTop}>
                    <Text style={styles.listTitle}>{e.endorsement_type.replace(/_/g, ' ')}</Text>
                    <Text style={styles.listMoney}>{formatLedgerMoney(e.premium_change)}</Text>
                  </View>
                  <Text style={styles.listMeta}>{e.effective_date}</Text>
                  {!!e.description && <Text style={styles.listDesc}>{e.description}</Text>}
                </View>
              ))
            )}

            {/* Certificates */}
            <Text style={styles.heading}>CERTIFICATES</Text>
            {detail.certificates.length === 0 ? (
              <Text style={styles.emptyText}>None.</Text>
            ) : (
              detail.certificates.map((c) => (
                <View key={c.id} style={styles.listCard}>
                  <View style={styles.listTop}>
                    <Text style={styles.listTitle} numberOfLines={1}>{c.certificate_holder}</Text>
                    <Text style={styles.listMetaRight}>{c.status}</Text>
                  </View>
                  <Text style={styles.listMeta}>expires {c.expires_on}</Text>
                  {c.additional_insured && (
                    <Text style={styles.listDesc}>Additional insured · {c.additional_insured_scope}</Text>
                  )}
                </View>
              ))
            )}

            {/* Linked claims */}
            <Text style={styles.heading}>CLAIMS</Text>
            {claims.length === 0 ? (
              <Text style={styles.emptyText}>No claims filed against this policy.</Text>
            ) : (
              claims.map((c) => (
                <Pressable
                  key={c.id}
                  style={styles.listCard}
                  onPress={() => navigation.navigate('Claims', { screen: 'CarrierClaimDetail', params: { cid: c.id } })}
                >
                  <View style={styles.listTop}>
                    <Text style={styles.listTitle} numberOfLines={1}>
                      {c.carrier_claim_number ?? c.id}
                    </Text>
                    <Text style={styles.listMetaRight}>{CLAIM_STATUS_LABEL[c.status]}</Text>
                  </View>
                  <Text style={styles.listMeta}>
                    {c.coverage_line.toUpperCase()} · loss {c.date_of_loss} · reserve{' '}
                    {formatLedgerMoney(c.current_reserve)}
                  </Text>
                </Pressable>
              ))
            )}
          </>
        )}
      </ScrollView>

      <PromptModal
        visible={prompt?.kind === 'assign'}
        title="Assign policy number"
        message="Enter the carrier-issued policy number."
        placeholder="e.g. MAR-2026-001"
        confirmLabel="Assign"
        onCancel={() => setPrompt(null)}
        onSubmit={(num) => {
          setPrompt(null);
          run('assign', () => policiesApi.assignNumber(pid, num));
        }}
      />
      <PromptModal
        visible={prompt?.kind === 'cancel'}
        title="Cancel policy"
        message="Record the reason for cancellation."
        placeholder="e.g. Venue closed"
        confirmLabel="Cancel policy"
        onCancel={() => setPrompt(null)}
        onSubmit={(reason) => {
          const method = prompt && 'method' in prompt ? prompt.method : 'pro_rata';
          setPrompt(null);
          run('cancel', () =>
            policiesApi.cancel(pid, { reason, method, cancellation_date: todayIso() }),
          );
        }}
      />
    </View>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryCell}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  backArrow: { color: Colors.accentInk, fontSize: 18, marginRight: 8, fontFamily: Fonts.monoBold },
  backLabel: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 13 },

  headerWrap: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 28, lineHeight: 32, color: Colors.text, letterSpacing: -0.5 },
  statusPill: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1, marginTop: 6 },

  card: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  cancelCard: { borderColor: Colors.error },
  summaryRow: { flexDirection: 'row', gap: 12 },
  summaryCell: { flex: 1 },
  summaryLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: Colors.textMuted, marginBottom: 2 },
  summaryValue: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text },

  lineChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  lineChip: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1,
    color: Colors.textSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  hash: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted, marginTop: 12 },

  sectionLabel: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.error, marginBottom: 6 },
  cancelMeta: { fontFamily: Fonts.monoBold, fontSize: 12, color: Colors.text },
  cancelReason: { fontFamily: Fonts.sansRegular, fontSize: 12, color: Colors.textSecondary, marginTop: 4 },

  actionWrap: { paddingHorizontal: 16, marginTop: 14, gap: 10 },
  primaryBtn: { backgroundColor: Colors.accent, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  primaryBtnText: { color: Colors.text, fontFamily: Fonts.monoBold, fontSize: 12, letterSpacing: 1 },
  ghostBtn: { borderWidth: 1, borderColor: Colors.accent, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  ghostBtnText: { color: Colors.accentInk, fontFamily: Fonts.monoBold, fontSize: 12, letterSpacing: 1 },
  dangerBtn: { paddingVertical: 11, alignItems: 'center' },
  dangerBtnText: { color: Colors.error, fontFamily: Fonts.sansMedium, fontSize: 13 },
  btnDisabled: { opacity: 0.4 },

  heading: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: Colors.textSecondary,
    marginTop: 22,
    marginBottom: 8,
    paddingHorizontal: 20,
  },
  listCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  listTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  listTitle: { fontFamily: Fonts.sansSemiBold, fontSize: 14, color: Colors.text, flex: 1, marginRight: 8, textTransform: 'capitalize' },
  listMoney: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text },
  listMetaRight: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 0.5, color: Colors.textSecondary },
  listMeta: { fontFamily: Fonts.monoRegular, fontSize: 11, color: Colors.textMuted, marginTop: 4 },
  listDesc: { fontFamily: Fonts.sansRegular, fontSize: 12, color: Colors.textSecondary, marginTop: 4 },

  emptyText: { color: Colors.textMuted, fontFamily: Fonts.sansRegular, fontSize: 13, paddingHorizontal: 20 },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
