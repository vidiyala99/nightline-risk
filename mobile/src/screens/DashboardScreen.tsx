import React, { useCallback, useEffect, useState } from 'react';
import { Colors } from "../theme/colors";
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
import { StatCard } from '../components/StatCard';
import { QuickActionTile } from '../components/QuickActionTile';
import { OnboardingCard } from '../components/OnboardingCard';
import { tierColor as getTierColor } from '../theme/tiers';
import { normalizeFactors, riskAttentionLine, factorGlyph } from '../lib/format';

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
  // Present when the venue has an in-force policy — the real bound premium,
  // which supersedes the indicative estimate (mirrors web PremiumQuote.policy).
  policy?: {
    annual_premium: string;
    monthly_premium: string;
    policy_number: string | null;
    status: string;
    effective_date: string;
    expiration_date: string;
    coverage_lines: string[];
  } | null;
}

interface VenueSummary {
  id: string;
  name: string;
}

interface LiveState {
  current_capacity?: number;
  max_capacity?: number;
  infrastructure?: Array<{ name: string; status?: string; is_degraded?: boolean }>;
  compliance_queue?: unknown[];
}

// ---- Operator report feed (mirrors web frontend/src/app/dashboard/page.tsx) ----
interface FeedRow {
  incident_id: string;
  summary: string;
  occurred_at: string;
  status: string;
  proposal_state: string | null;
  claim_status: string | null;
}

