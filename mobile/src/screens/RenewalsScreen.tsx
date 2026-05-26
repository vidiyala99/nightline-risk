/**
 * Broker renewals — mobile counterpart to /renewals on web.
 *
 * Lists policies expiring within 60 days (renewalsApi.due(60)) and lets
 * the broker tap "Renew" on a row. After a successful renew we show the
 * year-over-year context panel inline (prior premium, loss ratio,
 * experience adjustment).
 *
 * Parity boundary: the web version deep-links to /submissions/[sid].
 * Mobile has no submissions screen (broker placement flow is web-only),
 * so we surface the new submission id as read-only text instead of a
 * link. Styling mirrors CarrierClaimsListScreen.
 */
import React, { useCallback, useEffect, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useResponsive } from '../hooks/useResponsive';
import {
  renewalsApi,
  type RenewalDue,
  type RenewResult,
} from '../api/renewals';
import { formatLedgerMoney } from '../api/claim-tokens';
import { Fonts } from '../theme/typography';

function fmtPct(s: string): string {
  const n = parseFloat(s);
  return Number.isNaN(n) ? s : `${(n * 100).toFixed(1)}%`;
}

function fmtMultiplier(s: string): string {
  const n = parseFloat(s);
  return Number.isNaN(n) ? s : `×${n.toFixed(2)}`;
}

/** effective_date = tomorrow, as YYYY-MM-DD (mirrors web onRenew). */
function tomorrowIso(): string {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)
    .toISOString()
    .slice(0, 10);
}

