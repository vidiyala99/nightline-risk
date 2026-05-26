/**
 * Broker policies — mobile counterpart to /policies on web.
 *
 * Lists the working book with a status filter. Tap a row to open the
 * policy detail (endorsements, COIs, claims, and core actions). Styling
 * mirrors SubmissionsListScreen / CarrierClaimsListScreen.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { HandAccent } from '../components/HandAccent';
import { Colors } from '../theme/colors';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import {
  policiesApi,
  POLICY_STATUS_LABEL,
  POLICY_STATUS_COLOR,
  type Policy,
  type PolicyStatus,
} from '../api/policies';
import { formatLedgerMoney } from '../api/claim-tokens';
import { Fonts } from '../theme/typography';

type Filter = 'active' | PolicyStatus | 'all';
const FILTERS: Filter[] = ['active', 'bound_pending_number', 'cancelled', 'all'];

function filterLabel(f: Filter): string {
  if (f === 'active') return 'Active';
  if (f === 'all') return 'All';
  return POLICY_STATUS_LABEL[f];
}

export function PoliciesListScreen({ navigation }: any) {
  const [rows, setRows] = useState<Policy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('active');

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await policiesApi.list({ status: 'all' });
      setRows(data);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load policies');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const visible = useMemo(() => {
    if (!rows) return [] as Policy[];
    const list =
      filter === 'all'
        ? rows
        : filter === 'active'
          ? rows.filter((p) => p.status === 'active' || p.status === 'bound_pending_number')
          : rows.filter((p) => p.status === filter);
    return [...list].sort((a, b) => (b.bound_at ?? '').localeCompare(a.bound_at ?? ''));
  }, [rows, filter]);

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
        <Text style={styles.eyebrow}>BROKER · BOOK</Text>
        <Text style={styles.title}>Policies</Text>
        <HandAccent>bound and active</HandAccent>
        <Text style={styles.subtitle}>Your in-force book.</Text>
      </View>

      <View style={styles.filterBar}>
        <FlatList
          horizontal
          data={FILTERS}
          keyExtractor={(f) => f}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          renderItem={({ item: f }) => {
            const active = filter === f;
            return (
              <Pressable
                onPress={() => setFilter(f)}
                style={[styles.filterChip, active && styles.filterChipActive]}
              >
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {filterLabel(f)}
                </Text>
              </Pressable>
            );
          }}
        />
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
            {rows!.length === 0
              ? 'No policies yet. Bind a quote from a submission to create one.'
              : 'No policies match this filter.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => navigation.navigate('PolicyDetail', { pid: item.id })}
            >
              <View style={styles.rowTop}>
                <Text style={styles.rowId} numberOfLines={1}>
                  {item.policy_number ?? item.venue_id}
                </Text>
                <Text style={[styles.statusPill, { color: POLICY_STATUS_COLOR[item.status] }]}>
                  {POLICY_STATUS_LABEL[item.status]}
                </Text>
              </View>
              <Text style={styles.metaText} numberOfLines={1}>
                {item.policy_number ? `${item.venue_id} · ${item.carrier_id}` : item.carrier_id}
              </Text>
              <View style={styles.rowMoney}>
                <View style={styles.moneyCol}>
                  <Text style={styles.moneyLabel}>PREMIUM</Text>
                  <Text style={styles.moneyValue}>{formatLedgerMoney(item.annual_premium)}</Text>
                </View>
                <View style={styles.moneyCol}>
                  <Text style={styles.moneyLabel}>EFFECTIVE</Text>
                  <Text style={styles.moneyValueText}>{item.effective_date}</Text>
                </View>
                <View style={styles.moneyCol}>
                  <Text style={styles.moneyLabel}>EXPIRES</Text>
                  <Text style={styles.moneyValueText}>{item.expiration_date}</Text>
                </View>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  headerWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 32, lineHeight: 36, color: Colors.text, letterSpacing: -0.5 },
  subtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, fontFamily: Fonts.sansRegular },

  filterBar: { marginTop: 16, marginBottom: 12 },
  filterRow: { paddingHorizontal: 20, gap: 8 },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  filterChipActive: { borderColor: Colors.accent },
  filterText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12 },
  filterTextActive: { color: Colors.accentInk },

  row: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  rowId: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text, flex: 1, marginRight: 8 },
  statusPill: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1 },
  metaText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12, marginBottom: 10 },

  rowMoney: {
    flexDirection: 'row',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSubtle,
    paddingTop: 10,
  },
  moneyCol: { flex: 1 },
  moneyLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: Colors.textMuted, marginBottom: 2 },
  moneyValue: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text },
  moneyValueText: { fontFamily: Fonts.monoRegular, fontSize: 12, color: Colors.text },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: { color: Colors.textSecondary, textAlign: 'center', fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
