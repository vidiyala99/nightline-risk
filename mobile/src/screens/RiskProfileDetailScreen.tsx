import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { CapacityBar } from '../components/CapacityBar';

const TIER_COLOR: Record<string, string> = {
  A: '#c8f000', B: '#00d97e', C: '#ff9500', D: '#ff4557',
};

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

function getFactorTier(score: number): 'good' | 'moderate' | 'poor' {
  if (score >= 85) return 'good';
  if (score >= 65) return 'moderate';
  return 'poor';
}

function getFactorColor(score: number): string {
  if (score >= 85) return '#c8f000';
  if (score >= 65) return '#ff9500';
  return '#ff4557';
}

export function RiskProfileDetailScreen({ route, navigation }: any) {
  const { riskData, quoteData, venueName, isBroker } = route.params;
  const { signOut } = useAuth();
  const insets = useSafeAreaInsets();

  const tier = riskData?.tier ?? '—';
  const score = riskData?.total_score ?? 0;
  const tierColor = TIER_COLOR[tier] ?? '#4a4f65';
  const factors: Record<string, number> = riskData?.factors ?? {};

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
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backLabel}>Dashboard</Text>
        </Pressable>
        <Text style={styles.signOut} onPress={signOut}>SIGN OUT</Text>
      </View>

      {venueName && <Text style={styles.venueName}>{venueName}</Text>}
      <Text style={styles.screenTitle}>Risk Profile</Text>

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
            return (
              <View key={key} style={styles.factorItem}>
                <CapacityBar
                  label={info?.label ?? key.replace(/_/g, ' ').toUpperCase()}
                  value={score}
                  max={100}
                  invertScale
                />
                <Text style={[styles.factorExplain, { color: color === '#c8f000' ? '#8b90a8' : color }]}>
                  {info?.[tier] ?? ''}
                </Text>
              </View>
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
              <Text style={[styles.premiumValue, { color: '#c8f000' }]}>-${savingsAnnual.toLocaleString()}/yr</Text>
            </View>
          )}
          {!isBroker && nextTierSavings > 0 && (
            <View style={[styles.upgradeCard, { borderColor: '#c8f000' + '33' }]}>
              <Text style={styles.upgradeText}>
                Improving to the next tier could save an additional ~${nextTierSavings.toLocaleString()}/yr at renewal.
              </Text>
            </View>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07080f' },
  content: { paddingHorizontal: 20, paddingBottom: 48 },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  backArrow: { color: '#c8f000', fontSize: 18 },
  backLabel: { color: '#c8f000', fontSize: 13, fontWeight: '600', fontFamily: 'DMSans_600SemiBold' },
  signOut: { color: '#8b90a8', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },

  venueName: { color: '#4a4f65', fontSize: 13, fontFamily: 'DMSans_400Regular', marginBottom: 2 },
  screenTitle: { color: '#eeeef5', fontSize: 32, fontWeight: '800', letterSpacing: -0.5, marginBottom: 20, fontFamily: 'CormorantGaramond_700Bold' },

  scoreCard: {
    backgroundColor: '#0d0f1c', borderWidth: 1, borderRadius: 16,
    padding: 20, marginBottom: 12,
  },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  tierGlyph: { fontSize: 72, fontWeight: '800', letterSpacing: -2, lineHeight: 72, fontFamily: 'CormorantGaramond_700Bold' },
  scoreDetail: { flex: 1, gap: 4 },
  scoreNum: { fontSize: 36, fontWeight: '800', letterSpacing: -1, fontFamily: 'JetBrainsMono_700Bold' },
  scoreMax: { fontSize: 16, color: '#4a4f65', fontFamily: 'DMSans_400Regular' },
  tierLabel: { color: '#4a4f65', fontSize: 12, fontFamily: 'JetBrainsMono_400Regular' },
  savingsNote: { color: '#c8f000', fontSize: 12, fontFamily: 'JetBrainsMono_400Regular', marginTop: 4 },

  framingCard: {
    backgroundColor: '#0d0f1c', borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)', borderRadius: 14, padding: 16, marginBottom: 12, gap: 8,
  },
  framingTitle: { color: '#eeeef5', fontSize: 16, fontWeight: '700', fontFamily: 'DMSans_700Bold' },
  framingBody: { color: '#8b90a8', fontSize: 14, lineHeight: 22, fontFamily: 'DMSans_400Regular' },

  card: {
    backgroundColor: '#0d0f1c', borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)', borderRadius: 14, padding: 16, marginBottom: 12, gap: 14,
  },
  eyebrow: { color: '#4a4f65', fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },

  factorList: { gap: 18 },
  factorItem: { gap: 6 },
  factorExplain: { fontSize: 12, lineHeight: 17, fontFamily: 'DMSans_400Regular' },

  insightRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  insightIcon: { fontSize: 16, fontWeight: '700', color: '#c8f000', width: 16, fontFamily: 'JetBrainsMono_700Bold' },
  insightContent: { flex: 1, gap: 3 },
  insightLabel: { color: '#eeeef5', fontSize: 14, fontWeight: '600', fontFamily: 'DMSans_600SemiBold' },
  insightText: { color: '#8b90a8', fontSize: 13, lineHeight: 19, fontFamily: 'DMSans_400Regular' },
  insightAction: { fontSize: 12, fontWeight: '700', marginTop: 2, fontFamily: 'JetBrainsMono_700Bold' },

  premiumRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.05)',
  },
  premiumLabel: { color: '#8b90a8', fontSize: 14, fontFamily: 'DMSans_400Regular' },
  premiumValue: { fontSize: 18, fontWeight: '800', fontFamily: 'JetBrainsMono_700Bold' },
  premiumValueSub: { color: '#4a4f65', fontSize: 14, fontFamily: 'JetBrainsMono_400Regular' },
  upgradeCard: {
    borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 4,
    backgroundColor: 'rgba(200,240,0,0.04)',
  },
  upgradeText: { color: '#8b90a8', fontSize: 13, lineHeight: 19, fontFamily: 'DMSans_400Regular' },
});
