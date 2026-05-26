import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';

/**
 * Single-field text prompt. ThemedAlert is confirm-only, so reason/number
 * inputs (decline, withdraw, cancel, assign policy #) use this instead of
 * the iOS-only Alert.prompt. Controlled by the caller via `visible`.
 */
export function PromptModal({
  visible,
  title,
  message,
  placeholder,
  initialValue = '',
  confirmLabel = 'Confirm',
  required = true,
  onSubmit,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  required?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  const trimmed = value.trim();
  const canSubmit = required ? trimmed.length > 0 : true;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>{title}</Text>
          {!!message && <Text style={styles.message}>{message}</Text>}
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor={Colors.textMuted}
            autoFocus
            multiline
          />
          <View style={styles.buttonRow}>
            <Pressable style={[styles.btn, styles.btnCancel]} onPress={onCancel}>
              <Text style={styles.btnCancelLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, styles.btnConfirm, !canSubmit && styles.btnDisabled]}
              disabled={!canSubmit}
              onPress={() => onSubmit(trimmed)}
            >
              <Text style={styles.btnConfirmLabel}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(7, 8, 15, 0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderSubtle,
    borderRadius: 16,
    paddingHorizontal: 22,
    paddingVertical: 22,
    gap: 8,
  },
  title: {
    color: Colors.text,
    fontSize: 20,
    letterSpacing: -0.3,
    fontFamily: Fonts.displayBold,
  },
  message: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: Fonts.sansRegular,
    marginTop: 2,
  },
  input: {
    marginTop: 12,
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: Colors.text,
    fontFamily: Fonts.sansRegular,
    fontSize: 14,
    backgroundColor: Colors.bg,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 16,
  },
  btn: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    minWidth: 90,
    alignItems: 'center',
  },
  btnCancel: { backgroundColor: 'transparent', borderColor: 'rgba(23,21,15,0.14)' },
  btnCancelLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    letterSpacing: 1,
    fontFamily: Fonts.monoBold,
  },
  btnConfirm: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  btnConfirmLabel: {
    color: Colors.text,
    fontSize: 12,
    letterSpacing: 1,
    fontFamily: Fonts.monoBold,
  },
  btnDisabled: { opacity: 0.4 },
});
