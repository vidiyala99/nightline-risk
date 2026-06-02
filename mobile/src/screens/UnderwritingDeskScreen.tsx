/**
 * Carrier underwriting desk — submissions awaiting Nightline's own decision.
 * Tap a row to quote-at-terms or decline. Mirrors the web /underwriting queue.
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
import { tierColor } from '../theme/tiers';
import {
  fetchUnderwritingQueue,
  fmtMoney,
  lineLabel,
  type QueueRow,
} from '../api/underwriting';

export function UnderwritingDeskScreen({ navigation }: any) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await fetchUnderwritingQueue());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load the underwriting queue.');
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
        <Text style={styles.eyebrow}>CARRIER · UNDERWRITING</Text>
        <Text style={styles.title}>Underwriting desk</Text>
        <HandAccent>your call now</HandAccent>
        <Text style={styles.subtitle}>
          Broker submissions awaiting a decision. The engine suggests a premium for each.
        </Text>
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
            Desk clear — no submissions awaiting an underwriting decision.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows!}
          keyExtractor={(r) => r.quote_id}
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
          }
          renderItem={({ item }) => {
            const suggested = item.suggested_premium_breakdown?.total ?? null;
            return (
              <Pressable
                style={styles.row}
                onPress={() => navigation.navigate('UnderwriteDecision', { qid: item.quote_id })}
              >
                <View style={styles.rowTop}>
                  <Text style={styles.venue} numberOfLines={1}>
                    {item.venue_name}
                  </Text>
                  <View style={[styles.tierPill, { borderColor: tierColor(item.risk.tier) }]}>
                    <Text style={[styles.tierText, { color: tierColor(item.risk.tier) }]}>
                      {item.risk.tier}
                    </Text>
                  </View>
                </View>
                <Text style={styles.lines} numberOfLines={1}>
                  {item.coverage_lines.map(lineLabel).join(' · ') || 'Coverage TBD'}
                </Text>
                <View style={styles.rowBottom}>
                  <Text style={styles.scoreLabel}>
                    RISK <Text style={styles.score}>{item.risk.total_score}</Text>
                  </Text>
                  <View style={styles.premiumCol}>
                    <Text style={styles.premiumLabel}>SUGGESTED</Text>
                    <Text style={styles.premium}>{suggested != null ? fmtMoney(suggested) : '—'}</Text>
                  </View>
                </View>
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

  row: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  venue: { fontFamily: Fonts.displayBold, fontSize: 16, color: Colors.text, flex: 1, marginRight: 8 },
  tierPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  tierText: { fontFamily: Fonts.monoBold, fontSize: 12 },
  lines: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12, marginBottom: 10 },
  rowBottom: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSubtle,
    paddingTop: 10,
  },
  scoreLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: Colors.textMuted },
  score: { fontFamily: Fonts.monoBold, fontSize: 14, color: Colors.text },
  premiumCol: { alignItems: 'flex-end' },
  premiumLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: Colors.textMuted, marginBottom: 2 },
  premium: { fontFamily: Fonts.monoBold, fontSize: 16, color: Colors.accentInk },

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
