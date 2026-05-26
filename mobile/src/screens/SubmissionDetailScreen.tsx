/**
 * Broker submission detail — mobile counterpart to /submissions/[sid].
 *
 * Shows the submission summary and one card per carrier quote, with the
 * on-the-go market actions: submit to market (when open), record a carrier
 * response (indicative pricing), mark declined, recommend (select), and
 * bind. Heavy authoring (edit terms, create) stays on web.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { formatLedgerMoney } from '../api/claim-tokens';
import { useAlert } from '../components/ThemedAlert';
import { PromptModal } from '../components/PromptModal';
import {
  submissionsApi,
  formatRatePct,
  QUOTE_STATUS_LABEL,
  QUOTE_STATUS_COLOR,
  SUBMISSION_STATUS_LABEL,
  SUBMISSION_STATUS_COLOR,
  type Carrier,
  type CarrierQuote,
  type PremiumBreakdown,
  type SubmissionDetail,
} from '../api/submissions';
import { policiesApi } from '../api/policies';

type PromptKind = { kind: 'withdraw' } | { kind: 'decline'; qid: string } | null;

/** api.request throws Error(rawBody); pull the structured {error,message} detail out. */
function parseErrorDetail(message?: string): { error?: string; message?: string } | null {
  if (!message) return null;
  try {
    const p = JSON.parse(message);
    const d = p?.detail ?? p;
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

function friendlyError(e: any): string {
  const d = parseErrorDetail(e?.message);
  if (d && typeof d.message === 'string') return d.message;
  return e?.message ?? 'Try again.';
}

function hasBreakdown(q: CarrierQuote): q is CarrierQuote & { premium_breakdown: PremiumBreakdown } {
  return !!q.premium_breakdown && 'total' in q.premium_breakdown;
}

export function SubmissionDetailScreen({ route, navigation }: any) {
  const sid: string = route.params.sid;
  const alert = useAlert();

  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState<PromptKind>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, c] = await Promise.all([
        submissionsApi.get(sid),
        submissionsApi.listCarriers().catch(() => [] as Carrier[]),
      ]);
      setDetail(d);
      setCarriers(c);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load submission');
    }
  }, [sid]);

  useEffect(() => {
    load();
  }, [load]);

  const isOpen = detail?.status === 'open';
  const quotedCarrierIds = useMemo(
    () => new Set((detail?.quotes ?? []).map((q) => q.carrier_id)),
    [detail],
  );

  const toggleCarrier = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, onDone?: () => void) => {
      setBusy(key);
      try {
        await fn();
        await load();
        onDone?.();
      } catch (e: any) {
        alert.show({ title: 'Action failed', message: friendlyError(e), variant: 'error' });
      } finally {
        setBusy(null);
      }
    },
    [load, alert],
  );

  const doSubmit = useCallback(
    (allowOutOfAppetite = false) => {
      const targets = [...selected];
      if (targets.length === 0) return;
      setBusy('submit');
      submissionsApi
        .submitToMarket(sid, { target_carriers: targets, allow_out_of_appetite: allowOutOfAppetite })
        .then(async (res) => {
          setSelected(new Set());
          await load();
          if (res.rejected_carriers.length > 0) {
            const lines = res.rejected_carriers
              .map((r) => `${r.carrier_id}: ${r.reasons.join(', ')}`)
              .join('\n');
            alert.show({ title: 'Some carriers skipped', message: lines, variant: 'warning' });
          }
        })
        .catch((e) => {
          const detail = parseErrorDetail(e?.message);
          if (detail?.error === 'out_of_appetite' && !allowOutOfAppetite) {
            alert.show({
              title: 'Out of appetite',
              message: `All ${targets.length} selected carrier${targets.length === 1 ? '' : 's'} are out of appetite for this venue and coverage profile. Submit anyway?`,
              variant: 'warning',
              buttons: [
                { label: 'Cancel', style: 'cancel' },
                { label: 'Submit anyway', style: 'primary', onPress: () => doSubmit(true) },
              ],
            });
          } else {
            alert.show({ title: 'Submit failed', message: friendlyError(e), variant: 'error' });
          }
        })
        .finally(() => setBusy(null));
    },
    [selected, sid, load, alert],
  );

  const doRecordQuoted = (q: CarrierQuote) =>
    run(`rec-${q.id}`, async () => {
      const breakdown = await submissionsApi.buildIndicative(q.id);
      await submissionsApi.recordResponse(q.id, { status: 'quoted', premium_breakdown: breakdown });
    });

  const doSelect = (q: CarrierQuote) => run(`sel-${q.id}`, () => submissionsApi.selectQuote(q.id));

  const doBind = (q: CarrierQuote) =>
    alert.show({
      title: 'Bind this quote?',
      message: 'Creates a policy (pending number). Assign the carrier number later from Policies.',
      variant: 'warning',
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: 'Bind',
          style: 'primary',
          onPress: () =>
            run(
              `bind-${q.id}`,
              async () => {
                // Backend requires a selected quote before binding.
                if (!q.is_selected) await submissionsApi.selectQuote(q.id);
                const policy = await policiesApi.bind(q.id);
                navigation.navigate('Policies', { screen: 'PolicyDetail', params: { pid: policy.id } });
              },
            ),
        },
      ],
    });

  if (detail === null && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Pressable style={styles.backRow} onPress={() => navigation.goBack()}>
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.backLabel}>Submissions</Text>
        </Pressable>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={load} style={styles.retryBtn}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {detail && (
          <>
            <View style={styles.headerWrap}>
              <Text style={styles.eyebrow}>BROKER · SUBMISSION</Text>
              <Text style={styles.title}>{detail.venue_id}</Text>
              <Text
                style={[styles.statusPill, { color: SUBMISSION_STATUS_COLOR[detail.status] }]}
              >
                {SUBMISSION_STATUS_LABEL[detail.status]}
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.summaryRow}>
                <SummaryCell label="EFFECTIVE" value={detail.effective_date} />
                <SummaryCell label="QUOTES" value={String(detail.quotes.length)} />
                <SummaryCell
                  label="SUBMITTED"
                  value={detail.submitted_at ? detail.submitted_at.slice(0, 10) : '—'}
                />
              </View>
              <View style={styles.lineChips}>
                {detail.coverage_lines.map((cl) => (
                  <Text key={cl} style={styles.lineChip}>
                    {cl.toUpperCase()}
                  </Text>
                ))}
              </View>
            </View>

            {/* Open submission → pick carriers + submit / withdraw */}
            {isOpen && (
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>SEND TO MARKET</Text>
                {carriers.map((c) => {
                  const already = quotedCarrierIds.has(c.id);
                  const on = selected.has(c.id);
                  return (
                    <Pressable
                      key={c.id}
                      style={styles.carrierRow}
                      disabled={already}
                      onPress={() => toggleCarrier(c.id)}
                    >
                      <View style={[styles.checkbox, on && styles.checkboxOn]}>
                        {on && <Text style={styles.checkboxTick}>✓</Text>}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.carrierName, already && styles.carrierDim]}>
                          {c.name}
                        </Text>
                        <Text style={styles.carrierMeta}>
                          {c.market_type.toUpperCase()}
                          {c.am_best_rating ? ` · ${c.am_best_rating}` : ''}
                          {already ? ' · already requested' : ''}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
                <Pressable
                  style={[styles.primaryBtn, (selected.size === 0 || busy === 'submit') && styles.btnDisabled]}
                  disabled={selected.size === 0 || busy === 'submit'}
                  onPress={() => doSubmit()}
                >
                  <Text style={styles.primaryBtnText}>
                    {busy === 'submit' ? 'Submitting…' : `Submit to ${selected.size || 0} carrier${selected.size === 1 ? '' : 's'}`}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.dangerBtn}
                  disabled={busy === 'withdraw'}
                  onPress={() => setPrompt({ kind: 'withdraw' })}
                >
                  <Text style={styles.dangerBtnText}>Withdraw submission</Text>
                </Pressable>
              </View>
            )}

            {/* Quotes */}
            <Text style={styles.quotesHeading}>CARRIER QUOTES</Text>
            {detail.quotes.length === 0 ? (
              <Text style={styles.emptyText}>No quotes yet. Submit to carriers to request them.</Text>
            ) : (
              detail.quotes.map((q) => (
                <QuoteCard
                  key={q.id}
                  quote={q}
                  busy={busy}
                  onRecord={() => doRecordQuoted(q)}
                  onDecline={() => setPrompt({ kind: 'decline', qid: q.id })}
                  onSelect={() => doSelect(q)}
                  onBind={() => doBind(q)}
                />
              ))
            )}
          </>
        )}
      </ScrollView>

      <PromptModal
        visible={prompt?.kind === 'withdraw'}
        title="Withdraw submission"
        message="Give a reason for withdrawing this submission from market."
        placeholder="e.g. Client paused placement"
        confirmLabel="Withdraw"
        onCancel={() => setPrompt(null)}
        onSubmit={(reason) => {
          setPrompt(null);
          run('withdraw', () => submissionsApi.withdraw(sid, reason));
        }}
      />
      <PromptModal
        visible={prompt?.kind === 'decline'}
        title="Mark declined"
        message="Record why this carrier declined."
        placeholder="e.g. Outside appetite"
        confirmLabel="Mark declined"
        onCancel={() => setPrompt(null)}
        onSubmit={(reason) => {
          const qid = prompt && 'qid' in prompt ? prompt.qid : null;
          setPrompt(null);
          if (qid) run(`dec-${qid}`, () => submissionsApi.recordResponse(qid, { status: 'declined', decline_reason: reason }));
        }}
      />
    </View>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryCell}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

