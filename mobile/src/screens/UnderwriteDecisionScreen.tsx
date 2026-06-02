/**
 * Carrier underwriting decision — B layout.
 * KPI band → suggested premium → structured terms → actions → dossier accordions.
 * Uses fetchDossier (not fetchUnderwritingQueue) for a richer data set.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { tierColor } from '../theme/tiers';
import { Field } from './RecordReserveScreen';
import {
  fetchDossier,
  fmtMoney,
  lineLabel,
  requestInfo,
  rescaleBreakdownToTotal,
  underwriteQuote,
  type CoverageTerms,
  type Dossier,
  type ScheduleMod,
  type Subjectivity,
} from '../api/underwriting';

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** Color + label for a subjectivity status chip. */
function subjectivityColor(status: Subjectivity['status']): string {
  if (status === 'met') return Colors.success;
  if (status === 'waived') return Colors.textMuted;
  return Colors.warning;
}
function subjectivityLabel(status: Subjectivity['status']): string {
  if (status === 'met') return 'MET';
  if (status === 'waived') return 'WAIVED';
  return 'OPEN';
}

/** Color + word for compliance status */
function complianceChipColor(status: string): string {
  const s = status?.toLowerCase();
  if (s === 'compliant') return Colors.success;
  if (s === 'warning' || s === 'review') return Colors.warning;
  return Colors.error;
}

/** Severity chip color for compliance open items */
function severityColor(severity: string): string {
  if (severity === 'high') return Colors.error;
  if (severity === 'medium') return Colors.warning;
  return Colors.textMuted;
}

// ---------------------------------------------------------------------------
// Collapsible accordion section
// ---------------------------------------------------------------------------
function Accordion({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={acc.wrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={acc.header}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        hitSlop={{ top: 8, bottom: 8 }}
      >
        <Text style={acc.title}>{title}</Text>
        <Text style={acc.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open && <View style={acc.body}>{children}</View>}
    </View>
  );
}

const acc = StyleSheet.create({
  wrap: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    marginBottom: 10,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    minHeight: 44,
  },
  title: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
  },
  chevron: { color: Colors.textMuted, fontSize: 14 },
  body: { paddingHorizontal: 14, paddingBottom: 14 },
});

// ---------------------------------------------------------------------------
// Status chip (color + text, never color alone)
// ---------------------------------------------------------------------------
function Chip({
  label,
  color,
}: {
  label: string;
  color: string;
}) {
  return (
    <View style={[chip.wrap, { borderColor: color }]}>
      <Text style={[chip.text, { color }]}>{label}</Text>
    </View>
  );
}

