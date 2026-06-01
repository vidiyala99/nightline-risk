/**
 * Carrier detail — mobile counterpart to web /carriers/[cid].
 *
 * Reached by tapping a "By carrier" row on BookScreen. Shows carrier identity,
 * appetite tags (venue types / coverage lines / max capacity), a KPI strip
 * (written premium, commission, loss ratio), and the in-force policies placed
 * with the carrier. Money is STRING; loss ratio carries a color band AND a text
 * label (never color alone). Broker-only surface.
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
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { ChevronLeft } from 'lucide-react-native';

import { HandAccent } from '../components/HandAccent';
import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { fmtUsd, fmtLossRatio, lossBand, type LossBand } from '../api/book';
import { carriersApi, type CarrierDetail } from '../api/carriers';

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

function Tag({ children }: { children: string }) {
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{children}</Text>
    </View>
  );
}

export function CarrierDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const carrierId: string = route.params?.carrierId;

  const [data, setData] = useState<CarrierDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await carriersApi.detail(carrierId));
    } catch (e: any) {
      setError(e?.message ?? "Couldn't load this carrier.");
    }
  }, [carrierId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const openPolicy = useCallback(
    (pid: string) => navigation.navigate('Policies', { screen: 'PolicyDetail', params: { pid } }),
    [navigation],
  );

  if (data === null && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  const band = data ? lossBand(data.book.loss_ratio) : 'none';
  const a = data?.appetite ?? {};

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
    >
      <Pressable
        onPress={() => navigation.goBack()}
        style={styles.backRow}
        accessibilityRole="button"
        accessibilityLabel="Back to financials"
        hitSlop={8}
      >
        <ChevronLeft size={18} color={Colors.textSecondary} />
        <Text style={styles.backText}>Financials</Text>
      </Pressable>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : !data ? null : (
        <>
          <View style={styles.headerWrap}>
            <Text style={styles.eyebrow}>BROKER · CARRIER</Text>
            <Text style={styles.title}>{data.name}</Text>
            <HandAccent>appetite vs book</HandAccent>
            <Text style={styles.subtitle}>
              {[
                data.market_type?.toUpperCase(),
                data.am_best_rating ? `A.M. Best ${data.am_best_rating}` : null,
                data.naic_code ? `NAIC ${data.naic_code}` : null,
              ]
                .filter(Boolean)
                .join('  ·  ')}
            </Text>
            {data.contact_email ? <Text style={styles.contact}>{data.contact_email}</Text> : null}
          </View>

          {/* KPI strip */}
          <View style={styles.kpiGrid}>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>WRITTEN</Text>
              <Text style={styles.kpiValue}>{fmtUsd(data.book.written_premium)}</Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>COMMISSION</Text>
              <Text style={styles.kpiValue}>{fmtUsd(data.book.commission)}</Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>LOSS RATIO</Text>
              <View style={styles.lossWrap}>
                <Text style={[styles.kpiValue, { color: BAND_COLOR[band] }]}>
                  {fmtLossRatio(data.book.loss_ratio)}
                </Text>
                <View style={[styles.lossPill, { borderColor: BAND_COLOR[band] }]}>
                  <Text style={[styles.lossPillText, { color: BAND_COLOR[band] }]}>{BAND_LABEL[band]}</Text>
                </View>
              </View>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>EARNED</Text>
              <Text style={styles.kpiValue}>{fmtUsd(data.book.earned_premium)}</Text>
            </View>
          </View>

          {/* Appetite */}
          <Text style={styles.heading}>APPETITE</Text>
          <View style={styles.rowCard}>
            <Text style={styles.fieldLabel}>Venue types</Text>
            <View style={styles.tagWrap}>
              {a.venue_types && a.venue_types.length > 0
                ? a.venue_types.map((t) => <Tag key={t}>{t.replace(/_/g, ' ')}</Tag>)
                : <Text style={styles.anyText}>Any</Text>}
            </View>
            <Text style={[styles.fieldLabel, { marginTop: 14 }]}>Coverage lines written</Text>
            <View style={styles.tagWrap}>
              {a.coverage_lines && a.coverage_lines.length > 0
                ? a.coverage_lines.map((l) => <Tag key={l}>{l}</Tag>)
                : <Text style={styles.anyText}>Any</Text>}
            </View>
            <Text style={[styles.fieldLabel, { marginTop: 14 }]}>Max venue capacity</Text>
            <Text style={styles.capValue}>
              {a.max_capacity != null ? a.max_capacity.toLocaleString() : '—'}
            </Text>
          </View>

          {/* In-force policies */}
          <Text style={styles.heading}>IN-FORCE POLICIES ({data.book.policy_count})</Text>
          {data.policies.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No in-force policies placed with this carrier.</Text>
            </View>
          ) : (
            data.policies.map((p) => (
              <Pressable
                key={p.policy_id}
                onPress={() => openPolicy(p.policy_id)}
                style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
                accessibilityRole="button"
                accessibilityLabel={`Policy ${p.policy_number ?? p.policy_id}, ${p.venue_id}`}
              >
                <View style={styles.rowTop}>
                  <Text style={styles.policyNum} numberOfLines={1}>
                    {p.policy_number ?? p.policy_id}
                  </Text>
                  <Text style={styles.policyPremium}>{fmtUsd(p.annual_premium)}</Text>
                </View>
                <View style={styles.rowBottom}>
                  <Text style={styles.policyMeta} numberOfLines={1}>
                    {p.venue_id} · {p.status.replace(/_/g, ' ')}
                  </Text>
                  <Text style={styles.policyTerm}>
                    {p.effective_date} → {p.expiration_date}
                  </Text>
                </View>
              </Pressable>
            ))
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },

  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, minHeight: 44 },
  backText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 14, marginLeft: 2 },

  headerWrap: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 30, lineHeight: 34, color: Colors.text, letterSpacing: -0.5 },
  subtitle: { color: Colors.textSecondary, fontSize: 12, marginTop: 4, fontFamily: Fonts.monoRegular },
  contact: { color: Colors.textMuted, fontSize: 12, marginTop: 2, fontFamily: Fonts.monoRegular },

  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16, marginBottom: 4 },
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

  lossWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lossPill: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  lossPillText: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 0.5 },

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

  fieldLabel: { fontFamily: Fonts.monoRegular, fontSize: 9, letterSpacing: 0.5, color: Colors.textMuted, marginBottom: 6 },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  tagText: { fontFamily: Fonts.monoRegular, fontSize: 11, color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.4 },
  anyText: { fontFamily: Fonts.sansRegular, fontSize: 12, color: Colors.textMuted },
  capValue: { fontFamily: Fonts.monoBold, fontSize: 14, color: Colors.text },

  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  rowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 6 },
  policyNum: { flex: 1, fontFamily: Fonts.sansSemiBold, fontSize: 14, color: Colors.accentInk },
  policyPremium: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text },
  policyMeta: { flex: 1, fontFamily: Fonts.sansRegular, fontSize: 12, color: Colors.textSecondary, textTransform: 'capitalize' },
  policyTerm: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted },

  empty: { paddingHorizontal: 20, paddingVertical: 16 },
  emptyText: { color: Colors.textSecondary, fontFamily: Fonts.sansRegular, fontSize: 13 },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
