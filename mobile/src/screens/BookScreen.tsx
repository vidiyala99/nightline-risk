/**
 * Broker Book financials — mobile counterpart to web /book.
 *
 * Money rollup across the in-force book: written/earned premium, commission
 * revenue, loss ratio, plus per-coverage-line and per-carrier breakdowns.
 * Loss ratio is shown with a color band AND a text label (never color alone).
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { ChevronRight } from 'lucide-react-native';

import { HandAccent } from '../components/HandAccent';
import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import {
  bookApi,
  fmtUsd,
  fmtLossRatio,
  lossBand,
  type BookFinancials,
  type LossBand,
} from '../api/book';

const BAND_COLOR: Record<LossBand, string> = {
  healthy: Colors.accentInk,
  watch: Colors.warning,
  high: Colors.error,
  none: Colors.textMuted,
};
const BAND_LABEL: Record<LossBand, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  high: 'High',
  none: 'No premium',
};

function LossPill({ value }: { value: string | null }) {
  const band = lossBand(value);
  const color = BAND_COLOR[band];
  return (
    <View style={styles.lossWrap}>
      <Text style={[styles.lossPct, { color }]}>{fmtLossRatio(value)}</Text>
      <View style={[styles.lossPill, { borderColor: color }]}>
        <Text style={[styles.lossPillText, { color }]}>{BAND_LABEL[band]}</Text>
      </View>
    </View>
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

export function BookScreen() {
  const navigation = useNavigation<any>();
  const [data, setData] = useState<BookFinancials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await bookApi.financials());
    } catch (e: any) {
      setError(e?.message ?? "Couldn't load book financials.");
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (data === null && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  const empty = !!data && data.policy_count === 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
    >
      <View style={styles.headerWrap}>
        <Text style={styles.eyebrow}>BROKER · BOOK</Text>
        <Text style={styles.title}>Financials</Text>
        <HandAccent>premium vs losses</HandAccent>
        <Text style={styles.subtitle}>Written premium, commission, and loss ratio across the in-force book.</Text>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : !data ? null : empty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No in-force policies yet — bind a quote to start the book.</Text>
        </View>
      ) : (
        <>
          {/* KPI strip */}
          <View style={styles.kpiGrid}>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>WRITTEN</Text>
              <Text style={styles.kpiValue}>{fmtUsd(data.written_premium)}</Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>EARNED</Text>
              <Text style={styles.kpiValue}>{fmtUsd(data.earned_premium)}</Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>COMMISSION</Text>
              <Text style={styles.kpiValue}>{fmtUsd(data.commission_revenue)}</Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>LOSS RATIO</Text>
              <Text style={[styles.kpiValue, { color: BAND_COLOR[lossBand(data.loss_ratio)] }]}>
                {fmtLossRatio(data.loss_ratio)}
              </Text>
            </View>
          </View>

          <Text style={styles.secondary}>
            {data.policy_count} in-force · incurred {fmtUsd(data.incurred_losses)} · {data.open_claim_count} open{' '}
            {data.open_claim_count === 1 ? 'claim' : 'claims'}
          </Text>

          {/* By coverage line */}
          <Text style={styles.heading}>BY COVERAGE LINE</Text>
          {data.by_coverage_line.map((r) => (
            <View key={r.coverage_line} style={styles.rowCard}>
              <View style={styles.rowTop}>
                <Text style={styles.rowName}>{r.coverage_line.replace(/_/g, ' ').toUpperCase()}</Text>
                <LossPill value={r.loss_ratio} />
              </View>
              <View style={styles.miniRow}>
                <MiniCell label="Written" value={fmtUsd(r.written_premium)} />
                <MiniCell label="Earned" value={fmtUsd(r.earned_premium)} />
                <MiniCell label="Incurred" value={fmtUsd(r.incurred_losses)} />
              </View>
            </View>
          ))}

          {/* By carrier — tap a carrier to drill into its appetite + book */}
          <Text style={styles.heading}>BY CARRIER</Text>
          {data.by_carrier.map((r) => (
            <Pressable
              key={r.carrier_id}
              onPress={() => navigation.navigate('CarrierDetail', { carrierId: r.carrier_id })}
              style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
              accessibilityRole="button"
              accessibilityLabel={`${r.carrier_name}, view carrier detail`}
            >
              <View style={styles.rowTop}>
                <Text style={styles.rowName} numberOfLines={1}>{r.carrier_name}</Text>
                <View style={styles.rowTopRight}>
                  <LossPill value={r.loss_ratio} />
                  <ChevronRight size={16} color={Colors.textMuted} />
                </View>
              </View>
              <View style={styles.miniRow}>
                <MiniCell label={`${r.policy_count} ${r.policy_count === 1 ? 'policy' : 'policies'}`} value={fmtUsd(r.written_premium)} />
                <MiniCell label="Commission" value={fmtUsd(r.commission)} />
                <MiniCell label="Incurred" value={fmtUsd(r.incurred_losses)} />
              </View>
            </Pressable>
          ))}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },

  headerWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 32, lineHeight: 36, color: Colors.text, letterSpacing: -0.5 },
  subtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, fontFamily: Fonts.sansRegular },

  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16, marginBottom: 12 },
  kpiCell: {
    flexGrow: 1,
    flexBasis: '46%',
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 4,
  },
  kpiLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: Colors.textMuted },
  kpiValue: { fontFamily: Fonts.displayBold, fontSize: 22, color: Colors.text, letterSpacing: -0.5 },

  secondary: { paddingHorizontal: 20, marginBottom: 8, color: Colors.textMuted, fontFamily: Fonts.monoRegular, fontSize: 11 },

  heading: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: Colors.textSecondary,
    marginTop: 18,
    marginBottom: 8,
    paddingHorizontal: 20,
  },
  rowCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  rowCardPressed: { opacity: 0.6 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 },
  rowTopRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { flex: 1, fontFamily: Fonts.sansSemiBold, fontSize: 14, color: Colors.text },

  lossWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lossPct: { fontFamily: Fonts.monoBold, fontSize: 13 },
  lossPill: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  lossPillText: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 0.5 },

  miniRow: { flexDirection: 'row', gap: 12 },
  miniCell: { flex: 1 },
  miniLabel: { fontFamily: Fonts.monoRegular, fontSize: 9, letterSpacing: 0.5, color: Colors.textMuted, marginBottom: 2 },
  miniValue: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: { color: Colors.textSecondary, textAlign: 'center', fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
