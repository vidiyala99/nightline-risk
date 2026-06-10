import "./styles.css";
import "./mobile-native.css";
import { Hanken_Grotesk, Bricolage_Grotesque, Space_Mono, Caveat } from "next/font/google";
import { AuthProvider } from "@/contexts/AuthContext";
import { Toaster } from "react-hot-toast";
import PushRegistrar from "@/components/PushRegistrar";

// Paper & Ink type system (Third Space brand language):
// display = heavy grotesque, body = clean grotesque, mono = technical labels,
// script = one handwritten flourish. CSS var names are kept stable for styles.css.
const bodySans = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-dm-sans', weight: ['300', '400', '500', '600', '700'] });
const displayGrotesque = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-cormorant', weight: ['400', '600', '700', '800'] });
const techMono = Space_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', weight: ['400', '700'] });
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
    <html lang="en" className={`${bodySans.variable} ${displayGrotesque.variable} ${techMono.variable} ${scriptAccent.variable}`}>
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
