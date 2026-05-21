# Nightline Risk OS - Frontend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Nightline Risk OS frontend with a dual-aesthetic approach: "Editorial / Nightlife Glamour" for venues and "Industrial / Mission Control" for underwriters.

**Architecture:** We will update the global CSS variables and structures in `src/app/styles.css` to establish the new design system. We will then refactor the main layout (`src/components/layout/`), the venue dashboard (`src/app/dashboard/page.tsx`), and the underwriter workbench (`src/app/underwriter/page.tsx`) to implement the distinct aesthetics while sharing core typography and layout primitives.

**Tech Stack:** Next.js (App Router), React, Vanilla CSS (using CSS variables).

---

### Task 1: Update Global CSS Variables and Typography

**Files:**
- Modify: `frontend/src/app/styles.css`

- [ ] **Step 1: Replace global CSS variables**

Update the `:root` variables in `frontend/src/app/styles.css` to establish the "Midnight and Neon" palette and the new typography stack.

```css
/* In frontend/src/app/styles.css, replace the :root section with the following: */
:root {
  /* ============================================
     NIGHTLINE RISK OS DESIGN SYSTEM
     Midnight & Neon + Industrial Grids
     ============================================ */
  color-scheme: dark;

  /* Core Colors - Midnight Base */
  --bg-dark: #050505;
  --bg-base: #0a0a0a;
  --bg-surface: #121212;
  --bg-surface-elevated: #1a1a1a;
  --bg-surface-hover: #222222;

  /* Brand Colors - Neon Accents */
  --brand-primary: #D4FF00; /* Security Yellow */
  --brand-primary-dim: #AACC00;
  --brand-secondary: #00F0FF; /* Laser Blue */
  --brand-tertiary: #FF0055; /* Alert Red */

  /* Text Colors */
  --text-primary: #FFFFFF;
  --text-secondary: #A0A0A0;
  --text-tertiary: #666666;
  --text-inverse: #000000;

  /* Borders & Dividers */
  --border-subtle: rgba(255, 255, 255, 0.08);
  --border-default: rgba(255, 255, 255, 0.15);
  --border-strong: rgba(255, 255, 255, 0.25);
  
  /* Industrial Grid specific */
  --border-grid: #333333;

  /* State Colors */
  --state-success: #D4FF00;
  --state-warning: #FF9900;
  --state-error: #FF0055;
  --state-info: #00F0FF;

  /* Typography */
  /* Aggressive geometric sans for display */
  --font-display: 'Syncopate', 'Space Grotesk', system-ui, sans-serif;
  /* Clean sans for body */
  --font-body: 'Inter', system-ui, sans-serif;
  /* Dense mono for mission control */
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;
  --space-2xl: 48px;
  --space-3xl: 64px;
  
  /* Border Radius - sharper for industrial feel */
  --radius-sm: 2px;
  --radius-md: 4px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-full: 9999px;
  
  /* Glows */
  --glow-primary: 0 0 20px rgba(212, 255, 0, 0.15);
  --glow-secondary: 0 0 20px rgba(0, 240, 255, 0.15);
}
```

- [ ] **Step 2: Commit the CSS updates**

```bash
git add frontend/src/app/styles.css
git commit -m "style: update global variables for Midnight and Neon aesthetic"
```

### Task 2: Create Layout Primitives for the Dual Aesthetic

**Files:**
- Modify: `frontend/src/app/styles.css`

- [ ] **Step 1: Add dual-aesthetic specific classes**

Add specific classes for the "Nightlife Glamour" (Venue) and "Mission Control" (Underwriter) aesthetics at the end of `frontend/src/app/styles.css`.

