import React, { useCallback, useEffect, useState } from 'react';
import { Colors } from "../theme/colors";
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
import { tierColor as getTierColor } from '../theme/tiers';
import { getFactorTier, normalizeFactors } from '../lib/format';

// Tier-label shown in the factor-row chip. The 0-100 score is inverted from
// risk (higher score = lower risk, like a credit score). Pairing with risk
// language ("LOW RISK · 95/100") makes the row read direction-correctly for
// an insurance audience and stops the score from being misread as a count.
const FACTOR_TIER_LABEL: Record<'good' | 'moderate' | 'poor', string> = {
  good: 'LOW RISK',
  moderate: 'MODERATE',
  poor: 'HIGH RISK',
};
const FACTOR_TIER_COLOR: Record<'good' | 'moderate' | 'poor', string> = {
  good: Colors.accent,
  moderate: Colors.warning,
  poor: Colors.error,
};
// Display labels for the factor keys returned by the risk-score API. We
// rename the count-shaped ones to direction-bearing nouns so users don't
// read "Incident History 70" as "70 incidents".
const FACTOR_DISPLAY_LABEL: Record<string, string> = {
  incident_history: 'SAFETY RECORD',
  compliance: 'COMPLIANCE',
  operational: 'OPERATIONAL HEALTH',
  business_profile: 'BUSINESS PROFILE',
};

const STATUS_DOT: Record<string, string> = {
  operational: Colors.accent, active: Colors.accent, degraded: Colors.warning, down: Colors.error,
};

