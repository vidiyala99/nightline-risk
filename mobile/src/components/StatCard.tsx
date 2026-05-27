import React from 'react';
import { Colors } from '../theme/colors';
import { Pressable, StyleSheet, Text } from 'react-native';

type Tone = 'default' | 'error' | 'warning';

interface Props {
  value: number | string;
  label: string;
  tone?: Tone;
  onPress?: () => void;
}

const TONE_COLOR: Record<Tone, string> = {
  default: Colors.text,
  error: Colors.error,
  warning: Colors.warning,
};

export function StatCard({ value, label, tone = 'default', onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.8 }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
    >
      <Text style={[styles.value, { color: TONE_COLOR[tone] }]}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    padding: 12,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  value: {
    color: Colors.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -1,
    fontFamily: 'SpaceMono_700Bold',
  },
  label: {
    color: Colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.5,
    textAlign: 'center',
    fontFamily: 'SpaceMono_700Bold',
  },
});
