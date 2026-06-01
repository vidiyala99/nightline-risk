/**
 * Endorse policy — mid-term change authoring (mobile counterpart of the web
 * /policies/[pid]/endorse page).
 *
 * The endorsement_type chip-select drives which payload-specific fields show,
 * exactly like web. Each type maps to a terms_diff shape the backend
 * re-validates (app/schemas/policy.py). Re-hashes the policy snapshot.
 */
import React, { useState } from 'react';
import {
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
import { policiesApi } from '../api/policies';
import { Field } from './RecordReserveScreen';

type EndorsementType =
  | 'change_limit'
  | 'add_insured'
  | 'add_coverage'
  | 'remove_coverage'
  | 'add_location'
  | 'change_class'
  | 'correction';

const TYPE_OPTIONS: { value: EndorsementType; label: string }[] = [
  { value: 'change_limit', label: 'Change limit' },
  { value: 'add_insured', label: 'Add insured' },
  { value: 'add_coverage', label: 'Add coverage' },
  { value: 'remove_coverage', label: 'Remove coverage' },
  { value: 'add_location', label: 'Add location' },
  { value: 'change_class', label: 'Change class' },
  { value: 'correction', label: 'Correction' },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Chip-row select — mobile stand-in for web's <select>. */
function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.selectWrap}>
      <Text style={styles.selectLabel}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onChange(o.value)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function EndorsePolicyScreen({ route, navigation }: any) {
  const pid: string = route.params.pid;

  const [endorsementType, setEndorsementType] = useState<EndorsementType>('change_limit');
  const [effectiveDate, setEffectiveDate] = useState(todayIso);
  const [description, setDescription] = useState('');
  const [premiumChange, setPremiumChange] = useState('0.00');
  const [taxChange, setTaxChange] = useState('0.00');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Per-type fields (mirror web state names).
  const [coverageLine, setCoverageLine] = useState('gl');
  const [limitField, setLimitField] = useState<'per_occurrence' | 'aggregate' | 'deductible'>('per_occurrence');
  const [limitBefore, setLimitBefore] = useState('1000000');
  const [limitAfter, setLimitAfter] = useState('2000000');
  const [insuredName, setInsuredName] = useState('');
  const [insuredAddress, setInsuredAddress] = useState('');
  const [relationship, setRelationship] = useState<'landlord' | 'event_client' | 'contract_counterparty'>('landlord');
  const [aiScope, setAiScope] = useState<'ongoing_operations' | 'completed_operations' | 'single_event'>('ongoing_operations');
  const [perOccLimit, setPerOccLimit] = useState('1000000');
  const [aggLimit, setAggLimit] = useState('2000000');
  const [deductible, setDeductible] = useState('2500');
  const [reason, setReason] = useState('');
  const [locationName, setLocationName] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  const [venueType, setVenueType] = useState('music_venue');
  const [beforeClass, setBeforeClass] = useState('');
  const [afterClass, setAfterClass] = useState('');
  const [fieldCorrected, setFieldCorrected] = useState('');
  const [valueBefore, setValueBefore] = useState('');
  const [valueAfter, setValueAfter] = useState('');
  const [explanation, setExplanation] = useState('');

  const buildTermsDiff = (): Record<string, unknown> => {
    switch (endorsementType) {
      case 'change_limit':
        return { coverage_line: coverageLine, field: limitField, before: limitBefore, after: limitAfter };
      case 'add_insured':
        return { insured_name: insuredName, insured_address: insuredAddress, relationship, scope: aiScope };
      case 'add_coverage':
        return {
          coverage_line: coverageLine,
          per_occurrence_limit: perOccLimit,
          aggregate_limit: aggLimit || null,
          deductible,
        };
      case 'remove_coverage':
        return { coverage_line: coverageLine, reason };
      case 'add_location':
        return { location_name: locationName, location_address: locationAddress, venue_type: venueType };
      case 'change_class':
        return { coverage_line: coverageLine, before_class: beforeClass, after_class: afterClass, reason };
      case 'correction':
        return { field_corrected: fieldCorrected, before: valueBefore, after: valueAfter, explanation };
    }
  };

  async function submit() {
    setError(null);
    if (!effectiveDate.trim()) {
      setError('Effective date is required.');
      return;
    }
    setBusy(true);
    try {
      await policiesApi.issueEndorsement(pid, {
        endorsement_type: endorsementType,
        effective_date: effectiveDate.trim(),
        terms_diff: buildTermsDiff(),
        premium_change: premiumChange || '0.00',
        tax_change: taxChange || '0.00',
        description: description.trim(),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e: any) {
      setError(e?.message ?? 'Endorsement failed.');
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.eyebrow}>POLICY · ENDORSE</Text>
          <Text style={styles.title}>New endorsement</Text>
          <Text style={styles.subtitle}>Mid-term change. Re-hashes the policy snapshot.</Text>
        </View>

        <Select label="Endorsement type" value={endorsementType} options={TYPE_OPTIONS} onChange={setEndorsementType} />

        <Field
          label="Effective date"
          required
          value={effectiveDate}
          onChangeText={setEffectiveDate}
          placeholder="YYYY-MM-DD"
          mono
        />

        {/* Per-type field blocks (mirror web). */}
        {endorsementType === 'change_limit' && (
          <>
            <Field label="Coverage line" value={coverageLine} onChangeText={setCoverageLine} placeholder="gl" />
            <Select
              label="Field"
              value={limitField}
              options={[
                { value: 'per_occurrence', label: 'Per occurrence' },
                { value: 'aggregate', label: 'Aggregate' },
                { value: 'deductible', label: 'Deductible' },
              ]}
              onChange={setLimitField}
            />
            <Field label="Before" value={limitBefore} onChangeText={setLimitBefore} keyboardType="numeric" mono />
            <Field label="After" value={limitAfter} onChangeText={setLimitAfter} keyboardType="numeric" mono />
          </>
        )}

        {endorsementType === 'add_insured' && (
          <>
            <Field label="Insured name" required value={insuredName} onChangeText={setInsuredName} placeholder="599 Johnson LLC" />
            <Field label="Insured address" required value={insuredAddress} onChangeText={setInsuredAddress} placeholder="599 Johnson Ave, Brooklyn, NY" />
            <Select
              label="Relationship"
              value={relationship}
              options={[
                { value: 'landlord', label: 'Landlord' },
                { value: 'event_client', label: 'Event client' },
                { value: 'contract_counterparty', label: 'Contract counterparty' },
              ]}
              onChange={setRelationship}
            />
            <Select
              label="Scope (ISO CG form)"
              value={aiScope}
              options={[
                { value: 'ongoing_operations', label: 'Ongoing (CG 20 10)' },
                { value: 'completed_operations', label: 'Completed (CG 20 26)' },
                { value: 'single_event', label: 'Single event (CG 20 37)' },
              ]}
              onChange={setAiScope}
            />
          </>
        )}

        {endorsementType === 'add_coverage' && (
          <>
            <Field label="Coverage line" value={coverageLine} onChangeText={setCoverageLine} placeholder="gl" />
            <Field label="Per-occurrence limit" value={perOccLimit} onChangeText={setPerOccLimit} keyboardType="numeric" mono />
            <Field label="Aggregate limit" hint="Blank for property." value={aggLimit} onChangeText={setAggLimit} keyboardType="numeric" mono />
            <Field label="Deductible" value={deductible} onChangeText={setDeductible} keyboardType="numeric" mono />
          </>
        )}

        {endorsementType === 'remove_coverage' && (
          <>
            <Field label="Coverage line" value={coverageLine} onChangeText={setCoverageLine} placeholder="gl" />
            <Field label="Reason" required value={reason} onChangeText={setReason} />
          </>
        )}

        {endorsementType === 'add_location' && (
          <>
            <Field label="Location name" required value={locationName} onChangeText={setLocationName} />
            <Field label="Address" required value={locationAddress} onChangeText={setLocationAddress} />
            <Field label="Venue type" value={venueType} onChangeText={setVenueType} placeholder="music_venue" />
          </>
        )}

        {endorsementType === 'change_class' && (
          <>
            <Field label="Coverage line" value={coverageLine} onChangeText={setCoverageLine} placeholder="gl" />
            <Field label="Before class" required value={beforeClass} onChangeText={setBeforeClass} />
            <Field label="After class" required value={afterClass} onChangeText={setAfterClass} />
            <Field label="Reason" required value={reason} onChangeText={setReason} />
          </>
        )}

        {endorsementType === 'correction' && (
          <>
            <Field label="Field corrected" required value={fieldCorrected} onChangeText={setFieldCorrected} />
            <Field label="Before" required value={valueBefore} onChangeText={setValueBefore} />
            <Field label="After" required value={valueAfter} onChangeText={setValueAfter} />
            <Field label="Explanation" required value={explanation} onChangeText={setExplanation} multiline />
          </>
        )}

        <Field
          label="Premium change"
          value={premiumChange}
          onChangeText={(t) => setPremiumChange(t.replace(/[^0-9.\-]/g, ''))}
          placeholder="0.00"
          hint="Signed; negative for refund."
          keyboardType="numeric"
          mono
          prefix="$"
          suffix="USD"
        />
        <Field
          label="Tax change"
          value={taxChange}
          onChangeText={(t) => setTaxChange(t.replace(/[^0-9.\-]/g, ''))}
          placeholder="0.00"
          hint="E&S only."
          keyboardType="numeric"
          mono
          prefix="$"
          suffix="USD"
        />
        <Field
          label="Description"
          value={description}
          onChangeText={setDescription}
          placeholder="Short description for the audit trail"
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
          <Pressable onPress={submit} style={styles.btnPrimary} disabled={busy}>
            <Text style={styles.btnPrimaryText}>{busy ? 'Issuing…' : 'Issue endorsement'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: 20, paddingBottom: 60 },
  header: { marginBottom: 18 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.6, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 28, color: Colors.text, letterSpacing: -0.5, marginBottom: 6 },
  subtitle: { color: Colors.textSecondary, fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },

  selectWrap: { marginBottom: 14 },
  selectLabel: { color: Colors.text, fontFamily: Fonts.sansSemiBold, fontSize: 13, marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: Colors.borderSubtle,
  },
  chipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(200,240,0,0.08)' },
  chipText: { color: Colors.textMuted, fontSize: 12, fontFamily: Fonts.sansSemiBold },
  chipTextActive: { color: Colors.accentInk },

  errorBox: {
    backgroundColor: 'rgba(255,69,87,0.08)',
    borderColor: Colors.error,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    marginTop: 6,
    marginBottom: 12,
  },
  errorText: { color: Colors.error, fontFamily: Fonts.sansMedium, fontSize: 13 },

  actions: { flexDirection: 'row', gap: 8, marginTop: 12, justifyContent: 'flex-end' },
  btnGhost: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(23,21,15,0.16)' },
  btnGhostText: { color: Colors.text, fontFamily: Fonts.sansMedium },
  btnPrimary: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 8, backgroundColor: Colors.accent },
  btnPrimaryText: { color: Colors.text, fontFamily: Fonts.sansBold },
});