const chip = StyleSheet.create({
  wrap: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  text: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 0.8 },
});

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function UnderwriteDecisionScreen({ route, navigation }: any) {
  const { qid } = route.params as { qid: string };

  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [loading, setLoading] = useState(true);
  const [notDecidable, setNotDecidable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Decision form
  const [totalInput, setTotalInput] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const [infoNote, setInfoNote] = useState('');
  const [submitting, setSubmitting] = useState<'quote' | 'decline' | 'info' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Structured coverage terms
  const [coverageLines, setCoverageLines] = useState<
    Record<string, { limit: string; deductible: string; sublimit: string }>
  >({});
  const [subjectivities, setSubjectivities] = useState<Subjectivity[]>([]);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [endorsements, setEndorsements] = useState<string[]>([]);
  const [scheduleMods, setScheduleMods] = useState<ScheduleMod[]>([]);
  const [validUntil, setValidUntil] = useState('');

  // Dossier load
  const load = useCallback(async () => {
    setLoadError(null);
    setLoading(true);
    try {
      const d = await fetchDossier(qid);
      setDossier(d);
      if (!d.decidable) {
        setNotDecidable(true);
        return;
      }
      if (d.suggested_premium_breakdown) {
        setTotalInput(d.suggested_premium_breakdown.total);
      }
      // Prefill coverage line fields from requested_limits
      const initLines: Record<string, { limit: string; deductible: string; sublimit: string }> = {};
      for (const line of d.submission.coverage_lines) {
        const req = d.submission.requested_limits?.[line] ?? {};
        initLines[line] = {
          limit: req.limit ?? req.per_occurrence_limit ?? '',
          deductible: req.deductible ?? '',
          sublimit: req.sublimit ?? '',
        };
      }
      setCoverageLines(initLines);
      // Prefill from existing coverage_terms if present
      const existing = d.quote?.coverage_terms;
      if (existing) {
        if (existing.subjectivities?.length) setSubjectivities(existing.subjectivities);
        if (existing.exclusions?.length) setExclusions(existing.exclusions);
        if (existing.endorsements?.length) setEndorsements(existing.endorsements);
        if (existing.schedule_mods?.length) setScheduleMods(existing.schedule_mods);
        if (existing.valid_until) setValidUntil(existing.valid_until);
      }
    } catch (e: any) {
      setLoadError(e?.message ?? "Couldn't load this submission.");
    } finally {
      setLoading(false);
    }
  }, [qid]);

  useEffect(() => { load(); }, [load]);

  const suggested = dossier?.suggested_premium_breakdown ?? null;
  const feeFloor = useMemo(
    () =>
      suggested ? Number(suggested.fees.policy_fee) + Number(suggested.fees.surplus_lines_tax) : 0,
    [suggested],
  );

  // ---------------------------------------------------------------------------
  // Build CoverageTerms from form state
  // ---------------------------------------------------------------------------
  function buildCoverageTerms(): CoverageTerms {
    const lines: CoverageTerms['lines'] = {};
    for (const [id, vals] of Object.entries(coverageLines)) {
      const entry: { limit?: string; deductible?: string; sublimit?: string | null } = {};
      if (vals.limit) entry.limit = vals.limit;
      if (vals.deductible) entry.deductible = vals.deductible;
      if (vals.sublimit) entry.sublimit = vals.sublimit;
      if (Object.keys(entry).length) lines[id] = entry;
    }
    return {
      lines: Object.keys(lines).length ? lines : undefined,
      subjectivities: subjectivities.length ? subjectivities : undefined,
      exclusions: exclusions.filter(Boolean).length ? exclusions.filter(Boolean) : undefined,
      endorsements: endorsements.filter(Boolean).length ? endorsements.filter(Boolean) : undefined,
      schedule_mods: scheduleMods.length ? scheduleMods : undefined,
      valid_until: validUntil || undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------
  async function handleQuote() {
    if (!suggested) return;
    setError(null);
    const target = Number(totalInput);
    if (!Number.isFinite(target) || target <= 0) {
      setError('Enter a valid premium total.');
      return;
    }
    const unchanged = Math.round(target * 100) === Math.round(Number(suggested.total) * 100);
    const breakdown = unchanged ? suggested : rescaleBreakdownToTotal(suggested, target);
    if (!breakdown) {
      setError(`Total must be above the fixed fees (${fmtMoney(feeFloor, true)}).`);
      return;
    }
    setSubmitting('quote');
    try {
      await underwriteQuote(qid, {
        decision: 'quote',
        premium_breakdown: breakdown,
        coverage_terms: buildCoverageTerms(),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e: any) {
      setError(e?.message ?? 'Could not record the quote.');
    } finally {
      setSubmitting(null);
    }
  }

  async function handleDecline() {
    setError(null);
    if (!declineReason.trim()) {
      setError('A decline needs a reason (the broker relays it to the insured).');
      return;
    }
    setSubmitting('decline');
    try {
      await underwriteQuote(qid, { decision: 'decline', decline_reason: declineReason.trim() });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e: any) {
      setError(e?.message ?? 'Could not record the decline.');
    } finally {
      setSubmitting(null);
    }
  }

  async function handleRequestInfo() {
    setError(null);
    if (!infoNote.trim()) {
      setError('Add a note describing what information you need.');
      return;
    }
    setSubmitting('info');
    try {
      await requestInfo(qid, infoNote.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e: any) {
      setError(e?.message ?? 'Could not send the info request.');
    } finally {
      setSubmitting(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Subjectivity / list helpers
  // ---------------------------------------------------------------------------
  function addSubjectivity() {
    setSubjectivities((s) => [...s, { text: '', status: 'open' }]);
  }
  function cycleSubjectivityStatus(i: number) {
    setSubjectivities((s) =>
      s.map((x, idx) => {
        if (idx !== i) return x;
        const next: Subjectivity['status'] =
          x.status === 'open' ? 'met' : x.status === 'met' ? 'waived' : 'open';
        return { ...x, status: next };
      }),
    );
  }
  function updateSubjectivityText(i: number, text: string) {
    setSubjectivities((s) => s.map((x, idx) => (idx === i ? { ...x, text } : x)));
  }
  function removeSubjectivity(i: number) {
    setSubjectivities((s) => s.filter((_, idx) => idx !== i));
  }

  function addExclusion() { setExclusions((e) => [...e, '']); }
  function updateExclusion(i: number, v: string) { setExclusions((e) => e.map((x, idx) => (idx === i ? v : x))); }
  function removeExclusion(i: number) { setExclusions((e) => e.filter((_, idx) => idx !== i)); }

  function addEndorsement() { setEndorsements((e) => [...e, '']); }
  function updateEndorsement(i: number, v: string) { setEndorsements((e) => e.map((x, idx) => (idx === i ? v : x))); }
  function removeEndorsement(i: number) { setEndorsements((e) => e.filter((_, idx) => idx !== i)); }

  function addScheduleMod() { setScheduleMods((m) => [...m, { category: '', kind: 'credit', pct: '' }]); }
  function updateScheduleMod(i: number, patch: Partial<ScheduleMod>) {
    setScheduleMods((m) => m.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function removeScheduleMod(i: number) { setScheduleMods((m) => m.filter((_, idx) => idx !== i)); }

  // ---------------------------------------------------------------------------
  // Loading / not-found states
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  if (loadError || notDecidable || !dossier) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>
          {loadError ??
            'This submission is no longer awaiting a decision — it may already be quoted or declined.'}
        </Text>
        <Pressable onPress={() => navigation.goBack()} style={styles.retryBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.retryText}>Back to desk</Text>
        </Pressable>
      </View>
    );
  }

  const venueName = dossier.venue.name;
  const effectiveDate = dossier.submission.effective_date
    ? new Date(dossier.submission.effective_date).toLocaleDateString()
    : null;
  const coverageSummary =
    dossier.submission.coverage_lines.map(lineLabel).join(' · ') || 'Coverage TBD';
  const tc = tierColor(dossier.risk.tier);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8 }}>
          <Text style={styles.backText}>‹ Desk</Text>
        </Pressable>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.eyebrow}>CARRIER · UNDERWRITING DECISION</Text>
          <View style={styles.titleRow}>
            <Text style={styles.title}>{venueName}</Text>
          </View>
          <Text style={styles.subtitle}>
            {coverageSummary}
            {effectiveDate ? ` · effective ${effectiveDate}` : ''}
          </Text>
        </View>

        {/* ── KPI BAND ── */}
        <View style={styles.kpiBand}>
          {/* Tier */}
          <View style={styles.kpiCell}>
            <Text style={styles.kpiLabel}>RISK TIER</Text>
            <View style={[styles.tierPill, { borderColor: tc }]}>
              <Text style={[styles.tierText, { color: tc }]}>
                {dossier.risk.tier} · {dossier.risk.total_score}
              </Text>
            </View>
          </View>
          {/* Open incidents */}
          <View style={styles.kpiCell}>
            <Text style={styles.kpiLabel}>INCIDENTS</Text>
            <Text style={[styles.kpiValue, dossier.incidents.open_count > 0 && styles.kpiWarn]}>
              {dossier.incidents.open_count} open
            </Text>
          </View>
          {/* Compliance */}
          <View style={styles.kpiCell}>
            <Text style={styles.kpiLabel}>COMPLIANCE</Text>
            <Chip
              label={dossier.compliance.status.toUpperCase()}
              color={complianceChipColor(dossier.compliance.status)}
            />
            {dossier.compliance.open_items.length > 0 && (
              <Text style={[styles.kpiSub, { color: Colors.warning }]}>
                {dossier.compliance.open_items.length} open
              </Text>
            )}
          </View>
          {/* Loss run headline */}
          {dossier.loss_run && (
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>TOTAL INCURRED</Text>
              <Text style={styles.kpiMoney}>
                {fmtMoney(String(dossier.loss_run.summary.total_incurred ?? ''), true)}
              </Text>
            </View>
          )}
        </View>

        {/* ── SUGGESTED PREMIUM ── */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>SUGGESTED PREMIUM · PRICING ENGINE</Text>
          {suggested ? (
            <>
              {Object.entries(suggested.lines).map(([id, line]) => (
                <View key={id} style={styles.lineRow}>
                  <Text style={styles.lineName}>{lineLabel(id)}</Text>
                  <Text style={styles.lineMoney}>{fmtMoney(line.premium, true)}</Text>
                </View>
              ))}
              <View style={[styles.lineRow, styles.divider]}>
                <Text style={styles.feeLabel}>Policy fee</Text>
                <Text style={styles.lineMoney}>{fmtMoney(suggested.fees.policy_fee, true)}</Text>
              </View>
              {Number(suggested.fees.surplus_lines_tax) > 0 && (
                <View style={styles.lineRow}>
                  <Text style={styles.feeLabel}>Surplus lines tax</Text>
                  <Text style={styles.lineMoney}>{fmtMoney(suggested.fees.surplus_lines_tax, true)}</Text>
                </View>
              )}
              <View style={[styles.lineRow, styles.divider]}>
                <Text style={styles.totalLabel}>SUGGESTED TOTAL</Text>
                <Text style={styles.totalMoney}>{fmtMoney(suggested.total, true)}</Text>
              </View>
              <Text style={styles.hint}>
                Risk-adjusted by tier {dossier.risk.tier} and this carrier's appetite. Editing the total rescales the lines proportionally.
              </Text>
            </>
          ) : (
            <Text style={styles.hint}>
              No engine suggestion for this venue (outside the rated set). You can still decline.
            </Text>
          )}
        </View>

        {/* ── STRUCTURED TERMS FORM ── */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>COVERAGE TERMS</Text>

          {/* Per-line limit / deductible / sublimit */}
          {dossier.submission.coverage_lines.map((line) => (
            <View key={line} style={styles.lineTermsGroup}>
              <Text style={styles.lineTermsHeader}>{lineLabel(line).toUpperCase()}</Text>
              <Field
                label="Limit"
                value={coverageLines[line]?.limit ?? ''}
                onChangeText={(v) =>
                  setCoverageLines((cl) => ({ ...cl, [line]: { ...cl[line], limit: v } }))
                }
                placeholder="e.g. 1000000"
                keyboardType="numeric"
                mono
              />
              <Field
                label="Deductible"
                value={coverageLines[line]?.deductible ?? ''}
                onChangeText={(v) =>
                  setCoverageLines((cl) => ({ ...cl, [line]: { ...cl[line], deductible: v } }))
                }
                placeholder="e.g. 5000"
                keyboardType="numeric"
                mono
              />
              <Field
                label="Sublimit (optional)"
                value={coverageLines[line]?.sublimit ?? ''}
                onChangeText={(v) =>
                  setCoverageLines((cl) => ({ ...cl, [line]: { ...cl[line], sublimit: v } }))
                }
                placeholder="optional"
                keyboardType="numeric"
                mono
              />
            </View>
          ))}

          {/* Subjectivities */}
          <View style={styles.termsSection}>
            <View style={styles.termsSectionHeader}>
              <Text style={styles.termsSectionTitle}>SUBJECTIVITIES</Text>
              <Pressable
                onPress={addSubjectivity}
                style={styles.addBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel="Add subjectivity"
              >
                <Text style={styles.addBtnText}>+ Add</Text>
              </Pressable>
            </View>
            {subjectivities.length === 0 && (
              <Text style={styles.noneText}>None</Text>
            )}
            {subjectivities.map((sub, i) => (
              <View key={i} style={styles.subjectivityRow}>
                <View style={{ flex: 1 }}>
                  <Field
                    label={`Subjectivity ${i + 1}`}
                    value={sub.text}
                    onChangeText={(t) => updateSubjectivityText(i, t)}
                    placeholder="Describe the subjectivity…"
                    multiline
                  />
                </View>
                {/* 3-chip status selector */}
                <View style={styles.subjectivityChips}>
                  {(['open', 'met', 'waived'] as Subjectivity['status'][]).map((s) => {
                    const active = sub.status === s;
                    const c = subjectivityColor(s);
                    return (
                      <Pressable
                        key={s}
                        onPress={() =>
                          setSubjectivities((arr) =>
                            arr.map((x, idx) => (idx === i ? { ...x, status: s } : x)),
                          )
                        }
                        style={[
                          styles.subChip,
                          { borderColor: c, backgroundColor: active ? c + '22' : 'transparent' },
                        ]}
                        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                        accessibilityLabel={`Set status to ${s}`}
                        accessibilityState={{ selected: active }}
                      >
                        <Text style={[styles.subChipText, { color: c }]}>
                          {subjectivityLabel(s as Subjectivity['status'])}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Pressable
                  onPress={() => removeSubjectivity(i)}
                  style={styles.removeBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel={`Remove subjectivity ${i + 1}`}
                >
                  <Text style={styles.removeBtnText}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>

          {/* Additional terms — collapsible */}
          <Accordion title="Additional terms (exclusions, endorsements, schedule mods)">
            {/* Exclusions */}
            <View style={styles.termsSection}>
              <View style={styles.termsSectionHeader}>
                <Text style={styles.termsSectionTitle}>EXCLUSIONS</Text>
                <Pressable
                  onPress={addExclusion}
                  style={styles.addBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Add exclusion"
                >
                  <Text style={styles.addBtnText}>+ Add</Text>
                </Pressable>
              </View>
              {exclusions.length === 0 && <Text style={styles.noneText}>None</Text>}
              {exclusions.map((ex, i) => (
                <View key={i} style={styles.listItemRow}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label={`Exclusion ${i + 1}`}
                      value={ex}
                      onChangeText={(v) => updateExclusion(i, v)}
                      placeholder="Exclusion description…"
                    />
                  </View>
                  <Pressable
                    onPress={() => removeExclusion(i)}
                    style={styles.removeBtn}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityLabel={`Remove exclusion ${i + 1}`}
                  >
                    <Text style={styles.removeBtnText}>×</Text>
                  </Pressable>
                </View>
              ))}
            </View>

            {/* Endorsements */}
            <View style={styles.termsSection}>
              <View style={styles.termsSectionHeader}>
                <Text style={styles.termsSectionTitle}>ENDORSEMENTS</Text>
                <Pressable
                  onPress={addEndorsement}
                  style={styles.addBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Add endorsement"
                >
                  <Text style={styles.addBtnText}>+ Add</Text>
                </Pressable>
              </View>
              {endorsements.length === 0 && <Text style={styles.noneText}>None</Text>}
              {endorsements.map((en, i) => (
                <View key={i} style={styles.listItemRow}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label={`Endorsement ${i + 1}`}
                      value={en}
                      onChangeText={(v) => updateEndorsement(i, v)}
                      placeholder="Endorsement description…"
                    />
                  </View>
                  <Pressable
                    onPress={() => removeEndorsement(i)}
                    style={styles.removeBtn}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityLabel={`Remove endorsement ${i + 1}`}
                  >
                    <Text style={styles.removeBtnText}>×</Text>
                  </Pressable>
                </View>
              ))}
            </View>

            {/* Schedule mods */}
            <View style={styles.termsSection}>
              <View style={styles.termsSectionHeader}>
                <Text style={styles.termsSectionTitle}>SCHEDULE MODS</Text>
                <Pressable
                  onPress={addScheduleMod}
                  style={styles.addBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Add schedule modification"
                >
                  <Text style={styles.addBtnText}>+ Add</Text>
                </Pressable>
              </View>
              {scheduleMods.length === 0 && <Text style={styles.noneText}>None</Text>}
              {scheduleMods.map((mod, i) => (
                <View key={i} style={styles.scheduleModRow}>
                  <View style={{ flex: 1, marginBottom: 6 }}>
                    <Field
                      label="Category"
                      value={mod.category}
                      onChangeText={(v) => updateScheduleMod(i, { category: v })}
                      placeholder="Category…"
                    />
                    <Field
                      label="Percentage"
                      value={mod.pct}
                      onChangeText={(v) => updateScheduleMod(i, { pct: v })}
                      placeholder="0.0"
                      keyboardType="decimal-pad"
                      mono
                      suffix="%"
                    />
                    {/* Kind toggle: Credit / Debit */}
                    <View style={styles.kindRow}>
                      {(['credit', 'debit'] as ScheduleMod['kind'][]).map((k) => {
                        const active = mod.kind === k;
                        const c = k === 'credit' ? Colors.success : Colors.error;
                        return (
                          <Pressable
                            key={k}
                            onPress={() => updateScheduleMod(i, { kind: k })}
                            style={[
                              styles.kindChip,
                              { borderColor: c, backgroundColor: active ? c + '22' : 'transparent' },
                            ]}
                            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                            accessibilityLabel={`Set kind to ${k}`}
                            accessibilityState={{ selected: active }}
                          >
                            <Text style={[styles.kindChipText, { color: c }]}>
                              {k.toUpperCase()}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                  <Pressable
                    onPress={() => removeScheduleMod(i)}
                    style={styles.removeBtn}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityLabel={`Remove schedule mod ${i + 1}`}
                  >
                    <Text style={styles.removeBtnText}>×</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </Accordion>

          {/* Valid until */}
          <Field
            label="Quote valid until"
            value={validUntil}
            onChangeText={setValidUntil}
            placeholder="YYYY-MM-DD"
            hint="ISO date, e.g. 2026-08-01"
          />
        </View>

        {/* ── ACTIONS ── */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>DECISION</Text>

          {/* Quote */}
          <Field
            label="Annual premium"
            value={totalInput}
            onChangeText={(t) => setTotalInput(t.replace(/[^0-9.]/g, ''))}
            placeholder="0.00"
            keyboardType="decimal-pad"
            mono
            prefix="$"
            suffix="USD"
          />
          <Pressable
            onPress={handleQuote}
            style={[styles.btnPrimary, (!suggested || submitting !== null) && styles.btnDisabled]}
            disabled={!suggested || submitting !== null}
            accessibilityLabel="Quote submission"
          >
            <Text style={styles.btnPrimaryText}>
              {submitting === 'quote' ? 'Recording…' : `Quote at ${fmtMoney(totalInput)}`}
            </Text>
          </Pressable>
          <Text style={styles.actionHint}>
            Issues the carrier's quote with the terms above and escalates the submission for the broker to bind.
          </Text>

          <Text style={styles.orRule}>— OR —</Text>

          {/* Decline */}
          <Field
            label="Decline reason"
            value={declineReason}
            onChangeText={setDeclineReason}
            placeholder="Why this risk is outside appetite…"
            multiline
          />
          <Pressable
            onPress={handleDecline}
            style={[styles.btnDecline, (submitting !== null || !declineReason.trim()) && styles.btnDisabled]}
            disabled={submitting !== null || !declineReason.trim()}
            accessibilityLabel="Decline submission"
          >
            <Text style={styles.btnDeclineText}>
              {submitting === 'decline' ? 'Recording…' : 'Decline submission'}
            </Text>
          </Pressable>

          <Text style={styles.orRule}>— OR —</Text>

          {/* Request info */}
          <Field
            label="Request additional information"
            value={infoNote}
            onChangeText={setInfoNote}
            placeholder="What information do you need from the broker?"
            multiline
          />
          <Pressable
            onPress={handleRequestInfo}
            style={[styles.btnInfo, (submitting !== null || !infoNote.trim()) && styles.btnDisabled]}
            disabled={submitting !== null || !infoNote.trim()}
            accessibilityLabel="Request information from broker"
          >
            <Text style={styles.btnInfoText}>
              {submitting === 'info' ? 'Sending…' : 'Request info'}
            </Text>
          </Pressable>

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Text style={styles.footnote}>
            Decided on Nightline's own desk — stamped as a carrier decision in the audit trail.
          </Text>
        </View>

        {/* ── DOSSIER ACCORDIONS ── */}

        {/* Risk factors */}
        {Object.keys(dossier.risk.factors).length > 0 && (
          <Accordion title={`Risk factors (${Object.keys(dossier.risk.factors).length})`}>
            {Object.entries(dossier.risk.factors).map(([name, factor]) => (
              <View key={name} style={styles.factorRow}>
                <Text style={styles.factorName}>
                  {name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </Text>
                <Text style={styles.factorWeight}>
                  wt {(factor.weight * 100).toFixed(0)}%
                </Text>
                <View style={styles.factorBarWrap}>
                  <View
                    style={[
                      styles.factorBarFill,
                      {
                        width: `${Math.min(100, Math.max(0, factor.score))}%` as any,
                        backgroundColor:
                          factor.score > 70
                            ? Colors.error
                            : factor.score > 40
                            ? Colors.warning
                            : Colors.success,
                      },
                    ]}
                  />
                </View>
                <Text style={styles.factorScore}>{factor.score}</Text>
              </View>
            ))}
          </Accordion>
        )}

        {/* Loss run */}
        {dossier.loss_run && (
          <Accordion title="Loss run">
            {/* Summary */}
            <View style={styles.lossRunSummary}>
              {Object.entries(dossier.loss_run.summary).map(([k, v]) => (
                <View key={k} style={styles.lossRunCell}>
                  <Text style={styles.lossRunCellLabel}>{k.replace(/_/g, ' ').toUpperCase()}</Text>
                  <Text style={styles.lossRunCellValue}>
                    {typeof v === 'number' && k.includes('incurred')
                      ? fmtMoney(String(v), true)
                      : String(v)}
                  </Text>
                </View>
              ))}
            </View>
            {/* By coverage line */}
            {Array.isArray(dossier.loss_run.by_coverage_line) &&
              dossier.loss_run.by_coverage_line.length > 0 && (
                <View style={styles.lossRunTable}>
                  <View style={[styles.lossRunTableRow, styles.lossRunTableHeader]}>
                    <Text style={[styles.lossRunTableCell, styles.lossRunTableHeaderText, { flex: 2 }]}>
                      LINE
                    </Text>
                    <Text style={[styles.lossRunTableCell, styles.lossRunTableHeaderText]}>CLAIMS</Text>
                    <Text style={[styles.lossRunTableCell, styles.lossRunTableHeaderText]}>INCURRED</Text>
                  </View>
                  {dossier.loss_run.by_coverage_line.map((row: Record<string, unknown>, i: number) => (
                    <View key={i} style={styles.lossRunTableRow}>
                      <Text style={[styles.lossRunTableCell, { flex: 2 }]} numberOfLines={1}>
                        {lineLabel(String(row.coverage_line ?? row.line ?? ''))}
                      </Text>
                      <Text style={[styles.lossRunTableCell, styles.lossRunMono]}>
                        {String(row.claim_count ?? row.claims ?? '—')}
                      </Text>
                      <Text style={[styles.lossRunTableCell, styles.lossRunMono]}>
                        {fmtMoney(String(row.total_incurred ?? row.incurred ?? ''), true)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
          </Accordion>
        )}

        {/* Incidents */}
        {dossier.incidents.recent.length > 0 && (
          <Accordion title={`Recent incidents (${dossier.incidents.recent.length})`}>
            {dossier.incidents.recent.map((inc) => (
              <View key={inc.id} style={styles.incidentCard}>
                <Text style={styles.incidentSummary}>{inc.summary}</Text>
                <Text style={styles.incidentDate}>
                  {new Date(inc.occurred_at).toLocaleDateString()}
                </Text>
              </View>
            ))}
          </Accordion>
        )}

        {/* Compliance open items */}
        {dossier.compliance.open_items.length > 0 && (
          <Accordion
            title={`Compliance — open items (${dossier.compliance.open_items.length})`}
          >
            {dossier.compliance.open_items.map((item, i) => (
              <View key={i} style={styles.complianceItemRow}>
                <Chip
                  label={item.severity.toUpperCase()}
                  color={severityColor(item.severity)}
                />
                <Text style={styles.complianceItemTitle}>{item.title}</Text>
              </View>
            ))}
          </Accordion>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: 20, paddingBottom: 60 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.bg,
    padding: 32,
  },

  backBtn: { marginBottom: 10 },
  backText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 14 },

  // Header
  header: { marginBottom: 14 },
  eyebrow: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: {
    fontFamily: Fonts.displayBold,
    fontSize: 26,
    color: Colors.text,
    letterSpacing: -0.5,
    flex: 1,
    marginRight: 8,
  },
  subtitle: {
    color: Colors.textSecondary,
    fontFamily: Fonts.sansRegular,
    fontSize: 13,
    marginTop: 6,
    lineHeight: 18,
  },

  // KPI band
  kpiBand: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    padding: 12,
    marginBottom: 14,
    gap: 12,
  },
  kpiCell: { minWidth: 80, flex: 1, alignItems: 'flex-start' },
  kpiLabel: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1.2,
    color: Colors.textMuted,
    marginBottom: 4,
  },
  kpiValue: {
    fontFamily: Fonts.monoBold,
    fontSize: 13,
    color: Colors.text,
  },
  kpiWarn: { color: Colors.warning },
  kpiSub: { fontFamily: Fonts.monoRegular, fontSize: 10, marginTop: 2 },
  kpiMoney: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.accentInk },

  // Tier pill (in KPI band)
  tierPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  tierText: { fontFamily: Fonts.monoBold, fontSize: 11 },

  // Cards
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    padding: 16,
    marginBottom: 14,
  },
  cardLabel: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.4,
    color: Colors.textSecondary,
    marginBottom: 12,
  },

  // Suggested premium rows
  lineRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 8,
  },
  lineName: { fontFamily: Fonts.sansMedium, fontSize: 14, color: Colors.text },
  lineMoney: { fontFamily: Fonts.monoRegular, fontSize: 14, color: Colors.text },
  feeLabel: {
    fontFamily: Fonts.sansRegular,
    fontSize: 12,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSubtle,
    paddingTop: 8,
  },
  totalLabel: { fontFamily: Fonts.monoBold, fontSize: 11, letterSpacing: 1, color: Colors.textSecondary },
  totalMoney: { fontFamily: Fonts.monoBold, fontSize: 17, color: Colors.accentInk },
  hint: { color: Colors.textMuted, fontFamily: Fonts.sansRegular, fontSize: 11, marginTop: 8, lineHeight: 15 },

  // Coverage terms sections
  lineTermsGroup: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSubtle,
    paddingTop: 10,
    marginBottom: 6,
  },
  lineTermsHeader: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1.2,
    color: Colors.textSecondary,
    marginBottom: 8,
  },
  termsSection: { marginBottom: 12 },
  termsSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  termsSectionTitle: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1.2,
    color: Colors.textSecondary,
  },
  noneText: { color: Colors.textMuted, fontFamily: Fonts.sansRegular, fontSize: 12 },

  addBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.accentInk,
    minHeight: 30,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: { color: Colors.accentInk, fontFamily: Fonts.sansBold, fontSize: 12 },

  removeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignSelf: 'flex-start',
    marginTop: 6,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: { color: Colors.error, fontSize: 18, fontFamily: Fonts.sansBold },

  // Subjectivities
  subjectivityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  subjectivityChips: { flexDirection: 'column', gap: 4, marginTop: 26 },
  subChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 4,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subChipText: { fontFamily: Fonts.monoBold, fontSize: 9, letterSpacing: 0.8 },

  // Schedule mods
  scheduleModRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  kindRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  kindChip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 36,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kindChipText: { fontFamily: Fonts.monoBold, fontSize: 11 },

  listItemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },

  // Action buttons
  btnPrimary: {
    paddingVertical: 13,
    borderRadius: 8,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    minHeight: 44,
  },
  btnPrimaryText: { color: Colors.text, fontFamily: Fonts.sansBold, fontSize: 15 },
  actionHint: {
    color: Colors.textSecondary,
    fontFamily: Fonts.sansRegular,
    fontSize: 11,
    marginTop: 6,
    lineHeight: 15,
  },
  orRule: {
    textAlign: 'center',
    color: Colors.textMuted,
    fontFamily: Fonts.monoBold,
    fontSize: 11,
    letterSpacing: 2,
    marginVertical: 16,
  },
  btnDecline: {
    paddingVertical: 13,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.error,
    alignItems: 'center',
    minHeight: 44,
  },
  btnDeclineText: { color: Colors.error, fontFamily: Fonts.sansBold, fontSize: 15 },
  btnInfo: {
    paddingVertical: 13,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.borderSubtle,
    alignItems: 'center',
    minHeight: 44,
  },
  btnInfoText: { color: Colors.textSecondary, fontFamily: Fonts.sansBold, fontSize: 15 },
  btnDisabled: { opacity: 0.45 },

  errorBox: {
    backgroundColor: 'rgba(200,52,30,0.07)',
    borderColor: Colors.error,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    marginTop: 14,
  },
  errorText: { color: Colors.error, fontFamily: Fonts.sansMedium, fontSize: 13 },
  footnote: {
    color: Colors.textMuted,
    fontFamily: Fonts.sansRegular,
    fontSize: 11,
    marginTop: 14,
    fontStyle: 'italic',
    lineHeight: 15,
  },

  // Dossier accordions — risk factors
  factorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  factorName: {
    flex: 2,
    fontFamily: Fonts.sansRegular,
    fontSize: 12,
    color: Colors.text,
  },
  factorWeight: {
    fontFamily: Fonts.monoRegular,
    fontSize: 10,
    color: Colors.textSecondary,
    width: 44,
    textAlign: 'right',
  },
  factorBarWrap: {
    flex: 1,
    height: 6,
    backgroundColor: Colors.borderSubtle,
    borderRadius: 3,
    overflow: 'hidden',
  },
  factorBarFill: { height: '100%', borderRadius: 3 },
  factorScore: {
    fontFamily: Fonts.monoBold,
    fontSize: 12,
    color: Colors.text,
    width: 28,
    textAlign: 'right',
  },

  // Loss run
  lossRunSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 12,
  },
  lossRunCell: {},
  lossRunCellLabel: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1,
    color: Colors.textMuted,
    marginBottom: 2,
  },
  lossRunCellValue: { fontFamily: Fonts.monoBold, fontSize: 13, color: Colors.text },
  lossRunTable: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSubtle,
    paddingTop: 6,
  },
  lossRunTableRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSubtle,
  },
  lossRunTableHeader: {},
  lossRunTableHeaderText: {
    fontFamily: Fonts.monoBold,
    fontSize: 9,
    letterSpacing: 1,
    color: Colors.textSecondary,
  },
  lossRunTableCell: { flex: 1, fontFamily: Fonts.sansRegular, fontSize: 12, color: Colors.text },
  lossRunMono: { fontFamily: Fonts.monoRegular, textAlign: 'right' },

  // Incidents
  incidentCard: {
    backgroundColor: Colors.bgDeep,
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  incidentSummary: { fontFamily: Fonts.sansMedium, fontSize: 13, color: Colors.text, marginBottom: 2 },
  incidentDate: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted },

  // Compliance items
  complianceItemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 8,
  },
  complianceItemTitle: {
    flex: 1,
    fontFamily: Fonts.sansRegular,
    fontSize: 13,
    color: Colors.text,
    lineHeight: 18,
  },

  // Empty / not-found states
  emptyText: {
    color: Colors.textSecondary,
    textAlign: 'center',
    fontFamily: Fonts.sansRegular,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 16,
  },
  retryBtn: {
    borderColor: Colors.accent,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
