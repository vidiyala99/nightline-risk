"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { accountApi } from "@/lib/account";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { toastSuccess } from "@/lib/toast";
import { ArrowRight } from "lucide-react";

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
    <div className="lc-login">
      <div className="lc-login__stage">
        <Link href="/" className="lc-login__brand">
          <span className="lc-login__logo"><img src="/nightline-mark.svg" alt="Nightline" width={44} height={44} /></span>
          <span>
            <strong>Nightline</strong>
            <em>Risk OS</em>
          </span>
        </Link>

        <div className="lc-login__card">
          <h1 className="lc-login__heading">Set a <em>new password</em>.</h1>

          {!token ? (
            <div className="lc-login__error">
              This reset link is missing its token. Request a new one from the sign-in page.
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="lc-login__form">
              {error && <div className="lc-login__error">{error}</div>}

              <Input
                label="New password"
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                required
              />
              {newPw.length > 0 && !lengthOk && <p className="input-error" role="alert">Must be at least 6 characters.</p>}

              <Input
                label="Confirm new password"
                type="password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                required
              />
              {confirmPw.length > 0 && !matchOk && <p className="input-error" role="alert">Passwords don't match.</p>}

              <Button type="submit" isLoading={loading} disabled={!canSubmit} className="w-full">
                Reset password
                <ArrowRight size={18} />
              </Button>
            </form>
          )}

          <p className="lc-login__back">
            <Link href="/login">← Back to sign in</Link>
          </p>
        </div>
      </div>
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
