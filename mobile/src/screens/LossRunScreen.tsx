/**
 * Per-venue loss run — mobile counterpart of web /risk-profile/[id]/loss-run.
 *
 * Full claims history (open + closed) with reserves/paid/incurred, summary
 * totals, per-coverage-line rollup, and a CSV export via the OS share sheet.
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
import { lossRunApi, shareLossRunCsv, fmtUsd, type LossRun } from '../api/lossRun';

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

export function LossRunScreen({ route, navigation }: any) {
  const venueId: string = route.params.venueId;

  const [data, setData] = useState<LossRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await lossRunApi.get(venueId));
    } catch (e: any) {
      setError(e?.message ?? "Couldn't load the loss run.");
    }
  }, [venueId]);

  useEffect(() => { load(); }, [load]);

  const onShare = useCallback(async () => {
    setSharing(true);
    try {
      await shareLossRunCsv(venueId);
    } catch {
      setError('Export failed. Try again.');
    } finally {
      setSharing(false);
    }
  }, [venueId]);

  if (data === null && !error) {
    return <View style={styles.center}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  const s = data?.summary;
  const empty = !!data && s!.claim_count === 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <Pressable style={styles.backRow} onPress={() => navigation.goBack()}>
        <Text style={styles.backArrow}>←</Text>
        <Text style={styles.backLabel}>Risk profile</Text>
      </Pressable>

      <View style={styles.headerWrap}>
        <Text style={styles.eyebrow}>BROKER · LOSS RUN</Text>
        <Text style={styles.title}>Loss run</Text>
        <Text style={styles.subtitle}>Full claims history for {venueId.replace(/-/g, ' ')}.</Text>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}><Text style={styles.retryText}>Retry</Text></Pressable>
        </View>
      ) : !data || !s ? null : (
        <>
          <View style={styles.kpiGrid}>
            <View style={styles.kpiCell}><Text style={styles.kpiLabel}>CLAIMS</Text><Text style={styles.kpiValue}>{s.claim_count}</Text></View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>OPEN</Text>
              <Text style={[styles.kpiValue, s.open_count > 0 && { color: Colors.warning }]}>{s.open_count}</Text>
            </View>
            <View style={styles.kpiCell}><Text style={styles.kpiLabel}>INCURRED</Text><Text style={styles.kpiValue}>{fmtUsd(s.total_incurred)}</Text></View>
          </View>

          <Text style={styles.secondary}>
            reserves {fmtUsd(s.total_reserve)} · paid {fmtUsd(s.total_paid)} · recoveries {fmtUsd(s.total_recoveries)}
          </Text>

          {!empty && (
            <Pressable
              style={[styles.exportBtn, sharing && styles.btnDisabled]}
              disabled={sharing}
              onPress={onShare}
            >
              <Text style={styles.exportBtnText}>{sharing ? 'Exporting…' : '⤓  Export CSV'}</Text>
            </Pressable>
          )}

          {empty ? (
            <View style={styles.empty}><Text style={styles.emptyText}>No claims on file — a clean loss run.</Text></View>
          ) : (
            <>
              <Text style={styles.heading}>BY COVERAGE LINE</Text>
              {data.by_coverage_line.map((r) => (
                <View key={r.coverage_line} style={styles.rowCard}>
                  <View style={styles.rowTop}>
                    <Text style={styles.rowName}>{r.coverage_line.replace(/_/g, ' ').toUpperCase()}</Text>
                    <Text style={styles.rowCount}>{r.claim_count} {r.claim_count === 1 ? 'claim' : 'claims'}</Text>
                  </View>
                  <View style={styles.miniRow}>
                    <MiniCell label="Reserve" value={fmtUsd(r.reserve)} />
                    <MiniCell label="Paid" value={fmtUsd(r.paid)} />
                    <MiniCell label="Incurred" value={fmtUsd(r.incurred)} />
                  </View>
                </View>
              ))}

              <Text style={styles.heading}>CLAIMS HISTORY</Text>
              {data.claims.map((c) => (
                <View key={c.claim_id} style={styles.rowCard}>
                  <View style={styles.rowTop}>
                    <Text style={styles.rowName} numberOfLines={1}>{c.carrier_claim_number ?? c.claim_id}</Text>
                    <Text style={styles.rowDate}>{fmtDate(c.date_of_loss)}</Text>
                  </View>
                  <Text style={styles.claimMeta}>
                    {c.coverage_line.toUpperCase()} · {c.status.replace(/_/g, ' ')}
                  </Text>
                  <View style={styles.miniRow}>
                    <MiniCell label="Reserve" value={fmtUsd(c.current_reserve)} />
                    <MiniCell label="Paid" value={fmtUsd(c.indemnity_paid)} />
                    <MiniCell label="Incurred" value={fmtUsd(c.total_incurred)} />
                  </View>
                </View>
              ))}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

function MiniCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.miniCell}>
      <Text style={styles.miniLabel}>{label}</Text>
      <Text style={styles.miniValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },

  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  backArrow: { color: Colors.accentInk, fontSize: 18, marginRight: 8, fontFamily: Fonts.monoBold },
  backLabel: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 13 },

  headerWrap: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 30, lineHeight: 34, color: Colors.text, letterSpacing: -0.5 },
  subtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, fontFamily: Fonts.sansRegular, textTransform: 'capitalize' },

  kpiGrid: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginBottom: 10 },
  kpiCell: {
    flex: 1, backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12, gap: 4,
  },
  kpiLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: Colors.textMuted },
  kpiValue: { fontFamily: Fonts.displayBold, fontSize: 20, color: Colors.text, letterSpacing: -0.5 },

  secondary: { paddingHorizontal: 20, marginBottom: 12, color: Colors.textMuted, fontFamily: Fonts.monoRegular, fontSize: 11 },

  exportBtn: {
    marginHorizontal: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.accent,
    borderRadius: 8, paddingVertical: 12, alignItems: 'center',
  },
  exportBtnText: { color: Colors.accentInk, fontFamily: Fonts.monoBold, fontSize: 12, letterSpacing: 1 },
  btnDisabled: { opacity: 0.4 },

  heading: {
    fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary,
    marginTop: 18, marginBottom: 8, paddingHorizontal: 20,
  },
  rowCard: {
    marginHorizontal: 16, marginBottom: 8, padding: 14, backgroundColor: Colors.surface,
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 },
  rowName: { flex: 1, fontFamily: Fonts.sansSemiBold, fontSize: 14, color: Colors.text },
  rowCount: { fontFamily: Fonts.monoRegular, fontSize: 11, color: Colors.textMuted },
  rowDate: { fontFamily: Fonts.monoRegular, fontSize: 11, color: Colors.textMuted },
  claimMeta: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted, marginBottom: 8, letterSpacing: 0.3 },

  miniRow: { flexDirection: 'row', gap: 12 },
  miniCell: { flex: 1 },
  miniLabel: { fontFamily: Fonts.monoRegular, fontSize: 9, letterSpacing: 0.5, color: Colors.textMuted, marginBottom: 2 },
  miniValue: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: { color: Colors.textSecondary, textAlign: 'center', fontFamily: Fonts.sansRegular, fontSize: 13 },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
