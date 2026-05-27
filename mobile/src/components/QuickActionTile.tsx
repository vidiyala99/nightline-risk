import React from 'react';
import { Colors } from '../theme/colors';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface Props {
  label: string;
  onPress: () => void;
}

export function QuickActionTile({ label, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.tile, pressed && { opacity: 0.8 }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.label} numberOfLines={1}>{label}</Text>
      <Text style={styles.arrow}>→</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: Colors.accentWash,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.45)',
    gap: 8,
  },
  label: {
    flex: 1,
    color: Colors.text,
    fontSize: 11,
    letterSpacing: 1.5,
    fontFamily: 'SpaceMono_700Bold',
  },
  arrow: { color: Colors.accentInk, fontSize: 16, fontFamily: 'SpaceMono_700Bold' },
});
