import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api/client';
import { CapacityBar } from '../components/CapacityBar';

const TIER_COLOR: Record<string, string> = {
  A: '#c8f000',
  B: '#00d97e',
  C: '#ff9500',
  D: '#ff4557',
};

interface RiskScore {
  venue_id: string;
  total_score: number;
  tier: string;
  factors: Record<string, number>;
}

interface PremiumQuote {
  venue_id: string;
  venue_type: string;
  tier: string;
  annual_premium: number;
  monthly_premium: number;
}

export function DashboardScreen({ navigation }: any) {
  const { user, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const [riskData, setRiskData] = useState<RiskScore | null>(null);
  const [quoteData, setQuoteData] = useState<PremiumQuote | null>(null);
  const [openIncidents, setOpenIncidents] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    if (!user?.tenant_id) return;
    try {
      const [risk, quote, incidents] = await Promise.all([
        api.request<any>(`/api/venues/${user.tenant_id}/risk-score`),
        api.request<any>(`/api/venues/${user.tenant_id}/quote`),
        api.request<any[]>(`/api/venues/${user.tenant_id}/incidents?status=open`),
      ]);

      // Normalize factors to plain numbers so they never reach JSX as objects
      if (risk?.factors) {
        const normalized: Record<string, number> = {};
        for (const [k, v] of Object.entries(risk.factors)) {
          normalized[k] =
            typeof v === 'object' && v !== null
              ? Number((v as any).score ?? 0)
              : Number(v);
        }
        risk.factors = normalized;
      }

      setRiskData(risk);
      setQuoteData(quote);
      setOpenIncidents(Array.isArray(incidents) ? incidents.length : 0);
    } catch {
      // data stays stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.tenant_id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function onRefresh() {
    setRefreshing(true);
    fetchData();
  }

  // Broker / admin: simplified redirect message
  if (user?.role === 'broker' || user?.role === 'admin') {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={styles.brokerHeading}>Portfolio View</Text>
        <Text style={styles.brokerBody}>
          Use Portfolio tab to view all venues.
        </Text>
        <Text style={styles.signOut} onPress={signOut} accessibilityRole="button">
          SIGN OUT
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#c8f000" />
      </View>
    );
  }

  const tier = riskData?.tier ?? '—';
  const score = riskData?.total_score ?? 0;
  const factors: Record<string, number> = riskData?.factors ?? {};
  const tierColor = TIER_COLOR[tier] ?? '#4a4f65';

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#c8f000"
        />
      }
    >
      {/* Hero heading */}
      <View style={styles.heroSection}>
        <View style={styles.heroTopRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroHeading}>
              Operational{' '}
              <Text style={styles.heroAccent}>Defense</Text>
            </Text>
            <Text style={styles.heroSubtitle}>
              Your operational data — your defense against premium hikes
            </Text>
          </View>
          <Text style={styles.signOut} onPress={signOut} accessibilityRole="button">SIGN OUT</Text>
        </View>
      </View>

      {/* Stats bar */}
      <View style={styles.statsRow}>
        {/* Your Venue */}
        <View style={styles.statCard}>
          <Text style={styles.statEyebrow}>YOUR VENUE</Text>
          <Text style={styles.statValue}>1</Text>
        </View>

        {/* Open Incidents */}
        <Pressable style={styles.statCard} onPress={() => navigation.navigate('Incidents')}>
          <Text style={styles.statEyebrow}>OPEN INCIDENTS</Text>
          <Text style={[styles.statValue, openIncidents > 0 && styles.statError]}>
            {openIncidents}
          </Text>
        </Pressable>

        {/* Compliance Actions */}
        <View style={styles.statCard}>
          <Text style={styles.statEyebrow}>COMPLIANCE</Text>
          <Text style={styles.statValue}>0</Text>
        </View>
      </View>

      {/* Risk Profile card */}
      {riskData && (
        <View style={[styles.card, { borderColor: `${tierColor}22` }]}>
          <Text style={styles.sectionEyebrow}>RISK PROFILE</Text>

          {/* Tier badge + score */}
          <View style={styles.riskHeaderRow}>
            <View style={[styles.tierBadge, { borderColor: tierColor }]}>
              <Text style={[styles.tierBadgeText, { color: tierColor }]}>
                Tier {tier}
              </Text>
            </View>
            <View style={styles.scoreGroup}>
              <Text style={[styles.scoreValue, { color: tierColor }]}>{score}</Text>
              <Text style={styles.scoreMax}> / 100</Text>
            </View>
          </View>

          {/* Factor bars */}
          {Object.keys(factors).length > 0 && (
            <View style={styles.factorList}>
              {Object.entries(factors).map(([key, val]) => (
                <CapacityBar
                  key={key}
                  label={key.replace(/_/g, ' ').toUpperCase()}
                  value={Number(val)}
                  max={100}
                  invertScale
                />
              ))}
            </View>
          )}
        </View>
      )}

      {/* Premium Quote card */}
      {quoteData && (
        <View style={[styles.card, styles.quoteCard]}>
          <View style={styles.quoteHeader}>
            <Text style={styles.sectionEyebrow}>PREMIUM QUOTE</Text>
            <View
              style={[
                styles.tierBadge,
                { borderColor: TIER_COLOR[quoteData.tier] ?? '#4a4f65' },
              ]}
            >
              <Text
                style={[
                  styles.tierBadgeText,
                  { color: TIER_COLOR[quoteData.tier] ?? '#4a4f65' },
                ]}
              >
                {quoteData.tier} Tier
              </Text>
            </View>
          </View>

          <Text style={styles.venueTypeLabel}>
            {quoteData.venue_type.replace(/_/g, ' ').toUpperCase()}
          </Text>

          <Text style={styles.premiumAmount}>
            ${quoteData.annual_premium?.toLocaleString() ?? '—'}
          </Text>
          <Text style={styles.premiumSub}>
            / year
          </Text>

          <Text style={styles.premiumMonthly}>
            ${quoteData.monthly_premium?.toLocaleString() ?? '—'}
            <Text style={styles.premiumMonthlySub}> / month</Text>
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07080f' },
  content: { paddingHorizontal: 20, paddingBottom: 32 },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#07080f',
    paddingHorizontal: 24,
  },

  // Broker fallback
  brokerHeading: {
    color: '#eeeef5',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginBottom: 8,
    textAlign: 'center',
    fontFamily: 'CormorantGaramond_700Bold',
  },
  brokerBody: {
    color: '#4a4f65',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
    fontFamily: 'DMSans_400Regular',
  },
  signOut: {
    color: '#8b90a8',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    paddingTop: 4,
    fontFamily: 'JetBrainsMono_700Bold',
  },

  // Hero
  heroTopRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  heroSection: {
    marginBottom: 24,
  },
  heroHeading: {
    color: '#eeeef5',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 38,
    marginBottom: 8,
    fontFamily: 'CormorantGaramond_700Bold',
  },
  heroAccent: {
    color: '#c8f000',
  },
  heroSubtitle: {
    color: '#4a4f65',
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'DMSans_400Regular',
  },

  // Stats bar
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#0d0f1c',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 14,
    padding: 14,
    alignItems: 'flex-start',
  },
  statEyebrow: {
    color: '#4a4f65',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 6,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  statValue: {
    color: '#eeeef5',
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.5,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  statError: {
    color: '#ff4557',
  },

  // Shared card
  card: {
    backgroundColor: '#0d0f1c',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
  },
  sectionEyebrow: {
    color: '#4a4f65',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 14,
    fontFamily: 'JetBrainsMono_700Bold',
  },

  // Risk profile
  riskHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 16,
    marginBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.07)',
  },
  tierBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tierBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  scoreGroup: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  scoreValue: {
    fontSize: 48,
    fontWeight: '800',
    letterSpacing: -2,
    lineHeight: 52,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  scoreMax: {
    color: '#4a4f65',
    fontSize: 16,
    fontWeight: '500',
    paddingBottom: 6,
    fontFamily: 'DMSans_500Medium',
  },
  factorList: { gap: 16 },

  // Quote card
  quoteCard: {
    borderColor: 'rgba(200,240,0,0.15)',
  },
  quoteHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  venueTypeLabel: {
    color: '#4a4f65',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 12,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  premiumAmount: {
    color: '#eeeef5',
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1.5,
    lineHeight: 44,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  premiumSub: {
    color: '#4a4f65',
    fontSize: 12,
    marginBottom: 10,
    fontFamily: 'DMSans_400Regular',
  },
  premiumMonthly: {
    color: '#eeeef5',
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.5,
    fontFamily: 'JetBrainsMono_400Regular',
  },
  premiumMonthlySub: {
    color: '#4a4f65',
    fontSize: 13,
    fontWeight: '400',
    fontFamily: 'DMSans_400Regular',
  },
});
