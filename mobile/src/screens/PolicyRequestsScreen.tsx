/**
 * Broker "Policy Requests" queue — mobile counterpart to /policy-requests.
 *
 * The decide half of the propose→decide loop: operators raise requests from
 * their Coverage screen; brokers approve/decline here. Nested in
 * PortfolioStack, reached from the broker dashboard. Styling mirrors
 * CarrierClaimsListScreen (filter chips) + RenewalsScreen.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useResponsive } from '../hooks/useResponsive';
import {
  policyRequestsApi,
  REQUEST_STATUS_COLOR,
  REQUEST_STATUS_LABEL,
  REQUEST_TYPE_LABEL,
  type PolicyRequest,
  type PolicyRequestStatus,
} from '../api/policyRequests';
import { Fonts } from '../theme/typography';

type Filter = 'pending' | 'approved' | 'declined' | 'all';
const FILTERS: Filter[] = ['pending', 'approved', 'declined', 'all'];

function detailLine(r: PolicyRequest): string | null {
  const p = r.payload || {};
  if (r.request_type === 'cancellation' && p.cancellation_date) return `Out by ${p.cancellation_date}`;
  if (r.request_type === 'coi' && p.certificate_holder) return `Holder: ${p.certificate_holder}`;
  return null;
}

export function PolicyRequestsScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { isTablet } = useResponsive();
  const [rows, setRows] = useState<PolicyRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('pending');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await policyRequestsApi.list()); }
    catch (e: any) { setError(e?.message ?? 'Failed to load requests'); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await load(); setRefreshing(false);
  }, [load]);

  const visible = useMemo(() => {
    if (!rows) return [];
    if (filter === 'all') return rows;
    return rows.filter((r) => r.status === (filter as PolicyRequestStatus));
  }, [rows, filter]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { pending: 0, approved: 0, declined: 0, all: rows?.length ?? 0 };
    rows?.forEach((r) => { if (r.status in c) (c as any)[r.status] += 1; });
    return c;
  }, [rows]);

  async function runDecision(r: PolicyRequest, decision: 'approved' | 'declined') {
    setBusyId(r.id);
    try { await policyRequestsApi.decide(r.id, decision); await load(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not record the decision'); }
    finally { setBusyId(null); }
  }

  function decide(r: PolicyRequest, decision: 'approved' | 'declined') {
    if (decision === 'declined') {
      Alert.alert('Decline request?', `Decline this ${REQUEST_TYPE_LABEL[r.request_type].toLowerCase()} request from ${r.venue_id}?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Decline', style: 'destructive', onPress: () => runDecision(r, 'declined') },
      ]);
    } else {
      runDecision(r, 'approved');
    }
  }

  if (rows === null && !error) {
    return <View style={styles.center}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={visible}
        keyExtractor={(r) => r.id}
        contentContainerStyle={[
          { paddingBottom: 32, paddingTop: insets.top + 12 },
          isTablet && { maxWidth: 720, alignSelf: 'center', width: '100%' },
        ]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListHeaderComponent={
          <View>
            <Pressable style={styles.backRow} onPress={() => navigation.goBack()}>
              <Text style={styles.backArrow}>←</Text>
              <Text style={styles.backLabel}>Portfolio</Text>
            </Pressable>
            <View style={styles.headerWrap}>
              <Text style={styles.eyebrow}>BROKER · REQUESTS</Text>
              <Text style={styles.title}>Policy requests</Text>
              <Text style={styles.subtitle}>What your venues have asked you to action.</Text>
            </View>
            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
                <Pressable onPress={load} style={styles.retryBtn}><Text style={styles.retryText}>Retry</Text></Pressable>
              </View>
            )}
            <View style={styles.filterBar}>
              {FILTERS.map((f) => {
                const active = filter === f;
                return (
                  <Pressable key={f} onPress={() => setFilter(f)} style={[styles.chip, active && styles.chipActive]}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {f[0].toUpperCase() + f.slice(1)}
                    </Text>
                    <Text style={[styles.chipCount, active && styles.chipCountActive]}>{counts[f]}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        }
        ListEmptyComponent={
          error ? null : (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {filter === 'pending' ? "No pending requests. You're all caught up." : 'Nothing here for this filter.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const detail = detailLine(item);
          return (
            <View style={styles.row}>
              <View style={styles.rowTop}>
                <Text style={styles.rowVenue} numberOfLines={1}>{item.venue_id}</Text>
                <Text style={[styles.rowStatus, { color: REQUEST_STATUS_COLOR[item.status] }]}>
                  {REQUEST_STATUS_LABEL[item.status]}
                </Text>
              </View>
              <Text style={styles.rowType}>{REQUEST_TYPE_LABEL[item.request_type]}</Text>
              {!!(item.note || detail) && (
                <Text style={styles.rowNote} numberOfLines={2}>
                  {item.note || detail}{item.note && detail ? ` · ${detail}` : ''}
                </Text>
              )}
              {item.status === 'pending' ? (
                <View style={styles.actions}>
                  <Pressable
                    style={[styles.actionBtn, styles.declineBtn]}
                    disabled={busyId === item.id}
                    onPress={() => decide(item, 'declined')}
                  >
                    <Text style={styles.declineText}>Decline</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.actionBtn, styles.approveBtn, busyId === item.id && styles.btnBusy]}
                    disabled={busyId === item.id}
                    onPress={() => decide(item, 'approved')}
                  >
                    <Text style={styles.approveText}>{busyId === item.id ? '…' : 'Approve'}</Text>
                  </Pressable>
                </View>
              ) : (
                item.decided_by ? <Text style={styles.decidedBy}>by {item.decided_by}</Text> : null
              )}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 4 },
  backArrow: { color: Colors.accentInk, fontSize: 18, marginRight: 8, fontFamily: Fonts.monoBold },
  backLabel: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 13 },
  headerWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 32, lineHeight: 36, color: Colors.text, letterSpacing: -0.5 },
  subtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, fontFamily: Fonts.sansRegular },

  filterBar: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginTop: 16, marginBottom: 12, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  chipActive: { borderColor: Colors.accent },
  chipText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12 },
  chipTextActive: { color: Colors.accentInk },
  chipCount: { color: Colors.textSecondary, fontFamily: Fonts.monoBold, fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: 'rgba(23,21,15,0.06)' },
  chipCountActive: { color: Colors.accentInk },

  row: {
    marginHorizontal: 16, marginBottom: 10, padding: 14, backgroundColor: Colors.surface,
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  rowVenue: { fontFamily: Fonts.sansMedium, fontSize: 13, color: Colors.text, flex: 1, marginRight: 8 },
  rowStatus: { fontFamily: Fonts.monoBold, fontSize: 11 },
  rowType: { fontFamily: Fonts.monoBold, fontSize: 12, color: Colors.accentInk, marginBottom: 4 },
  rowNote: { color: Colors.textSecondary, fontFamily: Fonts.sansRegular, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  actions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  actionBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6 },
  declineBtn: { borderWidth: 1, borderColor: Colors.error },
  declineText: { color: Colors.error, fontFamily: Fonts.sansMedium, fontSize: 13 },
  approveBtn: { backgroundColor: Colors.accent },
  approveText: { color: Colors.text, fontFamily: Fonts.sansBold, fontSize: 13 },
  btnBusy: { opacity: 0.5 },
  decidedBy: { color: Colors.textMuted, fontFamily: Fonts.monoRegular, fontSize: 11, textAlign: 'right' },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: { color: Colors.textSecondary, textAlign: 'center', fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },
  errorBox: { paddingHorizontal: 20, paddingVertical: 16 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
