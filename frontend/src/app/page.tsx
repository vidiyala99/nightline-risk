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

import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";

// "Paper & Ink" landing — warm paper, ink text, a signature lime CTA, one
// handwritten Caveat flourish, rebuilt on the shadcn ds/ primitives to match
// the migrated login. Every text element carries an explicit colour (the
// migration rule) so the legacy `h1,h2,h3 { color: ink }` rule can't hijack
// inherited colour.

const DISPLAY = { fontFamily: "var(--font-display)" } as const;
const SCRIPT = { fontFamily: "var(--font-caveat)" } as const;

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
    body: "Incident footage and documents are hashed and corroborated at intake, then exported as one defense package made to beat the assault-and-battery claims driving rate hikes.",
  },
  {
    icon: Landmark,
    title: "An AI-native carrier, end to end",
    body: "Beyond placement: this prototype underwrites its own submissions and adjudicates its own claims — modeling the full carrier loop, not just a quoting tool.",
  },
];

const LOOP = ["Incident", "Hashed evidence", "Risk score", "Underwriting", "Claim", "Defense package"];

// Section eyebrow — lime square + mono uppercase label, matching login's voice.
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.18em] text-[#5A6E00]">
      <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
      {children}
    </span>
  );
}

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
    <main className="relative min-h-dvh overflow-x-clip bg-background text-foreground">
      {/* faint paper grain across the whole page */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-[0.04]"
        style={{
          backgroundImage: "radial-gradient(#17150F 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      <div className="relative mx-auto w-full max-w-5xl px-6 pb-24 sm:px-8">
        {/* ── Brand bar ──────────────────────────────────────────────── */}
        <header className="flex items-center justify-between py-6">
          <span className="flex items-center gap-2.5">
            <img
              src="/nightline-mark.svg"
              alt="Nightline"
              width={34}
              height={34}
              className="rounded-lg border border-border bg-card p-1"
            />
            <span className="text-[1.1rem] font-semibold tracking-tight text-foreground" style={DISPLAY}>
              Nightline
            </span>
          </span>
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center px-2 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Sign in
          </Link>
        </header>

        {/* ── 1 · Hero ───────────────────────────────────────────────── */}
        <section className="pb-16 pt-12 sm:pt-20">
          <Eyebrow>Nightline · Risk OS</Eyebrow>
          <h1
            className="mt-4 max-w-[18ch] text-[2.5rem] font-bold leading-[1.05] tracking-tight text-foreground sm:text-[3.25rem]"
            style={DISPLAY}
          >
            Insurance,{" "}
            <span className="text-[#5A6E00]" style={SCRIPT}>
              rebuilt
            </span>{" "}
            from the evidence up.
          </h1>
          <p className="mt-5 max-w-[60ch] text-[1.05rem] leading-relaxed text-muted-foreground">
            Nightline turns a venue&apos;s operational data and incident evidence into proprietary
            underwriting, lawsuit-ready defense, and carrier-side claims — the full chain, operator
            to broker to carrier.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Button
              type="button"
              size="lg"
              onClick={scrollToDemo}
              className="border border-foreground/15"
            >
              Explore the live demo <ArrowRight />
            </Button>
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center text-sm font-medium text-[#5A6E00] underline-offset-4 hover:underline"
            >
              or sign in →
            </Link>
          </div>
        </section>

        {/* ── 2 · Three pillars ──────────────────────────────────────── */}
        <section className="border-t border-border py-16">
          <Eyebrow>The model</Eyebrow>
          <p className="mb-8 mt-3 max-w-[56ch] text-sm leading-relaxed text-muted-foreground">
            A working prototype on seeded demo data — each pillar runs end to end, so you can click
            through the whole chain rather than read about it.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PILLARS.map(({ icon: Icon, title, body }) => (
              <Card key={title} className="gap-3 p-6">
                <Icon className="size-6 text-[#5A6E00]" aria-hidden />
                <h2 className="text-base font-semibold leading-snug text-foreground">{title}</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
              </Card>
            ))}
          </div>
        </section>

        {/* ── 3 · The loop ───────────────────────────────────────────── */}
        <section className="border-t border-border py-16">
          <Eyebrow>The loop</Eyebrow>
          <p className="mb-8 mt-3 max-w-[52ch] text-[1.05rem] leading-relaxed text-foreground">
            A system, not a stack of screens — every night flows through the same pipeline.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {LOOP.map((step, i) => (
              <span key={step} className="flex items-center gap-2">
                <span className="rounded-md border border-border bg-card px-3 py-2 font-mono text-xs uppercase tracking-wide text-foreground">
                  {step}
                </span>
                {i < LOOP.length - 1 && (
                  <ArrowRight className="size-3.5 shrink-0 text-[#5A6E00]" aria-hidden />
                )}
              </span>
            ))}
          </div>
        </section>

        {/* ── 4 · Differentiator ─────────────────────────────────────── */}
        <section className="border-t border-border py-16">
          <Card className="flex-row items-start gap-4 border-l-[3px] border-l-primary p-6">
            <Target className="mt-0.5 size-6 shrink-0 text-[#5A6E00]" aria-hidden />
            <div className="px-0">
              <h2 className="text-base font-semibold text-foreground">Eval-gated, not vibes</h2>
              <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
                Every agent recommendation — risk, memo, underwriting — is scored against a rubric in
                CI. The AI ships only when the numbers hold, so the calls you see are calibrated, not
                guessed.
              </p>
            </div>
          </Card>
        </section>

        {/* ── 5 · One-click demo ─────────────────────────────────────── */}
        <section id="demo" className="scroll-mt-8 border-t border-border py-16">
          <Eyebrow>See it live</Eyebrow>
          <h2
            className="mt-3 text-[1.8rem] font-bold tracking-tight text-foreground sm:text-[2.2rem]"
            style={DISPLAY}
          >
            Step inside the demo.
          </h2>
          <p className="mt-2 max-w-[52ch] text-[15px] text-muted-foreground">
            One click drops you into the live product as any persona. Real data, no signup.
          </p>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {DEMOS.map(({ label, email, home, icon: Icon }) => (
              <Button
                key={email}
                type="button"
                variant="outline"
                size="lg"
                onClick={() => runDemo(email, home)}
                disabled={busy !== null}
                className="justify-between text-foreground disabled:opacity-50"
                style={{ opacity: busy && busy !== email ? 0.5 : 1 }}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="size-[18px] text-[#5A6E00]" aria-hidden />
                  {label}
                </span>
                {busy === email ? (
                  <span className="loading-spinner" style={{ width: 16, height: 16 }} />
                ) : (
                  <ArrowRight className="size-4 text-[#5A6E00]" aria-hidden />
                )}
              </Button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
