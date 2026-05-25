/**
 * Operator "My Coverage" — mobile counterpart to /coverage on web.
 *
 * Operators can't transact policy lifecycle (broker-gated), and had no
 * policy surface on mobile. This shows their venue's coverage and lets them
 * raise a PolicyRequest (renewal/cancellation/COI/coverage-change) that lands
 * in the broker's queue. Reached from the operator dashboard; nested in
 * DashboardStack.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../contexts/AuthContext';
import {
  policyRequestsApi,
  REQUEST_STATUS_COLOR,
  REQUEST_STATUS_LABEL,
  REQUEST_TYPE_LABEL,
  type CoveragePolicy,
  type CreatePolicyRequestBody,
  type PolicyRequest,
} from '../api/policyRequests';
import { formatLedgerMoney } from '../api/claim-tokens';
import { Fonts } from '../theme/typography';
import { PolicyRequestSheet } from '../components/PolicyRequestSheet';

const POLICY_STATUS_COLOR: Record<string, string> = {
  active: '#00d97e',
  bound_pending_number: '#7aa2ff',
  cancelled: '#ff4557',
  non_renewed: '#ff9500',
  lapsed: '#ff9500',
  expired: '#8b90a8',
};

export function CoverageScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();

  const venueIds = React.useMemo(() => {
    const ids = new Set<string>();
    if (user?.tenant_id) ids.add(user.tenant_id);
    (user?.extra_venue_ids ?? []).forEach((v) => ids.add(v));
    return [...ids];
  }, [user?.tenant_id, (user?.extra_venue_ids ?? []).join(',')]);

  const [policies, setPolicies] = useState<CoveragePolicy[] | null>(null);
  const [requests, setRequests] = useState<PolicyRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sheetPolicy, setSheetPolicy] = useState<CoveragePolicy | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (venueIds.length === 0) { setPolicies([]); return; }
    setError(null);
    try {
      const [pol, req] = await Promise.all([
        Promise.all(venueIds.map((v) => policyRequestsApi.coverageForVenue(v))),
        Promise.all(venueIds.map((v) => policyRequestsApi.list({ venue_id: v }))),
      ]);
      setPolicies(pol.flat());
      setRequests(req.flat());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load coverage');
    }
  }, [venueIds]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  async function submitRequest(body: CreatePolicyRequestBody) {
    if (!sheetPolicy) return;
    setSubmitting(true);
    try {
      await policyRequestsApi.create(sheetPolicy.id, body);
      setSheetPolicy(null);
      await load();
    } catch (e: any) {
      Alert.alert('Request failed', e?.message ?? 'Could not submit your request.');
    } finally {
      setSubmitting(false);
    }
  }

  function withdraw(r: PolicyRequest) {
    Alert.alert('Withdraw request?', `Withdraw your ${REQUEST_TYPE_LABEL[r.request_type].toLowerCase()} request?`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Withdraw', style: 'destructive',
        onPress: async () => {
          try { await policyRequestsApi.cancel(r.id); await load(); }
          catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not withdraw'); }
        },
      },
    ]);
  }

  if (policies === null && !error) {
    return <View style={styles.center}><ActivityIndicator color="#c8f000" /></View>;
  }

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32, paddingTop: insets.top + 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#c8f000" />}
      >
        <Pressable style={styles.backRow} onPress={() => navigation.goBack()}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backLabel}>Dashboard</Text>
        </Pressable>
        <View style={styles.headerWrap}>
          <Text style={styles.eyebrow}>VENUE · COVERAGE</Text>
          <Text style={styles.title}>My coverage</Text>
          <Text style={styles.subtitle}>Your policy and anything you've asked your broker to action.</Text>
        </View>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={load} style={styles.retryBtn}><Text style={styles.retryText}>Retry</Text></Pressable>
          </View>
        )}

        {policies && policies.length === 0 && !error ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No coverage on file yet. Once your broker binds a policy for your venue, it'll show up here.
            </Text>
          </View>
        ) : (
          policies?.map((p) => (
            <View key={p.id} style={styles.card}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardEyebrow}>{p.carrier_id.toUpperCase()}</Text>
                  <Text style={styles.cardNumber}>{p.policy_number ?? p.id}</Text>
                </View>
                <View style={[styles.statusDot, { backgroundColor: POLICY_STATUS_COLOR[p.status] ?? '#8b90a8' }]} />
                <Text style={styles.statusText}>{p.status.replace(/_/g, ' ')}</Text>
              </View>
              <View style={styles.cardFacts}>
                <Fact label="PREMIUM" value={formatLedgerMoney(p.annual_premium)} />
                <Fact label="EXPIRES" value={p.expiration_date} />
                <Fact label="LINES" value={p.coverage_lines.map((l) => l.toUpperCase()).join(', ') || '—'} />
              </View>
              <Pressable style={styles.cta} onPress={() => setSheetPolicy(p)}>
                <Text style={styles.ctaText}>Request an action</Text>
              </Pressable>
            </View>
          ))
        )}

        {requests.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>YOUR REQUESTS</Text>
            {requests.map((r) => (
              <View key={r.id} style={styles.reqRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.reqType}>{REQUEST_TYPE_LABEL[r.request_type]}</Text>
                  {!!(r.decision_note || r.note) && (
                    <Text style={styles.reqNote} numberOfLines={2}>{r.decision_note || r.note}</Text>
                  )}
                </View>
                <View style={styles.reqRight}>
                  <Text style={[styles.reqStatus, { color: REQUEST_STATUS_COLOR[r.status] }]}>
                    {REQUEST_STATUS_LABEL[r.status]}
                  </Text>
                  {r.status === 'pending' && (
                    <Pressable onPress={() => withdraw(r)}><Text style={styles.withdraw}>Withdraw</Text></Pressable>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <PolicyRequestSheet
        visible={sheetPolicy !== null}
        policy={sheetPolicy}
        submitting={submitting}
        onClose={() => setSheetPolicy(null)}
        onSubmit={submitRequest}
      />
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#07080f' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#07080f' },
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 4 },
  backArrow: { color: '#c8f000', fontSize: 18, marginRight: 8, fontFamily: Fonts.monoBold },
  backLabel: { color: '#8b90a8', fontFamily: Fonts.sansMedium, fontSize: 13 },
  headerWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: '#8b90a8', marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 32, lineHeight: 36, color: '#eeeef5', letterSpacing: -0.5 },
  subtitle: { color: '#8b90a8', fontSize: 13, marginTop: 4, fontFamily: Fonts.sansRegular },

  card: {
    marginHorizontal: 16, marginTop: 12, padding: 16, backgroundColor: '#0d0f1c',
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.06)',
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  cardEyebrow: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: '#4a4f65', marginBottom: 3 },
  cardNumber: { fontFamily: Fonts.monoBold, fontSize: 14, color: '#eeeef5' },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { color: '#8b90a8', fontFamily: Fonts.sansMedium, fontSize: 11, textTransform: 'capitalize' },
  cardFacts: { flexDirection: 'row', gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.06)', paddingTop: 12, marginBottom: 14 },
  fact: { flex: 1 },
  factLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: '#4a4f65', marginBottom: 2 },
  factValue: { fontFamily: Fonts.monoBold, fontSize: 12, color: '#eeeef5' },
  cta: { alignSelf: 'flex-start', borderColor: '#c8f000', borderWidth: 1, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 8 },
  ctaText: { color: '#c8f000', fontFamily: Fonts.sansMedium, fontSize: 13 },

  section: { marginTop: 28, paddingHorizontal: 16 },
  sectionTitle: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: '#8b90a8', marginBottom: 10 },
  reqRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  reqType: { color: '#eeeef5', fontFamily: Fonts.sansMedium, fontSize: 13 },
  reqNote: { color: '#8b90a8', fontFamily: Fonts.sansRegular, fontSize: 12, marginTop: 2 },
  reqRight: { alignItems: 'flex-end' },
  reqStatus: { fontFamily: Fonts.monoBold, fontSize: 11 },
  withdraw: { color: '#ff4557', fontFamily: Fonts.sansMedium, fontSize: 12, marginTop: 4 },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: { color: '#8b90a8', textAlign: 'center', fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },
  errorBox: { paddingHorizontal: 20, paddingVertical: 16 },
  errorText: { color: '#ff4557', marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: '#c8f000', borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: '#c8f000', fontFamily: Fonts.sansMedium },
});