```css
/* Add to the end of frontend/src/app/styles.css */

/* ============================================
   AESTHETIC: NIGHTLIFE GLAMOUR (VENUE)
   ============================================ */
.theme-venue {
  background-color: var(--bg-dark);
  background-image: 
    radial-gradient(circle at 15% 50%, rgba(212, 255, 0, 0.03), transparent 25%),
    radial-gradient(circle at 85% 30%, rgba(0, 240, 255, 0.03), transparent 25%);
}

.theme-venue .card {
  background: rgba(18, 18, 18, 0.7);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.theme-venue h1, .theme-venue h2 {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: -0.02em;
}

.theme-venue .glow-text {
  text-shadow: 0 0 10px rgba(255, 255, 255, 0.3);
}

/* ============================================
   AESTHETIC: MISSION CONTROL (UNDERWRITER)
   ============================================ */
.theme-underwriter {
  background-color: #000000;
  /* Blueprint/Terminal Grid Background */
  background-image: 
    linear-gradient(var(--border-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--border-grid) 1px, transparent 1px);
  background-size: 40px 40px;
  background-position: center center;
}

.theme-underwriter .workbench-panel {
  background: #000000;
  border: 1px solid var(--brand-secondary);
  border-radius: 0;
  position: relative;
}

/* Industrial corners */
.theme-underwriter .workbench-panel::before,
.theme-underwriter .workbench-panel::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  border: 1px solid var(--brand-secondary);
}

.theme-underwriter .workbench-panel::before { top: -1px; left: -1px; border-right: none; border-bottom: none; }
.theme-underwriter .workbench-panel::after { bottom: -1px; right: -1px; border-left: none; border-top: none; }

.theme-underwriter h1, 
.theme-underwriter h2,
.theme-underwriter th,
.theme-underwriter .data-label {
  font-family: var(--font-mono);
  text-transform: uppercase;
  color: var(--brand-secondary);
  letter-spacing: 0.1em;
  font-size: 0.85rem;
}

.theme-underwriter .data-value {
  font-family: var(--font-mono);
  color: var(--text-primary);
}

.theme-underwriter .critical-data {
  color: var(--brand-primary);
  text-shadow: 0 0 8px rgba(212, 255, 0, 0.4);
}
```

- [ ] **Step 2: Commit the layout primitives**

```bash
git add frontend/src/app/styles.css
git commit -m "style: add Nightlife and Mission Control aesthetic primitives"
```

### Task 3: Refactor the Root Layout

**Files:**
- Modify: `frontend/src/app/layout.tsx`

- [ ] **Step 1: Ensure font imports support the new aesthetic**

