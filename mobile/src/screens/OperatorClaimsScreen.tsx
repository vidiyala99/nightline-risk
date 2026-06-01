/**
 * Operator "Your claims" — mobile counterpart to web /claims (operator branch,
 * OperatorClaimsTracker). Every incident the operator sent to their broker, and
 * exactly where each one stands: In-flight / Filed / Resolved, a plain-language
 * status, and a Reported→Sent→Approved→Filed→Resolved stepper.
 *
 * Tapping a claim opens its incident detail, where the inline "WHERE THIS STANDS"
 * tracker lives (mirrors web row → /incidents/[id]/claim-status). Operator-only.
 */
import React, { useCallback, useMemo, useState } from 'react';
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

import { HandAccent } from '../components/HandAccent';
import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { useAuth } from '../contexts/AuthContext';
import {
  operatorClaimsApi,
  isClaimRow,
  claimIsResolved,
  claimIsFiled,
  claimStatusLabel,
  claimSteps,
  type ClaimFeedRow,
  type ClaimTone,
} from '../api/operatorClaims';

const TONE_COLOR: Record<ClaimTone, string> = {
  info: Colors.accentInk,
  success: Colors.accentInk,
  warning: Colors.warning,
  error: Colors.error,
  neutral: Colors.textSecondary,
};

type Filter = 'active' | 'all' | 'resolved';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'active', label: 'In flight' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

function Kpi({ label, value, lit }: { label: string; value: number; lit?: boolean }) {
  return (
    <View style={styles.kpiCell}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, lit && { color: Colors.accentInk }]}>
        {value.toString().padStart(2, '0')}
      </Text>
    </View>
  );
}

export function OperatorClaimsScreen() {
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const venueId = user?.tenant_id ?? null;

  const [rows, setRows] = useState<ClaimFeedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('active');

  const load = useCallback(async () => {
    if (!venueId) { setRows([]); return; }
    setError(null);
    try {
      const data = await operatorClaimsApi.feed(venueId);
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e?.message ?? "Couldn't load your claims.");
    }
  }, [venueId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Only incidents that have entered the claim journey.
  const claims = useMemo(() => (rows ?? []).filter(isClaimRow), [rows]);
  const resolvedCount = claims.filter(claimIsResolved).length;
  const filedCount = claims.filter(claimIsFiled).length;
  const inFlightCount = claims.length - resolvedCount - filedCount;

  const visible = useMemo(() => {
    const list = claims.filter((r) => {
      if (filter === 'all') return true;
      if (filter === 'resolved') return claimIsResolved(r);
      return !claimIsResolved(r);
    });
    return [...list].sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  }, [claims, filter]);

  if (rows === null && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
    >
      <View style={styles.headerWrap}>
        <Text style={styles.eyebrow}>OPERATOR · VENUE</Text>
        <Text style={styles.title}>Your claims</Text>
        <HandAccent>where things stand</HandAccent>
        <Text style={styles.subtitle}>
          Every incident you&apos;ve sent to your broker — and exactly where each one stands.
        </Text>
      </View>

      {/* KPI strip */}
      <View style={styles.kpiGrid}>
        <Kpi label="IN FLIGHT" value={inFlightCount} lit={inFlightCount > 0} />
        <Kpi label="FILED" value={filedCount} />
        <Kpi label="RESOLVED" value={resolvedCount} />
      </View>

      {/* Filter chips */}
      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[styles.chip, filter === f.key && styles.chipActive]}
            onPress={() => setFilter(f.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === f.key }}
          >
            <Text style={[styles.chipText, filter === f.key && styles.chipTextActive]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {claims.length === 0
              ? "You haven't sent any incidents to your broker yet."
              : 'No claims match this filter.'}
          </Text>
        </View>
      ) : (
        visible.map((r) => {
          const s = claimStatusLabel(r);
          const color = TONE_COLOR[s.tone];
          const steps = claimSteps(r);
          return (
            <Pressable
              key={r.incident_id}
              onPress={() => navigation.navigate('IncidentDetail', { incidentId: r.incident_id })}
              style={({ pressed }) => [styles.rowCard, { borderLeftWidth: 3, borderLeftColor: color }, pressed && styles.rowCardPressed]}
              accessibilityRole="button"
              accessibilityLabel={`${r.summary}. ${s.text}`}
            >
              <Text style={styles.summary} numberOfLines={2}>{r.summary || 'Incident'}</Text>
              <Text style={[styles.statusText, { color }]}>{s.text}</Text>

              <View style={styles.stepperRow}>
                {steps.map((step, i) => (
                  <View key={step.label} style={styles.step}>
                    <Text style={[styles.stepGlyph, { color: step.lit ? Colors.accentInk : Colors.textMuted }]}>
                      {step.lit ? '●' : '○'}
                    </Text>
                    <Text style={[styles.stepLabel, step.lit && { color: Colors.accentInk }]} numberOfLines={1}>
                      {step.label}
                    </Text>
                    {i < steps.length - 1 && <Text style={styles.stepSep}>·</Text>}
                  </View>
                ))}
              </View>

              <Text style={styles.date}>
                {new Date(r.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            </Pressable>
          );
        })
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

  kpiGrid: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginBottom: 12 },
  kpiCell: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 4,
  },
  kpiLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: Colors.textMuted },
  kpiValue: { fontFamily: Fonts.displayBold, fontSize: 24, color: Colors.text, letterSpacing: -0.5 },

  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 12 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100, borderWidth: 1, borderColor: Colors.borderSubtle, minHeight: 36, justifyContent: 'center' },
  chipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(200,240,0,0.08)' },
  chipText: { color: Colors.textMuted, fontSize: 12, fontFamily: Fonts.sansSemiBold },
  chipTextActive: { color: Colors.accentInk },

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
  summary: { fontFamily: Fonts.sansSemiBold, fontSize: 14, color: Colors.text, lineHeight: 19 },
  statusText: { fontFamily: Fonts.sansSemiBold, fontSize: 13, marginTop: 6 },

  stepperRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 10 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  stepGlyph: { fontSize: 10 },
  stepLabel: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted, letterSpacing: 0.3 },
  stepSep: { color: Colors.textMuted, fontSize: 10, marginHorizontal: 2 },

  date: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted, marginTop: 10 },

  empty: { paddingHorizontal: 24, paddingVertical: 32, alignItems: 'center' },
  emptyText: { color: Colors.textSecondary, textAlign: 'center', fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
