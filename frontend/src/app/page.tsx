"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  Gauge,
  ShieldCheck,
  Landmark,
  Target,
  Building2,
  Briefcase,
  Users,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

// Demo personas — reuse the seeded demo accounts; each lands on its own home.
const DEMOS: { label: string; email: string; home: string; icon: typeof Building2 }[] = [
  { label: "Venue operator", email: "venue@elsewhere.com", home: "/dashboard", icon: Building2 },
  { label: "Broker portfolio", email: "broker@nightline.risk", home: "/dashboard", icon: Briefcase },
  { label: "Carrier desk", email: "underwriter@nightline.risk", home: "/underwriting", icon: Landmark },
  { label: "Floor staff", email: "staff@elsewhere.com", home: "/report", icon: Users },
];

const PILLARS = [
  {
    icon: Gauge,
    title: "Underwriting from operational data",
    body: "Camera, POS, and ID-scan signals fuse into a calibrated risk score that prices the risk — not a static questionnaire.",
  },
  {
    icon: ShieldCheck,
    title: "Evidence that defends",
    body: "Incident footage and documents are hashed and corroborated at intake, then exported as one defense package built to beat the assault-and-battery claims driving rate hikes.",
  },
  {
    icon: Landmark,
    title: "The AI-native carrier",
    body: "Nightline doesn't just place coverage — it underwrites its own submissions and adjudicates its own claims, end to end.",
  },
];

const LOOP = ["Incident", "Hashed evidence", "Risk score", "Underwriting", "Claim", "Defense package"];