Update `frontend/src/app/layout.tsx` to include Google Fonts for Syncopate, Inter, and JetBrains Mono. (Note: Since we are using CSS variables, we'll add standard HTML link tags for the fonts if `next/font/google` is not already heavily integrated, or modify the existing `next/font` config). *For simplicity and to avoid build errors with missing next fonts, we will inject a standard stylesheet link.*

```tsx
// Edit frontend/src/app/layout.tsx
// Find the <head> or return section and ensure the fonts are loaded.
// Assuming a standard Next.js 13+ layout:

import './styles.css'
import type { Metadata } from 'next'
import { Inter, Space_Grotesk, JetBrains_Mono } from 'next/font/google'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { AuthProvider } from '@/contexts/AuthContext'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk' })
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' })

export const metadata: Metadata = {
  title: 'Nightline Risk OS',
  description: 'Underwriting and Risk Management for Nightlife',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Syncopate:wght@400;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <AuthProvider>
          <ThemeProvider>
            {children}
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
```

- [ ] **Step 2: Commit the layout changes**

```bash
git add frontend/src/app/layout.tsx
git commit -m "chore: add Google fonts for redesign aesthetics"
```

### Task 4: Apply Nightlife Glamour to Dashboard

**Files:**
- Modify: `frontend/src/app/dashboard/layout.tsx` (or `page.tsx` depending on routing structure)
- Modify: `frontend/src/app/dashboard/page.tsx`

- [ ] **Step 1: Add the theme class to the dashboard layout/page**

Ensure the `theme-venue` class is wrapped around the dashboard content. Modify `frontend/src/app/dashboard/page.tsx` (or `layout.tsx` if it exists). Assuming `page.tsx` is the primary entry point:

```tsx
// Inside frontend/src/app/dashboard/page.tsx
// Add the 'theme-venue' class to the outermost container

// Example structure modification:
export default function DashboardPage() {
  return (
    <div className="theme-venue min-h-screen p-xl">
      <header className="page-header border-b border-subtle mb-xl pb-lg">
        <h1 className="text-4xl font-bold glow-text">VENUE <span className="text-accent">OS</span></h1>
        <p className="text-secondary mt-sm">Live Operational Health</p>
      </header>
      
      {/* ... rest of the dashboard components wrapped in card classes ... */}
      <div className="bento-grid">
         <div className="card bento-card highlight">
            <h2 className="text-xl mb-sm">Risk Profile</h2>
            <div className="text-4xl font-bold text-primary">84/100</div>
         </div>
      </div>
    </div>
  )
}
```
*(Note to implementer: Adapt the exact component structure to match what is currently in `dashboard/page.tsx`, simply ensuring the `theme-venue` class is applied to the root and `card` classes are used for modules).*

- [ ] **Step 2: Commit the dashboard updates**

```bash
git add frontend/src/app/dashboard/page.tsx
git commit -m "feat: apply Nightlife Glamour aesthetic to Venue Dashboard"
```

### Task 5: Apply Mission Control to Underwriter Workbench

**Files:**
- Modify: `frontend/src/app/underwriter/page.tsx` (or layout)

- [ ] **Step 1: Add the theme class and layout to the underwriter page**

Modify `frontend/src/app/underwriter/page.tsx` to use the `theme-underwriter` and `workbench-panel` classes.

```tsx
// Inside frontend/src/app/underwriter/page.tsx

// Example structure modification:
export default function UnderwriterPage() {
  return (
    <div className="theme-underwriter min-h-screen p-lg">
      <header className="flex justify-between items-center mb-xl border-b border-[#333] pb-sm">
        <div>
          <div className="data-label">SYSTEM.ID</div>
          <h1 className="text-2xl critical-data">UW_TERMINAL_V1</h1>
        </div>
        <div className="text-right">
          <div className="data-label">STATUS</div>
          <div className="data-value text-accent">ONLINE</div>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-lg">
        <div className="workbench-panel p-lg">
          <h2 className="mb-md">Target: Elsewhere</h2>
          <div className="flex flex-col gap-sm">
            <div className="flex justify-between border-b border-[#333] pb-xs">
              <span className="data-label">CAPACITY</span>
              <span className="data-value">1200</span>
            </div>
            <div className="flex justify-between border-b border-[#333] pb-xs">
              <span className="data-label">RISK_SCORE</span>
              <span className="critical-data">84.2</span>
            </div>
          </div>
        </div>
        
        <div className="workbench-panel p-lg col-span-2">
           <h2 className="mb-md">LIVE_TELEMETRY</h2>
           <table className="w-full text-left">
             <thead>
               <tr className="border-b border-[#333]">
                 <th className="pb-xs">TIMESTAMP</th>
                 <th className="pb-xs">EVENT</th>
                 <th className="pb-xs text-right">DELTA</th>
               </tr>
             </thead>
             <tbody className="font-mono text-sm">
               <tr>
                 <td className="py-sm text-secondary">2026-05-04T23:14:02Z</td>
                 <td className="py-sm data-value">CROWD_DENSITY_SPIKE</td>
                 <td className="py-sm text-right critical-data">+12%</td>
               </tr>
             </tbody>
           </table>
        </div>
      </div>
    </div>
  )
}
```
*(Note to implementer: Adapt the exact component structure to match what is currently in `underwriter/page.tsx`, ensuring `theme-underwriter`, `workbench-panel`, `data-label`, and `data-value` classes are used).*

- [ ] **Step 2: Commit the underwriter updates**

```bash
git add frontend/src/app/underwriter/page.tsx
git commit -m "feat: apply Mission Control aesthetic to Underwriter Workbench"
```
