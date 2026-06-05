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
import { api } from '../api/client';
import { openQuestionsApi, byIndex } from '../api/openQuestions';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { useAlert } from '../components/ThemedAlert';
import { ClaimProposeBottomSheet } from '../components/ClaimProposeBottomSheet';
import { downloadDefensePackagePdf } from '../api/claims';
import { STATE_LABEL, STATE_COLOR, type ClaimProposal, type OverrideReason } from '../types/claims';
import { STATUS_TRANSITIONS, type TransitionColor } from '../lib/incidentTransitions';

// Resolve the pure-data transition color keys to theme tokens.
const TRANSITION_COLOR: Record<TransitionColor, string> = {
  info: Colors.info,
  success: Colors.success,
  warning: Colors.warning,
  muted: Colors.textMuted,
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: Colors.error,
  high: Colors.error,
  medium: Colors.warning,
  low: Colors.accent,
  unknown: Colors.textMuted,
};

const CORROBORATION_COLOR: Record<string, string> = {
  CONSISTENT: Colors.accent,
  PARTIAL: Colors.warning,
  CONTRADICTED: Colors.error,
  INCONCLUSIVE: Colors.textMuted,
};

// Claim-status tracker — plain-language "where this stands" + a step index,
// mirroring web frontend/src/app/incidents/[id]/claim-status deriveStatus().
// Honours ADR-0004: a routed proposal is NOT yet a carrier claim.
type ClaimTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';
const CLAIM_TONE_COLOR: Record<ClaimTone, string> = {
  info: Colors.accentInk,
  success: Colors.accentInk,
  warning: Colors.warning,
  error: Colors.error,
  neutral: Colors.textSecondary,
};
const CLAIM_STEP_LABELS = ['Reported', 'Sent', 'Approved', 'Filed', 'Resolved'];

function deriveClaimStatus(
  proposalState: string | null,
  claimStatus: string | null,
  claimExists: boolean,
): { tone: ClaimTone; headline: string; detail: string; next: string; currentIndex: number } {
  const ps = proposalState;
  if (ps === 'paid' || claimStatus === 'closed_paid')
    return { tone: 'success', headline: 'Claim paid', detail: 'The carrier settled this claim.', next: 'Resolved — no action required.', currentIndex: 4 };
  if (ps === 'denied' || claimStatus === 'closed_denied')
    return { tone: 'error', headline: 'Claim denied by carrier', detail: 'The carrier declined this claim.', next: 'Talk to your broker about a dispute or appeal.', currentIndex: 4 };
  if (claimStatus === 'closed_dropped')
    return { tone: 'neutral', headline: 'Claim withdrawn', detail: 'This claim was dropped before settlement.', next: 'Resolved — no action required.', currentIndex: 4 };
  if (ps === 'rejected_by_broker')
    return { tone: 'error', headline: 'Declined by your broker', detail: 'Your broker decided not to file. It never became a carrier claim.', next: 'Review the recommendation or talk to your broker.', currentIndex: 1 };
  if (ps === 'filed_with_carrier' || claimExists)
    return { tone: 'info', headline: 'Filed with the carrier', detail: "Your broker filed this as a carrier claim. It's now in the carrier's hands.", next: "Awaiting the carrier's decision.", currentIndex: 3 };
  if (ps === 'approved')
    return { tone: 'success', headline: 'Approved — filing with the carrier', detail: 'Your broker approved the recommendation; the carrier claim is being opened.', next: 'Your broker has the next move.', currentIndex: 2 };
  if (ps === 'needs_more_info')
    return { tone: 'warning', headline: 'Your broker needs more information', detail: 'Your broker asked for additional evidence before filing.', next: 'You have the next move — add the requested evidence.', currentIndex: 1 };
  return { tone: 'info', headline: "Awaiting your broker's decision", detail: "We sent the recommendation to your broker.", next: "Your broker has the next move.", currentIndex: 1 };
}


