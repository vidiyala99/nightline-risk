import React, { useEffect, useState } from 'react';
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';
import { useAlert } from '../components/ThemedAlert';
import { STATE_LABEL, STATE_COLOR, type ClaimProposal } from '../types/claims';

const SEVERITY_COLOR: Record<string, string> = {
  critical: Colors.error, high: Colors.error, medium: Colors.warning, low: Colors.accent, unknown: Colors.textMuted,
};

const CORROBORATION_COLOR: Record<string, string> = {
  CONSISTENT: Colors.accent, PARTIAL: Colors.warning, CONTRADICTED: Colors.error, INCONCLUSIVE: Colors.textMuted,
};

export function BrokerReportDetailScreen({ route, navigation }: any) {
  const { packetId } = route.params;
  const { user } = useAuth();
  const alert = useAlert();

  const [packet, setPacket] = useState<any>(null);
  const [incident, setIncident] = useState<any>(null);
  const [visionAnalysis, setVisionAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [decisionMade, setDecisionMade] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [proposal, setProposal] = useState<ClaimProposal | null>(null);
  const [submittingBrokerDecision, setSubmittingBrokerDecision] = useState(false);
  const [brokerRejectNotes, setBrokerRejectNotes] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const pkt = await api.request<any>(`/api/packets/${packetId}`);
        setPacket(pkt);
        setProposal(pkt.claim_proposal ?? null);
        const [inc, vision] = await Promise.all([
          api.request<any>(`/api/incidents/${pkt.incident_id}`).catch(() => null),
          api.request<any>(`/api/incidents/${pkt.incident_id}/evidence-analysis`).catch(() => null),
        ]);
        setIncident(inc);
        setVisionAnalysis(vision);
        if (pkt.status === 'approved' || pkt.status === 'blocked') setDecisionMade(pkt.status);
      } catch {
        // non-fatal
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [packetId]);

  async function submitBrokerDecision(dec: 'approved' | 'rejected') {
    if (!proposal) return;
    setSubmittingBrokerDecision(true);
    try {
      const updated = await api.request<ClaimProposal>(`/api/claim-proposals/${proposal.id}/broker-decision`, {
        method: 'POST',
        body: JSON.stringify({
          broker_id: user?.id ?? 'unknown',
          decision: dec,
          notes: dec === 'rejected' && brokerRejectNotes.trim() ? brokerRejectNotes.trim() : null,
        }),
      });
      setProposal(updated);
      setBrokerRejectNotes('');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      alert.show({ title: 'Error', message: e.message ?? 'Failed to submit decision', variant: 'error' });
    } finally {
      setSubmittingBrokerDecision(false);
    }
  }

  async function submitDecision(dec: string) {
    if (!packet) return;
    setSubmitting(true);
    try {
      await api.request(`/api/packets/${packet.id}/review-decisions`, {
        method: 'POST',
        body: JSON.stringify({ reviewer_id: user?.id ?? 'unknown', decision: dec, notes: notes || null }),
      });
      setDecisionMade(dec);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      alert.show({ title: 'Error', message: e.message ?? 'Failed to submit decision', variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <View style={styles.centered}><ActivityIndicator color={Colors.accentInk} /></View>;
  if (!packet) return <View style={styles.centered}><Text style={styles.notFound}>Report not found</Text></View>;

  const severity = packet.risk_signals?.severity ?? 'unknown';
  const sevColor = SEVERITY_COLOR[severity] ?? Colors.textMuted;
  const confidence = Math.round((packet.risk_signals?.confidence ?? 0) * 100);

  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, { paddingTop: 12 }]}>
      {/* Header */}
      <View style={styles.headerRow}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backLabel}>Reports</Text>
        </Pressable>
      </View>

      <Text style={styles.venueName}>
        {(packet.venue_id ?? '').replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}
      </Text>
      <Text style={styles.reportDate}>
        {packet.generated_at ? new Date(packet.generated_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''}
      </Text>
      <View style={[styles.sevBanner, { borderColor: sevColor, backgroundColor: `${sevColor}12` }]}>
        <Text style={[styles.sevBannerText, { color: sevColor }]}>
          {severity.toUpperCase()} EXPOSURE · {confidence}% CONFIDENCE
        </Text>
      </View>

      {/* AI Claim Recommendation — EV math card (was missing on mobile) */}
      {packet.claim_recommendation && (() => {
        const rec = packet.claim_recommendation;
        const accent = rec.should_file ? Colors.accent : Colors.textMuted;
        const netEv = rec.net_expected_value_usd;
        const netLabel = (netEv >= 0 ? '+' : '-') + '$' + Math.abs(netEv).toLocaleString();
        return (
          <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: accent }]}>
            <View style={[styles.rowBetween, { gap: 10 }]}>
              <Text style={[styles.eyebrow, { letterSpacing: 1, flexShrink: 1 }]} numberOfLines={1}>
                AI CLAIM RECOMMENDATION
              </Text>
              <Text style={[styles.eyebrow, { color: accent, letterSpacing: 1 }]} numberOfLines={1}>
                {Math.round(rec.confidence * 100)}% CONFIDENT
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text style={{ fontSize: 28, color: accent, lineHeight: 32 }}>{rec.should_file ? '↑' : '↓'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: accent, fontSize: 20, fontFamily: 'HankenGrotesk_700Bold', letterSpacing: -0.3 }}>
                  {rec.should_file ? 'File this claim' : "Don't file yet"}
                </Text>
                <Text style={[styles.bodyText, { fontSize: 12 }]}>
                  {Math.round(rec.probability * 100)}% paid-out probability · net EV {netLabel}
                </Text>
              </View>
            </View>
            <View style={{ backgroundColor: Colors.bg, borderRadius: 10, padding: 14, gap: 8 }}>
              <View style={styles.rowBetween}>
                <Text style={styles.eyebrow}>EXPECTED PAYOUT</Text>
                <Text style={{ color: Colors.textSecondary, fontSize: 12, fontFamily: 'SpaceMono_400Regular' }}>
                  ${rec.expected_payout.low_usd.toLocaleString()} – ${rec.expected_payout.high_usd.toLocaleString()}
                </Text>
              </View>
              <View style={styles.rowBetween}>
                <Text style={styles.eyebrow}>MEDIAN</Text>
                <Text style={{ color: Colors.accentInk, fontSize: 13, fontFamily: 'SpaceMono_700Bold' }}>
                  ${rec.expected_payout.median_usd.toLocaleString()}
                </Text>
              </View>
              <View style={styles.rowBetween}>
                <Text style={styles.eyebrow}>PREMIUM IMPACT</Text>
                <Text style={{ color: Colors.warning, fontSize: 12, fontFamily: 'SpaceMono_400Regular' }}>
                  +${rec.expected_premium_impact.annual_delta_usd.toLocaleString()}/yr × {rec.expected_premium_impact.duration_years}yr
                </Text>
              </View>
              <View style={[styles.rowBetween, { paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.borderSubtle }]}>
                <Text style={styles.eyebrow}>NET EV</Text>
                <Text style={{ color: netEv >= 0 ? Colors.accent : Colors.error, fontSize: 13, fontFamily: 'SpaceMono_700Bold' }}>
                  {netLabel}
                </Text>
              </View>
            </View>
            {rec.reasons.slice(0, 2).map((r: string, i: number) => (
              <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
                <Text style={{ color: accent }}>→</Text>
                <Text style={[styles.bodyText, { flex: 1, fontSize: 12 }]}>{r}</Text>
              </View>
            ))}
          </View>
        );
      })()}

      {/* Claim Decision — broker action row */}
      {packet.claim_recommendation && (() => {
        if (!proposal) {
          return (
            <View style={styles.card}>
              <Text style={styles.eyebrow}>CLAIM DECISION</Text>
              <Text style={[styles.bodyText, { fontStyle: 'italic' }]}>
                Awaiting an operator proposal. The operator initiates; you decide.
              </Text>
            </View>
          );
        }
        const stateColor = STATE_COLOR[proposal.state] ?? Colors.textMuted;
        return (
          <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: stateColor }]}>
            <View style={styles.rowBetween}>
              <Text style={styles.eyebrow}>CLAIM DECISION</Text>
              {proposal.override_recommendation && (
                <Text style={{ color: Colors.warning, fontSize: 9, fontFamily: 'SpaceMono_700Bold', letterSpacing: 1 }}>
                  OVERRIDE
                </Text>
              )}
            </View>
            <View style={styles.rowBetween}>
              <Text style={{ color: stateColor, fontFamily: 'HankenGrotesk_700Bold', fontSize: 14 }}>
                {STATE_LABEL[proposal.state]}
              </Text>
              <Text style={[styles.eyebrow, { color: Colors.border }]}>
                {new Date(proposal.proposed_at).toLocaleDateString()}
              </Text>
            </View>
            {proposal.override_reason && (
              <Text style={styles.bodyText}>
                Override reason: {proposal.override_reason.replace(/_/g, ' ')}
                {proposal.override_freetext ? ` — "${proposal.override_freetext}"` : ''}
              </Text>
            )}
            {proposal.broker_notes && (
              <Text style={[styles.bodyText, { fontStyle: 'italic' }]}>Broker: "{proposal.broker_notes}"</Text>
            )}
            {proposal.state === 'pending_broker_review' && (
              <View style={{ gap: 8, marginTop: 4 }}>
                <TextInput
                  style={styles.notesInput}
                  placeholder="Reject notes (optional)..."
                  placeholderTextColor={Colors.textMuted}
                  value={brokerRejectNotes}
                  onChangeText={setBrokerRejectNotes}
                  multiline
                  editable={!submittingBrokerDecision}
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    style={[styles.decBtn, { flex: 1, backgroundColor: Colors.accent }]}
                    onPress={() => submitBrokerDecision('approved')}
                    disabled={submittingBrokerDecision}
                  >
                    <Text style={[styles.decBtnText, { color: Colors.text }]}>Approve & File</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.decBtn, { flex: 1, borderWidth: 1, borderColor: Colors.error }]}
                    onPress={() => submitBrokerDecision('rejected')}
                    disabled={submittingBrokerDecision}
                  >
                    <Text style={[styles.decBtnText, { color: Colors.error }]}>Reject</Text>
                  </Pressable>
                </View>
              </View>
            )}
            <Pressable onPress={() => navigation.navigate('ClaimDetail', { packetId: packet.id })}>
              <Text style={{ color: Colors.accentInk, fontSize: 12, fontFamily: 'HankenGrotesk_600SemiBold', marginTop: 4 }}>
                View claim detail →
              </Text>
            </Pressable>
          </View>
        );
      })()}

      {/* Review Decision */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>REVIEW DECISION</Text>
        {decisionMade ? (
          <View style={[styles.decisionResult, { borderColor: decisionMade === 'approved' ? Colors.accent : Colors.error }]}>
            <Text style={[styles.decisionResultText, { color: decisionMade === 'approved' ? Colors.accent : Colors.error }]}>
              {decisionMade === 'approved' ? '✓ APPROVED' : decisionMade === 'blocked' ? '✕ BLOCKED' : decisionMade.replace(/_/g, ' ').toUpperCase()}
            </Text>
          </View>
        ) : (
          <View style={styles.decisionButtons}>
            <TextInput
              style={styles.notesInput}
              placeholder="Add notes (optional)..."
              placeholderTextColor={Colors.textMuted}
              value={notes}
              onChangeText={setNotes}
              multiline
            />
            <Pressable style={[styles.decBtn, { backgroundColor: Colors.accent }]} onPress={() => submitDecision('approved')} disabled={submitting}>
              <Text style={[styles.decBtnText, { color: Colors.text }]}>{submitting ? 'Recording...' : '✓  Approve'}</Text>
            </Pressable>
            <Pressable style={[styles.decBtn, { borderWidth: 1, borderColor: Colors.warning }]} onPress={() => submitDecision('needs_more_info')} disabled={submitting}>
              <Text style={[styles.decBtnText, { color: Colors.warning }]}>Request More Info</Text>
            </Pressable>
            <Pressable style={[styles.decBtn, { borderWidth: 1, borderColor: Colors.error }]} onPress={() => submitDecision('blocked')} disabled={submitting}>
              <Text style={[styles.decBtnText, { color: Colors.error }]}>✕  Block</Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Incident */}
      {incident && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>INCIDENT</Text>
          <Text style={styles.bodyText}>{incident.summary}</Text>
          <View style={styles.metaGrid}>
            <MetaRow label="LOCATION" value={incident.location} />
            <MetaRow label="REPORTED BY" value={incident.reported_by} />
            <MetaRow label="DATE" value={new Date(incident.occurred_at).toLocaleString()} />
          </View>
          <View style={styles.flagRow}>
            {incident.injury_observed && <Flag label="INJURY" color={Colors.error} />}
            {incident.police_called && <Flag label="POLICE" color={Colors.warning} />}
            {incident.ems_called && <Flag label="EMS" color={Colors.info} />}
          </View>
        </View>
      )}

      {/* Risk Signal */}
      <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: sevColor }]}>
        <Text style={styles.eyebrow}>RISK SIGNAL</Text>
        <View style={styles.signalRow}>
          <View style={[styles.sevPill, { backgroundColor: `${sevColor}18` }]}>
            <Text style={[styles.sevPillText, { color: sevColor }]}>{severity.toUpperCase()}</Text>
          </View>
          <Text style={[styles.confNum, { color: sevColor }]}>{confidence}%</Text>
        </View>
        {packet.risk_signals?.explanation ? (
          <Text style={styles.bodyText}>{packet.risk_signals.explanation}</Text>
        ) : null}

        {packet.memo?.summary ? (
          <>
            <Text style={[styles.eyebrow, { marginTop: 8 }]}>UNDERWRITER MEMO</Text>
            <Text style={styles.bodyText}>{packet.memo.summary}</Text>
          </>
        ) : null}

        {(packet.memo?.open_questions?.length ?? 0) > 0 && (
          <>
            <Text style={[styles.eyebrow, { marginTop: 8 }]}>OPEN QUESTIONS</Text>
            {packet.memo.open_questions.map((q: string, i: number) => (
              <View key={i} style={styles.questionRow}>
                <Text style={styles.questionDot}>·</Text>
                <Text style={styles.questionText}>{q}</Text>
              </View>
            ))}
          </>
        )}
      </View>

      {/* Action Plan */}
      {(packet.action_plan?.length ?? 0) > 0 && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>REQUIRED ACTIONS</Text>
          {packet.action_plan.map((action: any, i: number) => (
            <View key={i} style={styles.actionItem}>
              <Text style={styles.actionTitle}>{action.title}</Text>
              {action.rationale ? <Text style={styles.actionSub}>{action.rationale}</Text> : null}
              {action.evidence_needed?.length > 0 && (
                <Text style={styles.actionEvidence}>{action.evidence_needed.join(' · ')}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {/* Vision Analysis */}
      {visionAnalysis?.analyses?.length > 0 && (
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.eyebrow}>VISUAL EVIDENCE</Text>
            {visionAnalysis.analyses[0]?.corroboration && (
              <Text style={[styles.corroBadge, {
                color: CORROBORATION_COLOR[visionAnalysis.analyses[0].corroboration] ?? Colors.textMuted,
                borderColor: `${CORROBORATION_COLOR[visionAnalysis.analyses[0].corroboration] ?? Colors.textMuted}44`,
              }]}>
                {visionAnalysis.analyses[0].corroboration}
              </Text>
            )}
          </View>
          {visionAnalysis.analyses.map((a: any, i: number) => (
            <View key={i} style={[styles.visionItem, { borderLeftColor: CORROBORATION_COLOR[a.corroboration] ?? Colors.textMuted }]}>
              <View style={styles.rowBetween}>
                <Text style={styles.visionType}>{(a.analysis_type ?? '').toUpperCase()}</Text>
                {a.confidence_delta != null && (
                  <Text style={{ color: Colors.accentInk, fontSize: 11 }}>+{Math.round(a.confidence_delta * 100)}%</Text>
                )}
              </View>
              {a.raw_description ? <Text style={styles.bodyText}>{a.raw_description}</Text> : null}
            </View>
          ))}
        </View>
      )}

      {/* Claims Timeline */}
      {(packet.claims_timeline?.length ?? 0) > 0 && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>CLAIMS TIMELINE</Text>
          {packet.claims_timeline.map((e: any, i: number) => (
            <View key={i} style={styles.timelineRow}>
              <Text style={styles.timelineTime}>{(e.at ?? '').split('T')[1]?.slice(0, 5) ?? e.at}</Text>
              <View style={styles.timelineContent}>
                <Text style={styles.timelineLabel}>{e.label}</Text>
                <Text style={styles.timelineSource}>{e.source}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Evidence Summary */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>EVIDENCE SUMMARY</Text>
        <View style={styles.evidenceSummaryRow}>
          <View style={styles.evidenceSummaryCard}>
            <Text style={styles.evidenceSummaryNum}>{packet.citation_ids?.length ?? 0}</Text>
            <Text style={styles.evidenceSummaryLabel}>CITATIONS</Text>
          </View>
          <View style={styles.evidenceSummaryCard}>
            <Text style={styles.evidenceSummaryNum}>{packet.claims_timeline?.length ?? 0}</Text>
            <Text style={styles.evidenceSummaryLabel}>EVENTS</Text>
          </View>
        </View>
        <Text style={styles.reportId}>Report ID: {(packet.id ?? '').slice(0, 16)}…</Text>
      </View>
    </ScrollView>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={metaStyles.row}>
      <Text style={metaStyles.label}>{label}</Text>
      <Text style={metaStyles.value}>{value}</Text>
    </View>
  );
}

function Flag({ label, color }: { label: string; color: string }) {
  return (
    <View style={[flagStyles.pill, { backgroundColor: `${color}12`, borderColor: `${color}44` }]}>
      <Text style={[flagStyles.text, { color }]}>{label}</Text>
    </View>
  );
}

const metaStyles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)' },
  label: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  value: { color: Colors.textSecondary, fontSize: 12, flex: 1, textAlign: 'right', fontFamily: 'HankenGrotesk_400Regular' },
});

const flagStyles = StyleSheet.create({
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth },
  text: { fontSize: 9, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },
  notFound: { color: Colors.textMuted, fontSize: 15, fontFamily: 'HankenGrotesk_400Regular' },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  backArrow: { color: Colors.accentInk, fontSize: 18 },
  backLabel: { color: Colors.accentInk, fontSize: 13, fontWeight: '600', fontFamily: 'HankenGrotesk_600SemiBold' },
  signOut: { color: Colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },

  venueName: { color: Colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'BricolageGrotesque_700Bold' },
  reportDate: { color: Colors.textMuted, fontSize: 12, marginTop: 4, marginBottom: 12, fontFamily: 'SpaceMono_400Regular' },
  sevBanner: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 16, alignSelf: 'flex-start' },
  sevBannerText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'SpaceMono_700Bold' },

  card: { backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, borderRadius: 14, padding: 18, marginBottom: 12, gap: 10 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  bodyText: { color: Colors.textSecondary, fontSize: 13, lineHeight: 20, fontFamily: 'HankenGrotesk_400Regular' },
  metaGrid: { gap: 0 },
  flagRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },

  signalRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sevPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 5 },
  sevPillText: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'SpaceMono_700Bold' },
  confNum: { fontSize: 28, fontWeight: '800', letterSpacing: -1, fontFamily: 'SpaceMono_700Bold' },

  questionRow: { flexDirection: 'row', gap: 8 },
  questionDot: { color: Colors.accentInk, fontSize: 16, lineHeight: 20 },
  questionText: { color: Colors.textSecondary, fontSize: 13, lineHeight: 20, flex: 1, fontFamily: 'HankenGrotesk_400Regular' },

  actionItem: { gap: 3, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)' },
  actionTitle: { color: Colors.text, fontSize: 13, fontWeight: '600', fontFamily: 'HankenGrotesk_600SemiBold' },
  actionSub: { color: Colors.textSecondary, fontSize: 12, fontFamily: 'HankenGrotesk_400Regular' },
  actionEvidence: { color: Colors.accentInk, fontSize: 11, fontFamily: 'HankenGrotesk_400Regular' },

  corroBadge: { fontSize: 9, fontWeight: '700', letterSpacing: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3, fontFamily: 'SpaceMono_700Bold' },
  visionItem: { borderLeftWidth: 2, paddingLeft: 10, gap: 4, paddingVertical: 4 },
  visionType: { color: Colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },

  timelineRow: { flexDirection: 'row', gap: 12, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)' },
  timelineTime: { color: Colors.textMuted, fontSize: 11, fontWeight: '600', width: 40, fontFamily: 'SpaceMono_400Regular' },
  timelineContent: { flex: 1 },
  timelineLabel: { color: Colors.text, fontSize: 13, fontFamily: 'HankenGrotesk_400Regular' },
  timelineSource: { color: Colors.textMuted, fontSize: 11, fontFamily: 'SpaceMono_400Regular' },

  evidenceSummaryRow: { flexDirection: 'row', gap: 10 },
  evidenceSummaryCard: { flex: 1, alignItems: 'center', padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, borderRadius: 10 },
  evidenceSummaryNum: { color: Colors.accentInk, fontSize: 24, fontWeight: '800', fontFamily: 'SpaceMono_700Bold' },
  evidenceSummaryLabel: { color: Colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginTop: 2, fontFamily: 'SpaceMono_700Bold' },
  reportId: { color: Colors.border, fontSize: 10, fontFamily: 'SpaceMono_400Regular' },

  decisionButtons: { gap: 10 },
  notesInput: { backgroundColor: Colors.bg, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border, borderRadius: 10, padding: 12, color: Colors.text, fontSize: 14, minHeight: 72, textAlignVertical: 'top' },
  decBtn: { borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  decBtnText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'HankenGrotesk_700Bold' },
  decisionResult: { borderWidth: 1, borderRadius: 10, paddingVertical: 16, alignItems: 'center' },
  decisionResultText: { fontSize: 14, fontWeight: '800', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },
});