export function BrokerVenueDetailScreen({ route, navigation }: any) {
  const { venueId, venueName, isProspect: isProspectParam } = route.params;
  const insets = useSafeAreaInsets();
  const [live, setLive] = useState<any>(null);
  const [risk, setRisk] = useState<any>(null);
  const [quote, setQuote] = useState<any>(null);
  // Status-bucketed counts power the "4 incidents · 2 open" line under the
  // Incident History factor. The total here MUST equal what IncidentList
  // shows when no filter is applied — guarded by backend reconciliation test.
  const [incidentCounts, setIncidentCounts] = useState<{ total: number; open: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [liveRaw, riskData, quoteData, countsData] = await Promise.all([
        api.request<any>(`/api/venues/${venueId}/live`),
        api.request<any>(`/api/venues/${venueId}/risk-score`).catch(() => null),
        api.request<any>(`/api/venues/${venueId}/quote`).catch(() => null),
        api.request<{ total: number; open: number }>(`/api/venues/${venueId}/incidents/counts`).catch(() => null),
      ]);
      if (countsData) {
        setIncidentCounts({ total: countsData.total ?? 0, open: countsData.open ?? 0 });
      }

      let infra: { name: string; status: string; detail?: string; is_degraded?: boolean }[] = [];
      if (Array.isArray(liveRaw.infrastructure)) {
        infra = liveRaw.infrastructure.map((i: any) => ({
          name: String(i.name ?? ''), status: String(i.status ?? ''),
          detail: i.detail ? String(i.detail) : undefined, is_degraded: Boolean(i.is_degraded),
        }));
      } else if (liveRaw.infrastructure && typeof liveRaw.infrastructure === 'object') {
        infra = Object.entries(liveRaw.infrastructure).map(([k, v]: [string, any]) => ({
          name: typeof v === 'object' ? String(v.name ?? k) : k,
          status: typeof v === 'object' ? String(v.status ?? '') : String(v),
          detail: typeof v === 'object' && v.detail ? String(v.detail) : undefined,
          is_degraded: typeof v === 'object' ? Boolean(v.is_degraded) : false,
        }));
      }

      if (riskData?.factors) {
        riskData.factors = normalizeFactors(riskData.factors);
      }

      const queue = (liveRaw.compliance_queue ?? []).map((item: any) => ({
        action: String(item.action ?? item.title ?? ''),
        priority: String(item.priority ?? item.severity ?? 'low').toLowerCase(),
      }));

      setLive({ ...liveRaw, infrastructure: infra, compliance_queue: queue });
      setRisk(riskData);
      setQuote(quoteData);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (loading) return <View style={styles.centered}><ActivityIndicator color={Colors.accentInk} /></View>;

  const tier = risk?.tier ?? '—';
  const tierColor = getTierColor(tier);
  const capacityPct = live ? live.current_capacity / live.max_capacity : 0;
  const factors: Record<string, number> = risk?.factors ?? {};
  const savingsAnnual = quote?.savings_annual ?? 0;
  const renewalDate = quote?.renewal_date ?? null;
  // Route param is authoritative — MarketScreen sets it for prospect entries,
  // BrokerVenuesScreen sets it to false. Backend `source` field is a fallback
  // for deep-link entries that don't go through those screens.
  const isProspect = isProspectParam ?? risk?.source === 'prospect';

  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}>
      {/* Back */}
      <Pressable
        style={styles.backRow}
        onPress={() => navigation.goBack()}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <Text style={styles.backArrow}>←</Text>
        <Text style={styles.backLabel}>Back</Text>
      </Pressable>

      {/* Header — framing flips for prospects (no live floor data exists) */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerEyebrow}>{isProspect ? 'ESTIMATED PROFILE' : 'LIVE TERMINAL'}</Text>
            <Text style={styles.venueName}>{venueName}</Text>
          </View>
          {isProspect ? (
            renewalDate && (
              <View style={styles.estBadge}>
                <Text style={styles.estBadgeText}>EST.</Text>
                <Text style={styles.renewalDate}>{renewalDate}</Text>
              </View>
            )
          ) : (
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveBadgeText}>LIVE</Text>
              {renewalDate && <Text style={styles.renewalDate}>{renewalDate}</Text>}
            </View>
          )}
        </View>
        {isProspect && (
          <Text style={styles.prospectNote}>
            Modeled from public license records — bind a quote to convert to a live profile.
          </Text>
        )}
      </View>

      {/* Live Occupancy — operator-only floor data; the /live endpoint zeros it
          for brokers, so this card stays hidden on the broker surface. */}
      {live && live.current_capacity > 0 && (
        <View style={[styles.card, capacityPct > 0.85 && styles.cardDanger]}>
          <View style={styles.occupancyHeader}>
            <Text style={styles.eyebrow}>LIVE OCCUPANCY</Text>
            <Text style={[styles.occupancyNumbers, { color: capacityPct > 0.85 ? Colors.error : Colors.warning }]}>
              {live.current_capacity} / {live.max_capacity}
            </Text>
          </View>
          <CapacityBar label="" value={live.current_capacity} max={live.max_capacity} />
        </View>
      )}

      {/* Risk Profile card */}
      {risk && (
        <Pressable
          style={({ pressed }) => [styles.card, { borderColor: `${tierColor}22` }, pressed && { opacity: 0.8 }]}
          onPress={() => navigation.navigate('RiskProfileDetail', { riskData: risk, quoteData: quote, venueName, isBroker: true, isProspect })}
        >
          <View style={styles.riskHeader}>
            <Text style={styles.eyebrow}>RISK PROFILE{isProspect ? ' (EST.)' : ''}</Text>
            <View style={[styles.tierBadge, { borderColor: tierColor }]}>
              <Text style={[styles.tierBadgeText, { color: tierColor }]}>TIER {tier}</Text>
            </View>
          </View>
          <View style={styles.scoreRow}>
            <Text style={[styles.scoreBig, { color: tierColor }]}>{risk.total_score}</Text>
            <Text style={styles.scoreMax}> / 100</Text>
          </View>
          {Object.keys(factors).length > 0 && (
            <View style={styles.factorList}>
              {Object.entries(factors).map(([key, val]) => {
                const s = Number(val);
                const ft = getFactorTier(s);
                const fcolor = FACTOR_TIER_COLOR[ft];
                const pct = Math.min(s / 100, 1);
                const label = FACTOR_DISPLAY_LABEL[key] ?? key.replace(/_/g, ' ').toUpperCase();
                // For incident_history we have a real count we can show. Other
                // factors don't have a clean numeric count, so we leave them
                // chip-only — truth over symmetry.
                const showCount = key === 'incident_history' && incidentCounts !== null;
                return (
                  <View key={key} style={styles.factorRow}>
                    <View style={styles.factorHeader}>
                      <Text style={styles.factorLabel}>{label}</Text>
                      <View style={[styles.factorChip, { borderColor: `${fcolor}55`, backgroundColor: `${fcolor}14` }]}>
                        <Text style={[styles.factorChipText, { color: fcolor }]}>
                          {FACTOR_TIER_LABEL[ft]} · {Math.round(s)}/100
                        </Text>
                      </View>
                    </View>
                    <View style={styles.factorTrack}>
                      <View style={[styles.factorFill, { width: `${pct * 100}%` as any, backgroundColor: fcolor }]} />
                    </View>
                    {showCount && (
                      incidentCounts!.total === 0 ? (
                        <Text style={styles.factorCountEmpty}>No incidents on file</Text>
                      ) : (
                        <Text style={styles.factorCount} accessibilityLabel={`${incidentCounts!.total} incidents total${incidentCounts!.open > 0 ? `, ${incidentCounts!.open} still open` : ''}`}>
                          <Text style={styles.factorCountStrong}>
                            {incidentCounts!.total} {incidentCounts!.total === 1 ? 'incident' : 'incidents'}
                          </Text>
                          {incidentCounts!.open > 0 && (
                            <Text style={[styles.factorCountOpen, { color: Colors.warning }]}>
                              {' '}· {incidentCounts!.open} open
                            </Text>
                          )}
                        </Text>
                      )
                    )}
                  </View>
                );
              })}
            </View>
          )}
          <Text style={styles.tapHint}>→ View full risk analysis</Text>
        </Pressable>
      )}

      {/* Premium card with market rate comparison */}
      {quote && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>PREMIUM</Text>
          <Text style={styles.premiumAmount}>${(quote.annual_premium ?? 0).toLocaleString()}<Text style={styles.premiumPer}> / Year</Text></Text>
          <Text style={styles.premiumMonthly}>${(quote.monthly_premium ?? 0).toLocaleString()} / month</Text>

          {savingsAnnual > 0 && (
            <View style={styles.savingsBox}>
              <View style={styles.savingsRow}>
                <Text style={styles.savingsLabel}>MARKET RATE</Text>
                <Text style={styles.savingsValue}>${(quote.market_rate_annual ?? 0).toLocaleString()}/yr</Text>
              </View>
              <View style={styles.savingsRow}>
                <Text style={[styles.savingsLabel, { color: Colors.accentInk }]}>CLIENT SAVES</Text>
                <Text style={[styles.savingsValue, { color: Colors.accentInk, fontWeight: '700' }]}>
                  ${savingsAnnual.toLocaleString()}/yr ({quote.savings_pct}%)
                </Text>
              </View>
            </View>
          )}

          <View style={styles.premiumMeta}>
            <Text style={styles.premiumMetaText}>↗ {tier} Tier Rate</Text>
            {renewalDate && <Text style={styles.premiumMetaText}>⊡ Renewal {renewalDate}</Text>}
          </View>
        </View>
      )}

      {/* Infrastructure */}
      {live?.infrastructure?.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>INFRASTRUCTURE SYNC</Text>
          {live.infrastructure.some((i: any) => i.is_degraded) && (
            <View style={styles.degradedWarning}>
              <Text style={styles.degradedText}>⚠ Degraded systems weaken claims defense.</Text>
            </View>
          )}
          {live.infrastructure.map((item: any, i: number) => {
            const dotColor = item.is_degraded ? Colors.warning : (STATUS_DOT[item.status.toLowerCase()] ?? Colors.textMuted);
            return (
              <View key={i} style={styles.infraRow}>
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

      {/* Compliance Queue */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>COMPLIANCE QUEUE</Text>
        {(!live?.compliance_queue || live.compliance_queue.length === 0) ? (
          <Text style={styles.complianceClear}>{'>'} No pending actions. All clear.</Text>
        ) : live.compliance_queue.map((item: any, i: number) => {
          const pColor = item.priority === 'high' || item.priority === 'urgent' ? Colors.error : item.priority === 'medium' ? Colors.warning : Colors.textMuted;
          return (
            <View key={i} style={[styles.queueRow, { borderLeftColor: pColor }]}>
              <Text style={styles.queueAction}>{item.action}</Text>
              <Text style={[styles.queuePriority, { color: pColor }]}>{item.priority.toUpperCase()}</Text>
            </View>
          );
        })}
      </View>

      {/* Coverage Breakdown */}
      {quote?.coverage_breakdown && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>COVERAGE</Text>
          {Object.entries(quote.coverage_breakdown).map(([key, val]: [string, any]) => {
            const isIncluded = val.included === true;
            const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
            const statusText = isIncluded ? 'INCLUDED' : val.optional ? 'OPTIONAL' : '—';
            return (
              <View key={key} style={styles.coverageRow}>
                <Text style={styles.coverageName}>{label}</Text>
                <Text style={[styles.coverageStatus, { color: isIncluded ? Colors.accent : Colors.textMuted }]}>{statusText}</Text>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },

  backRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 },
  backArrow: { color: Colors.accentInk, fontSize: 18 },
  backLabel: { color: Colors.accentInk, fontSize: 13, fontWeight: '600', fontFamily: 'HankenGrotesk_600SemiBold' },

  header: { marginBottom: 20 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  headerLeft: { flex: 1, gap: 4 },
  headerEyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  venueName: { color: Colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'BricolageGrotesque_700Bold' },
  liveBadge: {
    alignItems: 'center', gap: 4,
    borderWidth: 1, borderColor: 'rgba(200,240,0,0.3)', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, backgroundColor: 'rgba(200,240,0,0.06)',
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.accent },
  liveBadgeText: { color: Colors.accentInk, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  renewalDate: { color: Colors.textMuted, fontSize: 9, fontFamily: 'SpaceMono_400Regular' },

  estBadge: {
    alignItems: 'center', gap: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8,
  },
  estBadgeText: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  prospectNote: { color: Colors.textMuted, fontSize: 11, fontFamily: 'HankenGrotesk_400Regular', marginTop: 10, lineHeight: 16 },

  card: {
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle, borderRadius: 14,
    padding: 16, marginBottom: 12, gap: 12,
  },
  cardDanger: { borderColor: 'rgba(255,69,87,0.25)', backgroundColor: 'rgba(255,69,87,0.04)' },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },

  occupancyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  occupancyNumbers: { fontSize: 18, fontWeight: '800', fontFamily: 'SpaceMono_700Bold' },

  riskHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tierBadge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  tierBadgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },
  scoreRow: { flexDirection: 'row', alignItems: 'baseline' },
  scoreBig: { fontSize: 48, fontWeight: '800', letterSpacing: -2, fontFamily: 'SpaceMono_700Bold' },
  scoreMax: { color: Colors.textMuted, fontSize: 18, fontFamily: 'HankenGrotesk_400Regular' },
  factorList: { gap: 14 },
  factorRow: { gap: 6 },
  factorHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  factorLabel: { color: Colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'SpaceMono_700Bold' },
  factorChip: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  factorChipText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, fontFamily: 'SpaceMono_700Bold' },
  factorTrack: { height: 3, backgroundColor: Colors.borderSubtle, borderRadius: 2, overflow: 'hidden' },
  factorFill: { height: '100%', borderRadius: 2 },
  factorCount: { fontSize: 13, fontFamily: 'SpaceMono_400Regular', color: Colors.textSecondary, marginTop: 2 },
  factorCountEmpty: { fontSize: 12, fontFamily: 'SpaceMono_400Regular', color: Colors.textMuted, marginTop: 2, fontStyle: 'italic' },
  factorCountStrong: { color: Colors.text, fontFamily: 'SpaceMono_700Bold', letterSpacing: -0.2 },
  factorCountOpen: { fontFamily: 'SpaceMono_700Bold' },
  tapHint: { color: Colors.textMuted, fontSize: 11, fontFamily: 'SpaceMono_400Regular' },

  premiumAmount: { color: Colors.text, fontSize: 36, fontWeight: '800', letterSpacing: -1, fontFamily: 'SpaceMono_700Bold' },
  premiumPer: { color: Colors.textMuted, fontSize: 16, fontWeight: '400', fontFamily: 'HankenGrotesk_400Regular' },
  premiumMonthly: { color: Colors.textMuted, fontSize: 14, fontFamily: 'SpaceMono_400Regular' },
  savingsBox: {
    backgroundColor: 'rgba(200,240,0,0.04)', borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.15)', borderRadius: 8, padding: 12, gap: 8,
  },
  savingsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  savingsLabel: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  savingsValue: { color: Colors.textSecondary, fontSize: 12, fontFamily: 'SpaceMono_400Regular' },
  premiumMeta: { flexDirection: 'row', gap: 16 },
  premiumMetaText: { color: Colors.textMuted, fontSize: 11, fontFamily: 'SpaceMono_400Regular' },

  degradedWarning: {
    backgroundColor: 'rgba(255,149,0,0.08)', borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,149,0,0.3)', borderRadius: 8, padding: 10,
  },
  degradedText: { color: Colors.warning, fontSize: 12, fontFamily: 'SpaceMono_400Regular' },

  infraRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(23,21,15,0.06)' },
  infraDot: { width: 7, height: 7, borderRadius: 4, marginRight: 12 },
  infraName: { color: Colors.textSecondary, fontSize: 13, flex: 1, textTransform: 'capitalize', fontFamily: 'HankenGrotesk_400Regular' },
  infraStatus: { fontSize: 10, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },

  complianceClear: { color: Colors.textMuted, fontSize: 13, fontFamily: 'SpaceMono_400Regular' },
  queueRow: { borderLeftWidth: 2, paddingLeft: 12, paddingVertical: 4, gap: 2 },
  queueAction: { color: Colors.textSecondary, fontSize: 13, lineHeight: 18, fontFamily: 'HankenGrotesk_400Regular' },
  queuePriority: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'SpaceMono_700Bold' },

  coverageRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)',
  },
  coverageName: { color: Colors.textSecondary, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular' },
  coverageStatus: { fontSize: 11, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },
});
