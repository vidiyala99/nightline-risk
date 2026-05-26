/**
 * New submission — mobile counterpart to /submissions/new.
 *
 * Single-step form: pick a venue (from the broker's real venues), an
 * effective date, coverage lines, and optional notes. On create we drop
 * straight into the new submission's detail to pick carriers next.
 *
 * Coverage lines mirror the seeded CoverageLine table (no /api/coverage-lines
 * endpoint yet), matching frontend/src/app/submissions/new.
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
  TextInput,
  View,
} from 'react-native';

import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { api } from '../api/client';
import { submissionsApi } from '../api/submissions';
import { Field } from './RecordReserveScreen';

const COVERAGE_LINE_OPTIONS = [
  { id: 'gl', name: 'General Liability', required: true },
  { id: 'liquor', name: 'Liquor Liability', required: true },
  { id: 'assault_battery', name: 'Assault & Battery', required: false },
  { id: 'property', name: 'Property', required: false },
  { id: 'wc', name: 'Workers Comp', required: true },
  { id: 'epli', name: 'EPLI', required: false },
  { id: 'cyber', name: 'Cyber', required: false },
  { id: 'umbrella', name: 'Umbrella', required: false },
];

interface VenueLite {
  id: string;
  name: string;
  venue_type?: string;
}

function plus60Iso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 60);
  return d.toISOString().slice(0, 10);
}

export function NewSubmissionScreen({ navigation }: any) {
  const [venues, setVenues] = useState<VenueLite[] | null>(null);
  const [query, setQuery] = useState('');
  const [venueId, setVenueId] = useState<string | null>(null);
  const [effectiveDate, setEffectiveDate] = useState(plus60Iso);
  const [lines, setLines] = useState<Set<string>>(
    new Set(COVERAGE_LINE_OPTIONS.filter((l) => l.required).map((l) => l.id)),
  );
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .request<VenueLite[]>('/api/venues')
      .then((d) => setVenues(Array.isArray(d) ? d : []))
      .catch(() => setVenues([]));
  }, []);

  const filtered = useMemo(() => {
    const list = venues ?? [];
    const q = query.trim().toLowerCase();
    const matched = q
      ? list.filter((v) => v.name.toLowerCase().includes(q) || v.id.toLowerCase().includes(q))
      : list;
    return matched.slice(0, 40);
  }, [venues, query]);

  const toggleLine = (id: string) =>
    setLines((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const submit = useCallback(async () => {
    setError(null);
    if (!venueId) {
      setError('Pick a venue.');
      return;
    }
    if (lines.size === 0) {
      setError('Select at least one coverage line.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
      setError('Effective date must be YYYY-MM-DD.');
      return;
    }
    setBusy(true);
    try {
      const sub = await submissionsApi.create({
        venue_id: venueId,
        effective_date: effectiveDate,
        coverage_lines: [...lines],
        notes: notes.trim() || undefined,
      });
      navigation.replace('SubmissionDetail', { sid: sub.id });
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create submission.');
    } finally {
      setBusy(false);
    }
  }, [venueId, lines, effectiveDate, notes, navigation]);

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={styles.back}>← Submissions</Text>
        </Pressable>
        <Text style={styles.eyebrow}>BROKER · PLACEMENT</Text>
        <Text style={styles.title}>New submission</Text>

        <Text style={styles.section}>VENUE</Text>
        <View style={styles.searchWrap}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search venues…"
            placeholderTextColor={Colors.textMuted}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>
        {venues === null ? (
          <ActivityIndicator color={Colors.accentInk} style={{ marginVertical: 16 }} />
        ) : (
          <View style={styles.venueList}>
            {filtered.map((v) => {
              const on = venueId === v.id;
              return (
                <Pressable
                  key={v.id}
                  style={[styles.venueRow, on && styles.venueRowOn]}
                  onPress={() => setVenueId(v.id)}
                >
                  <View style={[styles.radio, on && styles.radioOn]}>{on && <View style={styles.radioDot} />}</View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.venueName} numberOfLines={1}>{v.name}</Text>
                    {!!v.venue_type && <Text style={styles.venueMeta}>{v.venue_type.toUpperCase()}</Text>}
                  </View>
                </Pressable>
              );
            })}
            {filtered.length === 0 && <Text style={styles.muted}>No venues match.</Text>}
          </View>
        )}

        <Field
          label="Effective date"
          required
          value={effectiveDate}
          onChangeText={setEffectiveDate}
          placeholder="YYYY-MM-DD"
          hint="Typical broker lead time is ~60 days out."
        />

        <Text style={styles.section}>COVERAGE LINES</Text>
        <View style={styles.chipsRow}>
          {COVERAGE_LINE_OPTIONS.map((l) => {
            const on = lines.has(l.id);
            return (
              <Pressable
                key={l.id}
                onPress={() => toggleLine(l.id)}
                style={[styles.chip, on && styles.chipActive]}
              >
                <Text style={[styles.chipText, on && styles.chipTextActive]}>{l.name}</Text>
              </Pressable>
            );
          })}
        </View>

        <Field
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Optional context for the file"
        />

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.actions}>
          <Pressable onPress={() => navigation.goBack()} style={styles.btnGhost} disabled={busy}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </Pressable>
          <Pressable onPress={submit} style={[styles.btnPrimary, busy && styles.btnDisabled]} disabled={busy}>
            <Text style={styles.btnPrimaryText}>{busy ? 'Creating…' : 'Create submission'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: 20, paddingBottom: 80 },
  back: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 13, marginBottom: 8 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.6, color: Colors.textSecondary, marginBottom: 4 },
  title: { fontFamily: Fonts.displayBold, fontSize: 32, color: Colors.text, letterSpacing: -0.5, marginBottom: 6 },

  section: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: Colors.textSecondary,
    marginTop: 18,
    marginBottom: 10,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSubtle,
  },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  searchIcon: { color: Colors.textMuted, fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, paddingVertical: 10, color: Colors.text, fontFamily: Fonts.sansRegular, fontSize: 14 },

  venueList: { gap: 6 },
  venueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
  },
  venueRowOn: { borderColor: Colors.accent },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: Colors.accent },
  radioDot: { width: 10, height: 10, borderRadius: 999, backgroundColor: Colors.accent },
  venueName: { fontFamily: Fonts.sansSemiBold, fontSize: 14, color: Colors.text },
  venueMeta: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted, marginTop: 1 },
  muted: { color: Colors.textMuted, fontFamily: Fonts.sansRegular, fontSize: 13, paddingVertical: 8 },

  chipsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chipActive: { borderColor: Colors.accent, backgroundColor: Colors.accentWash },
  chipText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12 },
  chipTextActive: { color: Colors.accentInk },

  errorBox: {
    borderColor: Colors.error,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    marginTop: 14,
  },
  errorText: { color: Colors.error, fontFamily: Fonts.sansMedium, fontSize: 13 },

  actions: { flexDirection: 'row', gap: 8, marginTop: 18, justifyContent: 'flex-end' },
  btnGhost: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: Colors.border },
  btnGhostText: { color: Colors.text, fontFamily: Fonts.sansMedium },
  btnPrimary: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 8, backgroundColor: Colors.accent },
  btnPrimaryText: { color: Colors.bg, fontFamily: Fonts.sansBold },
  btnDisabled: { opacity: 0.4 },
});
