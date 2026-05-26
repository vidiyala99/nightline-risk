import React, { ReactNode } from 'react';
import { Colors } from "../theme/colors";
import {
  ScrollView,
  ScrollViewProps,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useResponsive } from '../hooks/useResponsive';

/**
 * Standard screen wrapper.
 *
 * - Caps content at 720pt on tablets so iPad portrait/landscape do not
 *   stretch narrative content edge-to-edge.
 * - Adds bottom padding for the tab bar + home indicator so the last
 *   item in a list/scroll is not hidden.
 * - Respects top safe-area inset for screens that render their own
 *   header (pass `respectTopInset={false}` if a navigation header
 *   already covers the inset).
 *
 * Pass `scroll={false}` for screens that need their own scroll
 * container (FlatList, etc.) — the View variant still caps width
 * and pads for the tab bar.
 */
interface ScreenContainerProps {
  children: ReactNode;
  scroll?: boolean;
  respectTopInset?: boolean;
  /** Extra bottom padding on top of the tab-bar reserve. */
  bottomExtra?: number;
  /** Style override for the inner content wrapper. */
  contentStyle?: ScrollViewProps['contentContainerStyle'];
  scrollProps?: Omit<ScrollViewProps, 'contentContainerStyle' | 'children'>;
}

const TAB_BAR_RESERVE = 80;

export function ScreenContainer({
  children,
  scroll = true,
  respectTopInset = false,
  bottomExtra = 0,
  contentStyle,
  scrollProps,
}: ScreenContainerProps) {
  const insets = useSafeAreaInsets();
  const { contentMaxWidth, isTablet } = useResponsive();

  const bottomPadding = TAB_BAR_RESERVE + insets.bottom + bottomExtra;
  const topPadding = respectTopInset ? insets.top : 0;

  const innerStyle = [
    styles.inner,
    isTablet && { maxWidth: contentMaxWidth, alignSelf: 'center' as const, width: '100%' as const },
    { paddingTop: topPadding, paddingBottom: bottomPadding },
    contentStyle,
  ];

  if (!scroll) {
    return <View style={[styles.root, innerStyle]}>{children}</View>;
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={innerStyle}
      keyboardShouldPersistTaps="handled"
      {...scrollProps}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  inner: {
    flexGrow: 1,
  },
});
