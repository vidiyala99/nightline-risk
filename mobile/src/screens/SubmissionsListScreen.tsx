/**
 * Broker submissions — mobile counterpart to /submissions on web.
 *
 * Lists placement submissions with a status filter. Tap a row to open the
 * detail screen (carrier quotes + market actions). Styling mirrors
 * CarrierClaimsListScreen / RenewalsScreen.
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
  submissionsApi,
  SUBMISSION_STATUS_LABEL,
  SUBMISSION_STATUS_COLOR,
  type Submission,
  type SubmissionStatus,
} from '../api/submissions';
import { Fonts } from '../theme/typography';

type Filter = 'active' | SubmissionStatus | 'all';
const FILTERS: Filter[] = ['active', 'open', 'in_market', 'quoting', 'bound', 'all'];
const TERMINAL: SubmissionStatus[] = ['bound', 'lost', 'declined', 'withdrawn'];

function filterLabel(f: Filter): string {
  if (f === 'active') return 'Active';
  if (f === 'all') return 'All';
  return SUBMISSION_STATUS_LABEL[f];
}

export function SubmissionsListScreen({ navigation }: any) {
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('active');

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await submissionsApi.list();
      setRows(data);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load submissions');
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
    if (!rows) return [] as Submission[];
    const list =
      filter === 'all'
        ? rows
        : filter === 'active'
          ? rows.filter((s) => !TERMINAL.includes(s.status))
          : rows.filter((s) => s.status === filter);
    return [...list].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
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
        <View style={styles.titleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>BROKER · PLACEMENT</Text>
            <Text style={styles.title}>Submissions</Text>
          </View>
          <Pressable style={styles.newBtn} onPress={() => navigation.navigate('NewSubmission')}>
            <Text style={styles.newBtnText}>+ New</Text>
          </Pressable>
        </View>
        <HandAccent>shop the risk</HandAccent>
        <Text style={styles.subtitle}>Venue risks out to market for quotes.</Text>
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
              ? 'No submissions yet. Tap “+ New” to start one, or renew a policy.'
              : 'No submissions match this filter.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(s) => s.id}
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => navigation.navigate('SubmissionDetail', { sid: item.id })}
            >
              <View style={styles.rowTop}>
                <Text style={styles.rowId} numberOfLines={1}>
                  {item.venue_id}
                </Text>
                <Text style={[styles.statusPill, { color: SUBMISSION_STATUS_COLOR[item.status] }]}>
                  {SUBMISSION_STATUS_LABEL[item.status]}
                </Text>
              </View>
              <Text style={styles.metaText} numberOfLines={1}>
                effective {item.effective_date}
              </Text>
              <View style={styles.lineChips}>
                {item.coverage_lines.map((cl) => (
                  <Text key={cl} style={styles.lineChip}>
                    {cl.toUpperCase()}
                  </Text>
                ))}
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
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  newBtn: {
    marginTop: 4,
    borderColor: Colors.accent,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
  },
  newBtnText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium, fontSize: 13 },
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
  rowId: { fontFamily: Fonts.sansSemiBold, fontSize: 15, color: Colors.text, flex: 1, marginRight: 8 },
  statusPill: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1 },
  metaText: { color: Colors.textSecondary, fontFamily: Fonts.monoRegular, fontSize: 11, marginBottom: 10 },

  lineChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  lineChip: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1,
    color: Colors.textSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },

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
