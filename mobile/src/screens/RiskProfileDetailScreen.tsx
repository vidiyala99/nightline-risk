import React, { useEffect, useState } from 'react';
import { HandAccent } from "../components/HandAccent";
import { Colors } from "../theme/colors";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CapacityBar } from '../components/CapacityBar';
import { api } from '../api/client';
import { type OverrideStats } from '../types/claims';
import { getFactorTier, factorGlyph } from '../lib/format';
import { tierColor as getTierColor } from '../theme/tiers';
import { ChevronRight } from 'lucide-react-native';

// Per-factor plain-English explanations based on score ranges
const FACTOR_EXPLANATIONS: Record<string, {
  label: string;
  good: string;
  moderate: string;
  poor: string;
  action: string;
}> = {
  incident_history: {
    label: 'Incident History',
    good: 'Your incident record is clean. Low frequency and quick resolution show underwriters you run a safe operation.',
    moderate: 'A few open or recent incidents are moderately impacting your score. Closing them and documenting outcomes improves this factor.',
    poor: 'Multiple unresolved incidents are the biggest drag on your score. Prioritize closing open cases and uploading evidence packets.',
    action: 'Close open incidents and upload supporting evidence to each report.',
  },
  compliance: {
    label: 'Compliance',
    good: 'All compliance actions are resolved. Your documentation is in good standing with underwriters.',
    moderate: 'Some compliance items are pending. Clearing them shows proactive risk management.',
    poor: 'Unresolved compliance actions signal gaps in your risk documentation. Address these first.',
    action: 'Complete all pending compliance actions in the Live Terminal.',
  },
  operational: {
    label: 'Operational',
    good: 'Your infrastructure and security setup are strong. Real-time data feeds give underwriters confidence in your operations.',
    moderate: 'Some operational systems need attention. Degraded infrastructure signals reduce your score.',
    poor: 'Operational gaps — degraded feeds, low security rating — are significantly impacting your premium.',
    action: 'Repair degraded infrastructure feeds and ensure all systems report in real-time.',
  },
  business_profile: {
    label: 'Business Profile',
    good: 'Your venue type, capacity management, and carrier history all contribute positively to your profile.',
    moderate: 'Your business profile has some areas that underwriters view as higher risk.',
    poor: 'Your venue type or operating history is a significant risk factor. Evidence-based documentation can offset this.',
    action: 'Maintain consistent carrier relationships and document your operational standards.',
  },
};

function getFactorColor(score: number): string {
  if (score >= 85) return Colors.accent;
  if (score >= 65) return Colors.warning;
  return Colors.error;
}

