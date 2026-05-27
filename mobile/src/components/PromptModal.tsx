import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';

/**
 * Single-field text prompt. ThemedAlert is confirm-only, so reason/number
 * inputs (decline, withdraw, cancel, assign policy #, reopen reason, final
 * indemnity) use this instead of the iOS-only Alert.prompt. Controlled by the
 * caller via `visible`.
 */
export function PromptModal({
  visible,
  title,
  message,
  placeholder,
  initialValue = '',
  confirmLabel = 'Confirm',
  required = true,
  keyboardType = 'default',
  multiline = true,
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
  keyboardType?: 'default' | 'decimal-pad';
  multiline?: boolean;
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
            keyboardType={keyboardType}
            autoFocus
            multiline={multiline}
            onSubmitEditing={() => {
              if (!multiline && canSubmit) onSubmit(trimmed);
            }}
          />
          <View style={styles.buttonRow}>
            <Pressable
              style={({ pressed }) => [styles.btn, styles.btnCancel, pressed && styles.btnPressed]}
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={styles.btnCancelLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                styles.btnConfirm,
                pressed && styles.btnConfirmPressed,
                !canSubmit && styles.btnDisabled,
              ]}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              accessibilityState={{ disabled: !canSubmit }}
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
    // Ink scrim (Paper & Ink theme) at ~55% — within the 40-60% legibility
    // guidance; replaces a stale dark-theme navy left from the theme migration.
    backgroundColor: 'rgba(23, 21, 15, 0.55)',
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
    minHeight: 44, // touch-target-size (Apple HIG 44pt / Material 48dp)
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPressed: { backgroundColor: Colors.surfaceHover },
  btnCancel: { backgroundColor: 'transparent', borderColor: 'rgba(23,21,15,0.14)' },
  btnCancelLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    letterSpacing: 1,
    fontFamily: Fonts.monoBold,
  },
  btnConfirm: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  btnConfirmPressed: { opacity: 0.85 },
  btnConfirmLabel: {
    color: Colors.text,
    fontSize: 12,
    letterSpacing: 1,
    fontFamily: Fonts.monoBold,
  },
  btnDisabled: { opacity: 0.4 },
});
