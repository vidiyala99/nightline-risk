/**
 * Nightline Risk — Paper & Ink color tokens (mobile)
 *
 * Mirrors the web portal's v3 "Paper & Ink" theme: warm cream paper,
 * near-black ink, hard-edged borders, one lime accent. Import this and
 * reference Colors.* in StyleSheet blocks instead of hardcoding hex, so a
 * future theme change is a one-file edit (parity with the web token layer).
 */
export const Colors = {
  // Backgrounds — warm paper
  bg: '#F6F0E2',            // main background (was #07080f)
  bgDeep: '#ECE3CE',        // deepest paper
  surface: '#FBF8F0',       // card (was #0d0f1c)
  surfaceElevated: '#FFFFFF',
  surfaceHover: '#EFE7D3',
  tabBar: '#FBF8F0',        // tab bar / headers (was #0a0b14 / #07080f)

  // Ink text
  text: '#17150F',          // primary (was #eeeef5)
  textSecondary: '#4A463B', // (was #8b90a8)
  textMuted: '#8A8472',     // (was #4a4f65)
  textInverse: '#F6F0E2',   // text on the lime accent / ink fills

  // Brand
  accent: '#c8f000',        // signature lime — fills, active states, dots
  accentInk: '#5a6e00',     // dark olive-lime — lime used as TEXT on paper
  accentWash: 'rgba(200,240,0,0.18)', // lime @18% — active pill / icon chip background

  // State (contrast-safe on paper)
  success: '#1F8F4E',       // (was #00d97e)
  warning: '#B45309',       // (was #ff9500)
  error: '#C8341E',         // (was #ff4557)
  info: '#4338CA',

  // Risk tiers — heat ramp (A best → D worst)
  tierA: '#197A43',
  tierB: '#A87900',
  tierC: '#C2410C',
  tierD: '#B91C1C',

  // Borders & dividers — ink lines
  border: 'rgba(23,21,15,0.22)',
  borderSubtle: 'rgba(23,21,15,0.12)',
  borderStrong: '#17150F',
} as const;
