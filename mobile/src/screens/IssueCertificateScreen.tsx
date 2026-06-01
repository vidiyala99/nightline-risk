/**
 * Issue certificate of insurance (COI) — mobile counterpart of the web
 * /policies/[pid]/certificates/new page.
 *
 * Optional "additional insured" toggle reveals the ISO scope select, mirroring
 * web. expires_on seeds from the policy expiration date passed in route params.
 */
import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { policiesApi } from '../api/policies';
import { Field } from './RecordReserveScreen';

type AiScope = 'ongoing_operations' | 'completed_operations' | 'single_event';

const SCOPE_OPTIONS: { value: AiScope; label: string }[] = [
  { value: 'ongoing_operations', label: 'Ongoing (CG 20 10)' },
  { value: 'completed_operations', label: 'Completed (CG 20 26)' },
  { value: 'single_event', label: 'Single event (CG 20 37)' },
];

export function IssueCertificateScreen({ route, navigation }: any) {
  const { pid, expirationDate } = route.params as { pid: string; expirationDate?: string };

  const [holder, setHolder] = useState('');
  const [holderAddress, setHolderAddress] = useState('');
  const [operations, setOperations] = useState('Operations of the named insured');
  const [expiresOn, setExpiresOn] = useState(expirationDate ?? '');
  const [additionalInsured, setAdditionalInsured] = useState(false);
  const [aiScope, setAiScope] = useState<AiScope>('ongoing_operations');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (!holder.trim() || !holderAddress.trim() || !operations.trim() || !expiresOn.trim()) {
      setError('Holder, address, operations, and expiry are all required.');
      return;
    }
    setBusy(true);
    try {
      await policiesApi.issueCertificate(pid, {
        certificate_holder: holder.trim(),
        certificate_holder_address: holderAddress.trim(),
        description_of_operations: operations.trim(),
        expires_on: expiresOn.trim(),
        additional_insured: additionalInsured,
        additional_insured_scope: additionalInsured ? aiScope : null,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to issue certificate.');
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.eyebrow}>POLICY · CERTIFICATE</Text>
          <Text style={styles.title}>Issue COI</Text>
          <Text style={styles.subtitle}>Certificate of insurance for a third party (landlord, event client).</Text>
        </View>

        <Field label="Certificate holder" required value={holder} onChangeText={setHolder} placeholder="599 Johnson LLC" />
        <Field
          label="Holder address"
          required
          value={holderAddress}
          onChangeText={setHolderAddress}
          placeholder="599 Johnson Ave, Brooklyn, NY 11237"
        />
        <Field
          label="Description of operations"
          required
          value={operations}
          onChangeText={setOperations}
          multiline
        />
        <Field label="Expires on" required value={expiresOn} onChangeText={setExpiresOn} placeholder="YYYY-MM-DD" mono />

        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.switchLabel}>Add holder as additional insured</Text>
            <Text style={styles.switchHint}>Names the holder on the policy via an ISO endorsement.</Text>
          </View>
          <Switch
            value={additionalInsured}
            onValueChange={setAdditionalInsured}
            trackColor={{ false: Colors.borderSubtle, true: Colors.accent }}
            thumbColor={Colors.surface}
          />
        </View>

        {additionalInsured && (
          <View style={styles.selectWrap}>
            <Text style={styles.selectLabel}>Additional insured scope</Text>
            <View style={styles.chipRow}>
              {SCOPE_OPTIONS.map((o) => {
                const active = o.value === aiScope;
                return (
                  <Pressable
                    key={o.value}
                    onPress={() => setAiScope(o.value)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{o.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

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
            <Text style={styles.btnPrimaryText}>{busy ? 'Issuing…' : 'Issue certificate'}</Text>
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

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  switchText: { flex: 1 },
  switchLabel: { color: Colors.text, fontFamily: Fonts.sansSemiBold, fontSize: 13 },
  switchHint: { color: Colors.textMuted, fontFamily: Fonts.sansRegular, fontSize: 11, marginTop: 2, lineHeight: 15 },

  selectWrap: { marginBottom: 14 },
  selectLabel: { color: Colors.text, fontFamily: Fonts.sansSemiBold, fontSize: 13, marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 100, borderWidth: 1, borderColor: Colors.borderSubtle },
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
