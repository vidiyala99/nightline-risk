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
import {
  STATE_LABEL,
  STATE_COLOR,
  type ClaimProposal,
} from '../types/claims';

export function ClaimDetailScreen({ route, navigation }: any) {
  const { packetId } = route.params;
  const { user } = useAuth();
  const alert = useAlert();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';

  const [packet, setPacket] = useState<any>(null);
  const [proposal, setProposal] = useState<ClaimProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [rejectNotes, setRejectNotes] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const pkt = await api.request<any>(`/api/packets/${packetId}`);
        setPacket(pkt);
        setProposal(pkt.claim_proposal ?? null);
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
    setSubmitting(true);
    try {
      const updated = await api.request<ClaimProposal>(`/api/claim-proposals/${proposal.id}/broker-decision`, {
        method: 'POST',
        body: JSON.stringify({
          broker_id: user?.id ?? 'unknown',
          decision: dec,
          notes: dec === 'rejected' && rejectNotes.trim() ? rejectNotes.trim() : null,
        }),
      });
      setProposal(updated);
      setRejectNotes('');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      alert.show({ title: 'Error', message: e.message ?? 'Failed to submit decision', variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <View style={s.centered}><ActivityIndicator color={Colors.accentInk} /></View>;
  if (!packet) return (
    <View style={s.centered}>
      <Text style={s.notFound}>Claim not found</Text>
      <Pressable onPress={() => navigation.goBack()}><Text style={s.back}>← Back</Text></Pressable>
    </View>
  );

  const rec = packet.claim_recommendation;
  const stateColor = proposal ? (STATE_COLOR[proposal.state] ?? Colors.textMuted) : Colors.textMuted;

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {/* Header */}
      <Pressable style={s.backBtn} onPress={() => navigation.goBack()}>
        <Text style={s.backArrow}>←</Text>
        <Text style={s.backLabel}>Claims</Text>
      </Pressable>
      <Text style={s.title}>Claim Detail</Text>
      <Text style={s.subtitle}>{packet.venue_id?.replace(/-/g, ' ')}</Text>

      {/* Status badge */}
      {proposal && (
        <View style={[s.stateBadge, { borderColor: stateColor, backgroundColor: `${stateColor}12` }]}>
          <Text style={[s.stateText, { color: stateColor }]}>{STATE_LABEL[proposal.state].toUpperCase()}</Text>
        </View>
      )}

      {/* Override banner */}
      {proposal?.override_recommendation && (
        <View style={[s.card, { borderColor: Colors.warning, borderWidth: 1 }]}>
          <Text style={s.eyebrow}>OPERATOR OVERRIDE</Text>
          <Text style={{ color: Colors.warning, fontFamily: 'DMSans_700Bold', fontSize: 13 }}>
            {proposal.override_reason?.replace(/_/g, ' ')}
          </Text>
          {proposal.override_freetext && (
            <Text style={s.bodyText}>"{proposal.override_freetext}"</Text>
          )}
        </View>
      )}

      {/* EV breakdown */}
      {rec && (
        <>
          <View style={s.card}>
            <Text style={s.eyebrow}>RECOMMENDER VERDICT</Text>
            <Text style={{ color: rec.should_file ? Colors.accent : Colors.textMuted, fontFamily: 'DMSans_700Bold', fontSize: 16 }}>
              {rec.should_file ? 'File this claim' : "Don't file"}
            </Text>
            <Text style={s.bodyText}>{Math.round(rec.probability * 100)}% paid-out probability</Text>
          </View>

          <View style={s.card}>
            <Text style={s.eyebrow}>FILE VS DON'T FILE</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={[s.evBox, { borderColor: rec.net_expected_value_usd >= 0 ? Colors.accent : Colors.error }]}>
                <Text style={s.evLabel}>If you file</Text>
                <Text style={[s.evNum, { color: rec.net_expected_value_usd >= 0 ? Colors.accent : Colors.error }]}>
                  {rec.net_expected_value_usd >= 0 ? '+' : '-'}${Math.abs(rec.net_expected_value_usd).toLocaleString()}
                </Text>
                <Text style={s.evSub}>Net EV over 3yr</Text>
              </View>
              <View style={[s.evBox, { borderColor: Colors.borderSubtle }]}>
                <Text style={s.evLabel}>If you don't</Text>
                <Text style={[s.evNum, { color: Colors.textSecondary }]}>$0</Text>
                <Text style={s.evSub}>No impact</Text>
              </View>
            </View>
          </View>

          <View style={s.card}>
            <Text style={s.eyebrow}>EXPECTED PAYOUT</Text>
            <View style={s.evRow}><Text style={s.evRowLabel}>LOW</Text><Text style={s.evRowVal}>${rec.expected_payout.low_usd.toLocaleString()}</Text></View>
            <View style={s.evRow}><Text style={s.evRowLabel}>MEDIAN</Text><Text style={[s.evRowVal, { color: Colors.accentInk }]}>${rec.expected_payout.median_usd.toLocaleString()}</Text></View>
            <View style={s.evRow}><Text style={s.evRowLabel}>HIGH</Text><Text style={s.evRowVal}>${rec.expected_payout.high_usd.toLocaleString()}</Text></View>
          </View>

          <View style={s.card}>
            <Text style={s.eyebrow}>PREMIUM IMPACT / YEAR</Text>
            {Array.from({ length: rec.expected_premium_impact.duration_years }, (_, i) => (
              <View key={i} style={s.evRow}>
                <Text style={s.evRowLabel}>Y{i + 1}</Text>
                <Text style={[s.evRowVal, { color: Colors.warning }]}>+${rec.expected_premium_impact.annual_delta_usd.toLocaleString()}</Text>
              </View>
            ))}
            <View style={[s.evRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.borderSubtle, paddingTop: 8 }]}>
              <Text style={s.evRowLabel}>CUMULATIVE</Text>
              <Text style={[s.evRowVal, { color: Colors.warning, fontFamily: 'JetBrainsMono_700Bold' }]}>+${rec.expected_premium_impact.cumulative_usd.toLocaleString()}</Text>
            </View>
          </View>
        </>
      )}

      {/* Lifecycle */}
      {proposal && (
        <View style={s.card}>
          <Text style={s.eyebrow}>LIFECYCLE</Text>
          <View style={s.lifecycle}>
            <View style={s.dot} />
            <View>
              <Text style={s.lcTitle}>Proposed</Text>
              <Text style={s.lcDate}>{new Date(proposal.proposed_at).toLocaleString()}</Text>
            </View>
          </View>
          {proposal.broker_decided_at ? (
            <View style={s.lifecycle}>
              <View style={[s.dot, { backgroundColor: stateColor }]} />
              <View>
                <Text style={[s.lcTitle, { color: stateColor }]}>
                  Broker {proposal.state === 'approved' ? 'approved' : 'rejected'}
                </Text>
                <Text style={s.lcDate}>{new Date(proposal.broker_decided_at).toLocaleString()}</Text>
              </View>
            </View>
          ) : (
            <View style={[s.lifecycle, { opacity: 0.4 }]}>
              <View style={[s.dot, { borderWidth: 1, borderColor: Colors.textMuted, backgroundColor: 'transparent' }]} />
              <Text style={s.bodyText}>Awaiting broker decision</Text>
            </View>
          )}
        </View>
      )}

      {/* Broker action panel */}
      {isBroker && proposal?.state === 'pending_broker_review' && (
        <View style={[s.card, { borderColor: Colors.accent, borderWidth: 1 }]}>
          <Text style={s.eyebrow}>BROKER DECISION</Text>
          <TextInput
            style={s.notesInput}
            placeholder="Reject notes (optional)..."
            placeholderTextColor={Colors.textMuted}
            value={rejectNotes}
            onChangeText={setRejectNotes}
            multiline
            editable={!submitting}
          />
          <Pressable
            style={[s.btn, { backgroundColor: Colors.accent }, submitting && { opacity: 0.5 }]}
            onPress={() => submitBrokerDecision('approved')}
            disabled={submitting}
          >
            <Text style={[s.btnText, { color: Colors.text }]}>Approve & File</Text>
          </Pressable>
          <Pressable
            style={[s.btn, { borderWidth: 1, borderColor: Colors.error }, submitting && { opacity: 0.5 }]}
            onPress={() => submitBrokerDecision('rejected')}
            disabled={submitting}
          >
            <Text style={[s.btnText, { color: Colors.error }]}>Reject</Text>
          </Pressable>
        </View>
      )}

      {proposal?.broker_notes && (
        <View style={s.card}>
          <Text style={s.eyebrow}>BROKER NOTE</Text>
          <Text style={[s.bodyText, { fontStyle: 'italic' }]}>"{proposal.broker_notes}"</Text>
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 60 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg, gap: 12 },
  notFound: { color: Colors.textMuted, fontSize: 15, fontFamily: 'DMSans_400Regular' },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 60, marginBottom: 16 },
  backArrow: { color: Colors.accentInk, fontSize: 18 },
  backLabel: { color: Colors.accentInk, fontSize: 13, fontFamily: 'DMSans_600SemiBold' },
  back: { color: Colors.accentInk, fontFamily: 'DMSans_600SemiBold' },
  title: { color: Colors.text, fontSize: 26, fontFamily: 'CormorantGaramond_700Bold', letterSpacing: -0.5 },
  subtitle: { color: Colors.textMuted, fontSize: 12, fontFamily: 'JetBrainsMono_400Regular', marginBottom: 12, textTransform: 'capitalize' },
  stateBadge: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, marginBottom: 12 },
  stateText: { fontSize: 10, fontFamily: 'JetBrainsMono_700Bold', letterSpacing: 1 },
  card: { backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, borderRadius: 14, padding: 16, marginBottom: 12, gap: 8 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  bodyText: { color: Colors.textSecondary, fontSize: 13, lineHeight: 20, fontFamily: 'DMSans_400Regular' },
  evBox: { flex: 1, borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  evLabel: { color: Colors.textMuted, fontSize: 10, fontFamily: 'JetBrainsMono_700Bold', letterSpacing: 1 },
  evNum: { fontSize: 22, fontFamily: 'JetBrainsMono_700Bold', letterSpacing: -1 },
  evSub: { color: Colors.textMuted, fontSize: 10, fontFamily: 'DMSans_400Regular' },
  evRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  evRowLabel: { color: Colors.textMuted, fontSize: 10, fontFamily: 'JetBrainsMono_700Bold', letterSpacing: 1 },
  evRowVal: { color: Colors.textSecondary, fontSize: 13, fontFamily: 'JetBrainsMono_400Regular' },
  lifecycle: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.accent, marginTop: 4 },
  lcTitle: { color: Colors.text, fontSize: 13, fontFamily: 'DMSans_600SemiBold' },
  lcDate: { color: Colors.textMuted, fontSize: 11, fontFamily: 'JetBrainsMono_400Regular' },
  notesInput: { backgroundColor: Colors.bg, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border, borderRadius: 10, padding: 12, color: Colors.text, fontSize: 13, minHeight: 72, textAlignVertical: 'top' },
  btn: { borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  btnText: { fontSize: 13, fontFamily: 'DMSans_700Bold', letterSpacing: 0.5 },
});
