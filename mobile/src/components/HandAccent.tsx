import { Text, StyleSheet } from 'react-native';
import { Colors } from '../theme/colors';

/**
 * Handwritten (Caveat) accent that sits under/next to a screen title —
 * the mobile echo of the web's per-page script flourish ("the book, in
 * motion", "bound & live", ...). Keep the phrase short.
 */
export function HandAccent({ children }: { children: string }) {
  return <Text style={styles.accent}>{children}</Text>;
}

const styles = StyleSheet.create({
  accent: {
    color: Colors.accentInk,
    fontFamily: 'Caveat_600SemiBold',
    fontSize: 22,
    // No explicit lineHeight: let RN use Caveat's natural metrics so the
    // tall looped ascenders (d, l, h) aren't clipped by the line box.
    includeFontPadding: true,
    marginTop: 4,
    paddingTop: 2,
    paddingRight: 8,
    alignSelf: 'flex-start',
  },
});
