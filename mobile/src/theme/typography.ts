/**
 * Nightline Risk — Typography System (mobile)
 *
 * NOTE: mobile uses a different typeface set than the web portal. Web maps
 * --font-display/body/mono to Cormorant Garamond / DM Sans / JetBrains Mono;
 * mobile uses the families below. Cross-platform font unification is a
 * separate, deliberate follow-up — don't assume these match web.
 *   Display/headings → Bricolage Grotesque
 *   Body/UI          → Hanken Grotesk
 *   Data/labels      → Space Mono
 */

export const Fonts = {
  // Display — editorial headings (wordmark, hero, venue names)
  displayBold:    'BricolageGrotesque_700Bold',
  displayItalic:  'Caveat_600SemiBold',

  // Body — all UI text, labels, buttons
  sansRegular:    'HankenGrotesk_400Regular',
  sansMedium:     'HankenGrotesk_500Medium',
  sansSemiBold:   'HankenGrotesk_600SemiBold',
  sansBold:       'HankenGrotesk_700Bold',

  // Mono — data values, IDs, timestamps, status badges, eyebrows
  monoRegular:    'SpaceMono_400Regular',
  monoBold:       'SpaceMono_700Bold',
};

/** Shared text styles — import and spread in StyleSheet.create() */
export const TextStyles = {
  // Display (Bricolage Grotesque)
  wordmark:     { fontFamily: Fonts.displayBold,    fontSize: 56, letterSpacing: -1.5, lineHeight: 56 },
  heroHeading:  { fontFamily: Fonts.displayBold,    fontSize: 40, letterSpacing: -1,   lineHeight: 44 },
  screenTitle:  { fontFamily: Fonts.displayBold,    fontSize: 28, letterSpacing: -0.5 },
  venueName:    { fontFamily: Fonts.displayBold,    fontSize: 22, letterSpacing: -0.5 },
  tierGlyph:    { fontFamily: Fonts.displayBold,    fontSize: 96, letterSpacing: -4,   lineHeight: 96 },

  // Body UI (Hanken Grotesk)
  body:         { fontFamily: Fonts.sansRegular,    fontSize: 14, lineHeight: 21 },
  bodySmall:    { fontFamily: Fonts.sansRegular,    fontSize: 13, lineHeight: 19 },
  label:        { fontFamily: Fonts.sansMedium,     fontSize: 14 },
  buttonText:   { fontFamily: Fonts.sansBold,       fontSize: 13, letterSpacing: 0.5 },
  caption:      { fontFamily: Fonts.sansRegular,    fontSize: 12 },

  // Mono data (Space Mono)
  eyebrow:      { fontFamily: Fonts.monoBold,       fontSize: 10, letterSpacing: 2,   textTransform: 'uppercase' as const },
  dataLabel:    { fontFamily: Fonts.monoRegular,    fontSize: 11, letterSpacing: 1 },
  dataValue:    { fontFamily: Fonts.monoBold,       fontSize: 11, letterSpacing: 0.5 },
  timestamp:    { fontFamily: Fonts.monoRegular,    fontSize: 11 },
  badge:        { fontFamily: Fonts.monoBold,       fontSize: 9,  letterSpacing: 1.2 },
  packetId:     { fontFamily: Fonts.monoRegular,    fontSize: 10, letterSpacing: 0.5 },
};