function QuoteCard({
  quote,
  busy,
  onRecord,
  onDecline,
  onSelect,
  onBind,
}: {
  quote: CarrierQuote;
  busy: string | null;
  onRecord: () => void;
  onDecline: () => void;
  onSelect: () => void;
  onBind: () => void;
}) {
  const bd = hasBreakdown(quote) ? quote.premium_breakdown : null;
  const awaitingResponse = quote.status === 'requested' || quote.status === 'pending';
  const quoted = quote.status === 'quoted';

  return (
    <View style={[styles.quoteCard, quote.is_selected && styles.quoteCardSelected]}>
      <View style={styles.quoteTop}>
        <Text style={styles.quoteCarrier} numberOfLines={1}>
          {quote.carrier_id}
          {quote.is_selected ? '  ★' : ''}
        </Text>
        <Text style={[styles.statusPill, { color: QUOTE_STATUS_COLOR[quote.status] }]}>
          {QUOTE_STATUS_LABEL[quote.status]}
        </Text>
      </View>

      {bd && (
        <>
          <Text style={styles.quoteTotal}>{formatLedgerMoney(bd.total)}/yr</Text>
          <View style={styles.breakdown}>
            {Object.entries(bd.lines).map(([line, l]) => (
              <View key={line} style={styles.breakdownRow}>
                <Text style={styles.breakdownLine}>{line.toUpperCase()}</Text>
                <Text style={styles.breakdownVal}>{formatLedgerMoney(l.premium)}</Text>
              </View>
            ))}
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownFee}>Policy fee</Text>
              <Text style={styles.breakdownFeeVal}>{formatLedgerMoney(bd.fees.policy_fee)}</Text>
            </View>
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownFee}>Surplus lines tax</Text>
              <Text style={styles.breakdownFeeVal}>{formatLedgerMoney(bd.fees.surplus_lines_tax)}</Text>
            </View>
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownFee}>Commission ({formatRatePct(bd.commission_rate)})</Text>
              <Text style={styles.breakdownFeeVal}>{formatLedgerMoney(bd.commission_amount)}</Text>
            </View>
          </View>
        </>
      )}

      {quote.status === 'declined' && quote.decline_reason && (
        <Text style={styles.declineReason}>Declined — {quote.decline_reason}</Text>
      )}

      {/* Actions */}
      {awaitingResponse && (
        <View style={styles.actionRow}>
          <Pressable
            style={[styles.primaryBtn, styles.flexBtn, busy === `rec-${quote.id}` && styles.btnDisabled]}
            disabled={busy === `rec-${quote.id}`}
            onPress={onRecord}
          >
            <Text style={styles.primaryBtnText}>
              {busy === `rec-${quote.id}` ? 'Recording…' : 'Record quote'}
            </Text>
          </Pressable>
          <Pressable style={[styles.ghostBtn, styles.flexBtn]} onPress={onDecline}>
            <Text style={styles.ghostBtnText}>Declined</Text>
          </Pressable>
        </View>
      )}
      {quoted && (
        <View style={styles.actionRow}>
          {!quote.is_selected && (
            <Pressable style={[styles.ghostBtn, styles.flexBtn]} onPress={onSelect}>
              <Text style={styles.ghostBtnText}>Recommend</Text>
            </Pressable>
          )}
          <Pressable
            style={[styles.primaryBtn, styles.flexBtn, busy === `bind-${quote.id}` && styles.btnDisabled]}
            disabled={busy === `bind-${quote.id}`}
            onPress={onBind}
          >
            <Text style={styles.primaryBtnText}>
              {busy === `bind-${quote.id}` ? 'Binding…' : 'Bind →'}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  backArrow: { color: Colors.accentInk, fontSize: 18, marginRight: 8, fontFamily: Fonts.monoBold },
  backLabel: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 13 },

  headerWrap: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 30, lineHeight: 34, color: Colors.text, letterSpacing: -0.5 },
  statusPill: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1, marginTop: 6 },

  card: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  summaryRow: { flexDirection: 'row', gap: 12 },
  summaryCell: { flex: 1 },
  summaryLabel: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 1.2, color: Colors.textMuted, marginBottom: 2 },
  summaryValue: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text },

  lineChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  lineChip: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1,
    color: Colors.textSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },

  sectionLabel: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 10 },
  carrierRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  checkboxTick: { color: Colors.text, fontSize: 13, fontFamily: Fonts.monoBold },
  carrierName: { fontFamily: Fonts.sansSemiBold, fontSize: 14, color: Colors.text },
  carrierDim: { color: Colors.textMuted },
  carrierMeta: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted, marginTop: 1 },

  quotesHeading: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: Colors.textSecondary,
    marginTop: 22,
    marginBottom: 8,
    paddingHorizontal: 20,
  },
  quoteCard: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  quoteCardSelected: { borderColor: Colors.accent, borderWidth: 1 },
  quoteTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  quoteCarrier: { fontFamily: Fonts.sansSemiBold, fontSize: 15, color: Colors.text, flex: 1, marginRight: 8 },
  quoteTotal: { fontFamily: Fonts.displayBold, fontSize: 24, color: Colors.text, marginTop: 8, letterSpacing: -0.5 },

  breakdown: { marginTop: 10, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.borderSubtle, paddingTop: 10 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between' },
  breakdownLine: { fontFamily: Fonts.monoBold, fontSize: 11, color: Colors.textSecondary, letterSpacing: 0.5 },
  breakdownVal: { fontFamily: Fonts.monoBold, fontSize: 11, color: Colors.text },
  breakdownFee: { fontFamily: Fonts.sansRegular, fontSize: 11, color: Colors.textMuted },
  breakdownFeeVal: { fontFamily: Fonts.monoRegular, fontSize: 11, color: Colors.textSecondary },

  declineReason: { fontFamily: Fonts.sansRegular, fontSize: 12, color: Colors.error, marginTop: 10 },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  flexBtn: { flex: 1 },
  primaryBtn: {
    backgroundColor: Colors.accent,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryBtnText: { color: Colors.text, fontFamily: Fonts.monoBold, fontSize: 12, letterSpacing: 1 },
  ghostBtn: {
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 12,
  },
  ghostBtnText: { color: Colors.accentInk, fontFamily: Fonts.monoBold, fontSize: 12, letterSpacing: 1 },
  dangerBtn: { paddingVertical: 11, alignItems: 'center', marginTop: 8 },
  dangerBtnText: { color: Colors.error, fontFamily: Fonts.sansMedium, fontSize: 13 },
  btnDisabled: { opacity: 0.4 },

  emptyText: {
    color: Colors.textSecondary,
    fontFamily: Fonts.sansRegular,
    fontSize: 13,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
