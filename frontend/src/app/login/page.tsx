"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { toastError, toastSuccess } from "@/lib/toast";
import { Building2, Shield, ArrowRight } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("venue_operator");

  const performSignIn = async (creds: { email: string; password: string }) => {
    setLoading(true);
    setError("");
    try {
      await signIn(creds.email, creds.password);
      router.replace("/dashboard");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      setError(message);
      toastError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSignUp) {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000"}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, name, role }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Registration failed");
        localStorage.setItem("auth_token", data.access_token);
        toastSuccess("Account created successfully!");
        router.replace("/dashboard");
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
          <div className="lc-login__tabs">
            <button
              className={`lc-login__tab ${!isSignUp ? "is-active" : ""}`}
              onClick={() => setIsSignUp(false)}
              type="button"
            >01 / Sign in</button>
            <button
              className={`lc-login__tab ${isSignUp ? "is-active" : ""}`}
              onClick={() => setIsSignUp(true)}
              type="button"
            >02 / Create account</button>
          </div>

          <h1 className="lc-login__heading">
            {isSignUp ? <>Open a <em>new line</em>.</> : <>Welcome <em>back</em>.</>}
          </h1>

          <form onSubmit={handleSubmit} className="lc-login__form">
            {error && <div className="lc-login__error">{error}</div>}

            {isSignUp && (
              <Input
                label="Full name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                required
              />
            )}

            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@venue.com"
              required
            />

            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />

            {isSignUp && (
              <div className="lc-login__role">
                <span className="lc-stat-label">I am a</span>
                <div className="lc-login__role-grid">
                  <button
                    type="button"
                    className={`lc-login__role-cell ${role === "venue_operator" ? "is-active" : ""}`}
                    onClick={() => setRole("venue_operator")}
                  >
                    <Building2 size={18} />
                    <span>Venue Owner</span>
                  </button>
                  <button
                    type="button"
                    className={`lc-login__role-cell ${role === "broker" ? "is-active" : ""}`}
                    onClick={() => setRole("broker")}
                  >
                    <Shield size={18} />
                    <span>Broker</span>
                  </button>
                </div>
              </div>
            )}

            <Button type="submit" isLoading={loading} className="w-full">
              {isSignUp ? "Create account" : "Sign in"}
              <ArrowRight size={18} />
            </Button>
          </form>

          <div className="lc-login__demo">
            <span className="lc-stat-label">Demo accounts</span>
            <div className="lc-login__demo-row">
              <button
                type="button"
                className="lc-login__demo-btn"
                data-tone="indigo"
                disabled={loading}
                onClick={() => performSignIn({ email: "venue@elsewhere.com", password: "demo123" })}
              >
                Venue operator <ArrowRight size={13} />
              </button>
              <button
                type="button"
                className="lc-login__demo-btn"
                data-tone="lime"
                disabled={loading}
                onClick={() => performSignIn({ email: "broker@thirdspace.risk", password: "demo123" })}
              >
                Broker portfolio <ArrowRight size={13} />
              </button>
            </div>
          </div>

          <p className="lc-login__back">
            <Link href="/">← Back home</Link>
          </p>
        </div>

        <div className="lc-login__quote">
          <p>&ldquo;Keep cultural businesses alive.&rdquo;</p>
          <span>Nightline · Backed by a16z SpeedRun &amp; Dorm Room Fund</span>
        </div>
      </div>
    </div>
  );
}
