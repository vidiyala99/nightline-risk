import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CapacityBar } from '../components/CapacityBar';

interface InfraItem {
  name: string;
  status: string;
  detail?: string;
  is_degraded?: boolean;
}

interface QueueItem {
  action: string;
  priority: string;
}

interface LiveData {
  current_capacity: number;
  max_capacity: number;
  infrastructure: InfraItem[];
  compliance_queue: QueueItem[];
}

const TIER_COLOR: Record<string, string> = {
  A: '#c8f000',
  B: '#00d97e',
  C: '#ff9500',
  D: '#ff4557',
};

const STATUS_DOT: Record<string, string> = {
  operational: '#c8f000',
  active: '#c8f000',
  degraded: '#ff9500',
  down: '#ff4557',
};

const PRIORITY_COLOR: Record<string, string> = {
  high: '#ff4557',
  medium: '#ff9500',
  low: '#4a4f65',
};

export function LiveTerminalScreen({ navigation }: any) {
  const { user, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<LiveData | null>(null);
  const [riskData, setRiskData] = useState<any>(null);
  const [quoteData, setQuoteData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLive = useCallback(async () => {
    if (!user?.tenant_id) return;
    try {
      const [raw, risk, quote] = await Promise.all([
        api.request<any>(`/api/venues/${user.tenant_id}/live`),
        api.request<any>(`/api/venues/${user.tenant_id}/risk-score`).catch(() => null),
        api.request<any>(`/api/venues/${user.tenant_id}/quote`).catch(() => null),
      ]);
      setRiskData(risk);
      setQuoteData(quote);
      // Normalize infrastructure to a flat array of {name, status}
      let infra: InfraItem[] = [];
      if (Array.isArray(raw.infrastructure)) {
        infra = raw.infrastructure.map((item: any) => ({
          name: String(item.name ?? ''),
          status: String(item.status ?? ''),
          detail: item.detail ? String(item.detail) : undefined,
          is_degraded: Boolean(item.is_degraded),
        }));
      } else if (raw.infrastructure && typeof raw.infrastructure === 'object') {
        infra = Object.entries(raw.infrastructure).map(([key, val]: [string, any]) => ({
          name: typeof val === 'object' ? String(val.name ?? key) : key,
          status: typeof val === 'object' ? String(val.status ?? val) : String(val),
          detail: typeof val === 'object' && val.detail ? String(val.detail) : undefined,
          is_degraded: typeof val === 'object' ? Boolean(val.is_degraded) : false,
        }));
      }
      // Normalize compliance queue — API uses title/severity, UI uses action/priority
      const queue: QueueItem[] = (raw.compliance_queue ?? []).map((item: any) => ({
        action: String(item.action ?? item.title ?? ''),
        priority: String(item.priority ?? item.severity ?? 'low').toLowerCase(),
      }));
      setData({ ...raw, infrastructure: infra, compliance_queue: queue });
    } catch {
      // keep stale
    } finally {
      setLoading(false);
    }
  }, [user?.tenant_id]);

  useEffect(() => {
    fetchLive();
    intervalRef.current = setInterval(fetchLive, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchLive]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#c8f000" />
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.centered}>
        <Text style={styles.empty}>No live data available</Text>
      </View>
    );
  }

  const capacityPct = data.current_capacity / data.max_capacity;

  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}>
      <View style={styles.topRow}>
        <Text style={styles.title}>Live Terminal</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={styles.livePill}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
          <Text style={styles.signOut} onPress={signOut}>SIGN OUT</Text>
        </View>
      </View>

      {/* Risk Score + Premium */}
      {riskData && (
        <View style={styles.statsRow}>
          <Pressable
            style={({ pressed }) => [styles.statCard, { borderColor: `${TIER_COLOR[riskData.tier] ?? '#4a4f65'}33` }, pressed && { opacity: 0.75 }]}
            onPress={() => navigation.navigate('RiskProfileDetail', {
              riskData,
              quoteData,
              venueName: user?.name,
              isBroker: false,
            })}
          >
            <Text style={styles.statEyebrow}>RISK TIER</Text>
            <Text style={[styles.statBig, { color: TIER_COLOR[riskData.tier] ?? '#eeeef5' }]}>
              {riskData.tier ?? '—'}
            </Text>
            <Text style={[styles.statSub, { color: TIER_COLOR[riskData.tier] ?? '#4a4f65' }]}>
              {riskData.total_score ?? 0} / 100
            </Text>
          </Pressable>
          {quoteData && (
            <View style={styles.statCard}>
              <Text style={styles.statEyebrow}>PREMIUM</Text>
              <Text style={styles.statBig}>${(quoteData.annual_premium ?? 0).toLocaleString()}</Text>
              <Text style={styles.statSub}>${(quoteData.monthly_premium ?? 0).toLocaleString()} / mo</Text>
            </View>
          )}
        </View>
      )}

      <View style={[styles.card, capacityPct > 0.85 && styles.cardDanger]}>
        <Text style={styles.sectionEyebrow}>CAPACITY</Text>
        <View style={styles.capacityNumbers}>
          <Text style={[styles.capacityBig, { color: capacityPct > 0.85 ? '#ff4557' : '#eeeef5' }]}>
            {data.current_capacity}
          </Text>
          <Text style={styles.capacityMax}>/ {data.max_capacity} pax</Text>
        </View>
        <CapacityBar
          label=""
          value={data.current_capacity}
          max={data.max_capacity}
        />
      </View>

      {data.infrastructure.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.sectionEyebrow}>INFRASTRUCTURE SYNC</Text>
          {data.infrastructure.some(i => i.is_degraded) && (
            <View style={styles.degradedWarning}>
              <Text style={styles.degradedWarningText}>⚠ Degraded systems weaken your claims defense. Upload footage or repair feeds before your next event.</Text>
            </View>
          )}
          {data.infrastructure.map((item, i) => {
            const statusLower = item.status.toLowerCase();
            const dotColor = item.is_degraded ? '#ff9500' : (STATUS_DOT[statusLower] ?? '#4a4f65');
            return (
              <View key={i} style={[styles.infraRow, item.is_degraded && styles.infraRowDegraded]}>
                <View style={[styles.infraDot, { backgroundColor: dotColor }]} />
                <Text style={styles.infraName}>{item.name}</Text>
                <Text style={[styles.infraStatus, { color: dotColor }]}>
                  {item.detail ? `${item.status.toUpperCase()} ${item.detail}` : item.status.toUpperCase()}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.sectionEyebrow}>COMPLIANCE QUEUE</Text>
        {data.compliance_queue.length === 0 ? (
          <Text style={styles.complianceClear}>{'>'} Compliance{'\n'}No pending actions. You're all clear.</Text>
        ) : (
          data.compliance_queue.map((item, i) => (
            <View key={i} style={[styles.queueRow, { borderLeftColor: PRIORITY_COLOR[item.priority] ?? '#4a4f65' }]}>
              <View style={styles.queueContent}>
                <Text style={styles.queueAction}>{item.action}</Text>
                <Text style={[styles.queuePriority, { color: PRIORITY_COLOR[item.priority] ?? '#4a4f65' }]}>
                  {item.priority.toUpperCase()}
                </Text>
              </View>
            </View>
          ))
        )}
      </View>

      {/* Coverage breakdown */}
      {quoteData?.coverage_breakdown && (
        <View style={styles.card}>
          <Text style={styles.sectionEyebrow}>COVERAGE</Text>
          {Object.entries(quoteData.coverage_breakdown).map(([key, val]: [string, any]) => {
            const isIncluded = val.included === true;
            const isOptional = val.optional === true;
            const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
            const statusText = isIncluded ? 'INCLUDED' : isOptional ? 'OPTIONAL' : '—';
            const statusColor = isIncluded ? '#c8f000' : '#4a4f65';
            return (
              <View key={key} style={styles.coverageRow}>
                <Text style={styles.coverageName}>{label}</Text>
                <Text style={[styles.coverageStatus, { color: statusColor }]}>{statusText}</Text>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07080f' },
  content: { paddingHorizontal: 20, paddingBottom: 24, gap: 12 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#07080f' },
  empty: { color: '#4a4f65', fontSize: 14, fontFamily: 'DMSans_400Regular' },

  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  title: { color: '#eeeef5', fontSize: 28, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'CormorantGaramond_700Bold' },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(200,240,0,0.1)',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.25)',
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#c8f000' },
  liveText: { color: '#c8f000', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },
  signOut: { color: '#8b90a8', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },

  savingsCard: {
    backgroundColor: 'rgba(200,240,0,0.05)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.2)',
    borderRadius: 14,
    padding: 16,
    gap: 6,
  },
  savingsEyebrow: { color: '#8b90a8', fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  savingsAmount: { color: '#c8f000', fontSize: 36, fontWeight: '800', letterSpacing: -1, fontFamily: 'JetBrainsMono_700Bold' },
  savingsPerYear: { color: '#8b90a8', fontSize: 16, fontWeight: '400', fontFamily: 'DMSans_400Regular' },
  savingsSub: { color: '#8b90a8', fontSize: 12, lineHeight: 18, fontFamily: 'JetBrainsMono_400Regular' },

  degradedWarning: {
    backgroundColor: 'rgba(255,149,0,0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,149,0,0.3)',
    borderRadius: 8,
    padding: 10,
  },
  degradedWarningText: { color: '#ff9500', fontSize: 12, lineHeight: 17, fontFamily: 'JetBrainsMono_400Regular' },
  infraRowDegraded: { backgroundColor: 'rgba(255,149,0,0.04)', borderRadius: 6, paddingHorizontal: 6 },

  coverageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  coverageName: { color: '#8b90a8', fontSize: 14, fontFamily: 'DMSans_400Regular' },
  coverageStatus: { fontSize: 11, fontWeight: '700', letterSpacing: 1, fontFamily: 'JetBrainsMono_700Bold' },

  statsRow: { flexDirection: 'row', gap: 10 },
  statCard: {
    flex: 1,
    backgroundColor: '#0d0f1c',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 14,
    padding: 14,
    gap: 4,
  },
  statEyebrow: { color: '#4a4f65', fontSize: 9, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  statBig: { color: '#eeeef5', fontSize: 28, fontWeight: '800', letterSpacing: -1, fontFamily: 'JetBrainsMono_700Bold' },
  statSub: { color: '#4a4f65', fontSize: 12, fontFamily: 'JetBrainsMono_400Regular' },

  card: {
    backgroundColor: '#0d0f1c',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 16,
    padding: 18,
    gap: 14,
  },
  cardDanger: {
    borderColor: 'rgba(255,69,87,0.25)',
    backgroundColor: 'rgba(255,69,87,0.04)',
  },
  sectionEyebrow: {
    color: '#4a4f65',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'JetBrainsMono_700Bold',
  },

  capacityNumbers: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  capacityBig: { fontSize: 48, fontWeight: '800', letterSpacing: -2, lineHeight: 48, fontFamily: 'JetBrainsMono_700Bold' },
  capacityMax: { color: '#4a4f65', fontSize: 16, paddingBottom: 4, fontFamily: 'DMSans_400Regular' },

  infraRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  infraDot: { width: 7, height: 7, borderRadius: 4, marginRight: 12 },
  infraName: { color: '#8b90a8', fontSize: 13, flex: 1, textTransform: 'capitalize', fontFamily: 'DMSans_400Regular' },
  infraStatus: { fontSize: 10, fontWeight: '700', letterSpacing: 1, fontFamily: 'JetBrainsMono_700Bold' },

  complianceClear: { color: '#4a4f65', fontSize: 13, lineHeight: 20, fontFamily: 'JetBrainsMono_400Regular' },
  queueRow: {
    borderLeftWidth: 2,
    paddingLeft: 12,
    paddingVertical: 4,
  },
  queueContent: { gap: 2 },
  queueAction: { color: '#8b90a8', fontSize: 13, lineHeight: 18, fontFamily: 'DMSans_400Regular' },
  queuePriority: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'JetBrainsMono_700Bold' },
});
