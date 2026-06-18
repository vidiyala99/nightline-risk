import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Colors } from '../theme/colors';

export interface ChipOption {
  value: string;
  label: string;
}

interface FilterChipsProps {
  label: string;
  options: ChipOption[];
  value: string;
  onChange: (value: string) => void;
  /** Horizontal scroll (many options, e.g. type/borough) vs wrap row (few, e.g. sort). */
  scroll?: boolean;
  /** Surface-specific horizontal padding (Market uses 16, Venues 20). */
  padH?: number;
  padB?: number;
}

/**
 * Shared filter chip row for the mobile broker list surfaces (Market, Venues).
 * One source for the pill styling + label + active state — replaces the
 * per-screen filterGroup/chip/chipsRow StyleSheet blocks that had drifted
 * apart only by padding.
 */
export function FilterChips({ label, options, value, onChange, scroll = true, padH = 20, padB = 12 }: FilterChipsProps) {
  const renderChip = (opt: ChipOption) => {
    const active = value === opt.value;
    return (
      <Pressable
        key={opt.value}
        style={[styles.chip, active && styles.chipActive]}
        onPress={() => onChange(opt.value)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
      >
        <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.group}>
      <Text style={[styles.label, { paddingHorizontal: padH }]}>{label}</Text>
      {scroll ? (
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={options}
          keyExtractor={(o) => o.value}
          contentContainerStyle={[styles.row, { paddingHorizontal: padH, paddingBottom: padB }]}
          renderItem={({ item }) => renderChip(item)}
        />
      ) : (
        <View style={[styles.wrapRow, { paddingHorizontal: padH, paddingBottom: padB }]}>
          {options.map(renderChip)}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { marginBottom: 2 },
  label: { color: Colors.textMuted, fontSize: 9, letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold', marginBottom: 6 },
  row: { gap: 8 },
  wrapRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.accentWash, borderColor: Colors.accent },
  chipText: { color: Colors.textSecondary, fontSize: 12, fontWeight: '700', fontFamily: 'SpaceMono_700Bold' },
  chipTextActive: { color: Colors.accentInk },
});
