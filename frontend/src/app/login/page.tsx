"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth, roleHome } from "@/contexts/AuthContext";
import { accountApi } from "@/lib/account";
import { toastError, toastSuccess } from "@/lib/toast";
import { ArrowRight, Loader2, ShieldCheck, Building2, Briefcase, HardHat } from "lucide-react";

import { Button } from "@/components/ds/button";
import { Input } from "@/components/ds/input";
import { Label } from "@/components/ds/label";
import { cn } from "@/lib/utils";

// "Paper & Ink" login — warm paper, ink text, a signature lime CTA, one
// handwritten Caveat flourish — rebuilt on the shadcn ds/ primitives. Every
// text element carries an explicit colour (the migration rule) so the legacy
// `h1,h2,h3 { color: ink }` rule can't hijack inherited colour.

const DEMO_ACCOUNTS = [
  { label: "Venue operator", email: "venue@elsewhere.com", icon: Building2 },
  { label: "Broker portfolio", email: "broker@nightline.risk", icon: Briefcase },
  { label: "Carrier desk", email: "underwriter@nightline.risk", icon: ShieldCheck },
  { label: "Floor staff", email: "staff@elsewhere.com", icon: HardHat },
] as const;

const DISPLAY = { fontFamily: "var(--font-display)" } as const;
const SCRIPT = { fontFamily: "var(--font-caveat)" } as const;

export default function LoginPage() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  const performSignIn = async (creds: { email: string; password: string }) => {
    setLoading(true);
    setError("");
    try {
      const u = await signIn(creds.email, creds.password);
      router.replace(roleHome(u.role));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      setError(message);
      toastError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async () => {
    if (!email.trim()) {
      setError("Enter your email above, then select Forgot password.");
      return;
    }
    try {
      await accountApi.forgotPassword(email.trim());
      toastSuccess("If that email is registered, a reset link has been sent.");
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Request failed");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSignUp) {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000"}/api/auth/register`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, name }),
          }
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Registration failed");
        localStorage.setItem("auth_token", data.access_token);
        toastSuccess("Account created successfully!");
        router.replace(roleHome("venue_operator"));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Request failed";
        setError(message);
        toastError(message);
      } finally {
        setLoading(false);
      }
    } else {
      await performSignIn({ email, password });
    }
  };

  const tabs = [
    { key: false, label: "Sign in" },
    { key: true, label: "Create account" },
  ] as const;

  return (
    <div className="grid min-h-dvh bg-background text-foreground lg:grid-cols-2">
      {/* ── LEFT · editorial paper panel ───────────────────────────────── */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-[#EFE7D3] p-12 lg:flex">
        {/* faint paper grain */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage: "radial-gradient(#17150F 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />

        <Link href="/" className="relative flex items-center gap-3">
          <img src="/nightline-mark.svg" alt="Nightline" width={40} height={40} className="rounded-lg border border-border bg-card p-1" />
          <div className="leading-tight">
            <div className="text-lg font-semibold tracking-tight text-foreground">Nightline</div>
            <div className="text-xs text-muted-foreground">Risk OS</div>
          </div>
        </Link>

        <div className="relative max-w-md">
          <span className="mb-5 inline-block h-[3px] w-12 rounded-full bg-primary" aria-hidden />
          <h1 className="text-[2.7rem] font-bold leading-[1.04] tracking-tight text-foreground" style={DISPLAY}>
            Evidence-first underwriting for{" "}
            <span className="text-[#5A6E00]">nightlife</span>.
          </h1>
          <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-muted-foreground">
            Live risk, capacity, and compliance across your portfolio — priced from
            operational reality, not paperwork.
          </p>
        </div>

        <p className="relative text-xl text-foreground/55" style={SCRIPT}>
          Keep cultural businesses alive.
        </p>
      </aside>

      {/* ── RIGHT · auth ───────────────────────────────────────────────── */}
      <main className="relative flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <Link href="/" className="mb-8 flex items-center gap-2.5 lg:hidden">
            <img src="/nightline-mark.svg" alt="Nightline" width={36} height={36} className="rounded-lg border border-border" />
            <span className="text-base font-semibold tracking-tight text-foreground">
              Nightline <span className="font-normal text-muted-foreground">Risk OS</span>
            </span>
          </Link>

          {/* segmented tabs */}
          <div role="tablist" aria-label="Authentication mode" className="mb-8 inline-flex h-9 w-full items-center rounded-lg border border-border bg-muted p-1">
            {tabs.map((t) => (
              <button
                key={String(t.key)}
                type="button"
                role="tab"
                aria-selected={isSignUp === t.key}
                onClick={() => setIsSignUp(t.key)}
                className={cn(
                  "h-7 flex-1 rounded-md text-sm font-medium transition-all cursor-pointer",
                  isSignUp === t.key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <h2 className="text-[1.8rem] font-bold leading-tight tracking-tight text-foreground" style={DISPLAY}>
            {isSignUp ? "Open a new line" : "Welcome back"}
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {isSignUp
              ? "Create your operator account to get started."
              : "Sign in to your Nightline Risk workspace."}
          </p>

          <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            )}

            {isSignUp && (
              <div className="grid gap-2">
                <Label htmlFor="name" className="text-foreground">Full name</Label>
                <Input
                  id="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  required
                />
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="email" className="text-foreground">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@venue.com"
                required
              />
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-foreground">Password</Label>
                {!isSignUp && (
                  <button
                    type="button"
                    onClick={handleForgot}
                    disabled={loading}
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline cursor-pointer disabled:opacity-50"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <Input
                id="password"
                type="password"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            <Button type="submit" disabled={loading} className="mt-1 w-full border border-foreground/15">
              {loading ? (
                <Loader2 className="animate-spin" />
              ) : (
                <>
                  {isSignUp ? "Create account" : "Sign in"}
                  <ArrowRight />
                </>
              )}
            </Button>
          </form>

          <div className="mt-8">
            <div className="relative mb-4 text-center">
              <span className="relative z-10 bg-background px-3 text-xs uppercase tracking-wider text-muted-foreground">
                Demo accounts
              </span>
              <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {DEMO_ACCOUNTS.map((acct) => {
                const Icon = acct.icon;
                return (
                  <Button
                    key={acct.email}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => performSignIn({ email: acct.email, password: "demo123" })}
                    className="justify-start text-foreground"
                  >
                    <Icon className="text-muted-foreground" />
                    <span className="truncate">{acct.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
