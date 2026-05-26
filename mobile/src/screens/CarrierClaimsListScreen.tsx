/**
 * Broker's carrier-claim portfolio across their whole book.
 *
 * No cross-policy endpoint yet (slice 4 follow-up); until then this
 * aggregates per-policy. Four parallel workers bound the fanout for a
 * broker with many policies. When the backend ships
 * `GET /api/claims?status=...`, the load function collapses to one
 * call.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { HandAccent } from "../components/HandAccent";
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { api } from '../api/client';
import {
  claimsApi,
  totalPaidFromClaim,
  type Claim,
} from '../api/claims';
import {
  CLAIM_STATUS_LABEL,
  CLAIM_STATUS_GLYPH,
  formatLedgerMoney,
  isClosedStatus,
} from '../api/claim-tokens';
import { Fonts } from '../theme/typography';
import { StatusBadge } from '../components/StatusBadge';

interface PolicyLite {
  id: string;
  policy_number: string | null;
  venue_id: string;
}

interface Row extends Claim {
  policy: PolicyLite;
}

type Filter = 'open' | 'closed' | 'all';

export function CarrierClaimsListScreen({ navigation }: any) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('open');

  const load = useCallback(async () => {
    setError(null);
    try {
      // One cross-policy call (slice 4) — replaces the per-policy
      // aggregation that shipped in slice 3. Policy lookup happens
      // only for the policy_ids actually referenced.
      const claims = await claimsApi.listClaims();
      const policyIds = Array.from(new Set(claims.map((c) => c.policy_id)));
      const policies = await Promise.all(
        policyIds.map((pid) =>
          api.request<PolicyLite>(`/api/policies/${pid}`).catch(() => null),
        ),
      );
      const byId = new Map<string, PolicyLite>(
        policies
          .filter((p): p is PolicyLite => p !== null)
          .map((p) => [p.id, p]),
      );
      const accumulator: Row[] = claims
        .map((c) => {
          const policy = byId.get(c.policy_id);
          return policy ? ({ ...c, policy } as Row) : null;
        })
        .filter((r): r is Row => r !== null);
      setRows(accumulator);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load claims');
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

  const visible = useMemo(() => {
    if (!rows) return [] as Row[];
    if (filter === 'all') return rows;
    if (filter === 'closed') return rows.filter((r) => isClosedStatus(r.status));
    return rows.filter((r) => !isClosedStatus(r.status));
  }, [rows, filter]);

  const counts = useMemo(() => {
    if (!rows) return { open: 0, closed: 0, all: 0 };
    return {
      open: rows.filter((r) => !isClosedStatus(r.status)).length,
      closed: rows.filter((r) => isClosedStatus(r.status)).length,
      all: rows.length,
    };
  }, [rows]);

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
        <Text style={styles.eyebrow}>BROKER · PORTFOLIO</Text>
        <Text style={styles.title}>Carrier claims</Text>
        <HandAccent>every loss in view</HandAccent>
        <Text style={styles.subtitle}>Every reported loss across your book.</Text>
      </View>

      <View style={styles.filterBar}>
        {(['open', 'closed', 'all'] as Filter[]).map((f) => {
          const active = filter === f;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              style={[styles.filterChip, active && styles.filterChipActive]}
            >
              <Text style={[styles.filterText, active && styles.filterTextActive]}>
                {f === 'open' ? 'Open' : f === 'closed' ? 'Closed' : 'All'}
              </Text>
              <Text style={[styles.filterCount, active && styles.filterCountActive]}>
                {counts[f]}
              </Text>
            </Pressable>
          );
        })}
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
              ? 'No carrier claims in your book yet. File one from a policy.'
              : 'No claims match this filter.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() =>
                navigation.navigate('CarrierClaimDetail', { cid: item.id })
              }
            >
              <View style={styles.rowTop}>
                <Text style={styles.rowId} numberOfLines={1}>
                  <Text style={styles.glyph}>{CLAIM_STATUS_GLYPH[item.status]}  </Text>
                  {item.carrier_claim_number ?? item.id}
                </Text>
                {item.reopen_count > 0 && (
                  <Text style={styles.reopenBadge}>↻ {item.reopen_count}</Text>
                )}
              </View>
              <View style={styles.rowMeta}>
                <Text style={styles.metaText} numberOfLines={1}>
                  {item.policy.venue_id} · {item.coverage_line.toUpperCase()}
                </Text>
                <StatusBadge status={item.status} />
              </View>
              <View style={styles.rowMoney}>
                <View style={styles.moneyCol}>
                  <Text style={styles.moneyLabel}>RESERVE</Text>
                  <Text style={styles.moneyValue}>
                    {formatLedgerMoney(item.current_reserve)}
                  </Text>
                </View>
                <View style={styles.moneyCol}>
                  <Text style={styles.moneyLabel}>PAID</Text>
                  <Text style={styles.moneyValue}>
                    {formatLedgerMoney(totalPaidFromClaim(item))}
                  </Text>
                </View>
                <View style={styles.moneyCol}>
                  <Text style={styles.moneyLabel}>STATUS</Text>
                  <Text style={styles.moneyValueText}>
                    {CLAIM_STATUS_LABEL[item.status]}
                  </Text>
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

  filterBar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    marginTop: 16,
    marginBottom: 12,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  filterChipActive: { borderColor: Colors.accent },
  filterText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12 },
  filterTextActive: { color: Colors.accentInk },
  filterCount: {
    color: Colors.textSecondary,
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: 'rgba(23,21,15,0.06)',
  },
  filterCountActive: { color: Colors.accentInk },

  row: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  rowId: {
    fontFamily: Fonts.monoBold,
    fontSize: 13,
    color: Colors.text,
    flex: 1,
  },
  glyph: { color: Colors.accentInk },
  reopenBadge: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    color: Colors.error,
    borderColor: Colors.error,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  metaText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12, flex: 1, marginRight: 8 },

  rowMoney: {
    flexDirection: 'row',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSubtle,
    paddingTop: 10,
  },
  moneyCol: { flex: 1 },
  moneyLabel: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1.2,
    color: Colors.textMuted,
    marginBottom: 2,
  },
  moneyValue: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text },
  moneyValueText: { fontFamily: Fonts.sansMedium, fontSize: 12, color: Colors.text },

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
