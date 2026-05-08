import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ff4557', high: '#ff4557', medium: '#ff9500', low: '#c8f000', unknown: '#4a4f65',
};

const CORROBORATION_COLOR: Record<string, string> = {
  CONSISTENT: '#c8f000', PARTIAL: '#ff9500', CONTRADICTED: '#ff4557', INCONCLUSIVE: '#4a4f65',
};

export function BrokerReportDetailScreen({ route, navigation }: any) {
  const { packetId } = route.params;
  const { signOut } = useAuth();
  const insets = useSafeAreaInsets();

  const [packet, setPacket] = useState<any>(null);
  const [incident, setIncident] = useState<any>(null);
  const [visionAnalysis, setVisionAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [decisionMade, setDecisionMade] = useState<string | null>(null);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const pkt = await api.request<any>(`/api/packets/${packetId}`);
        setPacket(pkt);
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

  async function submitDecision(dec: string) {
    if (!packet) return;
    setSubmitting(true);
    try {
      await api.request(`/api/packets/${packet.id}/review-decisions`, {
        method: 'POST',
        body: JSON.stringify({ reviewer_id: 'uw-demo-reviewer', decision: dec, notes: notes || null }),
      });
      setDecisionMade(dec);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Failed to submit decision');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <View style={styles.centered}><ActivityIndicator color="#c8f000" /></View>;
  if (!packet) return <View style={styles.centered}><Text style={styles.notFound}>Report not found</Text></View>;

  const severity = packet.risk_signals?.severity ?? 'unknown';
  const sevColor = SEVERITY_COLOR[severity] ?? '#4a4f65';
  const confidence = Math.round((packet.risk_signals?.confidence ?? 0) * 100);

  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}>
      {/* Header */}
      <View style={styles.headerRow}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backLabel}>Reports</Text>
        </Pressable>
        <Text style={styles.signOut} onPress={signOut}>SIGN OUT</Text>
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

      {/* Review Decision */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>REVIEW DECISION</Text>
        {decisionMade ? (
          <View style={[styles.decisionResult, { borderColor: decisionMade === 'approved' ? '#c8f000' : '#ff4557' }]}>
            <Text style={[styles.decisionResultText, { color: decisionMade === 'approved' ? '#c8f000' : '#ff4557' }]}>
              {decisionMade === 'approved' ? '✓ APPROVED' : decisionMade === 'blocked' ? '✕ BLOCKED' : decisionMade.replace(/_/g, ' ').toUpperCase()}
            </Text>
          </View>
        ) : (
          <View style={styles.decisionButtons}>
            <TextInput
              style={styles.notesInput}
              placeholder="Add notes (optional)..."
              placeholderTextColor="#4a4f65"
              value={notes}
              onChangeText={setNotes}
              multiline
            />
            <Pressable style={[styles.decBtn, { backgroundColor: '#c8f000' }]} onPress={() => submitDecision('approved')} disabled={submitting}>
              <Text style={[styles.decBtnText, { color: '#07080f' }]}>{submitting ? 'Recording...' : '✓  Approve'}</Text>
            </Pressable>
            <Pressable style={[styles.decBtn, { borderWidth: 1, borderColor: '#ff9500' }]} onPress={() => submitDecision('needs_more_info')} disabled={submitting}>
              <Text style={[styles.decBtnText, { color: '#ff9500' }]}>Request More Info</Text>
            </Pressable>
            <Pressable style={[styles.decBtn, { borderWidth: 1, borderColor: '#ff4557' }]} onPress={() => submitDecision('blocked')} disabled={submitting}>
              <Text style={[styles.decBtnText, { color: '#ff4557' }]}>✕  Block</Text>
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
            {incident.injury_observed && <Flag label="INJURY" color="#ff4557" />}
            {incident.police_called && <Flag label="POLICE" color="#ff9500" />}
            {incident.ems_called && <Flag label="EMS" color="#5b8af5" />}
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
                color: CORROBORATION_COLOR[visionAnalysis.analyses[0].corroboration] ?? '#4a4f65',
                borderColor: `${CORROBORATION_COLOR[visionAnalysis.analyses[0].corroboration] ?? '#4a4f65'}44`,
              }]}>
                {visionAnalysis.analyses[0].corroboration}
              </Text>
            )}
          </View>
          {visionAnalysis.analyses.map((a: any, i: number) => (
            <View key={i} style={[styles.visionItem, { borderLeftColor: CORROBORATION_COLOR[a.corroboration] ?? '#4a4f65' }]}>
              <View style={styles.rowBetween}>
                <Text style={styles.visionType}>{(a.analysis_type ?? '').toUpperCase()}</Text>
                {a.confidence_delta != null && (
                  <Text style={{ color: '#c8f000', fontSize: 11 }}>+{Math.round(a.confidence_delta * 100)}%</Text>
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
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.05)' },
  label: { color: '#4a4f65', fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  value: { color: '#8b90a8', fontSize: 12, flex: 1, textAlign: 'right' },
});

const flagStyles = StyleSheet.create({
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth },
  text: { fontSize: 9, fontWeight: '700', letterSpacing: 1 },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07080f' },
  content: { paddingHorizontal: 20, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#07080f' },
  notFound: { color: '#4a4f65', fontSize: 15 },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  backArrow: { color: '#c8f000', fontSize: 18 },
  backLabel: { color: '#c8f000', fontSize: 13, fontWeight: '600' },
  signOut: { color: '#8b90a8', fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },

  venueName: { color: '#eeeef5', fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  reportDate: { color: '#4a4f65', fontSize: 12, marginTop: 4, marginBottom: 12 },
  sevBanner: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 16, alignSelf: 'flex-start' },
  sevBannerText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  card: { backgroundColor: '#0d0f1c', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.07)', borderRadius: 14, padding: 16, marginBottom: 12, gap: 10 },
  eyebrow: { color: '#4a4f65', fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  bodyText: { color: '#8b90a8', fontSize: 13, lineHeight: 20 },
  metaGrid: { gap: 0 },
  flagRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },

  signalRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sevPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 5 },
  sevPillText: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
  confNum: { fontSize: 28, fontWeight: '800', letterSpacing: -1 },

  questionRow: { flexDirection: 'row', gap: 8 },
  questionDot: { color: '#c8f000', fontSize: 16, lineHeight: 20 },
  questionText: { color: '#8b90a8', fontSize: 13, lineHeight: 20, flex: 1 },

  actionItem: { gap: 3, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.05)' },
  actionTitle: { color: '#eeeef5', fontSize: 13, fontWeight: '600' },
  actionSub: { color: '#8b90a8', fontSize: 12 },
  actionEvidence: { color: '#c8f000', fontSize: 11 },

  corroBadge: { fontSize: 9, fontWeight: '700', letterSpacing: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3 },
  visionItem: { borderLeftWidth: 2, paddingLeft: 10, gap: 4, paddingVertical: 4 },
  visionType: { color: '#4a4f65', fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },

  timelineRow: { flexDirection: 'row', gap: 12, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.05)' },
  timelineTime: { color: '#4a4f65', fontSize: 11, fontWeight: '600', width: 40 },
  timelineContent: { flex: 1 },
  timelineLabel: { color: '#eeeef5', fontSize: 13 },
  timelineSource: { color: '#4a4f65', fontSize: 11 },

  evidenceSummaryRow: { flexDirection: 'row', gap: 10 },
  evidenceSummaryCard: { flex: 1, alignItems: 'center', padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.07)', borderRadius: 10 },
  evidenceSummaryNum: { color: '#c8f000', fontSize: 24, fontWeight: '800' },
  evidenceSummaryLabel: { color: '#4a4f65', fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginTop: 2 },
  reportId: { color: '#2e3247', fontSize: 10, fontFamily: 'monospace' },

  decisionButtons: { gap: 10 },
  notesInput: { backgroundColor: '#07080f', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.1)', borderRadius: 10, padding: 12, color: '#eeeef5', fontSize: 14, minHeight: 72, textAlignVertical: 'top' },
  decBtn: { borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  decBtnText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  decisionResult: { borderWidth: 1, borderRadius: 10, paddingVertical: 16, alignItems: 'center' },
  decisionResultText: { fontSize: 14, fontWeight: '800', letterSpacing: 1 },
});
