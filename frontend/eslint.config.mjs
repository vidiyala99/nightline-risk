import next from "eslint-config-next";

// eslint-config-next@16 ships a native flat-config array (Next + React +
// react-hooks + typescript-eslint + import + jsx-a11y). Spread it directly;
// FlatCompat is not needed and crashes on this version.
const eslintConfig = [
  // Scope: application source only. Build output, deps, the service worker
  // (browser globals), Playwright artifacts, one-off scripts, config files,
  // and the generated OpenAPI client (src/api/**) are not hand-written app
  // code and would only produce noise.
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "public/**",
      "playwright-report/**",
      "test-results/**",
      "src/api/**",
      "*.config.mjs",
      "*.config.js",
      "next.config.mjs",
      "verify-op.mjs",
      "src/**/*.test.mjs",
    ],
  },
  ...next,
  {
    // Calibration for a first-time lint adoption on an existing app. Real
    // bug-catchers (rules-of-hooks, exhaustive-deps, unused vars) stay as
    // errors; the rest are downgraded so the lint is green and signal-rich
    // rather than a wall of stylistic red. Tighten over time.
    rules: {
      // Apostrophes/quotes in JSX copy are fine — React renders them. Noise.
      "react/no-unescaped-entities": "off",
      // New React-Compiler rules (eslint-plugin-react-hooks v6): valuable, but
      // fire on many correct data-loading effects. Surface as warnings during
      // adoption instead of blocking or mass-rewriting working code.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
    },
  },
];

export default eslintConfig;
