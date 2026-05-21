"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { User, Shield, CreditCard, Users, LogOut, Check, Building2, FileText } from "lucide-react";

export default function SettingsPage() {
  const router = useRouter();
  const { user, signOut, isSignedIn } = useAuth();
  const role = useRole();
  const [activeTab, setActiveTab] = useState("profile");
  const [saved, setSaved] = useState(false);

  const isBroker = role === "broker" || role === "admin";

  const tabs = [
    { id: "profile", label: "Profile", icon: User },
    { id: "security", label: "Security", icon: Shield },
    ...(isBroker ? [{ id: "team", label: "Team", icon: Users }] : []),
    { id: "coverage", label: "Coverage", icon: FileText },
  ];

  const handleSignOut = () => { signOut(); router.push("/login"); };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

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
        <div className="settings-section animate-fade-in">
          <div className="flex items-center gap-lg mb-xl">
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(212,255,0,0.1)', border: '2px solid var(--brand-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', fontWeight: 700, color: 'var(--brand-primary)' }}>
              {user?.name?.[0] ?? "U"}
            </div>
            <div>
              <h2 style={{ fontSize: '1.25rem', marginBottom: 4 }}>{user?.name}</h2>
              <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{user?.role?.replace("_", " ")}</p>
            </div>
          </div>
          <div className="settings-form">
            <div className="input-wrapper">
              <label className="input-label">Full Name</label>
              <input type="text" className="input-field" defaultValue={user?.name ?? ""} />
            </div>
            <div className="input-wrapper">
              <label className="input-label">Email</label>
              <input type="email" className="input-field" defaultValue={user?.email ?? ""} />
            </div>
            <div className="input-wrapper">
              <label className="input-label">Role</label>
              <input type="text" className="input-field" value={user?.role?.replace("_", " ") ?? ""} readOnly style={{ color: 'var(--text-tertiary)' }} />
            </div>
            <div className="flex justify-end">
              <button className="btn btn-primary" onClick={handleSave}>
                {saved ? <><Check size={16} /> Saved</> : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === "security" && (
        <div className="settings-section animate-fade-in">
          <div className="security-card mb-lg">
            <div className="security-info">
              <h4>Two-Factor Authentication</h4>
              <p>Add an extra layer of security with an authenticator app</p>
            </div>
            <button className="btn btn-secondary">Enable 2FA</button>
          </div>
          <div className="security-card mb-lg">
            <div className="security-info">
              <h4>Session Management</h4>
              <p>Active on this device · Last seen just now</p>
            </div>
            <button className="btn btn-ghost" style={{ color: 'var(--state-error)' }} onClick={handleSignOut}>Sign Out All</button>
          </div>
          <div className="security-card">
            <div className="security-info">
              <h4>Password</h4>
              <p>Last changed never</p>
            </div>
            <button className="btn btn-secondary">Change Password</button>
          </div>
        </div>
      )}

      {activeTab === "team" && isBroker && (
        <div className="settings-section animate-fade-in">
          <div className="team-list mb-lg">
            {[
              { name: user?.name ?? "You", email: user?.email ?? "", role: "Admin", isYou: true },
              { name: "Alex Rivera", email: "alex@nightline.risk", role: "Underwriter", isYou: false },
              { name: "Sam Patel", email: "sam@nightline.risk", role: "Claims Lead", isYou: false },
            ].map((member) => (
              <div key={member.email} className="team-member">
                <div className="team-avatar">{member.name[0]}</div>
                <div className="team-info">
                  <span className="team-name">{member.name} {member.isYou && <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>(you)</span>}</span>
                  <span className="team-email">{member.email}</span>
                </div>
                <span className="team-role">{member.role}</span>
              </div>
            ))}
          </div>
          <button className="btn btn-secondary"><Users size={16} /> Invite Member</button>
        </div>
      )}

      {activeTab === "coverage" && (
        <div className="settings-section animate-fade-in">
          <div className="flex flex-col gap-md">
            {[
              { label: "Liquor Liability", status: "Active", detail: "$1M per occurrence", icon: Shield },
              { label: "General Liability", status: "Active", detail: "$2M aggregate", icon: Shield },
              { label: "Property Coverage", status: "Optional", detail: "Not enrolled", icon: Building2 },
              { label: "Workers Compensation", status: "Optional", detail: "Not enrolled", icon: Users },
            ].map((item) => (
              <div key={item.label} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h4 style={{ marginBottom: 4 }}>{item.label}</h4>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>{item.detail}</p>
                </div>
                <span className={`badge ${item.status === "Active" ? "badge-success" : "badge-info"}`}>
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