/** Plain-language renewal line for a bound policy's expiration date. */
function renewalLabel(expiration: string): string {
  const exp = new Date(expiration).getTime();
  if (Number.isNaN(exp)) return 'in force';
  const days = Math.ceil((exp - new Date().getTime()) / 86400000);
  if (days < 0) return 'expired';
  if (days === 0) return 'renews today';
  if (days <= 60) return `renews in ${days} day${days === 1 ? '' : 's'}`;
  return `renews ${new Date(expiration).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

const TERMINAL_INCIDENT = new Set(['closed', 'closed_archived']);
const TERMINAL_CLAIM = new Set(['closed_paid', 'closed_denied', 'closed_dropped']);
const TERMINAL_PROPOSAL = new Set(['paid', 'denied', 'rejected_by_broker']);

// A report stays on the home feed only while *live* — closed-and-done belongs
// in the Incidents archive; a closed incident with a claim still in flight stays.
function isActiveReport(r: FeedRow): boolean {
  const incidentActive = !TERMINAL_INCIDENT.has(r.status);
  const claimActive = !!r.claim_status && !TERMINAL_CLAIM.has(r.claim_status);
  const proposalActive = !!r.proposal_state && !TERMINAL_PROPOSAL.has(r.proposal_state);
  return incidentActive || claimActive || proposalActive;
}

function reportSteps(r: FeedRow): Array<{ label: string; lit: boolean }> {
  const ps = r.proposal_state ?? '';
  return [
    { label: 'Reported', lit: true },
    { label: 'Sent', lit: !!r.proposal_state },
    { label: 'Approved', lit: ['approved', 'filed_with_carrier', 'paid', 'denied'].includes(ps) },
    { label: 'Filed', lit: ['filed_with_carrier', 'paid', 'denied'].includes(ps) || !!r.claim_status },
    { label: 'Resolved', lit: ['paid', 'denied'].includes(ps) || ['closed_paid', 'closed_denied', 'closed_dropped'].includes(r.claim_status ?? '') },
  ];
}

export function DashboardScreen({ navigation }: any) {
  const { user } = useAuth();
  const [riskData, setRiskData] = useState<RiskScore | null>(null);
  const [quoteData, setQuoteData] = useState<PremiumQuote | null>(null);
  const [openIncidents, setOpenIncidents] = useState<number>(0);
  const [complianceCount, setComplianceCount] = useState<number>(0);
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [feedRows, setFeedRows] = useState<FeedRow[]>([]);
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
      const [risk, quote, incidents, live, feed] = await Promise.all([
        api.request<any>(`/api/venues/${selectedVenueId}/risk-score`),
        api.request<any>(`/api/venues/${selectedVenueId}/quote`),
        api.request<any[]>(`/api/venues/${selectedVenueId}/incidents?status=open`),
        api.request<any>(`/api/venues/${selectedVenueId}/live`),
        // Report feed for the claim-journey section; tolerate failure.
        api.request<FeedRow[]>(`/api/venues/${selectedVenueId}/incident-status-feed`).catch(() => [] as FeedRow[]),
      ]);

      // Normalize factors to plain numbers so they never reach JSX as objects
      if (risk?.factors) {
        risk.factors = normalizeFactors(risk.factors);
      }

      setRiskData(risk);
      setQuoteData(quote);
      setOpenIncidents(Array.isArray(incidents) ? incidents.length : 0);
      setLiveState(live ?? null);
      setComplianceCount((live?.compliance_queue ?? []).length);
      setFeedRows(Array.isArray(feed) ? feed : []);
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      // 404 means the venue hasn't been set up yet — not a real error
      if (msg.includes('404') || msg.toLowerCase().includes('venue not found') || msg.includes('not found')) {
        setFetchError(null);
        // Clear stale data so we don't show another venue's risk while viewing this one.
        setRiskData(null);
        setQuoteData(null);
        setOpenIncidents(0);
        setLiveState(null);
        setFeedRows([]);
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
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  const tier = riskData?.tier ?? '—';
  const score = riskData?.total_score ?? 0;
  const factors: Record<string, number> = riskData?.factors ?? {};
  const tierColor = getTierColor(tier);

  // Report feed (claim journey) — only live reports on home; archive holds the rest.
  const activeReports = feedRows.filter(isActiveReport);
  const claimsInFlight = activeReports.filter(r => r.proposal_state != null || r.claim_status != null).length;
  const infoRequested = activeReports.filter(r => r.proposal_state === 'needs_more_info').length;

  // Insured venue → show the ACTUAL bound policy, not the indicative estimate.
  // The backend includes quote.policy only when a policy is in force (mirrors web).
  const boundPolicy = quoteData?.policy ?? null;

  // "On the floor" live state. Capacity is only present when the caller may read
  // floor data (operator on their own venue) — guard on a real max_capacity.
  const cap = liveState?.current_capacity ?? 0;
  const maxCap = liveState?.max_capacity ?? 0;
  const capPct = maxCap > 0 ? Math.min(100, Math.round((cap / maxCap) * 100)) : 0;
  const infra = liveState?.infrastructure ?? [];
  const showFloor = maxCap > 0 || infra.length > 0;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: 16 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={Colors.accent}
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

      {/* Savings hero — estimate-only; suppressed once a policy is in force. */}
      {!boundPolicy && quoteData && (quoteData.savings_annual ?? 0) > 0 && (
        <View style={styles.savingsCard}>
          <Text style={styles.savingsEyebrow}>NIGHTLINE SAVES YOU</Text>
          <Text style={styles.savingsAmount}>
            ${(quoteData.savings_annual ?? 0).toLocaleString()}
            <Text style={styles.savingsPerYear}>/yr</Text>
          </Text>
          <Text style={styles.savingsSub}>
            vs. a standard market rate of ${quoteData.market_rate_annual?.toLocaleString()} — {quoteData.savings_pct}% better when we place your risk on its real operational data
          </Text>
        </View>
      )}

      {/* Stats bar */}
      <View style={styles.statsRow}>
        <StatCard
          value={venuesList.length}
          label={venuesList.length === 1 ? 'YOUR VENUE' : 'YOUR VENUES'}
          onPress={() => navigation.getParent()?.navigate('More', { screen: 'Venues' })}
        />
        <StatCard
          value={openIncidents}
          label="OPEN INCIDENTS"
          tone={openIncidents > 0 ? 'error' : 'default'}
          onPress={() => navigation.getParent()?.navigate('Incidents', {
            screen: 'IncidentList',
            params: { venueId: selectedVenueId, initialFilter: 'open' },
          })}
        />
        <StatCard
          value={complianceCount}
          label="COMPLIANCE"
          tone={complianceCount > 0 ? 'error' : 'default'}
          onPress={() => navigation.getParent()?.navigate('Compliance', {
            screen: 'ComplianceList',
            params: { venueId: selectedVenueId },
          })}
        />
      </View>

      {/* On the floor — live operational state (operator-only; capacity is
          gated server-side via can_read_venue_floor). Mirrors web dashboard. */}
      {showFloor && (
        <View style={styles.card}>
          <Text style={styles.sectionEyebrow}>ON THE FLOOR</Text>
          {maxCap > 0 && (
            <>
              <View style={styles.floorCapRow}>
                <Text style={styles.floorCapValue}>{cap}<Text style={styles.floorCapMax}> / {maxCap}</Text></Text>
                <Text style={styles.floorCapPct}>{capPct}%</Text>
              </View>
              <View style={styles.floorBarTrack}>
                <View style={[styles.floorBarFill, { width: `${capPct}%`, backgroundColor: capPct >= 90 ? Colors.error : capPct >= 70 ? Colors.warning : Colors.accent }]} />
              </View>
            </>
          )}
          {infra.length > 0 && (
            <View style={styles.infraGrid}>
              {infra.map((item, i) => {
                const degraded = item.is_degraded || (item.status && item.status !== 'ok' && item.status !== 'operational');
                return (
                  <View key={`${item.name}-${i}`} style={styles.infraChip}>
                    <View style={[styles.infraDot, { backgroundColor: degraded ? Colors.error : Colors.success }]} />
                    <Text style={styles.infraName} numberOfLines={1}>{item.name}</Text>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}

      {/* Claims in flight — quick doorway to tracking, mirrors web summary band */}
      {(claimsInFlight > 0 || infoRequested > 0) && (
        <View style={styles.flightRow}>
          {claimsInFlight > 0 && (
            <Pressable
              style={({ pressed }) => [styles.flightCell, pressed && { opacity: 0.8 }]}
              onPress={() => navigation.getParent()?.navigate('Claims')}
            >
              <Text style={styles.flightNum}>{claimsInFlight}</Text>
              <Text style={styles.flightLabel}>claims in flight · track →</Text>
            </Pressable>
          )}
          {infoRequested > 0 && (
            <Pressable
              style={({ pressed }) => [styles.flightCell, styles.flightCellWarn, pressed && { opacity: 0.8 }]}
              onPress={() => navigation.getParent()?.navigate('Claims')}
            >
              <Text style={[styles.flightNum, { color: Colors.warning }]}>{infoRequested}</Text>
              <Text style={styles.flightLabel}>need info →</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Your reports — what happened next (claim journey step indicators) */}
      {activeReports.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.sectionEyebrow}>YOUR REPORTS — WHAT HAPPENED NEXT</Text>
          <View style={{ gap: 12 }}>
            {activeReports.slice(0, 6).map((r) => {
              const steps = reportSteps(r);
              const currentIdx = steps.map(s => s.lit).lastIndexOf(true);
              const branch = r.proposal_state === 'rejected_by_broker' ? 'Declined'
                : r.proposal_state === 'needs_more_info' ? 'Info requested' : null;
              return (
                <Pressable
                  key={r.incident_id}
                  style={({ pressed }) => [styles.reportRow, pressed && { opacity: 0.75 }]}
                  onPress={() => navigation.getParent()?.navigate('Incidents', {
                    screen: 'IncidentDetail',
                    params: { incidentId: r.incident_id, venueId: selectedVenueId },
                  })}
                >
                  <Text style={styles.reportSummary} numberOfLines={1}>{r.summary}</Text>
                  <View style={styles.stepRow}>
                    {steps.map((s, i) => (
                      <Text
                        key={s.label}
                        style={[
                          styles.stepText,
                          { color: s.lit ? Colors.accentInk : Colors.textMuted },
                          i === currentIdx && styles.stepCurrent,
                        ]}
                      >
                        {s.lit ? '● ' : '○ '}{s.label}{i === currentIdx ? ' · now' : ''}
                      </Text>
                    ))}
                    {branch && (
                      <Text style={[styles.stepText, { color: branch === 'Info requested' ? Colors.warning : Colors.error }]}>
                        · {branch}
                      </Text>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
          {activeReports.length > 6 && (
            <Pressable
              onPress={() => navigation.getParent()?.navigate('Incidents', { screen: 'IncidentList', params: { venueId: selectedVenueId } })}
              style={{ marginTop: 10 }}
            >
              <Text style={styles.reportMore}>+{activeReports.length - 6} more in Incidents →</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Onboarding nudge — capture insurance knowns so a broker can shop coverage */}
      {selectedVenueId && <OnboardingCard venueId={selectedVenueId} />}

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
          accessibilityRole="button"
          accessibilityLabel="Set up your venue"
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
      <View style={styles.actionRow}>
        <QuickActionTile label="MY COVERAGE" onPress={() => navigation.navigate('Coverage')} />
      </View>

      {/* Risk Profile card */}
      {riskData && (
        <Pressable
          style={({ pressed }) => [styles.card, { borderColor: `${tierColor}22` }, pressed && { opacity: 0.8 }]}
          onPress={() => navigation.navigate('RiskProfileDetail', {
            riskData,
            quoteData,
            venueName: user?.name,
            isBroker: false,
            isProspect: false,
          })}
          accessibilityRole="button"
          accessibilityLabel="View full risk analysis"
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

          {/* One-line attention summary — the full factor breakdown lives on
              the Risk Profile page, not here (glance vs detail). */}
          {Object.keys(factors).length > 0 && (() => {
            const attn = riskAttentionLine(factors);
            const attnColor = attn.tier === 'poor' ? Colors.error : attn.tier === 'moderate' ? Colors.warning : Colors.tierA;
            return (
              <View style={styles.attentionRow}>
                <Text style={[styles.attentionGlyph, { color: attnColor }]}>{factorGlyph(attn.tier)}</Text>
                <Text style={[styles.attentionText, { color: attnColor }]}>{attn.text}</Text>
              </View>
            );
          })()}
          <Text style={styles.tapHint}>Tap for full risk analysis →</Text>
        </Pressable>
      )}

      {/* Policy card — real bound policy if in force, else the premium estimate.
          A venue with coverage shouldn't see a speculative quote contradicting it. */}
      {boundPolicy ? (
        <Pressable
          style={[styles.card, styles.quoteCard]}
          onPress={() => navigation.navigate('Coverage')}
          accessibilityRole="button"
          accessibilityLabel="View your coverage"
        >
          <View style={styles.quoteHeader}>
            <Text style={styles.sectionEyebrow}>YOUR POLICY · IN FORCE</Text>
            <View style={[styles.tierBadge, { borderColor: Colors.accentInk }]}>
              <Text style={[styles.tierBadgeText, { color: Colors.accentInk }]}>
                {boundPolicy.status.replace(/_/g, ' ').toUpperCase()}
              </Text>
            </View>
          </View>

          <Text style={styles.venueTypeLabel}>
            {(quoteData?.venue_type ?? '').replace(/_/g, ' ').toUpperCase()} · {boundPolicy.policy_number ?? 'PENDING NUMBER'}
          </Text>

          <Text style={styles.premiumAmount}>
            ${Math.round(Number(boundPolicy.annual_premium)).toLocaleString()}
          </Text>
          <Text style={styles.premiumSub}>/ year</Text>

          <Text style={styles.policyLines}>
            {boundPolicy.coverage_lines.map((l) => l.toUpperCase()).join(' · ') || '—'}
          </Text>
          <Text style={styles.policyCta}>{renewalLabel(boundPolicy.expiration_date)} · view coverage →</Text>
        </Pressable>
      ) : quoteData ? (
        <View style={[styles.card, styles.quoteCard]}>
          <View style={styles.quoteHeader}>
            <Text style={styles.sectionEyebrow}>INDICATIVE PREMIUM</Text>
            <View
              style={[
                styles.tierBadge,
                { borderColor: getTierColor(quoteData.tier) },
              ]}
            >
              <Text
                style={[
                  styles.tierBadgeText,
                  { color: getTierColor(quoteData.tier) },
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
            / year · indicative, subject to carrier quote
          </Text>

          <Text style={styles.premiumMonthly}>
            ${quoteData.monthly_premium?.toLocaleString() ?? '—'}
            <Text style={styles.premiumMonthlySub}> / month</Text>
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 32 },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.bg,
    paddingHorizontal: 24,
  },

  // Broker fallback
  brokerHeading: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginBottom: 8,
    textAlign: 'center',
    fontFamily: 'BricolageGrotesque_700Bold',
  },
  brokerBody: {
    color: Colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
    fontFamily: 'HankenGrotesk_400Regular',
  },
  signOut: {
    color: Colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    paddingTop: 4,
    fontFamily: 'SpaceMono_700Bold',
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
  savingsEyebrow: { color: Colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  savingsAmount: { color: Colors.accentInk, fontSize: 36, fontWeight: '800', letterSpacing: -1, fontFamily: 'SpaceMono_700Bold' },
  savingsPerYear: { color: Colors.textSecondary, fontSize: 16, fontWeight: '400', fontFamily: 'HankenGrotesk_400Regular' },
  savingsSub: { color: Colors.textSecondary, fontSize: 12, lineHeight: 18, fontFamily: 'SpaceMono_400Regular' },

  heroSection: {
    marginBottom: 24,
  },
  heroHeading: {
    color: Colors.text,
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 38,
    marginBottom: 8,
    fontFamily: 'BricolageGrotesque_700Bold',
  },
  heroAccent: {
    color: Colors.accentInk,
  },
  heroSubtitle: {
    color: Colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'HankenGrotesk_400Regular',
  },

  // Venue switcher
  venueSwitcher: {
    marginBottom: 20,
    gap: 8,
  },
  venueSwitcherLabel: {
    color: Colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'SpaceMono_700Bold',
  },
  chipRow: {
    gap: 8,
    paddingRight: 16,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    maxWidth: 220,
  },
  chipActive: {
    borderColor: Colors.accent,
    backgroundColor: 'rgba(200,240,0,0.08)',
  },
  chipText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'HankenGrotesk_400Regular',
  },
  chipTextActive: {
    color: Colors.accentInk,
    fontWeight: '700',
  },

  // Stats bar
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },

  // Quick actions — shared tile row
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },

  // On the floor (live state)
  floorCapRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  floorCapValue: { color: Colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -1, fontFamily: 'SpaceMono_700Bold' },
  floorCapMax: { color: Colors.textMuted, fontSize: 16, fontWeight: '500', fontFamily: 'HankenGrotesk_500Medium' },
  floorCapPct: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700', fontFamily: 'SpaceMono_700Bold' },
  floorBarTrack: { height: 8, borderRadius: 4, backgroundColor: Colors.borderSubtle, marginTop: 8, overflow: 'hidden' },
  floorBarFill: { height: 8, borderRadius: 4 },
  infraGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  infraChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
    backgroundColor: Colors.bg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
  },
  infraDot: { width: 7, height: 7, borderRadius: 4 },
  infraName: { color: Colors.textSecondary, fontSize: 11, fontWeight: '600', fontFamily: 'HankenGrotesk_500Medium', maxWidth: 120 },

  // Claims in flight
  flightRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  flightCell: {
    flex: 1,
    backgroundColor: 'rgba(200,240,0,0.06)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(200,240,0,0.22)',
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, gap: 2,
  },
  flightCellWarn: { backgroundColor: 'rgba(255,176,32,0.06)', borderColor: 'rgba(255,176,32,0.25)' },
  flightNum: { color: Colors.accentInk, fontSize: 22, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'SpaceMono_700Bold' },
  flightLabel: { color: Colors.textMuted, fontSize: 11, fontFamily: 'HankenGrotesk_400Regular' },

  // Report feed
  reportRow: {
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderSubtle,
    paddingBottom: 12, gap: 6,
  },
  reportSummary: { color: Colors.text, fontSize: 14, fontWeight: '600', fontFamily: 'HankenGrotesk_600SemiBold' },
  stepRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stepText: { fontSize: 11, fontFamily: 'SpaceMono_400Regular' },
  stepCurrent: { fontFamily: 'SpaceMono_700Bold' },
  reportMore: { color: Colors.accentInk, fontSize: 12, fontFamily: 'SpaceMono_400Regular' },

  // Shared card
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderSubtle,
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
  },
  sectionEyebrow: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 14,
    fontFamily: 'SpaceMono_700Bold',
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
    color: Colors.error,
    fontSize: 14,
    fontWeight: '800',
    fontFamily: 'SpaceMono_700Bold',
    lineHeight: 16,
  },
  errorEyebrow: {
    color: Colors.error,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'SpaceMono_700Bold',
  },
  errorHeading: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.5,
    fontFamily: 'BricolageGrotesque_700Bold',
  },
  errorBody: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: 'HankenGrotesk_400Regular',
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
    color: Colors.error,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'SpaceMono_700Bold',
  },

  // Empty state
  emptyCard: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 16,
    padding: 24,
    marginBottom: 12,
    gap: 8,
  },
  emptyEyebrow: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'SpaceMono_700Bold',
  },
  emptyHeading: {
    color: Colors.text,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.5,
    fontFamily: 'BricolageGrotesque_700Bold',
  },
  emptyBody: {
    color: Colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: 'HankenGrotesk_400Regular',
  },
  emptyAction: {
    color: Colors.accentInk,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'SpaceMono_700Bold',
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
    borderBottomColor: Colors.borderSubtle,
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
    fontFamily: 'SpaceMono_700Bold',
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
    fontFamily: 'SpaceMono_700Bold',
  },
  scoreMax: {
    color: Colors.textMuted,
    fontSize: 16,
    fontWeight: '500',
    paddingBottom: 6,
    fontFamily: 'HankenGrotesk_500Medium',
  },
  attentionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  attentionGlyph: { fontSize: 13, fontWeight: '700', fontFamily: 'SpaceMono_700Bold' },
  attentionText: { fontSize: 13, fontFamily: 'SpaceMono_700Bold', letterSpacing: 0.2 },
  tapHint: { color: Colors.textMuted, fontSize: 11, fontFamily: 'SpaceMono_400Regular', marginTop: 4 },

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
    color: Colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 12,
    fontFamily: 'SpaceMono_700Bold',
  },
  premiumAmount: {
    color: Colors.text,
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1.5,
    lineHeight: 44,
    fontFamily: 'SpaceMono_700Bold',
  },
  premiumSub: {
    color: Colors.textMuted,
    fontSize: 12,
    marginBottom: 10,
    fontFamily: 'HankenGrotesk_400Regular',
  },
  premiumMonthly: {
    color: Colors.text,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.5,
    fontFamily: 'SpaceMono_400Regular',
  },
  premiumMonthlySub: {
    color: Colors.textMuted,
    fontSize: 13,
    fontWeight: '400',
    fontFamily: 'HankenGrotesk_400Regular',
  },
  policyLines: {
    color: Colors.textSecondary,
    fontSize: 11,
    letterSpacing: 0.4,
    marginTop: 6,
    fontFamily: 'SpaceMono_400Regular',
  },
  policyCta: {
    color: Colors.accentInk,
    fontSize: 12,
    marginTop: 10,
    fontFamily: 'HankenGrotesk_600SemiBold',
  },
});
