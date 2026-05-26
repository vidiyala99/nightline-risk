/**
 * Record payment — bottom-sheet form. Supports indemnity / expense / recovery.
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
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { claimsApi } from '../api/claims';
import { PAYMENT_TYPE_LABEL, type PaymentType } from '../api/claim-tokens';
import { Fonts } from '../theme/typography';

import { Field } from './RecordReserveScreen';

const TYPES: PaymentType[] = ['indemnity', 'expense', 'recovery'];

export function RecordPaymentScreen({ route, navigation }: any) {
  const { cid, onSuccess } = route.params as { cid: string; onSuccess?: () => void };

  const [paymentType, setPaymentType] = useState<PaymentType>('indemnity');
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setError(null);
    const n = parseFloat(amount);
    if (!amount || Number.isNaN(n) || n <= 0) {
      setError('Amount must be greater than zero.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
      setError('Paid on must be a date in YYYY-MM-DD format.');
      return;
    }
    setSubmitting(true);
    try {
      await claimsApi.recordPayment(cid, {
        amount,
        payment_type: paymentType,
        paid_on: paidOn,
        description: description.trim(),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSuccess?.();
      navigation.goBack();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to record payment.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.eyebrow}>RECORD PAYMENT</Text>
          <Text style={styles.title}>Payment</Text>
          <Text style={styles.subtitle}>
            Indemnity to claimant, expense to defense, or a recovery (subrogation / salvage).
          </Text>
        </View>

        <View style={typeStyles.wrap}>
          <Text style={typeStyles.label}>
            Type <Text style={typeStyles.required}>*</Text>
          </Text>
          <View style={typeStyles.row}>
            {TYPES.map((t) => {
              const active = paymentType === t;
              return (
                <Pressable
                  key={t}
                  onPress={() => setPaymentType(t)}
                  style={[typeStyles.chip, active && typeStyles.chipActive]}
                >
                  <Text style={[typeStyles.chipText, active && typeStyles.chipTextActive]}>
                    {PAYMENT_TYPE_LABEL[t]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={typeStyles.hint}>
            Recoveries (subrogation, salvage) are stored positive and subtracted from total
            incurred at close.
          </Text>
        </View>

        <Field
          label="Amount"
          required
          value={amount}
          onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))}
          placeholder="5000.00"
          keyboardType="decimal-pad"
          mono
          prefix="$"
          suffix="USD"
        />
        <Field
          label="Paid on"
          required
          value={paidOn}
          onChangeText={setPaidOn}
          placeholder="YYYY-MM-DD"
          hint="The date funds moved. ISO date format."
        />
        <Field
          label="Description"
          value={description}
          onChangeText={setDescription}
          placeholder="settlement to claimant, defense counsel invoice…"
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
            <Text style={styles.btnPrimaryText}>{submitting ? 'Recording…' : 'Record payment'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const typeStyles = StyleSheet.create({
  wrap: { marginBottom: 14 },
  label: { color: Colors.text, fontFamily: Fonts.sansSemiBold, fontSize: 13, marginBottom: 6 },
  required: { color: Colors.accentInk },
  row: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(23,21,15,0.14)',
    alignItems: 'center',
  },
  chipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(200,240,0,0.06)' },
  chipText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 13 },
  chipTextActive: { color: Colors.accentInk },
  hint: { color: Colors.textMuted, fontFamily: Fonts.sansRegular, fontSize: 11, marginTop: 6, lineHeight: 15 },
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
  btnPrimaryText: { color: Colors.bg, fontFamily: Fonts.sansBold },
});
