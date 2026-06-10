"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { accountApi, AccountError } from "@/lib/account";
import { toastSuccess } from "@/lib/toast";
import { User, Shield, LogOut, Check, Eye, EyeOff, ShieldCheck } from "lucide-react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SettingsPage() {
  const router = useRouter();
  const { user, signOut, isSignedIn, refreshUser } = useAuth();
  const role = useRole();
  const [activeTab, setActiveTab] = useState("profile");

  const isBroker = role === "broker" || role === "admin";

  const tabs = [
    { id: "profile", label: "Profile", icon: User },
    { id: "security", label: "Security", icon: Shield },
    // Coverage is operator-only (links to /coverage). Team + 2FA were
    // placeholder "coming soon" surfaces — removed until they're real.
    ...(!isBroker ? [{ id: "coverage", label: "Coverage", icon: ShieldCheck }] : []),
  ];

  const handleSignOut = () => { signOut(); router.push("/"); };

  if (!isSignedIn) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  return (
    <div className="page">
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            SETTINGS
            <span className="lc-eyebrow__sep" />
            {isBroker ? "BROKERAGE" : "VENUE"}
          </span>
          <h1 className="lc-display">Account <em>settings</em></h1>
          <p className="lc-sub">
            {isBroker ? "Manage your account and brokerage" : "Manage your account and venue"}
          </p>
        </div>
        <div className="lc-hero__meta">
          <button onClick={handleSignOut} className="btn btn-ghost"><LogOut size={18} /> Sign Out</button>
        </div>
      </section>

      <div className="settings-tabs">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} className={`settings-tab ${activeTab === tab.id ? "active" : ""}`} onClick={() => setActiveTab(tab.id)}>
              <Icon size={16} /> {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "profile" && (
        <ProfileTab
          key={user?.id}
          initialName={user?.name ?? ""}
          initialEmail={user?.email ?? ""}
          role={user?.role ?? ""}
          onSaved={refreshUser}
        />
      )}

      {activeTab === "security" && <SecurityTab onSignOut={handleSignOut} />}

      {activeTab === "coverage" && !isBroker && (
        <div className="settings-section animate-fade-in">
          <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <div>
              <h4 style={{ marginBottom: 4 }}>Your coverage</h4>
              <p style={{ fontSize: "0.85rem", color: "var(--text-tertiary)" }}>
                View your active policies and coverage lines.
              </p>
            </div>
            <button className="btn btn-secondary" onClick={() => router.push("/coverage")}>
              View coverage
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Profile ────────────────────────────────────────────────────────────────

function ProfileTab({
  initialName,
  initialEmail,
  role,
  onSaved,
}: {
  initialName: string;
  initialEmail: string;
  role: string;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const nameValid = trimmedName.length > 0;
  const emailValid = EMAIL_RE.test(trimmedEmail);
  const dirty = trimmedName !== initialName || trimmedEmail.toLowerCase() !== initialEmail.toLowerCase();
  const canSave = dirty && nameValid && emailValid && !saving;

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await accountApi.updateProfile({ name: trimmedName, email: trimmedEmail });
      await onSaved();
      toastSuccess("Profile updated");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof AccountError ? e.message : "Couldn't save your changes. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section animate-fade-in">
      <div className="flex items-center gap-lg mb-xl">
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: "rgba(200,240,0,0.1)", border: "2px solid var(--brand-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.5rem", fontWeight: 700, color: "var(--accent-ink)" }}>
          {trimmedName?.[0]?.toUpperCase() ?? "U"}
        </div>
        <div>
          <h2 style={{ fontSize: "1.25rem", marginBottom: 4 }}>{trimmedName || "Your name"}</h2>
          <p style={{ color: "var(--text-tertiary)", fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{role.replace(/_/g, " ")}</p>
        </div>
      </div>
      <div className="settings-form">
        <div className="input-wrapper">
          <label className="input-label" htmlFor="profile-name">Full Name</label>
          <input
            id="profile-name"
            type="text"
            className="input-field"
            value={name}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
          {!nameValid && <p className="input-error" role="alert">Name can't be empty.</p>}
        </div>
        <div className="input-wrapper">
          <label className="input-label" htmlFor="profile-email">Email</label>
          <input
            id="profile-email"
            type="email"
            className="input-field"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
          {trimmedEmail.length > 0 && !emailValid && <p className="input-error" role="alert">Enter a valid email address.</p>}
        </div>
        <div className="input-wrapper">
          <label className="input-label" htmlFor="profile-role">Role</label>
          <input id="profile-role" type="text" className="input-field" value={role.replace(/_/g, " ")} readOnly style={{ color: "var(--text-tertiary)" }} />
        </div>
        {error && <p className="input-error" role="alert">{error}</p>}
        <div className="flex justify-end">
          <button className="btn btn-primary" onClick={handleSave} disabled={!canSave}>
            {saving ? "Saving…" : saved ? <><Check size={16} /> Saved</> : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Security ─────────────────────────────────────────────────────────────

function SecurityTab({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="settings-section animate-fade-in">
      <ChangePasswordCard />
      <div className="security-card">
        <div className="security-info">
          <h4>Session</h4>
          <p>Active on this device · Last seen just now</p>
        </div>
        <button className="btn btn-ghost" style={{ color: "var(--state-error)" }} onClick={onSignOut}>Sign Out</button>
      </div>
    </div>
  );
}

function ChangePasswordCard() {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lengthOk = newPw.length >= 6;
  const matchOk = newPw === confirmPw;
  const canSubmit = oldPw.length > 0 && lengthOk && matchOk && !busy;

  const handleSubmit = async () => {
    setError(null);
    setBusy(true);
    try {
      await accountApi.changePassword({ old_password: oldPw, new_password: newPw });
      toastSuccess("Password changed");
      setDone(true);
      setOldPw(""); setNewPw(""); setConfirmPw("");
      setTimeout(() => setDone(false), 3000);
    } catch (e) {
      setError(e instanceof AccountError ? e.message : "Couldn't change your password. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="security-card mb-lg" style={{ flexDirection: "column", alignItems: "stretch", gap: 14 }}>
      <div className="security-info">
        <h4>Change Password</h4>
        <p>Use at least 6 characters. You'll stay signed in on this device.</p>
      </div>
      <div className="settings-form">
        <div className="input-wrapper">
          <label className="input-label" htmlFor="old-pw">Current password</label>
          <input id="old-pw" type={show ? "text" : "password"} className="input-field" value={oldPw} autoComplete="current-password" onChange={(e) => setOldPw(e.target.value)} />
        </div>
        <div className="input-wrapper">
          <label className="input-label" htmlFor="new-pw">New password</label>
          <input id="new-pw" type={show ? "text" : "password"} className="input-field" value={newPw} autoComplete="new-password" onChange={(e) => setNewPw(e.target.value)} />
          {newPw.length > 0 && !lengthOk && <p className="input-error" role="alert">Must be at least 6 characters.</p>}
        </div>
        <div className="input-wrapper">
          <label className="input-label" htmlFor="confirm-pw">Confirm new password</label>
          <input id="confirm-pw" type={show ? "text" : "password"} className="input-field" value={confirmPw} autoComplete="new-password" onChange={(e) => setConfirmPw(e.target.value)} />
          {confirmPw.length > 0 && !matchOk && <p className="input-error" role="alert">Passwords don't match.</p>}
        </div>
        {error && <p className="input-error" role="alert">{error}</p>}
        <div className="flex justify-end" style={{ gap: 10, alignItems: "center" }}>
          <button type="button" className="btn btn-ghost" onClick={() => setShow((s) => !s)}>
            {show ? <><EyeOff size={15} /> Hide</> : <><Eye size={15} /> Show</>}
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? "Updating…" : done ? <><Check size={16} /> Updated</> : "Change Password"}
          </button>
        </div>
      </div>
    </div>
  );
}

