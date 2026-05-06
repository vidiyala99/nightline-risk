"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { toastError, toastSuccess } from "@/lib/toast";
import { Building2, Shield, ArrowRight, Sparkles } from "lucide-react";

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (isSignUp) {
        const response = await fetch("http://127.0.0.1:8000/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, name, role }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Registration failed");
        localStorage.setItem("auth_token", data.access_token);
        toastSuccess("Account created successfully!");
        router.replace("/dashboard");
      } else {
        await signIn(email, password);
        router.replace("/dashboard");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      setError(message);
      toastError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-background">
        <div className="login-gradient-1" />
        <div className="login-gradient-2" />
        <div className="login-grid-pattern" />
      </div>
      
      <div className="login-container animate-fade-in">
        <div className="login-header">
          <div className="login-logo">
            <Building2 size={28} />
          </div>
          <h1>Third Space</h1>
          <p>AI-Powered Insurance for Nightlife</p>
        </div>

        <div className="login-card">
          <div className="login-tabs">
            <button 
              className={`login-tab ${!isSignUp ? "active" : ""}`}
              onClick={() => setIsSignUp(false)}
            >
              Sign In
            </button>
            <button 
              className={`login-tab ${isSignUp ? "active" : ""}`}
              onClick={() => setIsSignUp(true)}
            >
              Create Account
            </button>
          </div>

          <form onSubmit={handleSubmit} className="login-form">
            {error && <div className="login-error">{error}</div>}
          
            {isSignUp && (
              <Input
                label="Full Name"
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
              <div className="role-select">
                <label className="role-label">I am a</label>
                <div className="role-options">
                  <button
                    type="button"
                    className={`role-option ${role === "venue_operator" ? "active" : ""}`}
                    onClick={() => setRole("venue_operator")}
                  >
                    <Building2 size={18} />
                    <span>Venue Owner</span>
                  </button>
                  <button
                    type="button"
                    className={`role-option ${role === "broker" ? "active" : ""}`}
                    onClick={() => setRole("broker")}
                  >
                    <Shield size={18} />
                    <span>Broker</span>
                  </button>
                </div>
              </div>
            )}
            
            <Button type="submit" isLoading={loading} className="w-full">
              {isSignUp ? "Create Account" : "Sign In"}
              <ArrowRight size={18} />
            </Button>
          </form>

          <div className="login-footer">
            <p className="demo-note">
              <Sparkles size={14} />
              Demo: broker@thirdspace.risk / demo123
            </p>
          </div>
        </div>

        <p className="login-back">
          <Link href="/">← Back to Home</Link>
        </p>
      </div>

      <style jsx>{`
        .login-page {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          overflow: hidden;
          padding: 24px;
        }

        .login-background {
          position: absolute;
          inset: 0;
          z-index: 0;
        }

        .login-gradient-1 {
          position: absolute;
          width: 600px;
          height: 600px;
          background: radial-gradient(circle, rgba(212, 255, 0, 0.08) 0%, transparent 70%);
          top: -200px;
          left: -100px;
        }

        .login-gradient-2 {
          position: absolute;
          width: 500px;
          height: 500px;
          background: radial-gradient(circle, rgba(0, 240, 255, 0.07) 0%, transparent 70%);
          bottom: -150px;
          right: -100px;
        }

        .login-grid-pattern {
          position: absolute;
          inset: 0;
          background-image: 
            linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
          background-size: 60px 60px;
        }

        .login-container {
          position: relative;
          z-index: 1;
          width: 100%;
          max-width: 420px;
        }

        .login-header {
          text-align: center;
          margin-bottom: 32px;
        }

        .login-logo {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 56px;
          height: 56px;
          border-radius: 16px;
          background: linear-gradient(135deg, rgba(212, 255, 0, 0.15) 0%, rgba(0, 240, 255, 0.15) 100%);
          border: 1px solid rgba(212, 255, 0, 0.3);
          color: var(--brand-primary);
          margin-bottom: 16px;
        }

        .login-header h1 {
          font-size: 2rem;
          margin-bottom: 4px;
          background: linear-gradient(135deg, #fff 0%, var(--brand-primary) 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .login-header p {
          color: var(--text-tertiary);
          font-size: 0.9rem;
        }

        .login-card {
          background: rgba(22, 25, 32, 0.8);
          backdrop-filter: blur(20px);
          border: 1px solid var(--border-subtle);
          border-radius: 24px;
          padding: 32px;
        }

        .login-tabs {
          display: flex;
          gap: 4px;
          background: var(--bg-dark);
          padding: 4px;
          border-radius: 12px;
          margin-bottom: 24px;
        }

        .login-tab {
          flex: 1;
          padding: 10px;
          background: transparent;
          border: none;
          border-radius: 8px;
          color: var(--text-tertiary);
          font-size: 0.9rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .login-tab:hover { color: var(--text-secondary); }

        .login-tab.active {
          background: var(--bg-surface);
          color: var(--brand-primary);
        }

        .login-form {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .login-error {
          padding: 12px;
          background: rgba(255, 0, 110, 0.1);
          border: 1px solid rgba(255, 0, 110, 0.3);
          border-radius: 8px;
          color: var(--state-error);
          font-size: 0.85rem;
        }

        .role-select { margin-bottom: 8px; }

        .role-label {
          display: block;
          font-size: 0.75rem;
          font-weight: 500;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 8px;
        }

        .role-options {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }

        .role-option {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          padding: 16px;
          background: var(--bg-surface);
          border: 1px solid var(--border-default);
          border-radius: 12px;
          color: var(--text-tertiary);
          font-size: 0.85rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .role-option:hover {
          border-color: var(--brand-primary);
          color: var(--text-secondary);
        }

        .role-option.active {
          border-color: var(--brand-primary);
          background: rgba(212, 255, 0, 0.08);
          color: var(--brand-primary);
        }

        .login-footer {
          margin-top: 24px;
          padding-top: 24px;
          border-top: 1px solid var(--border-subtle);
        }

        .demo-note {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          font-size: 0.8rem;
          color: var(--text-tertiary);
        }

        .login-back {
          text-align: center;
          margin-top: 24px;
        }

        .login-back a {
          color: var(--text-tertiary);
          font-size: 0.85rem;
        }

        .login-back a:hover {
          color: var(--brand-primary);
        }
      `}</style>
    </div>
  );
}