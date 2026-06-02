/**
 * Carrier adjuster desk — claims assigned for adjudication.
 * Tap a row to open the decide-coverage-first detail screen.
 * Mirrors UnderwritingDeskScreen (queue layout) + uses claim-tokens vocab.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { HandAccent } from '../components/HandAccent';
import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import {
  fetchAdjusterQueue,
  type AdjusterQueueRow,
  type CoverageDecision,
} from '../api/adjusting';
import { CLAIM_STATUS_LABEL, formatLedgerMoney } from '../api/claim-tokens';
import { lineLabel } from '../api/underwriting';

/** Color + text for a claim status chip. */
function statusChip(status: string): { color: string; label: string } {
  const s = (status ?? '').toLowerCase();
  if (s === 'notified') return { color: Colors.info, label: 'NOTIFIED' };
  if (s === 'acknowledged') return { color: Colors.info, label: 'ACK' };
  if (s === 'under_investigation') return { color: Colors.warning, label: 'INVEST.' };
  if (s === 'reserved') return { color: Colors.warning, label: 'RESERVED' };
  if (s === 'settling') return { color: Colors.warning, label: 'SETTLING' };
  if (s.startsWith('closed')) return { color: Colors.textSecondary, label: 'CLOSED' };
  if (s === 'reopened') return { color: Colors.error, label: 'REOPENED' };
  return { color: Colors.textSecondary, label: s.toUpperCase() };
}

/** Color + text for a coverage decision chip. */
function coverageChip(decision: CoverageDecision | null): { color: string; label: string } | null {
  if (!decision) return null;
  if (decision === 'covered') return { color: Colors.success, label: 'COVERED' };
  if (decision === 'reservation_of_rights') return { color: Colors.warning, label: 'ROR' };
  if (decision === 'denied') return { color: Colors.error, label: 'DENIED' };
  return null;
}

export function AdjusterQueueScreen({ navigation }: any) {
  const [rows, setRows] = useState<AdjusterQueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await fetchAdjusterQueue());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load the adjuster queue.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Counts for the header
  const pendingCoverage = (rows ?? []).filter((r) => r.coverage_decision == null).length;
  const total = (rows ?? []).length;

  if (rows === null && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerWrap}>
        <Text style={styles.eyebrow}>CARRIER · ADJUDICATION</Text>
        <Text style={styles.title}>Adjuster desk</Text>
        <HandAccent>coverage first</HandAccent>
        <Text style={styles.subtitle}>
          Claims assigned for adjudication. Decide coverage before reserving or paying.
        </Text>
        {total > 0 && (
          <View style={styles.countRow}>
            <View style={styles.countPill}>
              <Text style={styles.countText}>{total} TOTAL</Text>
            </View>
            {pendingCoverage > 0 && (
              <View style={[styles.countPill, styles.countPillWarning]}>
                <Text style={[styles.countText, { color: Colors.warning }]}>
                  {pendingCoverage} NEED COVERAGE DECISION
                </Text>
              </View>
            )}
          </View>
        )}
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (rows?.length ?? 0) === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            No claims in the adjuster queue.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows!}
          keyExtractor={(r) => r.claim_id}
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
          }
          renderItem={({ item }) => {
            const sc = statusChip(item.status);
            const cc = coverageChip(item.coverage_decision);
            const needsCoverage = item.coverage_decision == null;
            return (
              <Pressable
                style={styles.row}
                onPress={() => navigation.navigate('AdjusterClaimDetail', { cid: item.claim_id })}
                accessibilityRole="button"
                accessibilityLabel={`${item.venue_name ?? 'Claim'}, ${item.coverage_line}, ${sc.label}`}
              >
                <View style={styles.rowTop}>
                  <Text style={styles.venue} numberOfLines={1}>
                    {item.venue_name ?? item.claim_id}
                  </Text>
                  <View style={styles.chipRow}>
                    {/* Coverage decision chip */}
                    {cc ? (
                      <View style={[styles.chip, { borderColor: cc.color }]}>
                        <Text style={[styles.chipText, { color: cc.color }]}>{cc.label}</Text>
                      </View>
                    ) : (
                      <View style={[styles.chip, { borderColor: Colors.warning, borderStyle: 'dashed' }]}>
                        <Text style={[styles.chipText, { color: Colors.warning }]}>NEEDS COVERAGE</Text>
                      </View>
                    )}
                    {/* Status chip */}
                    <View style={[styles.chip, { borderColor: sc.color }]}>
                      <Text style={[styles.chipText, { color: sc.color }]}>{sc.label}</Text>
                    </View>
                  </View>
                </View>

                <Text style={styles.line} numberOfLines={1}>
                  {lineLabel(item.coverage_line)}
                </Text>

                {item.carrier_claim_number && (
                  <Text style={styles.claimNumber} numberOfLines={1}>
                    {item.carrier_claim_number}
                  </Text>
                )}

                <View style={styles.rowBottom}>
                  <View style={styles.moneyCol}>
                    <Text style={styles.moneyLabel}>RESERVE</Text>
                    <Text style={styles.moneyValue}>{formatLedgerMoney(item.current_reserve)}</Text>
                  </View>
                  <View style={styles.moneyColRight}>
                    <Text style={styles.moneyLabel}>PAID</Text>
                    <Text style={[styles.moneyValue, Number(item.total_paid) > 0 && { color: Colors.accentInk }]}>
                      {formatLedgerMoney(item.total_paid)}
                    </Text>
                  </View>
                </View>

                {needsCoverage && (
                  <View style={styles.urgentBanner}>
                    <Text style={styles.urgentText}>Coverage decision required before payment</Text>
                  </View>
                )}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  headerWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  eyebrow: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  title: {
    fontFamily: Fonts.displayBold,
    fontSize: 32,
    lineHeight: 36,
    color: Colors.text,
    letterSpacing: -0.5,
  },
  subtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, fontFamily: Fonts.sansRegular },

  countRow: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  countPill: {
    borderWidth: 1,
    borderColor: Colors.borderSubtle,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  countPillWarning: { borderColor: Colors.warning },
  countText: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1,
    color: Colors.textSecondary,
  },

  row: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  venue: { fontFamily: Fonts.displayBold, fontSize: 16, color: Colors.text, flex: 1, marginRight: 8 },
  chipRow: { flexDirection: 'row', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 1 },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  chipText: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 0.8 },
  line: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12, marginBottom: 4 },
  claimNumber: { color: Colors.textMuted, fontFamily: Fonts.monoRegular, fontSize: 10, marginBottom: 8 },

  rowBottom: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSubtle,
    paddingTop: 10,
  },
  moneyCol: { alignItems: 'flex-start' },
  moneyColRight: { alignItems: 'flex-end' },
  moneyLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: Colors.textMuted, marginBottom: 2 },
  moneyValue: { fontFamily: Fonts.monoBold, fontSize: 15, color: Colors.text },

  urgentBanner: {
    marginTop: 8,
    backgroundColor: 'rgba(180,83,9,0.08)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(180,83,9,0.25)',
  },
  urgentText: { fontFamily: Fonts.sansMedium, fontSize: 11, color: Colors.warning },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: {
    color: Colors.textSecondary,
    textAlign: 'center',
    fontFamily: Fonts.sansRegular,
    fontSize: 13,
    lineHeight: 18,
  },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: {
    alignSelf: 'flex-start',
    borderColor: Colors.accent,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
