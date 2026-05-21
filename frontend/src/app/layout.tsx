import "./styles.css";
import { DM_Sans, Cormorant_Garamond, JetBrains_Mono } from "next/font/google";
import { AuthProvider } from "@/contexts/AuthContext";
import { Toaster } from "react-hot-toast";
import PushRegistrar from "@/components/PushRegistrar";

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans', weight: ['300', '400', '500', '600', '700'] });
const cormorant = Cormorant_Garamond({ subsets: ['latin'], variable: '--font-cormorant', weight: ['400', '500', '600', '700'] });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', weight: ['400', '500'] });

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
    <html lang="en" className={`${dmSans.variable} ${cormorant.variable} ${jetbrainsMono.variable}`}>
      <body>
        <AuthProvider>
          <PushRegistrar />
          {children}
          <Toaster
            position="top-right"
            toastOptions={{
              style: {
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '8px',
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
