import React from 'react';
import { Colors } from "../theme/colors";
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  label: string;
  value: number;
  max?: number;
  unit?: string;
  invertScale?: boolean;
}

function barColor(pct: number, invertScale = false) {
  if (invertScale) {
    // High value = good (risk scores, compliance)
    if (pct >= 0.85) return Colors.accent;
    if (pct >= 0.6) return Colors.warning;
    return Colors.error;
  }
  // High value = bad (capacity)
  if (pct < 0.6) return Colors.accent;
  if (pct < 0.85) return Colors.warning;
  return Colors.error;
}

export function CapacityBar({ label, value, max = 100, unit = '', invertScale = false }: Props) {
  const pct = Math.min(value / max, 1);
  const color = barColor(pct, invertScale);

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.value, { color }]}>
          {Math.round(value)}{unit}{max !== 100 ? ` / ${max}${unit}` : ''}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct * 100}%` as any, backgroundColor: color }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: Colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'SpaceMono_700Bold' },
  value: { fontSize: 12, fontWeight: '700', letterSpacing: 0.3, fontFamily: 'SpaceMono_700Bold' },
  track: {
    height: 3,
    backgroundColor: Colors.borderSubtle,
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 2 },
});