export function IncidentDetailScreen({ route, navigation }: any) {
  const { incidentId } = route.params;
  const { user } = useAuth();
  const alert = useAlert();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';

  const [incident, setIncident] = useState<any>(null);
  const [packets, setPackets] = useState<any[]>([]);
  const [evidence, setEvidence] = useState<any[]>([]);
  const [visionAnalysis, setVisionAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [proposal, setProposal] = useState<ClaimProposal | null>(null);
  const [claim, setClaim] = useState<any>(null);
  const [proposeSheetVisible, setProposeSheetVisible] = useState(false);
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [answerDrafts, setAnswerDrafts] = useState<Record<number, string>>({});
  const [savingQ, setSavingQ] = useState<number | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [inc, pkts, evs, vision] = await Promise.all([
          api.request<any>(`/api/incidents/${incidentId}`),
          api.request<any[]>(`/api/incidents/${incidentId}/packets`),
          api.request<any[]>(`/api/incidents/${incidentId}/evidence`),
          api.request<any>(`/api/incidents/${incidentId}/evidence-analysis`).catch(() => null),
        ]);
        setIncident(inc);
        const pktList = Array.isArray(pkts) ? pkts : [];
        setPackets(pktList);
        if (pktList.length > 0) setProposal(pktList[0].claim_proposal ?? null);
        setEvidence(Array.isArray(evs) ? evs : []);
        setVisionAnalysis(vision);
        // Closed loop: did this incident become a real carrier claim? The
        // venue-scoped read resolves for the operator (own venue) too, so
        // the operator finally sees the outcome of what they reported.
        if (inc?.venue_id) {
          try {
            const claims = await api.request<any[]>(`/api/venues/${inc.venue_id}/claims`);
            const match = Array.isArray(claims) ? claims.find((c) => c.incident_id === incidentId) : null;
            setClaim(match ?? null);
          } catch {
            // non-fatal
          }
        }
      } catch {
        // non-fatal
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [incidentId]);

  async function submitProposal(input: { override_recommendation: boolean; override_reason: OverrideReason; override_freetext: string | null }) {
    if (!packet) return;
    setSubmittingProposal(true);
    try {
      const created = await api.request<ClaimProposal>(`/api/packets/${packet.id}/claim-proposal`, {
        method: 'POST',
        body: JSON.stringify({ operator_id: user?.id ?? 'unknown', ...input }),
      });
      setProposal(created);
      setProposeSheetVisible(false);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      alert.show({ title: 'Error', message: e.message ?? 'Failed to propose claim', variant: 'error' });
    } finally {
      setSubmittingProposal(false);
    }
  }

  async function updateStatus(newStatus: string) {
    setUpdatingStatus(true);
    try {
      await api.request(`/api/incidents/${incidentId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      setIncident((prev: any) => ({ ...prev, status: newStatus }));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      alert.show({ title: 'Error', message: e.message ?? 'Status update failed', variant: 'error' });
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function downloadPdf(packetId: string) {
    // The defense PDF is venue-gated + keyed by packet id, so this resolves
    // for the operator (own venue) too — their "evidence defends you" artifact.
    setDownloadingPdf(true);
    try {
      await downloadDefensePackagePdf(packetId);
    } catch (e: any) {
      alert.show({ title: 'Download failed', message: e?.message ?? 'Could not download the defense package.', variant: 'error' });
    } finally {
      setDownloadingPdf(false);
    }
  }

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  if (!incident) {
    return <View style={styles.centered}><Text style={styles.notFound}>Incident not found</Text></View>;
  }

  const packet = packets[0];
  const riskSignals = packet?.risk_signals ?? {};
  const severity = riskSignals.severity ?? 'unknown';
  const severityColor = SEVERITY_COLOR[severity] ?? Colors.textMuted;
  const confidence = riskSignals.confidence ?? 0;
  const memo = packet?.memo ?? {};
  const citations: any[] = riskSignals.citations ?? [];
  const transitions = STATUS_TRANSITIONS[incident.status] ?? [];
  const hasVision = visionAnalysis?.total_files > 0;
  const oqResponses = byIndex(packet?.open_question_responses);

  async function reloadPackets() {
    try {
      const pkts = await api.request<any[]>(`/api/incidents/${incidentId}/packets`);
      setPackets(Array.isArray(pkts) ? pkts : []);
    } catch {
      /* non-fatal */
    }
  }

  async function answerQuestion(index: number, questionText: string) {
    if (!packet) return;
    const answer = (answerDrafts[index] ?? '').trim();
    if (!answer) return;
    setSavingQ(index);
    try {
      await openQuestionsApi.answer(packet.id, index, { question_text: questionText, answer });
      setAnswerDrafts((d) => ({ ...d, [index]: '' }));
      await reloadPackets();
    } catch (e: any) {
      alert.show({ title: 'Error', message: e?.message ?? 'Failed to save answer', variant: 'error' });
    } finally {
      setSavingQ(null);
    }
  }

  async function resolveQuestion(index: number, questionText: string) {
    if (!packet) return;
    setSavingQ(index);
    try {
      await openQuestionsApi.resolve(packet.id, index, { question_text: questionText });
      await reloadPackets();
    } catch (e: any) {
      alert.show({ title: 'Error', message: e?.message ?? 'Failed to resolve', variant: 'error' });
    } finally {
      setSavingQ(null);
    }
  }

  return (
    <>
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: 12 }]}
    >
      <View style={styles.backRow}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backLabel}>Incidents</Text>
        </Pressable>
      </View>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.location}>{incident.location}</Text>
        <Text style={styles.date}>
          {new Date(incident.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </Text>
        <View style={styles.statusRow}>
          <StatusBadge status={incident.status} />
          {incident.injury_observed && <FlagPill label="INJURY" color={Colors.error} />}
          {incident.police_called && <FlagPill label="POLICE" color={Colors.warning} />}
          {incident.ems_called && <FlagPill label="EMS" color={Colors.info} />}
        </View>
      </View>

      {/* Status Actions (operators only) */}
      {!isBroker && transitions.length > 0 && (
        <View style={styles.actionsRow}>
          {transitions.map(t => (
            <Pressable
              key={t.next}
              style={({ pressed }) => [styles.actionBtn, { borderColor: TRANSITION_COLOR[t.color] }, pressed && { opacity: 0.7 }]}
              onPress={() => updateStatus(t.next)}
              disabled={updatingStatus}
            >
              {updatingStatus
                ? <ActivityIndicator size="small" color={TRANSITION_COLOR[t.color]} />
                : <Text style={[styles.actionBtnText, { color: TRANSITION_COLOR[t.color] }]}>{t.label}</Text>
              }
            </Pressable>
          ))}
        </View>
      )}

      {/* Claim Propose — operator only, shown when a packet exists */}
      {!isBroker && packet && (() => {
        const rec = packet.claim_recommendation;
        if (!rec) return null;
        const stateColor = proposal ? (STATE_COLOR[proposal.state] ?? Colors.textMuted) : undefined;
        return (
          <View style={styles.card}>
            <Text style={styles.eyebrow}>CLAIM DECISION</Text>
            {proposal ? (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ color: stateColor, fontFamily: 'HankenGrotesk_700Bold', fontSize: 14 }}>
                    {STATE_LABEL[proposal.state]}
                  </Text>
                  {proposal.override_recommendation && (
                    <Text style={{ color: Colors.warning, fontSize: 9, fontFamily: 'SpaceMono_700Bold', letterSpacing: 1 }}>OVERRIDE</Text>
                  )}
                </View>
                {proposal.broker_notes && (
                  <Text style={[styles.summary, { fontStyle: 'italic', fontSize: 12 }]}>
                    Broker: "{proposal.broker_notes}"
                  </Text>
                )}
                <Pressable onPress={() => navigation.navigate('ClaimDetail', { packetId: packet.id })}>
                  <Text style={{ color: Colors.accentInk, fontSize: 12, fontFamily: 'HankenGrotesk_600SemiBold' }}>
                    View claim detail →
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.summary}>
                  {rec.should_file
                    ? `Recommender supports filing (${Math.round(rec.probability * 100)}% probability, net EV $${rec.net_expected_value_usd.toLocaleString()}).`
                    : `Recommender suggests not filing. Override only with additional context.`}
                </Text>
                <Pressable
                  style={[styles.actionBtn, { borderColor: rec.should_file ? Colors.accent : Colors.warning, backgroundColor: rec.should_file ? Colors.accentWash : 'transparent' }]}
                  onPress={() => setProposeSheetVisible(true)}
                  disabled={submittingProposal}
                >
                  <Text style={[styles.actionBtnText, { color: rec.should_file ? Colors.accentInk : Colors.warning }]}>
                    {rec.should_file ? 'Propose Claim' : 'Override & Propose'}
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        );
      })()}

      {/* Claim status tracker — operator-facing "where this stands" + stepper.
          Mirrors the web /incidents/[id]/claim-status page. Shown once the
          incident has entered the claim journey (proposal raised or claim filed). */}
      {!isBroker && (proposal || claim) && (() => {
        const s = deriveClaimStatus(proposal?.state ?? null, claim?.status ?? null, !!claim);
        const toneColor = CLAIM_TONE_COLOR[s.tone];
        return (
          <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: toneColor }]}>
            <Text style={styles.eyebrow}>WHERE THIS STANDS</Text>
            <Text style={{ color: toneColor, fontFamily: 'HankenGrotesk_700Bold', fontSize: 15, marginBottom: 4 }}>
              {s.headline}
            </Text>
            <Text style={styles.summary}>{s.detail}</Text>
            <Text style={[styles.eyebrow, { marginTop: 10, marginBottom: 2 }]}>WHAT HAPPENS NEXT</Text>
            <Text style={styles.summary}>{s.next}</Text>

            <View style={styles.stepperRow}>
              {CLAIM_STEP_LABELS.map((label, i) => {
                const done = i < s.currentIndex;
                const current = i === s.currentIndex;
                return (
                  <View
                    key={label}
                    style={[styles.stepChip, current && { borderColor: toneColor, backgroundColor: Colors.accentWash }]}
                  >
                    <Text style={[styles.stepGlyph, { color: done || current ? Colors.accentInk : Colors.textMuted }]}>
                      {done ? '✓' : current ? '◉' : '○'}
                    </Text>
                    <Text
                      style={[
                        styles.stepLabel,
                        { color: done || current ? Colors.accentInk : Colors.textMuted },
                        current && { fontFamily: 'SpaceMono_700Bold' },
                      ]}
                    >
                      {label}{current ? ' · now' : ''}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        );
      })()}

      {/* Closed loop: this incident became a real carrier claim */}
      {claim && (() => {
        const reserve = Number(claim.current_reserve);
        return (
          <View style={[styles.card, { borderColor: Colors.accentInk, borderWidth: 1, backgroundColor: Colors.accentWash }]}>
            <Text style={[styles.eyebrow, { color: Colors.accentInk }]}>FILED AS A CARRIER CLAIM</Text>
            <Text style={styles.summary}>
              {claim.carrier_claim_number ? `Claim ${claim.carrier_claim_number}` : 'Claim opened'}
              {' · '}{String(claim.coverage_line).toUpperCase()}
              {' · '}{String(claim.status).replace(/_/g, ' ')}
              {reserve > 0 ? ` · reserved $${reserve.toLocaleString()}` : ''}
            </Text>
          </View>
        );
      })()}

      {/* Description */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>DESCRIPTION</Text>
        <Text style={styles.summary}>{incident.summary}</Text>
        <View style={styles.metaGrid}>
          <MetaRow label="REPORTED BY" value={incident.reported_by} />
          <MetaRow label="TIME" value={new Date(incident.occurred_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} />
          <MetaRow label="INCIDENT ID" value={String(incident.id)} />
        </View>
      </View>

      {/* AI Risk Assessment */}
      {packet && (
        <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: severityColor }]}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.eyebrow}>AI RISK ASSESSMENT</Text>
            <View style={[styles.packetStatusBadge, { borderColor: `${severityColor}44`, backgroundColor: `${severityColor}12` }]}>
              <Text style={[styles.packetStatusText, { color: severityColor }]}>
                {(packet.status ?? '').replace('_', ' ').toUpperCase()}
              </Text>
            </View>
          </View>

          <View style={styles.signalRow}>
            <View style={[styles.severityPill, { backgroundColor: `${severityColor}18` }]}>
              <Text style={[styles.severityText, { color: severityColor }]}>{severity.toUpperCase()}</Text>
            </View>
            <View style={styles.confidenceWrap}>
              <View style={styles.confidenceTrack}>
                <View style={[styles.confidenceFill, { width: `${confidence * 100}%` as any, backgroundColor: severityColor }]} />
              </View>
              <Text style={[styles.confidenceNum, { color: severityColor }]}>{Math.round(confidence * 100)}%</Text>
            </View>
          </View>

          {riskSignals.explanation ? <Text style={styles.explanation}>{riskSignals.explanation}</Text> : null}

          {memo.summary ? (
            <>
              <Text style={[styles.eyebrow, { marginTop: 8 }]}>UNDERWRITER MEMO</Text>
              <Text style={styles.bodyText}>{memo.summary}</Text>
            </>
          ) : null}

          {Array.isArray(memo.open_questions) && memo.open_questions.length > 0 && (
            <>
              <Text style={[styles.eyebrow, { marginTop: 8 }]}>OPEN QUESTIONS</Text>
              {memo.open_questions.map((q: string, i: number) => {
                const resp = oqResponses.get(i);
                const answered = !!resp?.answer;
                const draft = answerDrafts[i] ?? '';
                return (
                  <View key={i} style={styles.oqCard}>
                    <Text style={styles.oqQuestion}>{q}</Text>

                    {resp?.resolved && (
                      <Text style={styles.oqResolved}>
                        ✓ RESOLVED{resp.resolved_by ? ` · ${resp.resolved_by}` : ''}
                      </Text>
                    )}

                    {answered && (
                      <View style={styles.oqAnswerBox}>
                        <Text style={styles.oqAnswerLabel}>
                          ANSWER{resp?.answered_by ? ` · ${resp.answered_by}` : ''}
                        </Text>
                        <Text style={styles.oqAnswerText}>{resp!.answer}</Text>
                      </View>
                    )}

                    {/* Operator answers; hidden once the broker resolves it. */}
                    {!isBroker && !resp?.resolved && (
                      <View style={styles.oqInputRow}>
                        <TextInput
                          style={styles.oqInput}
                          placeholder={answered ? 'Update your answer…' : 'Type your answer…'}
                          placeholderTextColor={Colors.textMuted}
                          value={draft}
                          onChangeText={(t) => setAnswerDrafts((d) => ({ ...d, [i]: t }))}
                          multiline
                        />
                        <Pressable
                          style={[styles.oqBtn, (!draft.trim() || savingQ === i) && { opacity: 0.5 }]}
                          onPress={() => answerQuestion(i, q)}
                          disabled={!draft.trim() || savingQ === i}
                          accessibilityRole="button"
                          accessibilityLabel={answered ? 'Update answer' : 'Submit answer'}
                        >
                          <Text style={styles.oqBtnText}>{savingQ === i ? '…' : answered ? 'Update' : 'Answer'}</Text>
                        </Pressable>
                      </View>
                    )}

                    {/* Broker resolves once satisfied. */}
                    {isBroker && !resp?.resolved && (
                      <Pressable
                        style={[styles.oqResolveBtn, savingQ === i && { opacity: 0.5 }]}
                        onPress={() => resolveQuestion(i, q)}
                        disabled={savingQ === i}
                        accessibilityRole="button"
                        accessibilityLabel="Mark question resolved"
                      >
                        <Text style={styles.oqResolveBtnText}>{savingQ === i ? '…' : 'Mark resolved'}</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </>
          )}

          {citations.length > 0 && (
            <>
              <Text style={[styles.eyebrow, { marginTop: 8 }]}>CITATIONS</Text>
              {citations.map((c: any, i: number) => (
                <View key={i} style={styles.citationRow}>
                  <View style={styles.citationSource}>
                    <Text style={styles.citationSourceType}>{(c.source_type ?? '').toUpperCase()}</Text>
                  </View>
                  <Text style={styles.citationExcerpt} numberOfLines={2}>{c.excerpt}</Text>
                </View>
              ))}
            </>
          )}

          <Pressable
            style={({ pressed }) => [styles.pdfBtn, pressed && { opacity: 0.7 }]}
            onPress={() => downloadPdf(packet.id)}
            disabled={downloadingPdf}
            accessibilityRole="button"
            accessibilityLabel="Download defense package PDF"
          >
            {downloadingPdf
              ? <ActivityIndicator size="small" color={Colors.accentInk} />
              : <Text style={styles.pdfBtnText}>↓ Download defense package (PDF)</Text>}
          </Pressable>
        </View>
      )}

      {/* Vision / AI Evidence Analysis */}
      {hasVision && (
        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.eyebrow}>AI EVIDENCE ANALYSIS</Text>
            {visionAnalysis.status === 'processing' ? (
              <Text style={[styles.corroborationBadge, { color: Colors.warning, borderColor: '#ff950044' }]}>PROCESSING</Text>
            ) : visionAnalysis.analyses?.[0]?.corroboration ? (
              <Text style={[styles.corroborationBadge, {
                color: CORROBORATION_COLOR[visionAnalysis.analyses[0].corroboration] ?? Colors.textMuted,
                borderColor: `${CORROBORATION_COLOR[visionAnalysis.analyses[0].corroboration] ?? Colors.textMuted}44`,
              }]}>
                {visionAnalysis.analyses[0].corroboration}
              </Text>
            ) : null}
          </View>

          {(visionAnalysis.analyses ?? []).map((a: any, i: number) => {
            const corrColor = CORROBORATION_COLOR[a.corroboration] ?? Colors.textMuted;
            return (
              <View key={i} style={[styles.visionItem, { borderLeftColor: corrColor }]}>
                <View style={styles.visionHeader}>
                  <Text style={styles.visionType}>{(a.analysis_type ?? '').toUpperCase()} ANALYSIS</Text>
                  {a.confidence_delta != null && (
                    <Text style={[styles.visionDelta, { color: corrColor }]}>
                      {a.confidence_delta > 0 ? '+' : ''}{Math.round(a.confidence_delta * 100)}% confidence
                    </Text>
                  )}
                </View>
                {a.raw_description ? <Text style={styles.bodyText}>{a.raw_description}</Text> : null}
                {Array.isArray(a.findings?.incident_indicators) && a.findings.incident_indicators.length > 0 && (
                  <View style={styles.indicatorRow}>
                    {a.findings.incident_indicators.map((ind: string, j: number) => (
                      <View key={j} style={styles.indicatorPill}>
                        <Text style={styles.indicatorText}>{ind}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* Evidence Files */}
      {evidence.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.eyebrow}>EVIDENCE FILES · {evidence.length}</Text>
          {evidence.map((ev: any) => (
            <View key={ev.id} style={styles.evidenceRow}>
              <View style={styles.evidenceIcon}>
                <Text style={styles.evidenceIconText}>
                  {ev.content_type?.startsWith('image/') ? 'IMG' : ev.content_type?.startsWith('video/') ? 'VID' : 'FILE'}
                </Text>
              </View>
              <View style={styles.evidenceMeta}>
                <Text style={styles.evidenceFilename} numberOfLines={1}>{ev.filename}</Text>
                <Text style={styles.evidenceSize}>
                  {ev.file_size ? `${(ev.file_size / 1024).toFixed(1)} KB` : ''}
                  {ev.uploaded_at ? `  ·  ${new Date(ev.uploaded_at).toLocaleDateString()}` : ''}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>

    {packet && (
      <ClaimProposeBottomSheet
        visible={proposeSheetVisible}
        onClose={() => setProposeSheetVisible(false)}
        recommenderVerdict={packet.claim_recommendation?.should_file ? 'file' : 'do_not_file'}
        submitting={submittingProposal}
        onSubmit={submitProposal}
      />
    )}
    </>
  );
}

function FlagPill({ label, color }: { label: string; color: string }) {
  return (
    <View style={[flagStyles.pill, { borderColor: `${color}44`, backgroundColor: `${color}12` }]}>
      <Text style={[flagStyles.text, { color }]}>{label}</Text>
    </View>
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

const flagStyles = StyleSheet.create({
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth },
  text: { fontSize: 9, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },
});

const metaStyles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)' },
  label: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  value: { color: Colors.textSecondary, fontSize: 12, fontFamily: 'HankenGrotesk_400Regular' },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },
  notFound: { color: Colors.textMuted, fontSize: 15, fontFamily: 'HankenGrotesk_400Regular' },

  backRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  signOut: { color: Colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, paddingVertical: 4, fontFamily: 'SpaceMono_700Bold' },
  backArrow: { color: Colors.accentInk, fontSize: 18, fontFamily: 'SpaceMono_400Regular' },
  backLabel: { color: Colors.accentInk, fontSize: 13, fontWeight: '600', fontFamily: 'SpaceMono_400Regular' },

  header: { gap: 10, marginBottom: 16 },
  location: { color: Colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'BricolageGrotesque_700Bold' },
  date: { color: Colors.textMuted, fontSize: 12, fontFamily: 'SpaceMono_400Regular' },
  statusRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },

  actionsRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  actionBtn: {
    flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  actionBtnText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'HankenGrotesk_700Bold' },

  card: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    gap: 10,
  },
  cardTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  packetStatusBadge: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3 },
  packetStatusText: { fontSize: 9, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },

  summary: { color: Colors.textSecondary, fontSize: 14, lineHeight: 22, fontFamily: 'HankenGrotesk_400Regular' },
  bodyText: { color: Colors.textSecondary, fontSize: 13, lineHeight: 20, fontFamily: 'HankenGrotesk_400Regular' },

  stepperRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  stepChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 5, borderRadius: 6,
    backgroundColor: Colors.bg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent',
  },
  stepGlyph: { fontSize: 11, fontFamily: 'SpaceMono_700Bold' },
  stepLabel: { fontSize: 11, fontFamily: 'SpaceMono_400Regular' },
  metaGrid: { gap: 0 },

  signalRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  severityPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 5 },
  severityText: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, fontFamily: 'SpaceMono_700Bold' },
  confidenceWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  confidenceTrack: { flex: 1, height: 3, backgroundColor: Colors.borderSubtle, borderRadius: 2, overflow: 'hidden' },
  confidenceFill: { height: '100%', borderRadius: 2 },
  confidenceNum: { fontSize: 11, fontWeight: '700', width: 32, textAlign: 'right', fontFamily: 'SpaceMono_700Bold' },

  explanation: { color: Colors.textSecondary, fontSize: 13, lineHeight: 20, fontFamily: 'HankenGrotesk_400Regular' },

  pdfBtn: {
    marginTop: 6, minHeight: 44, borderWidth: 1, borderColor: Colors.accentInk, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', paddingVertical: 11,
  },
  pdfBtnText: { color: Colors.accentInk, fontSize: 12, fontWeight: '700', letterSpacing: 0.3, fontFamily: 'HankenGrotesk_700Bold' },

  questionRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  questionDot: { color: Colors.accentInk, fontSize: 16, lineHeight: 20, fontFamily: 'HankenGrotesk_400Regular' },
  questionText: { color: Colors.textSecondary, fontSize: 13, lineHeight: 20, flex: 1, fontFamily: 'HankenGrotesk_400Regular' },

  oqCard: { marginTop: 10, padding: 12, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, backgroundColor: 'rgba(23,21,15,0.02)' },
  oqQuestion: { color: Colors.text, fontSize: 13, lineHeight: 19, fontFamily: 'HankenGrotesk_600SemiBold' },
  oqResolved: { color: Colors.accentInk, fontSize: 10, letterSpacing: 1, marginTop: 6, fontFamily: 'SpaceMono_700Bold' },
  oqAnswerBox: { marginTop: 8, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: Colors.accentInk },
  oqAnswerLabel: { color: Colors.textMuted, fontSize: 9, letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },
  oqAnswerText: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 2, fontFamily: 'HankenGrotesk_400Regular' },
  oqInputRow: { flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'flex-end' },
  oqInput: { flex: 1, minHeight: 44, maxHeight: 120, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, color: Colors.text, fontSize: 13, fontFamily: 'HankenGrotesk_400Regular', backgroundColor: Colors.bg },
  oqBtn: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 6, backgroundColor: Colors.accentWash, borderWidth: 1, borderColor: Colors.accent },
  oqBtnText: { color: Colors.accentInk, fontSize: 13, fontFamily: 'HankenGrotesk_600SemiBold' },
  oqResolveBtn: { alignSelf: 'flex-start', marginTop: 10, minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: Colors.accent },
  oqResolveBtnText: { color: Colors.accentInk, fontSize: 13, fontFamily: 'HankenGrotesk_600SemiBold' },

  citationRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)' },
  citationSource: { backgroundColor: 'rgba(200,240,0,0.08)', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 3, alignSelf: 'flex-start' },
  citationSourceType: { color: Colors.accentInk, fontSize: 8, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },
  citationExcerpt: { color: Colors.textMuted, fontSize: 12, lineHeight: 17, flex: 1, fontFamily: 'HankenGrotesk_400Regular' },

  corroborationBadge: { fontSize: 9, fontWeight: '700', letterSpacing: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3, fontFamily: 'SpaceMono_700Bold' },
  visionItem: { borderLeftWidth: 2, paddingLeft: 12, gap: 6, paddingVertical: 4 },
  visionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  visionType: { color: Colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  visionDelta: { fontSize: 11, fontWeight: '700', fontFamily: 'SpaceMono_700Bold' },
  indicatorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  indicatorPill: { backgroundColor: 'rgba(200,240,0,0.06)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(200,240,0,0.2)', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3 },
  indicatorText: { color: Colors.accentInk, fontSize: 9, fontWeight: '600', fontFamily: 'SpaceMono_400Regular' },

  evidenceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)' },
  evidenceIcon: { width: 44, height: 44, backgroundColor: 'rgba(23,21,15,0.06)', borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  evidenceIconText: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },
  evidenceMeta: { flex: 1 },
  evidenceFilename: { color: Colors.text, fontSize: 13, fontWeight: '600', fontFamily: 'HankenGrotesk_600SemiBold' },
  evidenceSize: { color: Colors.textMuted, fontSize: 11, marginTop: 2, fontFamily: 'SpaceMono_400Regular' },
});