export default function LandingPage() {
  const router = useRouter();
  const { isLoaded, isSignedIn, role, signIn } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  // Signed-in visitors go straight to their role home; the landing is for guests.
  useEffect(() => {
    if (isLoaded && isSignedIn) {
      router.replace(role === "carrier" ? "/underwriting" : "/dashboard");
    }
  }, [isLoaded, isSignedIn, role, router]);

  if (!isLoaded || isSignedIn) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  const runDemo = async (email: string, home: string) => {
    setError("");
    setBusy(email);
    try {
      await signIn(email, "demo123");
      router.replace(home);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the demo. Try again.");
      setBusy(null);
    }
  };

  const scrollToDemo = () => {
    document.getElementById("demo")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <main className="lc-shell" style={{ padding: "0 clamp(20px, 5vw, 64px) 80px" }}>
      {/* Top brand bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          maxWidth: 1100,
          margin: "0 auto",
          padding: "var(--space-lg) 0",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <img src="/nightline-mark.svg" alt="Nightline" width={32} height={32} />
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.15rem" }}>
            Nightline
          </span>
        </span>
        <Link
          href="/login"
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
            minHeight: 44,
            display: "inline-flex",
            alignItems: "center",
            padding: "0 var(--space-sm)",
          }}
        >
          Sign in
        </Link>
      </header>

      {/* 1. Hero */}
      <section
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          paddingTop: "clamp(40px, 8vh, 96px)",
          paddingBottom: "clamp(40px, 8vh, 88px)",
        }}
      >
        <span className="lc-eyebrow">
          NIGHTLINE
          <span className="lc-eyebrow__sep" />
          RISK OS
        </span>
        <h1 className="lc-display" style={{ maxWidth: "18ch", marginTop: 16 }}>
          Insurance, <em>rebuilt</em> from the evidence up.
        </h1>
        <p className="lc-sub" style={{ maxWidth: "60ch", fontSize: "1.1rem", marginTop: 18 }}>
          Nightline turns a venue&apos;s operational data and incident evidence into proprietary
          underwriting, lawsuit-ready defense, and carrier-side claims — the full chain, operator
          to broker to carrier.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-md)", marginTop: "var(--space-xl)", alignItems: "center" }}>
          <button type="button" className="btn btn-primary" onClick={scrollToDemo} style={{ minHeight: 48, fontSize: "0.95rem", padding: "12px 22px" }}>
            Explore the live demo <ArrowRight size={18} />
          </button>
          <Link href="/login" style={{ fontSize: "var(--text-sm)", color: "var(--accent-ink)", minHeight: 44, display: "inline-flex", alignItems: "center" }}>
            or sign in →
          </Link>
        </div>
      </section>

      {/* 2. Three pillars */}
      <section style={{ maxWidth: 1100, margin: "0 auto", paddingBottom: "clamp(40px, 7vh, 80px)" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "var(--space-md)",
          }}
        >
          {PILLARS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="lc-card">
              <div className="lc-card__inner">
                <Icon size={22} style={{ color: "var(--accent-ink)" }} aria-hidden />
                <h2 style={{ fontFamily: "var(--font-body)", fontSize: "1.05rem", fontWeight: 600, margin: "var(--space-sm) 0 var(--space-xs)" }}>
                  {title}
                </h2>
                <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
                  {body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 3. The loop */}
      <section style={{ maxWidth: 1100, margin: "0 auto", paddingBottom: "clamp(40px, 7vh, 80px)" }}>
        <span className="lc-eyebrow">THE LOOP</span>
        <p style={{ fontFamily: "var(--font-body)", fontSize: "1.1rem", color: "var(--text-primary)", margin: "12px 0 var(--space-lg)", maxWidth: "52ch" }}>
          A system, not a stack of screens — every night flows through the same pipeline.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-sm)" }}>
          {LOOP.map((step, i) => (
            <span key={step} style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-sm)" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                  background: "var(--bg-surface)",
                  borderRadius: "var(--radius-sm)",
                  padding: "8px 12px",
                }}
              >
                {step}
              </span>
              {i < LOOP.length - 1 && <ArrowRight size={14} style={{ color: "var(--accent-ink)", flexShrink: 0 }} aria-hidden />}
            </span>
          ))}
        </div>
      </section>

      {/* 4. Differentiator */}
      <section style={{ maxWidth: 1100, margin: "0 auto", paddingBottom: "clamp(40px, 7vh, 80px)" }}>
        <div className="lc-card" style={{ borderLeft: "3px solid var(--brand-primary)" }}>
          <div className="lc-card__inner" style={{ display: "flex", gap: "var(--space-md)", alignItems: "flex-start" }}>
            <Target size={22} style={{ color: "var(--accent-ink)", flexShrink: 0, marginTop: 2 }} aria-hidden />
            <div>
              <h2 style={{ fontFamily: "var(--font-body)", fontSize: "1.05rem", fontWeight: 600, margin: "0 0 var(--space-xs)" }}>
                Eval-gated, not vibes
              </h2>
              <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: 1.6, margin: 0, maxWidth: "62ch" }}>
                Every agent recommendation — risk, memo, underwriting — is scored against a rubric in
                CI. The AI ships only when the numbers hold, so the calls you see are calibrated, not
                guessed.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 5. One-click demo */}
      <section id="demo" style={{ maxWidth: 1100, margin: "0 auto", scrollMarginTop: "var(--space-xl)" }}>
        <span className="lc-eyebrow">SEE IT LIVE</span>
        <h2 className="lc-display" style={{ fontSize: "clamp(1.5rem, 2.5vw, 2.2rem)", marginTop: 12 }}>
          Step inside the demo.
        </h2>
        <p className="lc-sub" style={{ marginTop: 10, maxWidth: "52ch" }}>
          One click drops you into the live product as any persona. Real data, no signup.
        </p>
        {error && (
          <p role="alert" style={{ color: "var(--state-error)", fontSize: "var(--text-sm)", marginTop: "var(--space-sm)" }}>
            {error}
          </p>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: "var(--space-md)",
            marginTop: "var(--space-lg)",
          }}
        >
          {DEMOS.map(({ label, email, home, icon: Icon }) => (
            <button
              key={email}
              type="button"
              onClick={() => runDemo(email, home)}
              disabled={busy !== null}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-sm)",
                minHeight: 56,
                padding: "0 var(--space-md)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-md)",
                cursor: busy ? "wait" : "pointer",
                fontFamily: "var(--font-body)",
                fontSize: "0.95rem",
                fontWeight: 500,
                color: "var(--text-primary)",
                opacity: busy && busy !== email ? 0.5 : 1,
                transition: "border-color 120ms, background 120ms",
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-sm)" }}>
                <Icon size={18} style={{ color: "var(--accent-ink)" }} aria-hidden />
                {label}
              </span>
              {busy === email ? (
                <span className="loading-spinner" style={{ width: 16, height: 16 }} />
              ) : (
                <ArrowRight size={16} style={{ color: "var(--accent-ink)" }} aria-hidden />
              )}
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
