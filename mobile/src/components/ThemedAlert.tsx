import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Colors } from "../theme/colors";
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

type AlertButtonStyle = 'default' | 'primary' | 'destructive' | 'cancel';

export interface AlertButton {
  label: string;
  onPress?: () => void;
  style?: AlertButtonStyle;
}

export interface AlertOptions {
  title: string;
  message?: string;
  buttons?: AlertButton[];
  variant?: 'info' | 'warning' | 'error' | 'success';
}

interface AlertState extends AlertOptions {
  id: number;
}

interface AlertContextValue {
  show: (options: AlertOptions) => void;
}

const AlertContext = createContext<AlertContextValue | null>(null);

export function ThemedAlertProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<AlertState | null>(null);

  const show = useCallback((options: AlertOptions) => {
    setActive({ ...options, id: Date.now() });
  }, []);

  const dismiss = useCallback(() => setActive(null), []);

  const value = useMemo(() => ({ show }), [show]);

  const buttons: AlertButton[] = active?.buttons ?? [{ label: 'OK', style: 'primary' }];
  const accentColor = active ? VARIANT_ACCENT[active.variant ?? 'info'] : VARIANT_ACCENT.info;
  const eyebrowLabel = active ? VARIANT_EYEBROW[active.variant ?? 'info'] : '';

  return (
    <AlertContext.Provider value={value}>
      {children}
      <Modal
        visible={!!active}
        transparent
        animationType="fade"
        onRequestClose={dismiss}
      >
        <Pressable style={styles.backdrop} onPress={dismiss}>
          <Pressable style={[styles.card, { borderColor: `${accentColor}33` }]} onPress={() => undefined}>
            {!!eyebrowLabel && (
              <Text style={[styles.eyebrow, { color: accentColor }]}>{eyebrowLabel}</Text>
            )}
            {!!active?.title && <Text style={styles.title}>{active.title}</Text>}
            {!!active?.message && <Text style={styles.message}>{active.message}</Text>}
            <View style={styles.buttonRow}>
              {buttons.map((btn, i) => (
                <Pressable
                  key={`${btn.label}-${i}`}
                  onPress={() => {
                    btn.onPress?.();
                    dismiss();
                  }}
                  style={({ pressed }) => [
                    styles.btn,
                    buttonVariantStyle(btn.style, accentColor),
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={[styles.btnLabel, buttonLabelStyle(btn.style, accentColor)]}>
                    {btn.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </AlertContext.Provider>
  );
}

export function useAlert(): AlertContextValue {
  const ctx = useContext(AlertContext);
  if (!ctx) {
    throw new Error('useAlert must be used inside <ThemedAlertProvider>');
  }
  return ctx;
}

const VARIANT_ACCENT: Record<NonNullable<AlertOptions['variant']>, string> = {
  info: Colors.accent,
  warning: Colors.warning,
  error: Colors.error,
  success: Colors.success,
};

const VARIANT_EYEBROW: Record<NonNullable<AlertOptions['variant']>, string> = {
  info: 'NOTICE',
  warning: 'WARNING',
  error: 'ERROR',
  success: 'CONFIRMED',
};

function buttonVariantStyle(style: AlertButtonStyle | undefined, accent: string) {
  switch (style) {
    case 'primary':
      return { backgroundColor: accent, borderColor: accent };
    case 'destructive':
      return { backgroundColor: 'transparent', borderColor: Colors.error };
    case 'cancel':
      return { backgroundColor: 'transparent', borderColor: 'rgba(23,21,15,0.14)' };
    default:
      return { backgroundColor: 'transparent', borderColor: 'rgba(23,21,15,0.14)' };
  }
}

function buttonLabelStyle(style: AlertButtonStyle | undefined, accent: string) {
  switch (style) {
    case 'primary':
      return { color: Colors.bg };
    case 'destructive':
      return { color: Colors.error };
    case 'cancel':
      return { color: Colors.textSecondary };
    default:
      return { color: Colors.text };
  }
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
    borderRadius: 16,
    paddingHorizontal: 22,
    paddingVertical: 22,
    gap: 8,
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'JetBrainsMono_700Bold',
    marginBottom: 4,
  },
  title: {
    color: Colors.text,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
    fontFamily: 'CormorantGaramond_700Bold',
  },
  message: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: 'DMSans_400Regular',
    marginTop: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
  btnLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'JetBrainsMono_700Bold',
  },
});
