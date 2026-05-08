import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api/client';
import { CapacityBar } from '../components/CapacityBar';

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

export function BrokerVenueDetailScreen({ route, navigation }: any) {
  const { venueId, venueName } = route.params;
  const insets = useSafeAreaInsets();
  const [live, setLive] = useState<any>(null);
  const [risk, setRisk] = useState<any>(null);
  const [quote, setQuote] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [liveRaw, riskData, quoteData] = await Promise.all([
        api.request<any>(`/api/venues/${venueId}/live`),
        api.request<any>(`/api/venues/${venueId}/risk-score`).catch(() => null),
        api.request<any>(`/api/venues/${venueId}/quote`).catch(() => null),
      ]);

      // Normalize infrastructure
      let infra: { name: string; status: string }[] = [];
      if (Array.isArray(liveRaw.infrastructure)) {
        infra = liveRaw.infrastructure.map((i: any) => ({ name: String(i.name ?? ''), status: String(i.status ?? '') }));
      } else if (liveRaw.infrastructure && typeof liveRaw.infrastructure === 'object') {
        infra = Object.entries(liveRaw.infrastructure).map(([k, v]: [string, any]) => ({
          name: typeof v === 'object' ? String(v.name ?? k) : k,
          status: typeof v === 'object' ? String(v.status ?? '') : String(v),
        }));
      }

      // Normalize risk factors
      if (riskData?.factors) {
        const norm: Record<string, number> = {};
        for (const [k, v] of Object.entries(riskData.factors)) {
          norm[k] = typeof v === 'object' && v !== null ? Number((v as any).score ?? 0) : Number(v);
        }
        riskData.factors = norm;
      }

      setLive({ ...liveRaw, infrastructure: infra });
      setRisk(riskData);
      setQuote(quoteData);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color="#c8f000" /></View>;
  }

  const tier = risk?.tier ?? '—';
  const tierColor = TIER_COLOR[tier] ?? '#4a4f65';
  const capacityPct = live ? live.current_capacity / live.max_capacity : 0;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}
    >
      <Pressable style={styles.backRow} onPress={() => navigation.goBack()}>
        <Text style={styles.backArrow}>←</Text>
        <Text style={styles.backLabel}>Portfolio</Text>
      </Pressable>

      <View style={styles.header}>
        <Text style={styles.venueName}>{venueName}</Text>
        <Text style={styles.venueId}>{venueId}</Text>
      </View>

      {/* Risk Tier + Premium */}
      <View style={styles.statsRow}>
        <Pressable
          style={({ pressed }) => [styles.statCard, { borderColor: `${tierColor}33` }, pressed && { opacity: 0.75 }]}
          onPress={() => navigation.navigate('RiskProfileDetail', {
            riskData: risk,
            quoteData: quote,
            venueName,
            isBroker: true,
          })}
        >
          <Text style={styles.statEyebrow}>RISK TIER</Text>
          <Text style={[styles.statBig, { color: tierColor }]}>{tier}</Text>
          <Text style={[styles.statSub, { color: tierColor }]}>{risk?.total_score ?? 0} / 100</Text>
        </Pressable>
        {quote && (
          <View style={styles.statCard}>
            <Text style={styles.statEyebrow}>PREMIUM</Text>
            <Text style={styles.statBig}>${(quote.annual_premium ?? 0).toLocaleString()}</Text>
            <Text style={styles.statSub}>${(quote.monthly_premium ?? 0).toLocaleString()} / mo</Text>
          </View>
        )}
      </View>

      {/* Risk Factors */}
      {risk?.factors && Object.keys(risk.factors).length > 0 && (
        <Pressable
          style={({ pressed }) => [styles.card, pressed && { opacity: 0.8 }]}
          onPress={() => navigation.navigate('RiskProfileDetail', {
            riskData: risk,
            quoteData: quote,
            venueName,
            isBroker: true,
          })}
        >
          <Text style={styles.eyebrow}>RISK FACTORS</Text>
          <View style={styles.factorList}>
            {Object.entries(risk.factors).map(([key, val]) => (
              <CapacityBar
                key={key}
                label={key.replace(/_/g, ' ').toUpperCase()}
                value={Number(val)}
                max={100}
                invertScale
              />
            ))}
          </View>
          <Text style={styles.tapHint}>Tap for full risk analysis →</Text>
        </Pressable>
      )}

      {/* Live Capacity */}
      {live && (
        <View style={[styles.card, capacityPct > 0.85 && styles.cardDanger]}>
          <Text style={styles.eyebrow}>CAPACITY</Text>
          <View style={styles.capacityNumbers}>
            <Text style={[styles.capacityBig, { color: capacityPct > 0.85 ? '#ff4557' : '#eeeef5' }]}>
              {live.current_capacity}
            </Text>
            <Text style={styles.capacityMax}>/ {live.max_capacity} pax</Text>
          </View>
          <CapacityBar label="" value={live.current_capacity} max={live.max_capacity} />
        </View>
      )}

      {/* Infrastructure */}
      {live?.infrastructure?.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>INFRASTRUCTURE</Text>
          {live.infrastructure.map((item: any, i: number) => {
            const statusLower = item.status.toLowerCase();
            const dotColor = STATUS_DOT[statusLower] ?? '#4a4f65';
            return (
              <View key={i} style={styles.infraRow}>
                <View style={[styles.infraDot, { backgroundColor: dotColor }]} />
                <Text style={styles.infraName}>{item.name.replace(/_/g, ' ')}</Text>
                <Text style={[styles.infraStatus, { color: dotColor }]}>{item.status.toUpperCase()}</Text>
              </View>
            );
          })}
        </View>
      )}

      {/* Compliance Queue */}
      {live?.compliance_queue?.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>COMPLIANCE QUEUE</Text>
          {live.compliance_queue.map((item: any, i: number) => {
            const action = String(item.action ?? item.title ?? '');
            const priority = String(item.priority ?? item.severity ?? 'low').toLowerCase();
            const pColor = priority === 'high' || priority === 'urgent' ? '#ff4557' : priority === 'medium' ? '#ff9500' : '#4a4f65';
            return (
              <View key={i} style={[styles.queueRow, { borderLeftColor: pColor }]}>
                <Text style={styles.queueAction}>{action}</Text>
                <Text style={[styles.queuePriority, { color: pColor }]}>{priority.toUpperCase()}</Text>
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
  content: { paddingHorizontal: 20, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#07080f' },

  backRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 20 },
  backArrow: { color: '#c8f000', fontSize: 18 },
  backLabel: { color: '#c8f000', fontSize: 13, fontWeight: '600', fontFamily: 'DMSans_600SemiBold' },

  header: { marginBottom: 20, gap: 4 },
  venueName: { color: '#eeeef5', fontSize: 24, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'CormorantGaramond_700Bold' },
  venueId: { color: '#4a4f65', fontSize: 11, letterSpacing: 0.5, fontFamily: 'JetBrainsMono_400Regular' },

  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  statCard: {
    flex: 1, backgroundColor: '#0d0f1c',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 14, padding: 14, gap: 4,
  },
  statEyebrow: { color: '#4a4f65', fontSize: 9, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  statBig: { color: '#eeeef5', fontSize: 28, fontWeight: '800', letterSpacing: -1, fontFamily: 'CormorantGaramond_700Bold' },
  statSub: { color: '#4a4f65', fontSize: 12, fontFamily: 'JetBrainsMono_400Regular' },

  card: {
    backgroundColor: '#0d0f1c', borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)', borderRadius: 14,
    padding: 16, marginBottom: 12, gap: 14,
  },
  cardDanger: { borderColor: 'rgba(255,69,87,0.25)', backgroundColor: 'rgba(255,69,87,0.04)' },
  eyebrow: { color: '#4a4f65', fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },

  factorList: { gap: 16 },
  tapHint: { color: '#4a4f65', fontSize: 11, fontFamily: 'JetBrainsMono_400Regular', marginTop: 4 },

  capacityNumbers: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  capacityBig: { fontSize: 48, fontWeight: '800', letterSpacing: -2, lineHeight: 48, fontFamily: 'JetBrainsMono_700Bold' },
  capacityMax: { color: '#4a4f65', fontSize: 16, paddingBottom: 4, fontFamily: 'JetBrainsMono_400Regular' },

  infraRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.04)' },
  infraDot: { width: 7, height: 7, borderRadius: 4, marginRight: 12 },
  infraName: { color: '#8b90a8', fontSize: 13, flex: 1, textTransform: 'capitalize', fontFamily: 'DMSans_400Regular' },
  infraStatus: { fontSize: 10, fontWeight: '700', letterSpacing: 1, fontFamily: 'JetBrainsMono_700Bold' },

  queueRow: { borderLeftWidth: 2, paddingLeft: 12, paddingVertical: 4, gap: 2 },
  queueAction: { color: '#8b90a8', fontSize: 13, lineHeight: 18, fontFamily: 'DMSans_400Regular' },
  queuePriority: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'JetBrainsMono_700Bold' },
});
