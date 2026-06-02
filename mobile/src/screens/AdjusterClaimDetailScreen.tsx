/**
 * Carrier adjuster claim detail — decide-coverage-first adjudication screen.
 *
 * Layout (top → bottom):
 *   1. Header — claim number, status + coverage chips, back link
 *   2. Coverage section (FIRST): 3-chip picker Covered/RoR/Denied + rationale →
 *      decideCoverage(); once decided renders the determination read-only
 *   3. Summary tiles — reserve / indemnity / expense / recoveries
 *   4. Reserve section — Field + advisory reserve-hint + adjustReserve
 *   5. Payment section — type chips + amount/paid_on/description Fields;
 *      indemnity disabled until covered or RoR
 *   6. Payment ledger (sorted newest first)
 *   7. Reserve history
 *   8. Close section — disposition + optional final_indemnity → closeClaim
 *   9. Meta strip
 *
 * Pull-to-refresh; Haptics on every mutation success; single inline error line.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { lineLabel } from '../api/underwriting';
import {
  fetchAdjusterClaim,
  decideCoverage,
  adjustReserve,
  approvePayment,
  closeClaim,
  type AdjusterClaimDetail,
  type AdjusterClaimResponse,
  type CoverageDecision,
} from '../api/adjusting';
import {
  CLAIM_STATUS_LABEL,
  CLAIM_STATUS_GLYPH,
  LIFECYCLE_ORDER,
  LIFECYCLE_LABEL_SHORT,
  PAYMENT_TYPE_LABEL,
  formatLedgerMoney,
  formatClaimMoney,
  formatReserveDelta,
  isClosedStatus,
  lifecyclePosition,
  type ClaimStatus,
} from '../api/claim-tokens';
import { Field } from './RecordReserveScreen';

// ─── Coverage decision helpers ────────────────────────────────────────────

const COVERAGE_OPTIONS: { value: CoverageDecision; label: string; color: string }[] = [
  { value: 'covered', label: 'Covered', color: Colors.success },
  { value: 'reservation_of_rights', label: 'Reservation of rights', color: Colors.warning },
  { value: 'denied', label: 'Denied', color: Colors.error },
];

function coverageColor(d: CoverageDecision | null): string {
  if (d === 'covered') return Colors.success;
  if (d === 'reservation_of_rights') return Colors.warning;
  if (d === 'denied') return Colors.error;
  return Colors.textSecondary;
}

function coverageLabel(d: CoverageDecision | null): string {
  if (d === 'covered') return 'Covered';
  if (d === 'reservation_of_rights') return 'Reservation of rights';
  if (d === 'denied') return 'Denied';
  return '—';
}

// ─── Payment types ────────────────────────────────────────────────────────

const PAYMENT_TYPES: { value: string; label: string }[] = [
  { value: 'indemnity', label: 'Indemnity' },
  { value: 'expense', label: 'Expense' },
  { value: 'recovery', label: 'Recovery' },
];

// ─── Main screen ─────────────────────────────────────────────────────────

export function AdjusterClaimDetailScreen({ route, navigation }: any) {
  const { cid } = route.params as { cid: string };

  const [data, setData] = useState<AdjusterClaimResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Coverage section state
  const [coveragePick, setCoveragePick] = useState<CoverageDecision | null>(null);
  const [rationale, setRationale] = useState('');
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [coverageSubmitting, setCoverageSubmitting] = useState(false);

  // Reserve section state
  const [reserveAmt, setReserveAmt] = useState('');
  const [reserveReason, setReserveReason] = useState('');
  const [reserveError, setReserveError] = useState<string | null>(null);
  const [reserveSubmitting, setReserveSubmitting] = useState(false);

  // Payment section state
  const [payType, setPayType] = useState<string>('expense');
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payDesc, setPayDesc] = useState('');
  const [payError, setPayError] = useState<string | null>(null);
  const [paySubmitting, setPaySubmitting] = useState(false);

  // Close section state
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closeSubmitting, setCloseSubmitting] = useState(false);

  const claim = data?.claim ?? null;

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await fetchAdjusterClaim(cid);
      setData(d);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load claim');
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const onMutationSuccess = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    load();
  }, [load]);

  // ── Coverage submit ───────────────────────────────────────────────────

  const submitCoverage = useCallback(async () => {
    if (!coveragePick) { setCoverageError('Select a coverage determination.'); return; }
    if (!rationale.trim()) { setCoverageError('Rationale is required.'); return; }
    setCoverageError(null);
    setCoverageSubmitting(true);
    try {
      await decideCoverage(cid, coveragePick, rationale.trim());
      setRationale('');
      onMutationSuccess();
    } catch (e: any) {
      setCoverageError(e?.message ?? 'Failed to record decision.');
    } finally {
      setCoverageSubmitting(false);
    }
  }, [cid, coveragePick, rationale, onMutationSuccess]);

  // ── Reserve submit ────────────────────────────────────────────────────

  const submitReserve = useCallback(async () => {
    if (!reserveAmt || parseFloat(reserveAmt) < 0) { setReserveError('Enter a valid reserve amount.'); return; }
    if (!reserveReason.trim()) { setReserveError('Change reason is required.'); return; }
    setReserveError(null);
    setReserveSubmitting(true);
    try {
      await adjustReserve(cid, reserveAmt, reserveReason.trim());
      setReserveAmt('');
      setReserveReason('');
      onMutationSuccess();
    } catch (e: any) {
      setReserveError(e?.message ?? 'Failed to adjust reserve.');
    } finally {
      setReserveSubmitting(false);
    }
  }, [cid, reserveAmt, reserveReason, onMutationSuccess]);

  // ── Payment submit ────────────────────────────────────────────────────

  const indemnityAllowed = useMemo(() => {
    const d = claim?.coverage_decision;
    return d === 'covered' || d === 'reservation_of_rights';
  }, [claim?.coverage_decision]);

  const submitPayment = useCallback(async () => {
    if (payType === 'indemnity' && !indemnityAllowed) {
      setPayError('Coverage must be Covered or Reservation of rights before recording indemnity.');
      return;
    }
    if (!payAmount || parseFloat(payAmount) <= 0) { setPayError('Enter a valid payment amount.'); return; }
    if (!payDate) { setPayError('Payment date is required.'); return; }
    setPayError(null);
    setPaySubmitting(true);
    try {
      await approvePayment(cid, payAmount, payType, payDate, payDesc.trim());
      setPayAmount('');
      setPayDesc('');
      onMutationSuccess();
    } catch (e: any) {
      setPayError(e?.message ?? 'Failed to record payment.');
    } finally {
      setPaySubmitting(false);
    }
  }, [cid, payType, payAmount, payDate, payDesc, indemnityAllowed, onMutationSuccess]);

  // ── Close claim ───────────────────────────────────────────────────────

  const runClose = useCallback(
    (disposition: 'paid' | 'denied' | 'dropped', finalIndemnity?: string) => {
      setCloseError(null);
      setCloseSubmitting(true);
      closeClaim(cid, disposition, finalIndemnity)
        .then(() => onMutationSuccess())
        .catch((e: any) => setCloseError(e?.message ?? 'Failed to close claim.'))
        .finally(() => setCloseSubmitting(false));
    },
    [cid, onMutationSuccess],
  );

  const handleClose = useCallback(() => {
    const doClose = (disposition: 'paid' | 'denied' | 'dropped') => {
      if (disposition === 'paid') {
        Alert.prompt?.(
          'Final indemnity',
          'Settlement amount for this closure.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Close claim',
              onPress: (amt: string | undefined) => runClose('paid', amt?.trim() || undefined),
            },
          ],
          'plain-text',
          '',
          'decimal-pad',
        ) ?? Alert.alert('Close claim', 'Enter final indemnity in the form above, then select Paid.', [
          { text: 'OK' },
        ]);
      } else {
        runClose(disposition);
      }
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Paid', 'Denied', 'Dropped', 'Cancel'], cancelButtonIndex: 3, title: 'Close claim — disposition' },
        (idx) => {
          if (idx === 0) doClose('paid');
          else if (idx === 1) doClose('denied');
          else if (idx === 2) doClose('dropped');
        },
      );
    } else {
      Alert.alert('Close claim', 'Choose a disposition.', [
        { text: 'Paid', onPress: () => doClose('paid') },
        { text: 'Denied', onPress: () => doClose('denied') },
        { text: 'Dropped', onPress: () => doClose('dropped') },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [runClose]);

  // ── Render ────────────────────────────────────────────────────────────

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  if (error || !claim) {
    return (
      <View style={styles.errorBox}>
        <Text style={styles.errorText}>{error ?? 'Claim not found'}</Text>
        <Pressable onPress={load} style={styles.retryBtn}><Text style={styles.retryText}>Retry</Text></Pressable>
      </View>
    );
  }

  const status = claim.status as ClaimStatus;
  const closed = isClosedStatus(status);
  const lifeIdx = lifecyclePosition(status);
  const incurredNum = parseFloat(claim.indemnity_paid_to_date) + parseFloat(claim.expense_paid_to_date);
  const headFmt = formatClaimMoney(incurredNum);
  const delta = formatReserveDelta(claim.current_reserve, incurredNum);
  const hint = data?.reserve_hint ?? null;
  const hasCoverage = claim.coverage_decision != null;
  const covColor = coverageColor(claim.coverage_decision);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ── */}
        <View style={styles.headerWrap}>
          <Pressable onPress={() => navigation.goBack()} style={styles.backRow}>
            <Text style={styles.backText}>← Adjuster queue</Text>
          </Pressable>
          <Text style={styles.eyebrow}>
            <Text style={styles.glyph}>{CLAIM_STATUS_GLYPH[status]}  </Text>
            CARRIER · ADJUDICATION
          </Text>
          <Text style={styles.masthead}>{claim.carrier_claim_number ?? claim.id}</Text>
          <View style={styles.headerChipRow}>
            {/* Status chip */}
            <View style={[styles.chip, { borderColor: Colors.textSecondary }]}>
              <Text style={[styles.chipText, { color: Colors.textSecondary }]}>
                {CLAIM_STATUS_LABEL[status] ?? status}
              </Text>
            </View>
            {/* Coverage chip */}
            {hasCoverage && (
              <View style={[styles.chip, { borderColor: covColor }]}>
                <Text style={[styles.chipText, { color: covColor }]}>
                  {coverageLabel(claim.coverage_decision)}
                </Text>
              </View>
            )}
          </View>
          <Text style={styles.headerSub}>
            {lineLabel(claim.coverage_line).toUpperCase()} ·{' '}
            {new Date(claim.date_of_loss).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
            {'  ·  '}{claim.policy_id}
          </Text>
        </View>

        {/* ── Headline ── */}
        <View style={styles.headline}>
          <Text style={styles.headlineLabel}>TOTAL INCURRED</Text>
          <View style={styles.headlineValueRow}>
            <Text style={styles.headlineUnit}>$</Text>
            <Text style={styles.headlineDigits}>{headFmt.digits}</Text>
          </View>
          {delta.label !== '—' && (
            <Text style={[styles.delta, { color: delta.tone === 'success' ? Colors.accent : delta.tone === 'danger' ? Colors.error : Colors.textSecondary }]}>
              {delta.label}
            </Text>
          )}
        </View>

        {/* ── Lifecycle strip ── */}
        <LifecycleStrip status={status} pos={lifeIdx} reopenCount={claim.reopen_count} />

        {/* ── Summary tiles ── */}
        <View style={styles.summaryGrid}>
          <Tile label="Current reserve" value={formatLedgerMoney(claim.current_reserve)} />
          <Tile label="Indemnity paid" value={formatLedgerMoney(claim.indemnity_paid_to_date)} />
          <Tile label="Expense paid" value={formatLedgerMoney(claim.expense_paid_to_date)} />
          <Tile label="Recoveries" value={formatLedgerMoney(claim.recoveries_to_date)} />
        </View>

        {/* ── Coverage determination (FIRST / primary section) ── */}
        <SectionTitle>Coverage determination</SectionTitle>

        {!hasCoverage ? (
          /* Coverage picker — undecided */
          <View style={styles.sectionBox}>
            <Text style={styles.sectionHint}>
              Decide coverage before recording reserves or indemnity payments.
            </Text>
            <View style={styles.chipPickerRow}>
              {COVERAGE_OPTIONS.map((opt) => {
                const selected = coveragePick === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => setCoveragePick(opt.value)}
                    style={[
                      styles.pickerChip,
                      { borderColor: opt.color },
                      selected && { backgroundColor: opt.color + '18' },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={opt.label}
                  >
                    <Text style={[styles.pickerChipText, { color: opt.color }]}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ paddingHorizontal: 16 }}>
              <Field
                label="Rationale"
                required
                value={rationale}
                onChangeText={setRationale}
                placeholder="Basis for this determination"
                multiline
                hint="Will be logged on the claim and visible to the broker."
              />
            </View>
            {coverageError && <Text style={styles.inlineError}>{coverageError}</Text>}
            <Pressable
              style={[styles.actionBtn, styles.actionBtnPrimary, coverageSubmitting && styles.actionBtnBusy]}
              onPress={submitCoverage}
              disabled={coverageSubmitting}
              accessibilityRole="button"
            >
              <Text style={styles.actionBtnTextPrimary}>
                {coverageSubmitting ? 'Recording…' : 'Record determination'}
              </Text>
            </Pressable>
          </View>
        ) : (
          /* Coverage decided — read-only display */
          <View style={styles.sectionBox}>
            <View style={[styles.determinationCard, { borderLeftColor: covColor }]}>
              <View style={[styles.chip, { borderColor: covColor, alignSelf: 'flex-start', marginBottom: 8 }]}>
                <Text style={[styles.chipText, { color: covColor }]}>
                  {coverageLabel(claim.coverage_decision)}
                </Text>
              </View>
              {claim.coverage_rationale ? (
                <Text style={styles.rationaleText}>{claim.coverage_rationale}</Text>
              ) : null}
            </View>
          </View>
        )}

        {/* ── Reserve section ── */}
        {!closed && (
          <>
            <SectionTitle>Adjust reserve</SectionTitle>
            <View style={styles.sectionBox}>
              {hint && (
                <View style={styles.hintCard}>
                  <Text style={styles.hintTitle}>Reserve advisory</Text>
                  <Text style={styles.hintBody}>
                    {hint.severity_band} · ${hint.low}–${hint.high}
                  </Text>
                  <Text style={styles.hintBasis}>{hint.basis}</Text>
                </View>
              )}
              <View style={{ paddingHorizontal: 16 }}>
                <Field
                  label="New reserve"
                  required
                  value={reserveAmt}
                  onChangeText={(t) => setReserveAmt(t.replace(/[^0-9.]/g, ''))}
                  placeholder="25000.00"
                  keyboardType="decimal-pad"
                  mono
                  prefix="$"
                  suffix="USD"
                />
                <Field
                  label="Change reason"
                  required
                  value={reserveReason}
                  onChangeText={setReserveReason}
                  placeholder="initial reserve, post-investigation adjustment"
                />
              </View>
              {reserveError && <Text style={styles.inlineError}>{reserveError}</Text>}
              <Pressable
                style={[styles.actionBtn, styles.actionBtnSecondary, reserveSubmitting && styles.actionBtnBusy]}
                onPress={submitReserve}
                disabled={reserveSubmitting}
                accessibilityRole="button"
              >
                <Text style={styles.actionBtnTextSecondary}>
                  {reserveSubmitting ? 'Recording…' : 'Adjust reserve'}
                </Text>
              </Pressable>
            </View>
          </>
        )}

        {/* ── Payment section ── */}
        {!closed && (
          <>
            <SectionTitle>Record payment</SectionTitle>
            <View style={styles.sectionBox}>
              <View style={styles.chipPickerRow}>
                {PAYMENT_TYPES.map((pt) => {
                  const sel = payType === pt.value;
                  const disabled = pt.value === 'indemnity' && !indemnityAllowed;
                  return (
                    <Pressable
                      key={pt.value}
                      onPress={() => !disabled && setPayType(pt.value)}
                      style={[
                        styles.pickerChip,
                        sel && styles.pickerChipSelected,
                        disabled && styles.pickerChipDisabled,
                      ]}
                      disabled={disabled}
                      accessibilityRole="button"
                      accessibilityState={{ selected: sel, disabled }}
                    >
                      <Text style={[styles.pickerChipText, sel && styles.pickerChipTextSelected, disabled && styles.pickerChipTextDisabled]}>
                        {pt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {payType === 'indemnity' && !indemnityAllowed && (
                <Text style={styles.disabledHint}>
                  Coverage must be Covered or Reservation of rights to record indemnity.
                </Text>
              )}
              <View style={{ paddingHorizontal: 16 }}>
                <Field
                  label="Amount"
                  required
                  value={payAmount}
                  onChangeText={(t) => setPayAmount(t.replace(/[^0-9.]/g, ''))}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                  mono
                  prefix="$"
                  suffix="USD"
                />
                <Field
                  label="Payment date"
                  required
                  value={payDate}
                  onChangeText={setPayDate}
                  placeholder="YYYY-MM-DD"
                  hint="ISO date, e.g. 2026-06-15"
                />
                <Field
                  label="Description"
                  value={payDesc}
                  onChangeText={setPayDesc}
                  placeholder="Medical bills, attorney fees, etc."
                  multiline
                />
              </View>
              {payError && <Text style={styles.inlineError}>{payError}</Text>}
              <Pressable
                style={[styles.actionBtn, styles.actionBtnSecondary, paySubmitting && styles.actionBtnBusy]}
                onPress={submitPayment}
                disabled={paySubmitting}
                accessibilityRole="button"
              >
                <Text style={styles.actionBtnTextSecondary}>
                  {paySubmitting ? 'Recording…' : 'Record payment'}
                </Text>
              </Pressable>
            </View>
          </>
        )}

        {/* ── Payment ledger ── */}
        <SectionTitle>Payments</SectionTitle>
        {(claim.payments ?? []).length === 0 ? (
          <Text style={styles.empty}>No payments recorded yet.</Text>
        ) : (
          [...(claim.payments ?? [])]
            .sort((a, b) => new Date(b.paid_on).getTime() - new Date(a.paid_on).getTime())
            .map((p) => (
              <View key={p.id} style={styles.ledgerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.ledgerType}>{PAYMENT_TYPE_LABEL[p.payment_type as keyof typeof PAYMENT_TYPE_LABEL] ?? p.payment_type}</Text>
                  <Text style={styles.ledgerDesc} numberOfLines={2}>{p.description || '—'}</Text>
                  <Text style={styles.ledgerSub}>{new Date(p.paid_on).toLocaleDateString()} · {p.recorded_by}</Text>
                </View>
                <Text style={styles.ledgerAmount}>{formatLedgerMoney(p.amount)}</Text>
              </View>
            ))
        )}

        {/* ── Reserve history ── */}
        <SectionTitle>Reserve history</SectionTitle>
        {(claim.reserve_changes ?? []).length === 0 ? (
          <Text style={styles.empty}>No reserve changes recorded yet.</Text>
        ) : (
          [...(claim.reserve_changes ?? [])]
            .sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime())
            .map((r) => (
              <View key={r.id} style={styles.ledgerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.ledgerType} numberOfLines={1}>{r.change_reason}</Text>
                  <Text style={styles.ledgerDesc}>{formatLedgerMoney(r.from_amount)} → {formatLedgerMoney(r.to_amount)}</Text>
                  <Text style={styles.ledgerSub}>{new Date(r.changed_at).toLocaleDateString()}</Text>
                </View>
              </View>
            ))
        )}

        {/* ── Close claim ── */}
        {!closed && (
          <>
            <SectionTitle>Close claim</SectionTitle>
            <View style={styles.sectionBox}>
              {closeError && <Text style={styles.inlineError}>{closeError}</Text>}
              <Pressable
                style={[styles.actionBtn, styles.actionBtnDestructive, closeSubmitting && styles.actionBtnBusy]}
                onPress={handleClose}
                disabled={closeSubmitting}
                accessibilityRole="button"
              >
                <Text style={styles.actionBtnTextDestructive}>
                  {closeSubmitting ? 'Closing…' : 'Close claim…'}
                </Text>
              </Pressable>
            </View>
          </>
        )}

        {/* ── Meta strip ── */}
        <SectionTitle>Detail</SectionTitle>
        <MetaRow label="FNOL filed" value={new Date(claim.fnol_submitted_at).toLocaleString()} />
        {claim.adjuster_name && (
          <MetaRow
            label="Adjuster"
            value={`${claim.adjuster_name}${claim.adjuster_email ? ' — ' + claim.adjuster_email : ''}`}
          />
        )}
        {closed && claim.closed_at && (
          <MetaRow label="Closed" value={`${new Date(claim.closed_at).toLocaleString()} · ${CLAIM_STATUS_LABEL[status]}`} />
        )}
        {closed && claim.final_indemnity && (
          <MetaRow label="Final indemnity" value={formatLedgerMoney(claim.final_indemnity)} />
        )}
        <MetaRow label="Snapshot hash" value={claim.snapshot_hash} mono />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{String(children).toUpperCase()}</Text>;
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label.toUpperCase()}</Text>
      <Text style={styles.tileValue}>{value}</Text>
    </View>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label.toUpperCase()}</Text>
      <Text style={[styles.metaValue, mono && { fontFamily: Fonts.monoRegular, fontSize: 11 }]} numberOfLines={3}>
        {value}
      </Text>
    </View>
  );
}

function LifecycleStrip({ status, pos, reopenCount }: { status: ClaimStatus; pos: number; reopenCount: number }) {
  return (
    <View style={styles.lifeWrap}>
      {reopenCount > 0 && (
        <Text style={styles.lifeReopen}>↻ Reopened {reopenCount}×</Text>
      )}
      <View style={styles.lifeNodes}>
        {LIFECYCLE_ORDER.map((node, i) => {
          const lit = i < pos;
          const active = i === pos && !isClosedStatus(status);
          const finalLit = i === LIFECYCLE_ORDER.length - 1 && isClosedStatus(status);
          const dotColor = active || lit || (finalLit && status === 'closed_paid')
            ? Colors.accent
            : finalLit
              ? Colors.textSecondary
              : 'rgba(23,21,15,0.14)';
          const labelColor = active ? Colors.accent : (lit || finalLit) ? Colors.text : Colors.textMuted;
          return (
            <View key={node} style={styles.lifeCol}>
              <View style={[styles.lifeDot, { backgroundColor: dotColor }]} />
              <Text style={[styles.lifeLabel, { color: labelColor }]}>{LIFECYCLE_LABEL_SHORT[node]}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },

  headerWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  backRow: { marginBottom: 12 },
  backText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 13 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  glyph: { color: Colors.accentInk },
  masthead: {
    fontFamily: Fonts.monoBold,
    fontSize: 16,
    color: Colors.text,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    paddingBottom: 8,
  },
  headerChipRow: { flexDirection: 'row', gap: 8, marginBottom: 6, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 0.8 },
  headerSub: { color: Colors.textSecondary, fontSize: 12, fontFamily: Fonts.monoRegular },

  headline: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 },
  headlineLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.6, color: Colors.textSecondary, marginBottom: 4 },
  headlineValueRow: { flexDirection: 'row', alignItems: 'baseline' },
  headlineUnit: { fontFamily: Fonts.displayBold, fontSize: 26, color: Colors.textMuted },
  headlineDigits: {
    fontFamily: Fonts.displayBold,
    fontSize: 56,
    lineHeight: 60,
    color: Colors.text,
    letterSpacing: -1.5,
    fontVariant: ['tabular-nums'],
  },
  delta: { fontFamily: Fonts.monoBold, fontSize: 11, marginTop: 6 },

  lifeWrap: { paddingHorizontal: 20, paddingVertical: 16 },
  lifeReopen: { alignSelf: 'flex-end', fontFamily: Fonts.monoBold, fontSize: 10, color: Colors.error, marginBottom: 6 },
  lifeNodes: { flexDirection: 'row', justifyContent: 'space-between' },
  lifeCol: { alignItems: 'center', flex: 1 },
  lifeDot: { width: 10, height: 10, borderRadius: 5, marginBottom: 6 },
  lifeLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2 },

  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, gap: 8, marginBottom: 16 },
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: Colors.surface,
    padding: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  tileLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 4 },
  tileValue: { fontFamily: Fonts.monoBold, fontSize: 16, color: Colors.text },

  sectionTitle: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: Colors.textSecondary,
    paddingHorizontal: 20,
    marginTop: 16,
    marginBottom: 8,
  },
  sectionBox: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    paddingTop: 14,
    paddingBottom: 14,
    overflow: 'hidden',
  },
  sectionHint: {
    fontFamily: Fonts.sansRegular,
    fontSize: 12,
    color: Colors.textSecondary,
    marginBottom: 12,
    paddingHorizontal: 16,
    lineHeight: 16,
  },

  chipPickerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 14,
  },
  pickerChip: {
    borderWidth: 1,
    borderColor: Colors.borderSubtle,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerChipSelected: { borderColor: Colors.accentInk, backgroundColor: Colors.accentWash },
  pickerChipDisabled: { borderColor: 'rgba(23,21,15,0.08)', backgroundColor: 'rgba(23,21,15,0.03)' },
  pickerChipText: { fontFamily: Fonts.sansMedium, fontSize: 12, color: Colors.text },
  pickerChipTextSelected: { color: Colors.accentInk },
  pickerChipTextDisabled: { color: Colors.textMuted },
  disabledHint: {
    fontFamily: Fonts.sansRegular,
    fontSize: 11,
    color: Colors.warning,
    paddingHorizontal: 16,
    marginBottom: 10,
    lineHeight: 15,
  },

  determinationCard: {
    marginHorizontal: 16,
    borderLeftWidth: 3,
    paddingLeft: 12,
    paddingRight: 4,
    marginBottom: 4,
  },
  rationaleText: { fontFamily: Fonts.sansRegular, fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },

  hintCard: {
    marginHorizontal: 16,
    marginBottom: 14,
    padding: 12,
    backgroundColor: Colors.bg,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  hintTitle: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: Colors.accentInk, marginBottom: 4 },
  hintBody: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text },
  hintBasis: { fontFamily: Fonts.sansRegular, fontSize: 11, color: Colors.textMuted, marginTop: 2 },

  inlineError: {
    color: Colors.error,
    fontFamily: Fonts.sansMedium,
    fontSize: 12,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  actionBtn: {
    marginHorizontal: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  actionBtnPrimary: { backgroundColor: Colors.accent },
  actionBtnSecondary: { borderWidth: 1, borderColor: Colors.border, backgroundColor: 'transparent' },
  actionBtnDestructive: { borderWidth: 1, borderColor: 'rgba(200,52,30,0.35)' },
  actionBtnBusy: { opacity: 0.5 },
  actionBtnTextPrimary: { color: Colors.text, fontFamily: Fonts.sansBold, fontSize: 13 },
  actionBtnTextSecondary: { color: Colors.text, fontFamily: Fonts.sansSemiBold, fontSize: 13 },
  actionBtnTextDestructive: { color: Colors.error, fontFamily: Fonts.sansSemiBold, fontSize: 13 },

  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSubtle,
  },
  ledgerType: { fontFamily: Fonts.sansSemiBold, fontSize: 13, color: Colors.text },
  ledgerDesc: { fontFamily: Fonts.monoRegular, fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  ledgerSub: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted, marginTop: 4 },
  ledgerAmount: { fontFamily: Fonts.monoBold, fontSize: 14, color: Colors.text },

  empty: {
    color: Colors.textMuted,
    fontStyle: 'italic',
    fontFamily: Fonts.sansRegular,
    fontSize: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    lineHeight: 16,
  },
  metaRow: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(23,21,15,0.06)',
  },
  metaLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.4, color: Colors.textMuted, marginBottom: 2 },
  metaValue: { color: Colors.text, fontFamily: Fonts.sansRegular, fontSize: 13 },

  errorBox: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: Colors.bg },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium, fontSize: 14 },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
