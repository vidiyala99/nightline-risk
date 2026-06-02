/**
 * Carrier underwriting decision — quote-at-terms or decline for one submission.
 * Mirrors the web /underwriting/[qid] decision form. No single-quote endpoint
 * yet, so it reads the queue and finds the row (the queue is small).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { tierColor } from '../theme/tiers';
import { Field } from './RecordReserveScreen';
import {
  fetchUnderwritingQueue,
  fmtMoney,
  lineLabel,
  rescaleBreakdownToTotal,
  underwriteQuote,
  type QueueRow,
} from '../api/underwriting';

export function UnderwriteDecisionScreen({ route, navigation }: any) {
  const { qid } = route.params as { qid: string };

  const [row, setRow] = useState<QueueRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notInQueue, setNotInQueue] = useState(false);

  const [totalInput, setTotalInput] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const [submitting, setSubmitting] = useState<'quote' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const queue = await fetchUnderwritingQueue();
      const found = queue.find((r) => r.quote_id === qid) ?? null;
      setRow(found);
      setNotInQueue(!found);
      if (found?.suggested_premium_breakdown) setTotalInput(found.suggested_premium_breakdown.total);
    } catch (e: any) {
      setError(e?.message ?? "Couldn't load this submission.");
    } finally {
      setLoading(false);
    }
  }, [qid]);

  useEffect(() => {
    load();
  }, [load]);

  const suggested = row?.suggested_premium_breakdown ?? null;
  const feeFloor = useMemo(
    () =>
      suggested ? Number(suggested.fees.policy_fee) + Number(suggested.fees.surplus_lines_tax) : 0,
    [suggested],
  );

  async function handleQuote() {
    if (!suggested) return;
    setError(null);
    const target = Number(totalInput);
    if (!Number.isFinite(target) || target <= 0) {
      setError('Enter a valid premium total.');
      return;
    }
    const unchanged = Math.round(target * 100) === Math.round(Number(suggested.total) * 100);
    const breakdown = unchanged ? suggested : rescaleBreakdownToTotal(suggested, target);
    if (!breakdown) {
      setError(`Total must be above the fixed fees (${fmtMoney(feeFloor, true)}).`);
      return;
    }
    setSubmitting('quote');
    try {
      await underwriteQuote(qid, { decision: 'quote', premium_breakdown: breakdown });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e: any) {
      setError(e?.message ?? 'Could not record the quote.');
    } finally {
      setSubmitting(null);
    }
  }

  async function handleDecline() {
    setError(null);
    if (!declineReason.trim()) {
      setError('A decline needs a reason (the broker relays it to the insured).');
      return;
    }
    setSubmitting('decline');
    try {
      await underwriteQuote(qid, { decision: 'decline', decline_reason: declineReason.trim() });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e: any) {
      setError(e?.message ?? 'Could not record the decline.');
    } finally {
      setSubmitting(null);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  if (notInQueue || !row) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>
          This submission is no longer awaiting a decision — it may already be quoted or declined.
        </Text>
        <Pressable onPress={() => navigation.goBack()} style={styles.retryBtn}>
          <Text style={styles.retryText}>Back to desk</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>‹ Desk</Text>
        </Pressable>

        <View style={styles.header}>
          <Text style={styles.eyebrow}>CARRIER · UNDERWRITING DECISION</Text>
          <View style={styles.titleRow}>
            <Text style={styles.title}>{row.venue_name}</Text>
            <View style={[styles.tierPill, { borderColor: tierColor(row.risk.tier) }]}>
              <Text style={[styles.tierText, { color: tierColor(row.risk.tier) }]}>
                {row.risk.tier} · {row.risk.total_score}
              </Text>
            </View>
          </View>
          <Text style={styles.subtitle}>
            {row.coverage_lines.map(lineLabel).join(' · ') || 'Coverage TBD'}
            {row.effective_date ? ` · effective ${new Date(row.effective_date).toLocaleDateString()}` : ''}
          </Text>
        </View>

        {/* Engine-suggested breakdown (read-only) */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>SUGGESTED PREMIUM · PRICING ENGINE</Text>
          {suggested ? (
            <>
              {Object.entries(suggested.lines).map(([id, line]) => (
                <View key={id} style={styles.lineRow}>
                  <Text style={styles.lineName}>{lineLabel(id)}</Text>
                  <Text style={styles.lineMoney}>{fmtMoney(line.premium, true)}</Text>
                </View>
              ))}
              <View style={[styles.lineRow, styles.divider]}>
                <Text style={styles.feeLabel}>Policy fee</Text>
                <Text style={styles.lineMoney}>{fmtMoney(suggested.fees.policy_fee, true)}</Text>
              </View>
              {Number(suggested.fees.surplus_lines_tax) > 0 && (
                <View style={styles.lineRow}>
                  <Text style={styles.feeLabel}>Surplus lines tax</Text>
                  <Text style={styles.lineMoney}>{fmtMoney(suggested.fees.surplus_lines_tax, true)}</Text>
                </View>
              )}
              <View style={[styles.lineRow, styles.divider]}>
                <Text style={styles.totalLabel}>SUGGESTED TOTAL</Text>
                <Text style={styles.totalMoney}>{fmtMoney(suggested.total, true)}</Text>
              </View>
              <Text style={styles.hint}>
                Risk-adjusted by tier {row.risk.tier} and this carrier&apos;s appetite. Editing the total
                rescales the lines proportionally.
              </Text>
            </>
          ) : (
            <Text style={styles.hint}>
              No engine suggestion for this venue (outside the rated set). You can still decline.
            </Text>
          )}
        </View>

        {/* Decision */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>DECISION</Text>

          <Field
            label="Annual premium"
            value={totalInput}
            onChangeText={(t) => setTotalInput(t.replace(/[^0-9.]/g, ''))}
            placeholder="0.00"
            keyboardType="decimal-pad"
            mono
            prefix="$"
            suffix="USD"
          />
          <Pressable
            onPress={handleQuote}
            style={[styles.btnPrimary, (!suggested || submitting !== null) && styles.btnDisabled]}
            disabled={!suggested || submitting !== null}
          >
            <Text style={styles.btnPrimaryText}>
              {submitting === 'quote' ? 'Recording…' : `Quote at ${fmtMoney(totalInput)}`}
            </Text>
          </Pressable>
          <Text style={styles.actionHint}>
            Issues the carrier&apos;s quote and escalates the submission for the broker to bind.
          </Text>

          <Text style={styles.orRule}>— OR —</Text>

          <Field
            label="Decline reason"
            value={declineReason}
            onChangeText={setDeclineReason}
            placeholder="Why this risk is outside appetite…"
            multiline
          />
          <Pressable
            onPress={handleDecline}
            style={[styles.btnDecline, (submitting !== null || !declineReason.trim()) && styles.btnDisabled]}
            disabled={submitting !== null || !declineReason.trim()}
          >
            <Text style={styles.btnDeclineText}>
              {submitting === 'decline' ? 'Recording…' : 'Decline submission'}
            </Text>
          </Pressable>

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Text style={styles.footnote}>
            Decided on Nightline&apos;s own desk — stamped as a carrier decision in the audit trail.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: 20, paddingBottom: 60 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.bg,
    padding: 32,
  },
  backBtn: { marginBottom: 10 },
  backText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 14 },

  header: { marginBottom: 18 },
  eyebrow: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontFamily: Fonts.displayBold, fontSize: 26, color: Colors.text, letterSpacing: -0.5, flex: 1, marginRight: 8 },
  tierPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  tierText: { fontFamily: Fonts.monoBold, fontSize: 12 },
  subtitle: { color: Colors.textSecondary, fontFamily: Fonts.sansRegular, fontSize: 13, marginTop: 6, lineHeight: 18 },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    padding: 16,
    marginBottom: 14,
  },
  cardLabel: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: Colors.textSecondary,
    marginBottom: 12,
  },
  lineRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
  lineName: { fontFamily: Fonts.sansMedium, fontSize: 14, color: Colors.text },
  lineMoney: { fontFamily: Fonts.monoRegular, fontSize: 14, color: Colors.text },
  feeLabel: { fontFamily: Fonts.sansRegular, fontSize: 12, color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.borderSubtle, paddingTop: 8 },
  totalLabel: { fontFamily: Fonts.monoBold, fontSize: 11, letterSpacing: 1, color: Colors.textSecondary },
  totalMoney: { fontFamily: Fonts.monoBold, fontSize: 17, color: Colors.accentInk },
  hint: { color: Colors.textMuted, fontFamily: Fonts.sansRegular, fontSize: 11, marginTop: 8, lineHeight: 15 },

  btnPrimary: {
    paddingVertical: 13,
    borderRadius: 8,
    backgroundColor: Colors.accent,
    alignItems: 'center',
  },
  btnPrimaryText: { color: Colors.text, fontFamily: Fonts.sansBold, fontSize: 15 },
  actionHint: { color: Colors.textSecondary, fontFamily: Fonts.sansRegular, fontSize: 11, marginTop: 6, lineHeight: 15 },

  orRule: {
    textAlign: 'center',
    color: Colors.textMuted,
    fontFamily: Fonts.monoBold,
    fontSize: 11,
    letterSpacing: 2,
    marginVertical: 16,
  },

  btnDecline: {
    paddingVertical: 13,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.error,
    alignItems: 'center',
  },
  btnDeclineText: { color: Colors.error, fontFamily: Fonts.sansBold, fontSize: 15 },
  btnDisabled: { opacity: 0.45 },

  errorBox: {
    backgroundColor: 'rgba(255,69,87,0.08)',
    borderColor: Colors.error,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    marginTop: 14,
  },
  errorText: { color: Colors.error, fontFamily: Fonts.sansMedium, fontSize: 13 },

  footnote: { color: Colors.textMuted, fontFamily: Fonts.sansRegular, fontSize: 11, marginTop: 14, fontStyle: 'italic', lineHeight: 15 },

  emptyText: {
    color: Colors.textSecondary,
    textAlign: 'center',
    fontFamily: Fonts.sansRegular,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 16,
  },
  retryBtn: {
    borderColor: Colors.accent,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
