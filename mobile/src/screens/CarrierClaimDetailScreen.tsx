/**
 * Carrier-claim detail. Mobile counterpart to /claims/[cid] on web.
 *
 * Layout (top → bottom):
 *   1. Header — status badge + masthead claim ID + back link to list
 *   2. Headline — Total incurred in Cormorant + reserve delta
 *   3. Lifecycle strip — 5 nodes lit per current status
 *   4. Summary tiles — reserve / indemnity / expense / recoveries
 *   5. Payment ledger
 *   6. Reserve history
 *   7. Meta strip (FNOL date, adjuster, defense package, snapshot hash)
 * Bottom pinned: state-gated action toolbar above the safe area.
 *
 * Pull-to-refresh + haptics on action success.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Colors } from "../theme/colors";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import {
  claimsApi,
  downloadDefensePackagePdf,
  totalIncurredFromClaim,
  type ClaimDetail,
} from '../api/claims';
import {
  ACTION_PRIORITY,
  CLAIM_STATUS_GLYPH,
  CLAIM_STATUS_LABEL,
  LIFECYCLE_LABEL_SHORT,
  LIFECYCLE_ORDER,
  PAYMENT_TYPE_LABEL,
  formatClaimMoney,
  formatLedgerMoney,
  formatReserveDelta,
  isClosedStatus,
  lifecyclePosition,
  type ActionEmphasis,
  type ActionId,
  type ClaimStatus,
} from '../api/claim-tokens';
import { Fonts } from '../theme/typography';
import { StatusBadge } from '../components/StatusBadge';
import { PromptModal } from '../components/PromptModal';

const ACTION_LABEL: Record<ActionId, string> = {
  record_reserve: 'Record reserve',
  record_payment: 'Record payment',
  close_claim: 'Close claim',
  reopen_claim: 'Reopen claim',
  attach_defense_package: 'Attach defense package',
};

export function CarrierClaimDetailScreen({ route, navigation }: any) {
  const { cid } = route.params;
  const [claim, setClaim] = useState<ClaimDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  // Free-text / amount prompts use the cross-platform PromptModal (Alert.prompt
  // is iOS-only). `final_indemnity` is reached only via the "paid" disposition.
  const [prompt, setPrompt] = useState<null | { kind: 'reopen' } | { kind: 'final_indemnity' }>(null);

  const onDownloadDefensePdf = useCallback(async (packetId: string) => {
    setDownloadingPdf(true);
    try {
      await downloadDefensePackagePdf(packetId);
    } catch (e: any) {
      Alert.alert('Download failed', e?.message ?? 'Could not download the defense package.');
    } finally {
      setDownloadingPdf(false);
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await claimsApi.claimDetail(cid);
      setClaim(data);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load claim');
    } finally {
      setLoading(false);
    }
  }, [cid]);

  const onDone = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    load();
  }, [load]);

  const runReopen = useCallback(async (id: string, reason: string) => {
    try {
      await claimsApi.reopenClaim(id, { reason });
      onDone();
    } catch (e: any) {
      Alert.alert('Reopen failed', e?.message ?? 'Try again.');
    }
  }, [onDone]);

  const runClose = useCallback(async (id: string, disposition: 'paid' | 'denied' | 'dropped', final: string | null) => {
    try {
      await claimsApi.closeClaim(id, { disposition, final_indemnity: final });
      onDone();
    } catch (e: any) {
      Alert.alert('Close failed', e?.message ?? 'Try again.');
    }
  }, [onDone]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const onAction = useCallback(
    (id: ActionId) => {
      if (!claim) return;
      if (id === 'record_reserve') {
        navigation.navigate('RecordReserve', { cid: claim.id, onSuccess: () => load() });
      } else if (id === 'record_payment') {
        navigation.navigate('RecordPayment', { cid: claim.id, onSuccess: () => load() });
      } else if (id === 'close_claim') {
        chooseDisposition((disposition) => {
          // Paid settlements need an amount → defer to the prompt modal; the
          // other dispositions close immediately.
          if (disposition === 'paid') setPrompt({ kind: 'final_indemnity' });
          else runClose(claim.id, disposition, null);
        });
      } else if (id === 'reopen_claim') {
        setPrompt({ kind: 'reopen' });
      } else if (id === 'attach_defense_package') {
        Alert.alert(
          'Attach defense package',
          'Attach is currently a web-only flow. Use the /claims/[cid] page on desktop to attach a packet.',
        );
      }
    },
    [claim, load, navigation, runClose],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  if (error || !claim) {
    return (
      <View style={styles.errorBox}>
        <Text style={styles.errorText}>{error ?? 'Claim not found'}</Text>
        <Pressable onPress={load} style={styles.retryBtn}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const incurred = totalIncurredFromClaim(claim);
  const head = formatClaimMoney(incurred);
  const delta = formatReserveDelta(claim.current_reserve, incurred);
  const masthead = claim.carrier_claim_number ?? claim.id;
  const closed = isClosedStatus(claim.status);
  const lifeIdx = lifecyclePosition(claim.status);

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: 140 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
        }
      >
        <View style={styles.headerWrap}>
          <Pressable onPress={() => navigation.goBack()} style={styles.backRow}>
            <Text style={styles.backText}>← Carrier claims</Text>
          </Pressable>
          <Text style={styles.eyebrow}>
            <Text style={styles.glyph}>{CLAIM_STATUS_GLYPH[claim.status]}  </Text>
            CARRIER CLAIM
          </Text>
          <Text style={styles.masthead}>{masthead}</Text>
          <View style={styles.headerRow}>
            <StatusBadge status={claim.status} />
            {claim.reopen_count > 0 && (
              <Text style={styles.reopenBadge}>↻ {claim.reopen_count}</Text>
            )}
          </View>
          <Text style={styles.headerSub}>
            {claim.coverage_line.toUpperCase()} ·{' '}
            {new Date(claim.date_of_loss).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
            {'  ·  '}
            {claim.policy_id}
          </Text>
        </View>

        <View style={styles.headline}>
          <Text style={styles.headlineLabel}>TOTAL INCURRED</Text>
          <View style={styles.headlineValueRow}>
            <Text style={styles.headlineUnit}>$</Text>
            <Text style={styles.headlineDigits}>{head.digits}</Text>
          </View>
          {delta.label !== '—' && (
            <Text style={[styles.delta, deltaStyle(delta.tone)]}>{delta.label}</Text>
          )}
        </View>

        <LifecycleStrip status={claim.status} reopenCount={claim.reopen_count} pos={lifeIdx} />

        <View style={styles.summaryGrid}>
          <Tile label="Current reserve" value={formatLedgerMoney(claim.current_reserve)} />
          <Tile label="Indemnity paid" value={formatLedgerMoney(claim.indemnity_paid_to_date)} />
          <Tile label="Expense paid" value={formatLedgerMoney(claim.expense_paid_to_date)} />
          <Tile label="Recoveries" value={formatLedgerMoney(claim.recoveries_to_date)} />
        </View>

        <SectionTitle>Payments</SectionTitle>
        {claim.payments.length === 0 ? (
          <Text style={styles.empty}>
            No payments recorded yet. Record from the toolbar below.
          </Text>
        ) : (
          claim.payments
            .slice()
            .sort((a, b) => new Date(b.paid_on).getTime() - new Date(a.paid_on).getTime())
            .map((p) => (
              <View key={p.id} style={styles.ledgerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.ledgerType}>{PAYMENT_TYPE_LABEL[p.payment_type]}</Text>
                  <Text style={styles.ledgerDesc} numberOfLines={2}>
                    {p.description || '—'}
                  </Text>
                  <Text style={styles.ledgerSub}>
                    {new Date(p.paid_on).toLocaleDateString()} · {p.recorded_by}
                  </Text>
                </View>
                <Text style={styles.ledgerAmount}>{formatLedgerMoney(p.amount)}</Text>
              </View>
            ))
        )}

        <SectionTitle>Reserve history</SectionTitle>
        {claim.reserve_changes.length === 0 ? (
          <Text style={styles.empty}>
            No reserve changes recorded yet. The carrier's first reserve will appear here.
          </Text>
        ) : (
          claim.reserve_changes
            .slice()
            .sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime())
            .map((r) => (
              <View key={r.id} style={styles.ledgerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.ledgerType} numberOfLines={1}>
                    {r.change_reason}
                  </Text>
                  <Text style={styles.ledgerDesc}>
                    {formatLedgerMoney(r.from_amount)} → {formatLedgerMoney(r.to_amount)}
                  </Text>
                  <Text style={styles.ledgerSub} numberOfLines={1}>
                    {new Date(r.received_at).toLocaleDateString()} · {r.received_from}
                  </Text>
                </View>
              </View>
            ))
        )}

        <SectionTitle>Detail</SectionTitle>
        <MetaRow label="FNOL filed" value={new Date(claim.fnol_submitted_at).toLocaleString()} />
        {claim.adjuster_name && (
          <MetaRow
            label="Adjuster"
            value={`${claim.adjuster_name}${claim.adjuster_email ? ' — ' + claim.adjuster_email : ''}`}
          />
        )}
        {claim.defense_package_id && (
          <>
            <MetaRow label="Defense package" value={claim.defense_package_id} mono />
            <Pressable
              style={[styles.pdfBtn, downloadingPdf && styles.pdfBtnBusy]}
              disabled={downloadingPdf}
              onPress={() => onDownloadDefensePdf(claim.defense_package_id!)}
            >
              <Text style={styles.pdfBtnText}>
                {downloadingPdf ? 'Preparing PDF…' : '↓ Download PDF'}
              </Text>
            </Pressable>
          </>
        )}
        {closed && claim.closed_at && (
          <MetaRow
            label="Closed"
            value={`${new Date(claim.closed_at).toLocaleString()} · ${CLAIM_STATUS_LABEL[claim.status]}`}
          />
        )}
        {closed && claim.final_indemnity && (
          <MetaRow label="Final indemnity" value={formatLedgerMoney(claim.final_indemnity)} />
        )}
        {claim.reopened_at && (
          <MetaRow
            label="Reopened"
            value={`${new Date(claim.reopened_at).toLocaleString()} · ${claim.reopen_count}×`}
          />
        )}
        <MetaRow label="Snapshot hash" value={claim.snapshot_hash} mono />
      </ScrollView>

      <ActionToolbar status={claim.status} onAction={onAction} />

      <PromptModal
        visible={prompt?.kind === 'reopen'}
        title="Reopen reason"
        message="Logged on the claim audit trail."
        placeholder="e.g. New medical bills received"
        confirmLabel="Reopen"
        onCancel={() => setPrompt(null)}
        onSubmit={(reason) => {
          setPrompt(null);
          runReopen(claim.id, reason);
        }}
      />
      <PromptModal
        visible={prompt?.kind === 'final_indemnity'}
        title="Final indemnity"
        message="Required for a paid disposition. Enter the settlement amount."
        placeholder="0.00"
        confirmLabel="Close claim"
        keyboardType="decimal-pad"
        multiline={false}
        onCancel={() => setPrompt(null)}
        onSubmit={(amount) => {
          setPrompt(null);
          runClose(claim.id, 'paid', amount);
        }}
      />
    </>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label.toUpperCase()}</Text>
      <Text style={styles.tileValue}>{value}</Text>
    </View>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{String(children).toUpperCase()}</Text>;
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label.toUpperCase()}</Text>
      <Text style={[styles.metaValue, mono && { fontFamily: Fonts.monoRegular, fontSize: 11 }]} numberOfLines={3}>
        {value}
      </Text>
    </View>
  );
}

function LifecycleStrip({
  status,
  reopenCount,
  pos,
}: {
  status: ClaimStatus;
  reopenCount: number;
  pos: number;
}) {
  return (
    <View style={styles.lifeWrap}>
      {reopenCount > 0 && (
        <Text style={styles.lifeReopen}>↻ Reopened {reopenCount}×</Text>
      )}
      <View style={styles.lifeNodes}>
        {LIFECYCLE_ORDER.map((node, i) => {
          const lit = i < pos;
          const active = i === pos && !isClosedStatus(status);
          const finalLit = i === LIFECYCLE_ORDER.length - 1 && isClosedStatus(status);
          const litFinalPaid = finalLit && status === 'closed_paid';
          const dotColor = active || lit || litFinalPaid
            ? Colors.accent
            : finalLit
              ? Colors.textSecondary
              : 'rgba(23,21,15,0.14)';
          const labelColor = active
            ? Colors.accent
            : lit || finalLit
              ? Colors.text
              : Colors.textMuted;
          return (
            <View key={node} style={styles.lifeCol}>
              <View style={[styles.lifeDot, { backgroundColor: dotColor }]} />
              <Text style={[styles.lifeLabel, { color: labelColor }]}>
                {LIFECYCLE_LABEL_SHORT[node]}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ActionToolbar({
  status,
  onAction,
}: {
  status: ClaimStatus;
  onAction: (id: ActionId) => void;
}) {
  const priority = ACTION_PRIORITY[status];
  const buttons: { id: ActionId; emphasis: ActionEmphasis }[] = (
    Object.keys(priority) as ActionId[]
  )
    .map((id) => ({ id, emphasis: priority[id] }))
    .filter((b) => b.emphasis !== 'hidden')
    // Attach-defense is a web-only flow today; hide the button on mobile rather
    // than surface a button that just points the user to desktop.
    .filter((b) => b.id !== 'attach_defense_package')
    .sort((a, b) => {
      const order: Record<ActionEmphasis, number> = { primary: 0, secondary: 1, tertiary: 2, hidden: 3 };
      return order[a.emphasis] - order[b.emphasis];
    });

  if (buttons.length === 0) return null;

  return (
    <View style={styles.toolbar}>
      {buttons.map((b) => {
        const isPrimary = b.emphasis === 'primary';
        const isTertiary = b.emphasis === 'tertiary';
        const isDestructive = b.id === 'close_claim' || b.id === 'reopen_claim';
        return (
          <Pressable
            key={b.id}
            onPress={() => onAction(b.id)}
            style={[
              styles.toolbarBtn,
              isPrimary && styles.toolbarBtnPrimary,
              !isPrimary && styles.toolbarBtnSecondary,
              isTertiary && styles.toolbarBtnTertiary,
              isDestructive && !isPrimary && styles.toolbarBtnDestructive,
            ]}
          >
            <Text
              style={[
                styles.toolbarBtnText,
                isPrimary && styles.toolbarBtnTextPrimary,
                isDestructive && !isPrimary && styles.toolbarBtnTextDestructive,
              ]}
              numberOfLines={1}
            >
              {ACTION_LABEL[b.id]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── Inline destructive-action confirms ──────────────────────────────────

// Disposition is a choice (not text), so a native action sheet / alert is the
// right control. The amount + reason free-text inputs are handled by
// PromptModal in the component (Alert.prompt is iOS-only).
function chooseDisposition(onPick: (disposition: 'paid' | 'denied' | 'dropped') => void) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Paid', 'Denied', 'Dropped', 'Cancel'], cancelButtonIndex: 3, title: 'Close claim — disposition' },
      (idx) => {
        if (idx === 0) onPick('paid');
        else if (idx === 1) onPick('denied');
        else if (idx === 2) onPick('dropped');
      },
    );
  } else {
    Alert.alert('Close claim', 'Choose a disposition.', [
      { text: 'Paid', onPress: () => onPick('paid') },
      { text: 'Denied', onPress: () => onPick('denied') },
      { text: 'Dropped', onPress: () => onPick('dropped') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }
}

function deltaStyle(tone: 'success' | 'danger' | 'neutral') {
  return {
    color: tone === 'success' ? Colors.accent : tone === 'danger' ? Colors.error : Colors.textSecondary,
  } as const;
}

// ─── Styles ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },

  headerWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  backRow: { marginBottom: 12 },
  backText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 13 },
  eyebrow: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  glyph: { color: Colors.accentInk },
  masthead: {
    fontFamily: Fonts.monoBold,
    fontSize: 16,
    color: Colors.text,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    paddingBottom: 8,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  reopenBadge: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    color: Colors.error,
    borderColor: Colors.error,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  headerSub: { color: Colors.textSecondary, fontSize: 12, fontFamily: Fonts.monoRegular },

  headline: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
  },
  headlineLabel: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1.6,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  headlineValueRow: { flexDirection: 'row', alignItems: 'baseline' },
  headlineUnit: { fontFamily: Fonts.displayBold, fontSize: 26, color: Colors.textMuted },
  headlineDigits: {
    fontFamily: Fonts.displayBold,
    fontSize: 56,
    lineHeight: 60,
    color: Colors.text,
    letterSpacing: -1.5,
    fontVariant: ['tabular-nums'],
  },
  delta: { fontFamily: Fonts.monoBold, fontSize: 11, marginTop: 6 },

  lifeWrap: { paddingHorizontal: 20, paddingVertical: 16 },
  lifeReopen: {
    alignSelf: 'flex-end',
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    color: Colors.error,
    marginBottom: 6,
  },
  lifeNodes: { flexDirection: 'row', justifyContent: 'space-between' },
  lifeCol: { alignItems: 'center', flex: 1 },
  lifeDot: { width: 10, height: 10, borderRadius: 5, marginBottom: 6 },
  lifeLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2 },

  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 16,
  },
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: Colors.surface,
    padding: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  tileLabel: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1.4,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  tileValue: { fontFamily: Fonts.monoBold, fontSize: 16, color: Colors.text },

  sectionTitle: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: Colors.textSecondary,
    paddingHorizontal: 20,
    marginTop: 12,
    marginBottom: 8,
  },

  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSubtle,
  },
  ledgerType: { fontFamily: Fonts.sansSemiBold, fontSize: 13, color: Colors.text },
  ledgerDesc: {
    fontFamily: Fonts.monoRegular,
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  ledgerSub: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted, marginTop: 4 },
  ledgerAmount: { fontFamily: Fonts.monoBold, fontSize: 14, color: Colors.text },

  empty: {
    color: Colors.textMuted,
    fontStyle: 'italic',
    fontFamily: Fonts.sansRegular,
    fontSize: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    lineHeight: 16,
  },

  metaRow: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(23,21,15,0.06)',
  },
  metaLabel: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1.4,
    color: Colors.textMuted,
    marginBottom: 2,
  },
  metaValue: { color: Colors.text, fontFamily: Fonts.sansRegular, fontSize: 13 },

  toolbar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.tabBar,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 28,
    flexDirection: 'row',
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(23,21,15,0.10)',
  },
  toolbarBtn: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  toolbarBtnPrimary: { backgroundColor: Colors.accent },
  toolbarBtnSecondary: {
    borderWidth: 1,
    borderColor: 'rgba(23,21,15,0.20)',
    backgroundColor: 'transparent',
  },
  toolbarBtnTertiary: { borderStyle: 'dashed' as const, borderColor: 'rgba(23,21,15,0.14)' },
  toolbarBtnDestructive: { borderColor: 'rgba(255,69,87,0.4)' },
  toolbarBtnText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 12,
    color: Colors.text,
    textAlign: 'center',
  },
  toolbarBtnTextPrimary: { color: Colors.text },
  toolbarBtnTextDestructive: { color: Colors.error },

  errorBox: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: Colors.bg },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium, fontSize: 14 },
  retryBtn: {
    alignSelf: 'flex-start',
    borderColor: Colors.accent,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },

  pdfBtn: {
    alignSelf: 'flex-start',
    marginTop: 8,
    marginBottom: 4,
    borderColor: Colors.accent,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  pdfBtnBusy: { opacity: 0.5 },
  pdfBtnText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium, fontSize: 13 },
});
