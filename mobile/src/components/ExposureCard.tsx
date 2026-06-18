import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Colors } from '../theme/colors';
import { fetchExposure, type Finding } from '../api/intelligence';

/**
 * "What needs your attention" — the deterministic exposure feed, ported to the
 * RN operator dashboard (parity with the web ExposurePanel / MobileExposure).
 * Self-fetches, sorts critical→low, severity filter chips, self-hides on
 * empty/error.
 *
 * Navigation is host-owned: the screen passes `onSelectFinding` (RN routes
 * differ per stack, so the shared component can't hardcode them). A row is
 * tappable — and shows the "→" affordance — only when the host says it can
 * route that finding (`canNavigate`); otherwise it stays honest static text.
 */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
type Severity = (typeof SEVERITY_ORDER)[number];
type SeverityFilter = 'all' | Severity;

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const SEVERITY_WEIGHT: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_COLOR: Record<string, string> = {
  critical: Colors.error,
  high: Colors.error,
  medium: Colors.warning,
  low: Colors.accentInk,
};
const MAX_ROWS = 8;

interface ExposureCardProps {
  /** Host-owned navigation for a tapped finding (routes differ per stack). */
  onSelectFinding?: (f: Finding) => void;
  /** Whether the host can route this finding; gates the tap + "→" affordance. */
  canNavigate?: (f: Finding) => boolean;
}

export function ExposureCard({ onSelectFinding, canNavigate }: ExposureCardProps = {}) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<SeverityFilter>('all');

  useEffect(() => {
    let active = true;
    fetchExposure()
      .then((r) => active && setFindings(r.findings))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);

  const sorted = useMemo(
    () =>
      findings
        ? [...findings].sort((a, b) => (SEVERITY_WEIGHT[a.severity] ?? 9) - (SEVERITY_WEIGHT[b.severity] ?? 9))
        : [],
    [findings],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: sorted.length, critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of sorted) c[f.severity] = (c[f.severity] ?? 0) + 1;
    return c;
  }, [sorted]);
  const visible = filter === 'all' ? sorted : sorted.filter((f) => f.severity === filter);

  if (error || findings === null || sorted.length === 0) return null;

  const urgent = counts.critical + counts.high;
  const rows = visible.slice(0, MAX_ROWS);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>WHAT NEEDS YOUR ATTENTION</Text>
        <Text style={styles.kpi}>
          {counts.all} open{urgent > 0 ? ` · ${urgent} need eyes` : ''}
        </Text>
      </View>

      <View style={styles.chips}>
        <Pressable style={[styles.chip, filter === 'all' && styles.chipActive]} onPress={() => setFilter('all')}>
          <Text style={[styles.chipText, filter === 'all' && styles.chipTextActive]}>All · {counts.all}</Text>
        </Pressable>
        {SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => (
          <Pressable key={s} style={[styles.chip, filter === s && styles.chipActive]} onPress={() => setFilter(s)}>
            <Text style={[styles.chipText, filter === s && styles.chipTextActive]}>
              {SEVERITY_LABEL[s]} · {counts[s]}
            </Text>
          </Pressable>
        ))}
      </View>

      <View>
        {rows.map((f) => {
          const color = SEVERITY_COLOR[f.severity] ?? Colors.textMuted;
          const navigable = !!onSelectFinding && (canNavigate ? canNavigate(f) : true);
          const body = (
            <>
              <Text style={[styles.rowSev, { color }]}>{SEVERITY_LABEL[f.severity as Severity] ?? f.severity}</Text>
              <Text style={styles.rowSubject}>{f.subject.label || f.subject.entity_id}</Text>
              {!!f.why[0]?.excerpt && (
                <Text style={styles.rowWhy} numberOfLines={2}>
                  {f.why[0].excerpt}
                </Text>
              )}
              {/* The "→" affordance is shown only when the row actually routes. */}
              <Text style={styles.rowAction}>{f.recommended_action.label}{navigable ? ' →' : ''}</Text>
            </>
          );
          return navigable ? (
            <Pressable
              key={f.id}
              style={({ pressed }) => [styles.row, { borderLeftColor: color }, pressed && { opacity: 0.7 }]}
              onPress={() => onSelectFinding!(f)}
            >
              {body}
            </Pressable>
          ) : (
            <View key={f.id} style={[styles.row, { borderLeftColor: color }]}>{body}</View>
          );
        })}
      </View>
      {visible.length > MAX_ROWS && <Text style={styles.more}>+{visible.length - MAX_ROWS} more</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 12 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  kpi: { color: Colors.textSecondary, fontSize: 11, letterSpacing: 0.4, fontFamily: 'SpaceMono_400Regular' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, backgroundColor: Colors.bg },
  chipActive: { borderColor: Colors.accent, backgroundColor: Colors.accentWash },
  chipText: { color: Colors.textSecondary, fontSize: 11, fontWeight: '600', fontFamily: 'SpaceMono_400Regular' },
  chipTextActive: { color: Colors.accentInk, fontWeight: '700' },

  row: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderSubtle },
  rowSev: { fontSize: 10, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', fontFamily: 'SpaceMono_700Bold' },
  rowSubject: { color: Colors.text, fontSize: 14, fontWeight: '600', marginTop: 3, fontFamily: 'HankenGrotesk_600SemiBold' },
  rowWhy: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 4, marginBottom: 6, fontFamily: 'HankenGrotesk_400Regular' },
  rowAction: { color: Colors.accentInk, fontSize: 12, fontWeight: '600', fontFamily: 'HankenGrotesk_600SemiBold' },
  more: { color: Colors.textMuted, fontSize: 12, marginTop: 12, fontFamily: 'SpaceMono_400Regular' },
});
