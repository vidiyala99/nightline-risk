// globals.css is the single style entry: it pulls the legacy "Paper & Ink"
// stylesheets into a low-priority cascade layer, then loads Tailwind v4 + the
// v4 "Signal" tokens on top. Legacy imports are deleted once every page is
// migrated off the old CSS.
import "./globals.css";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Hanken_Grotesk, Bricolage_Grotesque, Caveat } from "next/font/google";
import { AuthProvider } from "@/contexts/AuthContext";
import { Toaster } from "react-hot-toast";
import PushRegistrar from "@/components/PushRegistrar";

// v4 "Signal" type system: Inter for UI, JetBrains Mono for tabular data.
// JetBrains Mono also serves --font-jetbrains-mono for legacy pages (cosmetic
// only during the transition).
const sans = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' });

// Legacy Paper & Ink fonts — still referenced by not-yet-migrated pages via
// styles.css var names. Removed alongside the legacy CSS at the end of the sweep.
const bodySans = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-dm-sans', weight: ['300', '400', '500', '600', '700'] });
const displayGrotesque = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-cormorant', weight: ['400', '600', '700', '800'] });
const scriptAccent = Caveat({ subsets: ['latin'], variable: '--font-caveat', weight: ['400', '600', '700'] });

export const metadata = {
  title: "Nightline Risk OS",
  description: "Evidence-first underwriting for nightlife venues.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${bodySans.variable} ${displayGrotesque.variable} ${scriptAccent.variable}`}>
      <body>
        <AuthProvider>
          <PushRegistrar />
          {children}
          <Toaster
            position="top-right"
            toastOptions={{
              style: {
                background: 'var(--bg-surface-elevated)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.875rem',
                fontFamily: 'var(--font-dm-sans)',
              },
            }}
          />
        </AuthProvider>
      </body>
    </html>
  );
}
