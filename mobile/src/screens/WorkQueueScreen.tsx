/**
 * Broker Work Queue — mobile counterpart to /work-queue on web.
 *
 * The claim-proposal *triage* surface (distinct from TasksScreen, which mirrors
 * /tasks = renewals + policy-requests). Three buckets:
 *   • To decide     — pending_broker_review, priority-sorted (confidence × payout)
 *   • Awaiting info  — needs_more_info, oldest-first (you asked the operator)
 *   • Ready to file  — approved, confirm FNOL
 *
 * Each row deep-links to the underwriter-review detail (ClaimProposalDetail),
 * exactly as web routes a row to /underwriter/{packetId}.
 *
 * Money + confidence live on recommendation_snapshot, which a proposal can
 * predate — show "—" rather than a misleading 0% / ~$0.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { HandAccent } from '../components/HandAccent';
import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { api } from '../api/client';

// Work-queue rows only need a slice of the proposal — mirror web's local
// Proposal shape rather than widen the shared ClaimProposal type.
interface WorkQueueProposal {
  id: string;
  packet_id: string;
  venue_id: string;
  state: string;
  proposed_at: string;
  recommendation_snapshot?: {
    should_file?: boolean;
    confidence?: number;
    expected_payout?: { median_usd?: number };
  } | null;
}

async function fetchBucket(status: string, sort?: string): Promise<WorkQueueProposal[]> {
  const q = new URLSearchParams({ status });
  if (sort) q.set('sort', sort);
  try {
    const data = await api.request<WorkQueueProposal[]>(`/api/claim-proposals?${q.toString()}`);
    return Array.isArray(data) ? data : [];
  } catch {
    // Let the caller's Promise.all reject so the screen shows a retry, not a
    // half-populated queue.
    throw new Error('bucket');
  }
}

function ProposalRow({
  p,
  onOpen,
}: {
  p: WorkQueueProposal;
  onOpen: (packetId: string) => void;
}) {
  const s = p.recommendation_snapshot;
  const conf = s?.confidence != null ? Math.round(s.confidence * 100) : null;
  const median = s?.expected_payout?.median_usd;
  const shouldFile = !!s?.should_file;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onOpen(p.packet_id)}
      accessibilityRole="button"
      accessibilityLabel={`Review proposal for ${p.venue_id.replace(/-/g, ' ')}${
        conf != null ? `, confidence ${conf} percent` : ''
      }`}
    >
      <Text style={styles.rowVenue} numberOfLines={1}>
        {p.venue_id.replace(/-/g, ' ')}
      </Text>
      <View style={[styles.fileBadge, shouldFile ? styles.fileBadgeFile : styles.fileBadgeReview]}>
        <Text style={[styles.fileBadgeText, shouldFile ? styles.fileBadgeTextFile : styles.fileBadgeTextReview]}>
          {shouldFile ? 'FILE' : 'REVIEW'}
        </Text>
      </View>
      <Text style={styles.rowConf}>{conf != null ? `${conf}%` : '—'}</Text>
      <Text style={styles.rowPayout}>
        {median != null ? `~$${Number(median).toLocaleString()}` : '—'}
      </Text>
    </Pressable>
  );
}

function Section({
  title,
  hint,
  rows,
  onOpen,
  urgent = false,
}: {
  title: string;
  hint: string;
  rows: WorkQueueProposal[];
  onOpen: (packetId: string) => void;
  urgent?: boolean;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <View style={styles.sectionHeadLeft}>
          <Text style={styles.sectionTitle}>{title}</Text>
          <Text style={styles.sectionHint}>{hint}</Text>
        </View>
        {rows.length > 0 && (
          <View style={[styles.countChip, urgent && styles.countChipUrgent]}>
            <Text style={[styles.countChipText, urgent && styles.countChipTextUrgent]}>
              {rows.length}
            </Text>
          </View>
        )}
      </View>
      {rows.length === 0 ? (
        <Text style={styles.sectionEmpty}>Nothing here.</Text>
      ) : (
        <View>
          {rows.map((p) => (
            <ProposalRow key={p.id} p={p} onOpen={onOpen} />
          ))}
        </View>
      )}
    </View>
  );
}

export function WorkQueueScreen({ navigation }: any) {
  const [toDecide, setToDecide] = useState<WorkQueueProposal[]>([]);
  const [awaiting, setAwaiting] = useState<WorkQueueProposal[]>([]);
  const [ready, setReady] = useState<WorkQueueProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [decide, info, appr] = await Promise.all([
        fetchBucket('pending_broker_review', 'priority'),
        fetchBucket('needs_more_info'),
        fetchBucket('approved'),
      ]);
      setToDecide(decide);
      // endpoint returns newest-first; awaiting wants oldest-first
      setAwaiting([...info].reverse());
      setReady(appr);
    } catch {
      setError("Couldn't load the work queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const open = (packetId: string) =>
    navigation.navigate('Proposals', {
      screen: 'ClaimProposalDetail',
      params: { packetId },
    });

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  const empty = toDecide.length === 0 && awaiting.length === 0 && ready.length === 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
      }
    >
      <View style={styles.headerWrap}>
        <Text style={styles.eyebrow}>BROKER · WORK QUEUE</Text>
        <Text style={styles.title}>Work Queue</Text>
        <HandAccent>highest value first</HandAccent>
        <Text style={styles.subtitle}>Triage and decide — aging items surface automatically.</Text>
      </View>

      {/* At-a-glance counts, mirroring the web hero meta cells. */}
      <View style={styles.metaRow}>
        <View style={styles.metaCell}>
          <Text style={styles.metaLabel}>To decide</Text>
          <Text style={[styles.metaValue, toDecide.length > 0 && styles.metaValueUrgent]}>
            {String(toDecide.length).padStart(2, '0')}
          </Text>
        </View>
        <View style={styles.metaCell}>
          <Text style={styles.metaLabel}>Awaiting</Text>
          <Text style={styles.metaValue}>{String(awaiting.length).padStart(2, '0')}</Text>
        </View>
        <View style={styles.metaCell}>
          <Text style={styles.metaLabel}>Ready</Text>
          <Text style={styles.metaValue}>{String(ready.length).padStart(2, '0')}</Text>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : empty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Queue clear — nothing to decide right now.</Text>
        </View>
      ) : (
        <>
          <Section
            title="To decide"
            hint="pending review · value + urgency"
            rows={toDecide}
            onOpen={open}
            urgent
          />
          <Section
            title="Awaiting info"
            hint="you asked the operator · oldest first"
            rows={awaiting}
            onOpen={open}
          />
          <Section
            title="Ready to file"
            hint="approved · confirm FNOL"
            rows={ready}
            onOpen={open}
          />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },

  headerWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 32, lineHeight: 36, color: Colors.text, letterSpacing: -0.5 },
  subtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, fontFamily: Fonts.sansRegular },

  metaRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginBottom: 16 },
  metaCell: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 4,
  },
  metaLabel: { fontFamily: Fonts.monoRegular, fontSize: 10, letterSpacing: 0.8, color: Colors.textMuted },
  metaValue: { fontFamily: Fonts.displayBold, fontSize: 24, color: Colors.text, letterSpacing: -0.5 },
  metaValueUrgent: { color: Colors.warning },

  section: {
    marginHorizontal: 16,
    marginBottom: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sectionHeadLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flex: 1 },
  sectionTitle: { fontFamily: Fonts.sansSemiBold, fontSize: 14, color: Colors.text },
  sectionHint: { fontFamily: Fonts.sansRegular, fontSize: 11, color: Colors.textMuted, flexShrink: 1 },
  countChip: {
    borderWidth: 1,
    borderColor: Colors.borderSubtle,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countChipUrgent: { borderColor: Colors.warning },
  countChipText: { fontFamily: Fonts.monoBold, fontSize: 11, color: Colors.textMuted },
  countChipTextUrgent: { color: Colors.warning },
  sectionEmpty: { fontFamily: Fonts.sansRegular, fontSize: 12, color: Colors.textMuted },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(23,21,15,0.06)',
  },
  rowPressed: { opacity: 0.6 },
  rowVenue: { flex: 1, fontFamily: Fonts.sansSemiBold, fontSize: 14, color: Colors.text, textTransform: 'capitalize' },
  fileBadge: { borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2, borderWidth: 1 },
  fileBadgeFile: { borderColor: Colors.warning, backgroundColor: 'rgba(255,149,0,0.08)' },
  fileBadgeReview: { borderColor: Colors.borderSubtle },
  fileBadgeText: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1 },
  fileBadgeTextFile: { color: Colors.warning },
  fileBadgeTextReview: { color: Colors.textMuted },
  rowConf: { fontFamily: Fonts.monoRegular, fontSize: 12, color: Colors.textMuted, minWidth: 36, textAlign: 'right' },
  rowPayout: { fontFamily: Fonts.monoBold, fontSize: 12, color: Colors.text, minWidth: 64, textAlign: 'right' },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: { color: Colors.textSecondary, textAlign: 'center', fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
