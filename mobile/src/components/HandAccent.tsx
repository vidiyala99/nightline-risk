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
    fontSize: 21,
    lineHeight: 30,
    marginTop: 2,
    paddingRight: 8,
    alignSelf: 'flex-start',
  },
});
