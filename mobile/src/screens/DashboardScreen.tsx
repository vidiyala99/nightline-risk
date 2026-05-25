import React, { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
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
  savings_annual?: number;
  market_rate_annual?: number;
  savings_pct?: number;
}

interface VenueSummary {
  id: string;
  name: string;
}

export function DashboardScreen({ navigation }: any) {
  const { user } = useAuth();
  const [riskData, setRiskData] = useState<RiskScore | null>(null);
  const [quoteData, setQuoteData] = useState<PremiumQuote | null>(null);
  const [openIncidents, setOpenIncidents] = useState<number>(0);
  const [complianceCount, setComplianceCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Multi-venue support: which venue's data we're currently viewing.
  // Defaults to the operator's primary venue (tenant_id) and can be switched
  // via the chip row when the operator has added extras.
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);
  const [venuesList, setVenuesList] = useState<VenueSummary[]>([]);

  const extraIdsKey = (user?.extra_venue_ids ?? []).join(',');

  // Initial selection — once the user has loaded, target their primary venue.
  useEffect(() => {
    if (!selectedVenueId && user?.tenant_id) setSelectedVenueId(user.tenant_id);
  }, [user?.tenant_id, selectedVenueId]);

  // Load chip-row labels (primary + each extra). Extras can fail (deleted on
  // another device) — skip those silently.
  useEffect(() => {
    let cancelled = false;
    async function loadVenueList() {
      if (!user?.tenant_id) return;
      const ids = [user.tenant_id, ...(user.extra_venue_ids ?? [])];
      const results = await Promise.all(
        ids.map(async (id): Promise<VenueSummary | null> => {
          try {
            const v = await api.request<{ id?: string; name?: string }>(`/api/venues/${id}`);
            return { id, name: v.name ?? id };
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      setVenuesList(results.filter((v): v is VenueSummary => v != null));
    }
    loadVenueList();
    return () => { cancelled = true; };
  }, [user?.tenant_id, extraIdsKey]);

  const fetchData = useCallback(async () => {
    if (!selectedVenueId) return;
    setFetchError(null);
    try {
      const [risk, quote, incidents, live] = await Promise.all([
        api.request<any>(`/api/venues/${selectedVenueId}/risk-score`),
        api.request<any>(`/api/venues/${selectedVenueId}/quote`),
        api.request<any[]>(`/api/venues/${selectedVenueId}/incidents?status=open`),
        api.request<any>(`/api/venues/${selectedVenueId}/live`),
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
      setComplianceCount((live?.compliance_queue ?? []).length);
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      // 404 means the venue hasn't been set up yet — not a real error
      if (msg.includes('404') || msg.toLowerCase().includes('venue not found') || msg.includes('not found')) {
        setFetchError(null);
        // Clear stale data so we don't show another venue's risk while viewing this one.
        setRiskData(null);
        setQuoteData(null);
        setOpenIncidents(0);
      } else {
        setFetchError(msg || 'Failed to load venue data');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedVenueId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]));

  function handleSelectVenue(venueId: string) {
    if (venueId === selectedVenueId) return;
    setSelectedVenueId(venueId);
    setLoading(true);
  }

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
      contentContainerStyle={[styles.content, { paddingTop: 16 }]}
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
        <Text style={styles.heroHeading}>
          Operational{' '}
          <Text style={styles.heroAccent}>Defense</Text>
        </Text>
        <Text style={styles.heroSubtitle}>
          Your operational data — your defense against premium hikes
        </Text>
      </View>

      {/* Venue switcher — only render when the operator has more than one venue */}
      {venuesList.length > 1 && (
        <View style={styles.venueSwitcher}>
          <Text style={styles.venueSwitcherLabel}>VIEWING</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {venuesList.map((v) => {
              const active = v.id === selectedVenueId;
              return (
                <Pressable
                  key={v.id}
                  onPress={() => handleSelectVenue(v.id)}
                  style={({ pressed }) => [
                    styles.chip,
                    active && styles.chipActive,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                    {v.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Savings hero */}
      {quoteData && (quoteData.savings_annual ?? 0) > 0 && (
        <View style={styles.savingsCard}>
          <Text style={styles.savingsEyebrow}>NIGHTLINE SAVES YOU</Text>
          <Text style={styles.savingsAmount}>
            ${(quoteData.savings_annual ?? 0).toLocaleString()}
            <Text style={styles.savingsPerYear}>/yr</Text>
          </Text>
          <Text style={styles.savingsSub}>
            vs. market rate of ${quoteData.market_rate_annual?.toLocaleString()} — {quoteData.savings_pct}% discount through evidence-first underwriting
          </Text>
        </View>
      )}

      {/* Stats bar */}
      <View style={styles.statsRow}>
        {/* Your Venue(s) */}
        <Pressable style={styles.statCard} onPress={() => navigation.getParent()?.navigate('Venues')}>
          <Text style={styles.statEyebrow}>{venuesList.length === 1 ? 'YOUR VENUE' : 'YOUR VENUES'}</Text>
          <Text style={styles.statValue}>{venuesList.length}</Text>
        </Pressable>

        {/* Open Incidents */}
        <Pressable
          style={styles.statCard}
          onPress={() => navigation.getParent()?.navigate('Incidents', {
            screen: 'IncidentList',
            params: { venueId: selectedVenueId, initialFilter: 'open' },
          })}
        >
          <Text style={styles.statEyebrow}>OPEN INCIDENTS</Text>
          <Text style={[styles.statValue, openIncidents > 0 && styles.statError]}>
            {openIncidents}
          </Text>
        </Pressable>

        {/* Compliance Actions */}
        <Pressable
          style={styles.statCard}
          onPress={() => navigation.getParent()?.navigate('Compliance', {
            screen: 'ComplianceList',
            params: { venueId: selectedVenueId },
          })}
        >
          <Text style={styles.statEyebrow}>COMPLIANCE</Text>
          <Text style={[styles.statValue, complianceCount > 0 && styles.statError]}>
            {complianceCount}
          </Text>
        </Pressable>
      </View>

      {/* Error state — venue exists but data failed to load */}
      {!riskData && !quoteData && fetchError && (
        <View style={styles.errorCard}>
          <View style={styles.errorIconRow}>
            <View style={styles.errorIconBadge}>
              <Text style={styles.errorIconText}>!</Text>
            </View>
            <Text style={styles.errorEyebrow}>FAILED TO LOAD</Text>
          </View>
          <Text style={styles.errorHeading}>Couldn't load venue data</Text>
          <Text style={styles.errorBody}>
            Your venue is set up but we hit a snag fetching your risk profile. This is usually temporary.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.8 }]}
            onPress={() => { setLoading(true); fetchData(); }}
          >
            <Text style={styles.retryBtnText}>Try again →</Text>
          </Pressable>
        </View>
      )}

      {/* Empty state — no venue set up yet */}
      {!riskData && !quoteData && !fetchError && (
        <Pressable
          style={({ pressed }) => [styles.emptyCard, pressed && { opacity: 0.8 }]}
          onPress={() => navigation.navigate('VenueSetup')}
        >
          <Text style={styles.emptyEyebrow}>NO VENUE DATA</Text>
          <Text style={styles.emptyHeading}>Set up your venue</Text>
          <Text style={styles.emptyBody}>
            Tap to add your venue details and generate your first risk profile and premium quote.
          </Text>
          <Text style={styles.emptyAction}>Get started →</Text>
        </Pressable>
      )}

      {/* Coverage entry — operator's policy + request surface (nested in DashboardStack) */}
      <Pressable
        style={({ pressed }) => [styles.coverageLink, pressed && { opacity: 0.8 }]}
        onPress={() => navigation.navigate('Coverage')}
      >
        <Text style={styles.coverageLinkLabel}>MY COVERAGE</Text>
        <Text style={styles.coverageLinkArrow}>→</Text>
      </Pressable>

      {/* Risk Profile card */}
      {riskData && (
        <Pressable
          style={({ pressed }) => [styles.card, { borderColor: `${tierColor}22` }, pressed && { opacity: 0.8 }]}
          onPress={() => navigation.navigate('RiskProfileDetail', {
            riskData,
            quoteData,
            venueName: user?.name,
            isBroker: false,
          })}
        >
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
          <Text style={styles.tapHint}>Tap for full risk analysis →</Text>
        </Pressable>
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
  savingsCard: {
    backgroundColor: 'rgba(200,240,0,0.05)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.2)',
    borderRadius: 14,
    padding: 16,
    gap: 6,
    marginBottom: 4,
  },
  savingsEyebrow: { color: '#8b90a8', fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  savingsAmount: { color: '#c8f000', fontSize: 36, fontWeight: '800', letterSpacing: -1, fontFamily: 'JetBrainsMono_700Bold' },
  savingsPerYear: { color: '#8b90a8', fontSize: 16, fontWeight: '400', fontFamily: 'DMSans_400Regular' },
  savingsSub: { color: '#8b90a8', fontSize: 12, lineHeight: 18, fontFamily: 'JetBrainsMono_400Regular' },

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

  // Venue switcher
  venueSwitcher: {
    marginBottom: 20,
    gap: 8,
  },
  venueSwitcherLabel: {
    color: '#4a4f65',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  chipRow: {
    gap: 8,
    paddingRight: 16,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: '#0d0f1c',
    maxWidth: 220,
  },
  chipActive: {
    borderColor: '#c8f000',
    backgroundColor: 'rgba(200,240,0,0.08)',
  },
  chipText: {
    color: '#8b90a8',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'DMSans_400Regular',
  },
  chipTextActive: {
    color: '#c8f000',
    fontWeight: '700',
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
  coverageLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0d0f1c',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(200,240,0,0.25)',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
  },
  coverageLinkLabel: { color: '#c8f000', fontSize: 11, letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },
  coverageLinkArrow: { color: '#c8f000', fontSize: 16, fontFamily: 'JetBrainsMono_700Bold' },
  sectionEyebrow: {
    color: '#4a4f65',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 14,
    fontFamily: 'JetBrainsMono_700Bold',
  },

  // Error state
  errorCard: {
    backgroundColor: 'rgba(255,69,87,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,69,87,0.2)',
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
    gap: 10,
  },
  errorIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  errorIconBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,69,87,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,69,87,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorIconText: {
    color: '#ff4557',
    fontSize: 14,
    fontWeight: '800',
    fontFamily: 'JetBrainsMono_700Bold',
    lineHeight: 16,
  },
  errorEyebrow: {
    color: '#ff4557',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  errorHeading: {
    color: '#eeeef5',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.5,
    fontFamily: 'CormorantGaramond_700Bold',
  },
  errorBody: {
    color: '#8b90a8',
    fontSize: 13,
    lineHeight: 20,
    fontFamily: 'DMSans_400Regular',
  },
  retryBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: 'rgba(255,69,87,0.35)',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 2,
  },
  retryBtnText: {
    color: '#ff4557',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'JetBrainsMono_700Bold',
  },

  // Empty state
  emptyCard: {
    backgroundColor: '#0d0f1c',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 16,
    padding: 24,
    marginBottom: 12,
    gap: 8,
  },
  emptyEyebrow: {
    color: '#4a4f65',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  emptyHeading: {
    color: '#eeeef5',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.5,
    fontFamily: 'CormorantGaramond_700Bold',
  },
  emptyBody: {
    color: '#4a4f65',
    fontSize: 13,
    lineHeight: 20,
    fontFamily: 'DMSans_400Regular',
  },
  emptyAction: {
    color: '#c8f000',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'JetBrainsMono_700Bold',
    marginTop: 4,
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
  tapHint: { color: '#4a4f65', fontSize: 11, fontFamily: 'JetBrainsMono_400Regular', marginTop: 4 },

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