export function RiskProfileDetailScreen({ route, navigation }: any) {
  const { riskData, quoteData, venueName, isBroker } = route.params;
  const venueId: string | undefined = riskData?.venue_id;

  const [overrideStats, setOverrideStats] = useState<OverrideStats | null>(null);

  useEffect(() => {
    if (!venueId) return;
    api.request<OverrideStats>(`/api/venues/${venueId}/override-stats`)
      .then(setOverrideStats)
      .catch(() => {});
  }, [venueId]);

  const tier = riskData?.tier ?? '—';
  const score = riskData?.total_score ?? 0;
  const tierColor = getTierColor(tier);
  const factors: Record<string, number> = riskData?.factors ?? {};

  // Each factor drills into the evidence behind it. Only return an action when
  // a real, in-context destination exists — rows without one stay static (no
  // chevron), so we never show a fake affordance.
  const factorAction = (key: string): (() => void) | null => {
    switch (key) {
      case 'incident_history':
        return () => navigation.navigate('Incidents', {
          screen: 'IncidentList',
          params: { venueId, initialFilter: 'open' },
        });
      case 'compliance':
        return () => navigation.navigate('Compliance', {
          screen: 'ComplianceList',
          params: { venueId },
        });
      case 'operational':
        // Floor telemetry lives in the operator's Live Terminal; brokers can't
        // see it, so this factor stays static for them.
        return isBroker ? null : () => navigation.navigate('More', {
          screen: 'Live',
          params: { screen: 'LiveHome' },
        });
      default:
        return null;
    }
  };

  const goodFactors = Object.entries(factors).filter(([, v]) => getFactorTier(Number(v)) === 'good');
  const moderateFactors = Object.entries(factors).filter(([, v]) => getFactorTier(Number(v)) === 'moderate');
  const poorFactors = Object.entries(factors).filter(([, v]) => getFactorTier(Number(v)) === 'poor');

  const savingsAnnual = quoteData?.savings_annual ?? 0;
  const nextTierSavings = tier === 'B' ? Math.round((quoteData?.market_rate_annual ?? 0) * 0.1) :
                          tier === 'C' ? Math.round((quoteData?.market_rate_annual ?? 0) * 0.2) :
                          tier === 'D' ? Math.round((quoteData?.market_rate_annual ?? 0) * 0.3) : 0;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: 12 }]}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backLabel}>Dashboard</Text>
        </Pressable>
      </View>

      {venueName && <Text style={styles.venueName}>{venueName}</Text>}
      <Text style={styles.screenTitle}>Risk Profile</Text>
      <HandAccent>your risk picture</HandAccent>

      {/* Score hero */}
      <View style={[styles.scoreCard, { borderColor: `${tierColor}33` }]}>
        <View style={styles.scoreRow}>
          <Text style={[styles.tierGlyph, { color: tierColor }]}>{tier}</Text>
          <View style={styles.scoreDetail}>
            <Text style={[styles.scoreNum, { color: tierColor }]}>{score}<Text style={styles.scoreMax}>/100</Text></Text>
            <Text style={styles.tierLabel}>Tier {tier} · Evidence-First Underwriting</Text>
            {savingsAnnual > 0 && !isBroker && (
              <Text style={styles.savingsNote}>Saving ${savingsAnnual.toLocaleString()}/yr vs market rate</Text>
            )}
          </View>
        </View>
      </View>

      {/* Broker framing vs operator framing */}
      {isBroker ? (
        <View style={styles.framingCard}>
          <Text style={styles.framingTitle}>Risk Intelligence Summary</Text>
          <Text style={styles.framingBody}>
            This venue's risk profile reflects their operational data, incident history, and compliance posture. Use this breakdown when discussing coverage terms or renewal pricing with the venue.
          </Text>
        </View>
      ) : (
        <View style={styles.framingCard}>
          <Text style={styles.framingTitle}>
            {score >= 85 ? 'Your profile is strong — keep it up.' :
             score >= 65 ? 'Good foundation — a few areas to improve.' :
             'Action needed to lower your premium.'}
          </Text>
          <Text style={styles.framingBody}>
            {score >= 85
              ? 'Your operational data and incident record show underwriters you run a tight operation. Maintaining this keeps your premium low and your coverage secure.'
              : score >= 65
              ? 'You\'re in good standing but addressing the factors below could move you to a better tier and reduce your annual premium.'
              : 'Your current score is driving a higher premium. The factors below are specific — addressing them directly will improve your rate at renewal.'}
          </Text>
        </View>
      )}

      {/* Factor breakdown */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>FACTOR BREAKDOWN</Text>
        <View style={styles.factorList}>
          {Object.entries(factors).map(([key, val]) => {
            const score = Number(val);
            const color = getFactorColor(score);
            const info = FACTOR_EXPLANATIONS[key];
            const tier = getFactorTier(score);
            const label = info?.label ?? key.replace(/_/g, ' ').toUpperCase();
            const onPress = factorAction(key);

            const inner = (
              <>
                <CapacityBar label={label} value={score} max={100} invertScale />
                <View style={styles.factorExplainRow}>
                  <Text
                    style={[styles.factorGlyph, { color }]}
                    accessibilityLabel={`${score} out of 100, ${tier}`}
                  >
                    {factorGlyph(tier)}
                  </Text>
                  <Text style={[styles.factorExplain, { color: color === Colors.accent ? Colors.textSecondary : color }]}>
                    {info?.[tier] ?? ''}
                  </Text>
                </View>
              </>
            );

            if (!onPress) {
              return <View key={key} style={styles.factorItem}>{inner}</View>;
            }
            return (
              <Pressable
                key={key}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={`View ${label.toLowerCase()}`}
                style={({ pressed }) => [styles.factorItemNav, pressed && { opacity: 0.7 }]}
              >
                <View style={styles.factorMain}>{inner}</View>
                <ChevronRight size={18} color={Colors.textMuted} />
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* What's working */}
      {goodFactors.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>WHAT'S WORKING</Text>
          {goodFactors.map(([key, val]) => {
            const info = FACTOR_EXPLANATIONS[key];
            return (
              <View key={key} style={styles.insightRow}>
                <Text style={styles.insightIcon}>✓</Text>
                <View style={styles.insightContent}>
                  <Text style={styles.insightLabel}>{info?.label ?? key.replace(/_/g, ' ')}</Text>
                  <Text style={styles.insightText}>{info?.good ?? ''}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* What needs attention (operators only) */}
      {!isBroker && (moderateFactors.length > 0 || poorFactors.length > 0) && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>WHAT TO IMPROVE</Text>
          {[...poorFactors, ...moderateFactors].map(([key, val]) => {
            const score = Number(val);
            const info = FACTOR_EXPLANATIONS[key];
            const tier = getFactorTier(score);
            const color = getFactorColor(score);
            return (
              <View key={key} style={styles.insightRow}>
                <Text style={[styles.insightIcon, { color }]}>↑</Text>
                <View style={styles.insightContent}>
                  <Text style={styles.insightLabel}>{info?.label ?? key.replace(/_/g, ' ')}</Text>
                  <Text style={styles.insightText}>{info?.[tier] ?? ''}</Text>
                  {info?.action && (
                    <Text style={[styles.insightAction, { color }]}>{info.action}</Text>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* Broker: exposed risk factors */}
      {isBroker && (moderateFactors.length > 0 || poorFactors.length > 0) && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>RISK EXPOSURE</Text>
          {[...poorFactors, ...moderateFactors].map(([key, val]) => {
            const score = Number(val);
            const info = FACTOR_EXPLANATIONS[key];
            const tier = getFactorTier(score);
            const color = getFactorColor(score);
            return (
              <View key={key} style={styles.insightRow}>
                <Text style={[styles.insightIcon, { color }]}>!</Text>
                <View style={styles.insightContent}>
                  <Text style={styles.insightLabel}>{info?.label ?? key.replace(/_/g, ' ')}</Text>
                  <Text style={styles.insightText}>{info?.[tier] ?? ''}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* Premium impact */}
      {quoteData && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>PREMIUM IMPACT</Text>
          <View style={styles.premiumRow}>
            <Text style={styles.premiumLabel}>Annual Premium</Text>
            <Text style={[styles.premiumValue, { color: tierColor }]}>${(quoteData.annual_premium ?? 0).toLocaleString()}</Text>
          </View>
          <View style={styles.premiumRow}>
            <Text style={styles.premiumLabel}>Monthly</Text>
            <Text style={styles.premiumValueSub}>${(quoteData.monthly_premium ?? 0).toLocaleString()}</Text>
          </View>
          {savingsAnnual > 0 && (
            <View style={styles.premiumRow}>
              <Text style={styles.premiumLabel}>vs. Market Rate</Text>
              <Text style={[styles.premiumValue, { color: Colors.accentInk }]}>-${savingsAnnual.toLocaleString()}/yr</Text>
            </View>
          )}
          {!isBroker && nextTierSavings > 0 && (
            <View style={[styles.upgradeCard, { borderColor: Colors.accent + '33' }]}>
              <Text style={styles.upgradeText}>
                Improving to the next tier could save an additional ~${nextTierSavings.toLocaleString()}/yr at renewal.
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Override Calibration */}
      {overrideStats && overrideStats.override_total > 0 && (() => {
        const right = overrideStats.override_right_rate;
        const base = overrideStats.non_override_right_rate;
        const decided = overrideStats.override_approved + overrideStats.override_rejected;
        const rateColor = right == null ? Colors.textMuted
          : base == null ? Colors.accent
          : right >= base ? Colors.accent
          : right >= base * 0.6 ? Colors.warning
          : Colors.error;
        const delta = right != null && base != null ? Math.round((right - base) * 100) : null;
        return (
          <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: rateColor }]}>
            <Text style={styles.eyebrow}>OVERRIDE CALIBRATION</Text>
            <Text style={{ color: Colors.textSecondary, fontSize: 12, fontFamily: 'HankenGrotesk_400Regular', marginTop: -8 }}>
              How often operator overrides align with broker decisions
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1, alignItems: 'center', padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: `${rateColor}44`, borderRadius: 10 }}>
                <Text style={{ color: rateColor, fontSize: 28, fontFamily: 'SpaceMono_700Bold', letterSpacing: -1 }}>
                  {right == null ? '—' : `${Math.round(right * 100)}%`}
                </Text>
                <Text style={styles.eyebrow}>OVERRIDES</Text>
                <Text style={{ color: Colors.textMuted, fontSize: 10, fontFamily: 'SpaceMono_400Regular', marginTop: 2 }}>
                  {decided} of {overrideStats.override_total} decided
                </Text>
              </View>
              <View style={{ flex: 1, alignItems: 'center', padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, borderRadius: 10 }}>
                <Text style={{ color: Colors.textSecondary, fontSize: 28, fontFamily: 'SpaceMono_700Bold', letterSpacing: -1 }}>
                  {base == null ? '—' : `${Math.round(base * 100)}%`}
                </Text>
                <Text style={styles.eyebrow}>BASELINE</Text>
                <Text style={{ color: Colors.textMuted, fontSize: 10, fontFamily: 'SpaceMono_400Regular', marginTop: 2 }}>
                  Non-overrides
                </Text>
              </View>
              {delta != null && (
                <View style={{ flex: 1, alignItems: 'center', padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, borderRadius: 10 }}>
                  <Text style={{ color: delta >= 0 ? Colors.accent : Colors.error, fontSize: 24, fontFamily: 'SpaceMono_700Bold' }}>
                    {delta >= 0 ? '+' : ''}{delta}
                  </Text>
                  <Text style={styles.eyebrow}>DELTA PP</Text>
                </View>
              )}
            </View>
            {Object.entries(overrideStats.by_reason).map(([reason, counts]) => {
              const d = counts.approved + counts.rejected;
              const rr = d > 0 ? Math.round(counts.approved / d * 100) : null;
              return (
                <View key={reason} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)' }}>
                  <Text style={{ color: Colors.textSecondary, fontSize: 12, fontFamily: 'HankenGrotesk_400Regular', textTransform: 'capitalize' }}>
                    {reason.replace(/_/g, ' ')}
                  </Text>
                  <Text style={{ color: rr == null ? Colors.textMuted : rr >= 70 ? Colors.accent : rr >= 40 ? Colors.warning : Colors.error, fontFamily: 'SpaceMono_700Bold', fontSize: 12 }}>
                    {rr == null ? 'pending' : `${rr}%`}
                  </Text>
                </View>
              );
            })}
          </View>
        );
      })()}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 48 },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  backArrow: { color: Colors.accentInk, fontSize: 18 },
  backLabel: { color: Colors.accentInk, fontSize: 13, fontWeight: '600', fontFamily: 'HankenGrotesk_600SemiBold' },
  signOut: { color: Colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },

  venueName: { color: Colors.textMuted, fontSize: 13, fontFamily: 'HankenGrotesk_400Regular', marginBottom: 2 },
  screenTitle: { color: Colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.5, marginBottom: 20, fontFamily: 'BricolageGrotesque_700Bold' },

  scoreCard: {
    backgroundColor: Colors.surface, borderWidth: 1, borderRadius: 16,
    padding: 20, marginBottom: 12,
  },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  tierGlyph: { fontSize: 72, fontWeight: '800', letterSpacing: -2, lineHeight: 72, fontFamily: 'BricolageGrotesque_700Bold' },
  scoreDetail: { flex: 1, gap: 4 },
  scoreNum: { fontSize: 36, fontWeight: '800', letterSpacing: -1, fontFamily: 'SpaceMono_700Bold' },
  scoreMax: { fontSize: 16, color: Colors.textMuted, fontFamily: 'HankenGrotesk_400Regular' },
  tierLabel: { color: Colors.textMuted, fontSize: 12, fontFamily: 'SpaceMono_400Regular' },
  savingsNote: { color: Colors.accentInk, fontSize: 12, fontFamily: 'SpaceMono_400Regular', marginTop: 4 },

  framingCard: {
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle, borderRadius: 14, padding: 16, marginBottom: 12, gap: 8,
  },
  framingTitle: { color: Colors.text, fontSize: 16, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  framingBody: { color: Colors.textSecondary, fontSize: 14, lineHeight: 22, fontFamily: 'HankenGrotesk_400Regular' },

  card: {
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle, borderRadius: 14, padding: 16, marginBottom: 12, gap: 14,
  },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },

  factorList: { gap: 18 },
  factorItem: { gap: 6 },
  factorItemNav: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  factorMain: { flex: 1, gap: 6 },
  factorExplainRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  factorGlyph: { fontSize: 12, lineHeight: 17, fontFamily: 'SpaceMono_700Bold', width: 14 },
  factorExplain: { flex: 1, fontSize: 12, lineHeight: 17, fontFamily: 'HankenGrotesk_400Regular' },

  insightRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  insightIcon: { fontSize: 16, fontWeight: '700', color: Colors.accentInk, width: 16, fontFamily: 'SpaceMono_700Bold' },
  insightContent: { flex: 1, gap: 3 },
  insightLabel: { color: Colors.text, fontSize: 14, fontWeight: '600', fontFamily: 'HankenGrotesk_600SemiBold' },
  insightText: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19, fontFamily: 'HankenGrotesk_400Regular' },
  insightAction: { fontSize: 12, fontWeight: '700', marginTop: 2, fontFamily: 'SpaceMono_700Bold' },

  premiumRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)',
  },
  premiumLabel: { color: Colors.textSecondary, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular' },
  premiumValue: { fontSize: 18, fontWeight: '800', fontFamily: 'SpaceMono_700Bold' },
  premiumValueSub: { color: Colors.textMuted, fontSize: 14, fontFamily: 'SpaceMono_400Regular' },
  upgradeCard: {
    borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 4,
    backgroundColor: 'rgba(200,240,0,0.04)',
  },
  upgradeText: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19, fontFamily: 'HankenGrotesk_400Regular' },
});
