import React, { useState } from 'react';
import { Colors } from "../theme/colors";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { OVERRIDE_REASON_LABELS, type OverrideReason } from '../types/claims';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSubmit: (input: {
    override_recommendation: boolean;
    override_reason: OverrideReason;
    override_freetext: string | null;
  }) => Promise<void>;
  recommenderVerdict: 'file' | 'do_not_file';
  submitting: boolean;
}

const REASONS = Object.keys(OVERRIDE_REASON_LABELS) as OverrideReason[];

export function ClaimProposeBottomSheet({
  visible,
  onClose,
  onSubmit,
  recommenderVerdict,
  submitting,
}: Props) {
  const [reason, setReason] = useState<OverrideReason>('additional_evidence');
  const [freetext, setFreetext] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (reason === 'other' && !freetext.trim()) {
      setError("'Other' requires a written explanation.");
      return;
    }
    setError(null);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await onSubmit({
      override_recommendation: true,
      override_reason: reason,
      override_freetext: freetext.trim() || null,
    });
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={s.handle} />

          <Text style={s.title}>
            {recommenderVerdict === 'do_not_file'
              ? 'Override recommendation'
              : 'Propose with reason'}
          </Text>
          <Text style={s.subtitle}>
            {recommenderVerdict === 'do_not_file'
              ? "The recommender suggested not filing. Tell the broker why you disagree."
              : "Add an optional structured reason for the broker."}
          </Text>

          <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
            {REASONS.map((key) => {
              const { title, hint } = OVERRIDE_REASON_LABELS[key];
              const selected = reason === key;
              return (
                <Pressable
                  key={key}
                  style={[s.option, selected && s.optionSelected]}
                  onPress={() => { setReason(key); setError(null); }}
                >
                  <View style={[s.radio, selected && s.radioSelected]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.optionTitle, selected && s.optionTitleSelected]}>{title}</Text>
                    <Text style={s.optionHint}>{hint}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          <Text style={s.label}>
            {reason === 'other' ? 'Explanation (required)' : 'Additional context (optional)'}
          </Text>
          <TextInput
            style={s.input}
            placeholder={
              reason === 'other'
                ? 'Why are you filing against the recommendation?'
                : 'Anything else for the broker? (optional)'
            }
            placeholderTextColor={Colors.textMuted}
            multiline
            numberOfLines={3}
            value={freetext}
            onChangeText={setFreetext}
            editable={!submitting}
          />

          {error && <Text style={s.error}>{error}</Text>}

          <View style={s.row}>
            <Pressable
              style={[s.btn, s.btnPrimary, submitting && s.btnDisabled]}
              onPress={handleSubmit}
              disabled={submitting}
            >
              <Text style={s.btnPrimaryText}>{submitting ? 'Submitting…' : 'Submit proposal'}</Text>
            </Pressable>
            <Pressable style={s.btnGhost} onPress={onClose} disabled={submitting}>
              <Text style={s.btnGhostText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderColor: Colors.warning,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    color: Colors.text,
    fontSize: 16,
    fontFamily: 'DMSans_600SemiBold',
    marginBottom: 6,
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: 'DMSans_400Regular',
    marginBottom: 16,
    lineHeight: 18,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.borderSubtle,
    marginBottom: 8,
  },
  optionSelected: {
    borderColor: Colors.accent,
    backgroundColor: 'rgba(200,240,0,0.05)',
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: Colors.textMuted,
    marginTop: 2,
  },
  radioSelected: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accent,
  },
  optionTitle: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: 'DMSans_600SemiBold',
  },
  optionTitleSelected: { color: Colors.text },
  optionHint: {
    color: Colors.textMuted,
    fontSize: 12,
    fontFamily: 'DMSans_400Regular',
    marginTop: 2,
  },
  label: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontFamily: 'DMSans_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 12,
    marginBottom: 6,
  },
  input: {
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.borderSubtle,
    borderRadius: 10,
    color: Colors.text,
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
    padding: 12,
    minHeight: 72,
    textAlignVertical: 'top',
  },
  error: {
    color: Colors.error,
    fontSize: 12,
    fontFamily: 'DMSans_400Regular',
    marginTop: 6,
  },
  row: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnPrimary: { backgroundColor: Colors.accent },
  btnDisabled: { opacity: 0.5 },
  btnPrimaryText: { color: Colors.text, fontFamily: 'DMSans_700Bold', fontSize: 14 },
  btnGhost: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  btnGhostText: { color: Colors.textSecondary, fontFamily: 'DMSans_400Regular', fontSize: 14 },
});