export function RenewalsScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { isTablet } = useResponsive();
  const [rows, setRows] = useState<RenewalDue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [result, setResult] = useState<RenewResult | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await renewalsApi.due(60);
      setRows(data);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load renewals');
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

  const onRenew = useCallback(async (policyId: string) => {
    setBusyId(policyId);
    setError(null);
    setResult(null);
    try {
      const res = await renewalsApi.renew(policyId, tomorrowIso());
      setResult(res);
      setRows((prev) => (prev ? prev.filter((r) => r.policy_id !== policyId) : prev));
    } catch (e: any) {
      setError(e?.message ?? 'Renew failed');
    } finally {
      setBusyId(null);
    }
  }, []);

  if (rows === null && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => r.policy_id}
        contentContainerStyle={[
          { paddingBottom: 32, paddingTop: insets.top + 12 },
          isTablet && { maxWidth: 720, alignSelf: 'center', width: '100%' },
        ]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
        }
        ListHeaderComponent={
          <View>
            <Pressable style={styles.backRow} onPress={() => navigation.goBack()}>
              <Text style={styles.backArrow}>←</Text>
              <Text style={styles.backLabel}>Portfolio</Text>
            </Pressable>
            <View style={styles.headerWrap}>
              <Text style={styles.eyebrow}>BROKER · RENEWALS</Text>
              <Text style={styles.title}>Renewals due</Text>
              <Text style={styles.subtitle}>
                Policies expiring within 60 days. Tap Renew to open a renewal submission.
              </Text>
            </View>

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
                <Pressable onPress={load} style={styles.retryBtn}>
                  <Text style={styles.retryText}>Retry</Text>
                </Pressable>
              </View>
            )}

            {result && (
              <View style={styles.yoyPanel}>
                <View style={styles.yoyHeader}>
                  <Text style={styles.yoyBadge}>RENEWAL SUBMITTED</Text>
                  <Pressable onPress={() => setResult(null)}>
                    <Text style={styles.yoyDismiss}>Dismiss</Text>
                  </Pressable>
                </View>
                <Text style={styles.yoySub}>
                  New submission {result.submission.id.slice(0, 8)}… · venue{' '}
                  {result.submission.venue_id} · effective {result.submission.effective_date}
                </Text>
                <View style={styles.yoyGrid}>
                  <YoyCell label="PRIOR PREMIUM" value={formatLedgerMoney(result.yoy_context.prior_annual_premium)} />
                  <YoyCell label="LOSS RATIO" value={fmtPct(result.yoy_context.loss_ratio)} />
                  <YoyCell label="CLAIMS" value={String(result.yoy_context.claim_count)} />
                  <YoyCell label="EXPERIENCE ADJ." value={fmtMultiplier(result.yoy_context.loss_adjustment)} />
                </View>
                <Text style={styles.yoyNote}>
                  Open the new submission on desktop (/submissions) to quote and bind.
                </Text>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          error ? null : (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                No policies expiring in the next 60 days. Check back closer to renewal season.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowTop}>
              <Text style={styles.rowId} numberOfLines={1}>
                {item.policy_number ?? item.policy_id}
              </Text>
              <Text style={styles.rowExpires}>exp {item.expiration_date}</Text>
            </View>
            <Text style={styles.metaText} numberOfLines={1}>
              {item.venue_id}
            </Text>
            <View style={styles.rowMoney}>
              <View style={styles.moneyCol}>
                <Text style={styles.moneyLabel}>PREMIUM</Text>
                <Text style={styles.moneyValue}>{formatLedgerMoney(item.annual_premium)}</Text>
              </View>
              <View style={styles.moneyCol}>
                <Text style={styles.moneyLabel}>LOSS RATIO</Text>
                <Text style={styles.moneyValue}>{fmtPct(item.loss_ratio)}</Text>
              </View>
              <View style={styles.moneyCol}>
                <Text style={styles.moneyLabel}>PROJ. ADJ.</Text>
                <Text style={styles.moneyValue}>{fmtMultiplier(item.projected_loss_adjustment)}</Text>
              </View>
              <View style={styles.moneyCol}>
                <Text style={styles.moneyLabel}>CLAIMS</Text>
                <Text style={styles.moneyValue}>{item.claim_count}</Text>
              </View>
            </View>
            <Pressable
              style={[styles.renewBtn, busyId === item.policy_id && styles.renewBtnBusy]}
              disabled={busyId === item.policy_id}
              onPress={() => onRenew(item.policy_id)}
            >
              <Text style={styles.renewText}>
                {busyId === item.policy_id ? 'Renewing…' : 'Renew'}
              </Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

function YoyCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.yoyCell}>
      <Text style={styles.yoyCellLabel}>{label}</Text>
      <Text style={styles.yoyCellValue}>{value}</Text>
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
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  rowId: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text, flex: 1, marginRight: 8 },
  rowExpires: { fontFamily: Fonts.monoRegular, fontSize: 11, color: Colors.textSecondary },
  metaText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12, marginBottom: 10 },

  rowMoney: {
    flexDirection: 'row',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSubtle,
    paddingTop: 10,
    marginBottom: 12,
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

  renewBtn: {
    alignSelf: 'flex-end',
    borderColor: Colors.accent,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 6,
  },
  renewBtnBusy: { opacity: 0.5 },
  renewText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium, fontSize: 13 },

  yoyPanel: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 16,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  yoyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  yoyBadge: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.accentInk },
  yoyDismiss: { fontFamily: Fonts.sansMedium, fontSize: 12, color: Colors.textSecondary },
  yoySub: { color: Colors.textSecondary, fontFamily: Fonts.monoRegular, fontSize: 11, marginTop: 8 },
  yoyGrid: { flexDirection: 'row', gap: 12, marginTop: 12 },
  yoyCell: { flex: 1 },
  yoyCellLabel: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1.2,
    color: Colors.textMuted,
    marginBottom: 2,
  },
  yoyCellValue: { fontFamily: Fonts.monoBold, fontSize: 12, color: Colors.text },
  yoyNote: {
    color: Colors.textSecondary,
    fontFamily: Fonts.sansRegular,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 12,
  },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: {
    color: Colors.textSecondary,
    textAlign: 'center',
    fontFamily: Fonts.sansRegular,
    fontSize: 13,
    lineHeight: 18,
  },
  errorBox: { paddingHorizontal: 20, paddingVertical: 16 },
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
