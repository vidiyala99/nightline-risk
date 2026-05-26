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

import {
  PolicyRequestType,
  REQUEST_TYPE_HINT,
  REQUEST_TYPE_LABEL,
  type CoveragePolicy,
  type CreatePolicyRequestBody,
} from '../api/policyRequests';

const TYPES: PolicyRequestType[] = ['renewal', 'cancellation', 'coi', 'coverage_change'];

interface Props {
  visible: boolean;
  policy: CoveragePolicy | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (body: CreatePolicyRequestBody) => Promise<void>;
}

/**
 * Operator "Request an action" bottom sheet. Mirrors ClaimProposeBottomSheet
 * styling. Collects request type + optional note + one type-specific field
 * (cancellation date / certificate holder), folded into payload.
 */
export function PolicyRequestSheet({ visible, policy, submitting, onClose, onSubmit }: Props) {
  const [type, setType] = useState<PolicyRequestType>('renewal');
  const [note, setNote] = useState('');
  const [extra, setExtra] = useState('');

  async function handleSubmit() {
    const payload: Record<string, unknown> = {};
    if (type === 'cancellation' && extra.trim()) payload.cancellation_date = extra.trim();
    if (type === 'coi' && extra.trim()) payload.certificate_holder = extra.trim();
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await onSubmit({ request_type: type, note: note.trim(), payload });
    setType('renewal');
    setNote('');
    setExtra('');
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={s.handle} />
          <Text style={s.title}>Request an action</Text>
          <Text style={s.subtitle}>{policy?.policy_number ?? policy?.id ?? ''}</Text>

          <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
            {TYPES.map((t) => {
              const selected = type === t;
              return (
                <Pressable
                  key={t}
                  style={[s.option, selected && s.optionSelected]}
                  onPress={() => { setType(t); setExtra(''); }}
                >
                  <View style={[s.radio, selected && s.radioSelected]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.optionTitle, selected && s.optionTitleSelected]}>
                      {REQUEST_TYPE_LABEL[t]}
                    </Text>
                    <Text style={s.optionHint}>{REQUEST_TYPE_HINT[t]}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          {(type === 'cancellation' || type === 'coi') && (
            <>
              <Text style={s.label}>
                {type === 'cancellation' ? 'Preferred cancellation date' : 'Certificate holder'}
              </Text>
              <TextInput
                style={s.inputLine}
                placeholder={type === 'cancellation' ? 'YYYY-MM-DD' : 'e.g. 123 Property LLC'}
                placeholderTextColor={Colors.textMuted}
                value={extra}
                onChangeText={setExtra}
                editable={!submitting}
                autoCapitalize={type === 'coi' ? 'words' : 'none'}
              />
            </>
          )}

          <Text style={s.label}>Note (optional)</Text>
          <TextInput
            style={s.input}
            placeholder="Anything your broker should know…"
            placeholderTextColor={Colors.textMuted}
            multiline
            numberOfLines={3}
            value={note}
            onChangeText={setNote}
            editable={!submitting}
          />

          <View style={s.row}>
            <Pressable
              style={[s.btn, s.btnPrimary, submitting && s.btnDisabled]}
              onPress={handleSubmit}
              disabled={submitting}
            >
              <Text style={s.btnPrimaryText}>{submitting ? 'Sending…' : 'Send request'}</Text>
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
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderColor: Colors.accent,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: 'center', marginBottom: 16 },
  title: { color: Colors.text, fontSize: 16, fontFamily: 'DMSans_600SemiBold', marginBottom: 4 },
  subtitle: { color: Colors.textSecondary, fontSize: 12, fontFamily: 'JetBrainsMono_400Regular', marginBottom: 14 },
  option: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 12,
    borderRadius: 10, borderWidth: 1, borderColor: Colors.borderSubtle, marginBottom: 8,
  },
  optionSelected: { borderColor: Colors.accent, backgroundColor: 'rgba(200,240,0,0.05)' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: Colors.textMuted, marginTop: 2 },
  radioSelected: { borderColor: Colors.accent, backgroundColor: Colors.accent },
  optionTitle: { color: Colors.textSecondary, fontSize: 13, fontFamily: 'DMSans_600SemiBold' },
  optionTitleSelected: { color: Colors.text },
  optionHint: { color: Colors.textMuted, fontSize: 12, fontFamily: 'DMSans_400Regular', marginTop: 2 },
  label: {
    color: Colors.textSecondary, fontSize: 11, fontFamily: 'DMSans_600SemiBold',
    textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 12, marginBottom: 6,
  },
  inputLine: {
    backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.borderSubtle,
    borderRadius: 10, color: Colors.text, fontFamily: 'DMSans_400Regular', fontSize: 13, padding: 12,
  },
  input: {
    backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.borderSubtle,
    borderRadius: 10, color: Colors.text, fontFamily: 'DMSans_400Regular', fontSize: 13,
    padding: 12, minHeight: 72, textAlignVertical: 'top',
  },
  row: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  btnPrimary: { backgroundColor: Colors.accent },
  btnDisabled: { opacity: 0.5 },
  btnPrimaryText: { color: Colors.text, fontFamily: 'DMSans_700Bold', fontSize: 14 },
  btnGhost: {
    paddingVertical: 14, paddingHorizontal: 20, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.border, alignItems: 'center',
  },
  btnGhostText: { color: Colors.textSecondary, fontFamily: 'DMSans_400Regular', fontSize: 14 },
});
