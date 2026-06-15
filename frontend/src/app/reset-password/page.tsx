"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { accountApi } from "@/lib/account";
import { toastSuccess } from "@/lib/toast";
import { ArrowRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ds/button";
import { Input } from "@/components/ds/input";
import { Label } from "@/components/ds/label";

// "Paper & Ink" reset-password — sibling of the migrated login. Warm paper,
// ink text, a signature lime CTA, one handwritten Caveat flourish, rebuilt on
// the shadcn ds/ primitives. Every text element carries an explicit colour
// (the migration rule) so the legacy `h1,h2,h3 { color: ink }` rule can't
// hijack inherited colour.

const DISPLAY = { fontFamily: "var(--font-display)" } as const;
const SCRIPT = { fontFamily: "var(--font-caveat)" } as const;

function ResetPasswordInner() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";

  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const lengthOk = newPw.length >= 6;
  const matchOk = newPw === confirmPw;
  const canSubmit = !!token && lengthOk && matchOk && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await accountApi.resetPassword({ token, new_password: newPw });
      toastSuccess("Password updated. Please sign in.");
      router.replace("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reset your password.");
    } finally {
      setLoading(false);
    }
  };

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
            A fresh <span className="text-[#5A6E00]">key</span> to your workspace.
          </h1>
          <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-muted-foreground">
            Choose a new password and you&apos;re back in — live risk, capacity, and
            compliance across your portfolio.
          </p>
        </div>

        <p className="relative text-xl text-foreground/55" style={SCRIPT}>
          Keep cultural businesses alive.
        </p>
      </aside>

      {/* ── RIGHT · reset form ─────────────────────────────────────────── */}
      <main className="relative flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <Link href="/" className="mb-8 flex items-center gap-2.5 lg:hidden">
            <img src="/nightline-mark.svg" alt="Nightline" width={36} height={36} className="rounded-lg border border-border" />
            <span className="text-base font-semibold tracking-tight text-foreground">
              Nightline <span className="font-normal text-muted-foreground">Risk OS</span>
            </span>
          </Link>

          <h2 className="text-[1.8rem] font-bold leading-tight tracking-tight text-foreground" style={DISPLAY}>
            Set a new password
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Choose a password you don&apos;t use anywhere else.
          </p>

          {!token ? (
            <div
              role="alert"
              className="mt-8 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              This reset link is missing its token. Request a new one from the sign-in page.
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
              {error && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </div>
              )}

              <div className="grid gap-2">
                <Label htmlFor="new-password" className="text-foreground">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  required
                />
                {newPw.length > 0 && !lengthOk && (
                  <p className="text-xs text-destructive" role="alert">Must be at least 6 characters.</p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="confirm-password" className="text-foreground">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  required
                />
                {confirmPw.length > 0 && !matchOk && (
                  <p className="text-xs text-destructive" role="alert">Passwords don&apos;t match.</p>
                )}
              </div>

              <Button type="submit" disabled={!canSubmit} className="mt-1 w-full border border-foreground/15">
                {loading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <>
                    Reset password
                    <ArrowRight />
                  </>
                )}
              </Button>
            </form>
          )}

          <p className="mt-8 text-sm text-muted-foreground">
            <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
              ← Back to sign in
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="page-loading"><div className="loading-spinner" /></div>}>
      <ResetPasswordInner />
    </Suspense>
  );
}
