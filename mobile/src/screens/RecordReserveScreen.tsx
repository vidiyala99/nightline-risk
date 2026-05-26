/**
 * Record carrier reserve — bottom-sheet style form.
 *
 * Param contract:
 *   cid: string
 *   onSuccess: () => void   (called by parent on commit so it can refetch)
 */
import React, { useState } from 'react';
import { Colors } from "../theme/colors";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { claimsApi } from '../api/claims';
import { Fonts } from '../theme/typography';

export function RecordReserveScreen({ route, navigation }: any) {
  const { cid, onSuccess } = route.params as { cid: string; onSuccess?: () => void };

  const [reserve, setReserve] = useState('');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setError(null);
    if (!reserve || parseFloat(reserve) < 0) {
      setError("Enter the carrier's new reserve amount.");
      return;
    }
    if (!reason.trim() || !source.trim()) {
      setError('Reason and source are both required.');
      return;
    }
    setSubmitting(true);
    try {
      await claimsApi.recordCarrierReserve(cid, {
        new_reserve: reserve,
        change_reason: reason.trim(),
        received_from: source.trim(),
        received_at: new Date().toISOString(),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSuccess?.();
      navigation.goBack();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to record reserve.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.eyebrow}>RECORD RESERVE</Text>
          <Text style={styles.title}>Carrier reserve</Text>
          <Text style={styles.subtitle}>
            The carrier set or adjusted this claim's reserve. Record the new amount and source.
          </Text>
        </View>

        <Field
          label="New reserve"
          required
          value={reserve}
          onChangeText={(t) => setReserve(t.replace(/[^0-9.]/g, ''))}
          placeholder="25000.00"
          keyboardType="decimal-pad"
          mono
          prefix="$"
          suffix="USD"
        />
        <Field
          label="Reason"
          required
          value={reason}
          onChangeText={setReason}
          placeholder="initial reserve, post-investigation adjustment"
          hint="As communicated by the carrier or adjuster."
        />
        <Field
          label="Received from"
          required
          value={source}
          onChangeText={setSource}
          placeholder="Adjuster name or carrier letter ref"
        />

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.actions}>
          <Pressable onPress={() => navigation.goBack()} style={styles.btnGhost} disabled={submitting}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </Pressable>
          <Pressable onPress={submit} style={styles.btnPrimary} disabled={submitting}>
            <Text style={styles.btnPrimaryText}>{submitting ? 'Recording…' : 'Record reserve'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Field primitive (reused by RecordPaymentScreen + FileFnolScreen) ───

export function Field({
  label,
  required,
  value,
  onChangeText,
  placeholder,
  hint,
  keyboardType,
  mono,
  prefix,
  suffix,
  multiline,
  autoComplete,
}: {
  label: string;
  required?: boolean;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  hint?: string;
  keyboardType?: 'default' | 'decimal-pad' | 'email-address' | 'numeric';
  mono?: boolean;
  prefix?: string;
  suffix?: string;
  multiline?: boolean;
  autoComplete?: 'email' | 'name' | 'off';
}) {
  return (
    <View style={fieldStyles.field}>
      <Text style={fieldStyles.label}>
        {label}
        {required && <Text style={fieldStyles.required}> *</Text>}
      </Text>
      <View style={[fieldStyles.inputWrap, (prefix || suffix) && fieldStyles.inputWrapMoney]}>
        {prefix && <Text style={fieldStyles.prefix}>{prefix}</Text>}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={Colors.textMuted}
          keyboardType={keyboardType ?? 'default'}
          autoComplete={autoComplete}
          multiline={multiline}
          style={[
            fieldStyles.input,
            multiline && fieldStyles.inputMulti,
            mono && { fontFamily: Fonts.monoRegular, textAlign: 'right' },
            (prefix || suffix) && { textAlign: 'right' },
          ]}
        />
        {suffix && <Text style={fieldStyles.suffix}>{suffix}</Text>}
      </View>
      {hint && <Text style={fieldStyles.hint}>{hint}</Text>}
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  field: { marginBottom: 14 },
  label: { color: Colors.text, fontFamily: Fonts.sansSemiBold, fontSize: 13, marginBottom: 6 },
  required: { color: Colors.accentInk },
  inputWrap: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  inputWrapMoney: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  prefix: { color: Colors.textMuted, fontFamily: Fonts.monoRegular, fontSize: 14, marginRight: 4 },
  suffix: { color: Colors.textMuted, fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.2, marginLeft: 8 },
  input: {
    flex: 1,
    color: Colors.text,
    fontFamily: Fonts.sansRegular,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },
  hint: { color: Colors.textMuted, fontFamily: Fonts.sansRegular, fontSize: 11, marginTop: 4, lineHeight: 15 },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: 20, paddingBottom: 60 },
  header: { marginBottom: 18 },
  eyebrow: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: Colors.textSecondary,
    marginBottom: 6,
  },
  title: {
    fontFamily: Fonts.displayBold,
    fontSize: 28,
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: 6,
  },
  subtitle: { color: Colors.textSecondary, fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },

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
  btnGhost: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(23,21,15,0.16)',
  },
  btnGhostText: { color: Colors.text, fontFamily: Fonts.sansMedium },
  btnPrimary: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: Colors.accent,
  },
  btnPrimaryText: { color: Colors.text, fontFamily: Fonts.sansBold },
});
