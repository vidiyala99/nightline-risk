"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { User, Shield, CreditCard, Users, LogOut } from "lucide-react";

export default function SettingsPage() {
  const router = useRouter();
  const { user, signOut, isSignedIn, isLoaded } = useAuth();
const role = useRole();
  const [activeTab, setActiveTab] = useState("profile");

  const isBroker = role === "broker" || role === "admin";

  const tabs = [
    { id: "profile", label: "Profile", icon: User },
    { id: "security", label: "Security", icon: Shield },
    { id: "team", label: "Team", icon: Users },
    { id: "billing", label: "Billing", icon: CreditCard },
  ];

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.push("/login");
    }
  }, [isLoaded, isSignedIn, router]);

  const handleSignOut = () => {
    signOut();
    router.push("/login");
  };

  if (!isSignedIn) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="page-subtitle">
            {isBroker 
              ? "Manage your account and organization" 
              : "Manage your account"}
          </p>
        </div>
        <button onClick={handleSignOut} className="btn btn-ghost">
          <LogOut size={18} />
          Sign Out
        </button>
      </header>

      <div className="settings-tabs">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              className={`settings-tab ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={18} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "profile" && (
        <div className="settings-section animate-fade-in">
          <h3>Profile Information</h3>
          <div className="settings-form">
            <div className="input-wrapper">
              <label className="input-label">Full Name</label>
              <input
                type="text"
                className="input-field"
                value={user?.name || ""}
                disabled
              />
            </div>
            <div className="input-wrapper">
              <label className="input-label">Email</label>
              <input
                type="email"
                className="input-field"
                value={user?.email || ""}
                disabled
              />
            </div>
            <p className="settings-hint">
              Contact your broker to update profile information.
            </p>
          </div>
        </div>
      )}

      {activeTab === "security" && (
        <div className="settings-section animate-fade-in">
          <h3>Security Settings</h3>
          <div className="security-card">
            <div className="security-info">
              <h4>Two-Factor Authentication</h4>
              <p>Add an extra layer of security to your account</p>
            </div>
            <button className="btn btn-secondary">
              Enable 2FA
            </button>
          </div>
        </div>
      )}

      {activeTab === "team" && isBroker && (
        <div className="settings-section animate-fade-in">
          <h3>Team Members</h3>
          <div className="team-list">
            <div className="team-member">
              <div className="team-avatar">{user?.name?.[0] || "U"}</div>
              <div className="team-info">
                <span className="team-name">{user?.name || "User"}</span>
                <span className="team-email">{user?.email}</span>
              </div>
              <span className="team-role">Admin</span>
            </div>
          </div>
          <button className="btn btn-secondary mt-md">
            <Users size={18} />
            Invite Member
          </button>
        </div>
      )}

      {activeTab === "team" && !isBroker && (
        <div className="settings-section animate-fade-in">
          <h3>Team Members</h3>
          <div className="team-list">
            <div className="team-member">
              <div className="team-avatar">{user?.name?.[0] || "U"}</div>
              <div className="team-info">
                <span className="team-name">{user?.name || "User"}</span>
                <span className="team-email">{user?.email}</span>
              </div>
              <span className="team-role">Admin</span>
            </div>
          </div>
        </div>
      )}

      {activeTab === "billing" && (
        <div className="settings-section animate-fade-in">
          <h3>Billing</h3>
          <div className="empty-state">
            <CreditCard size={48} />
            <h3>Billing Management</h3>
            <p>Contact support for changes to your subscription.</p>
          </div>
        </div>
      )}
    </div>
  );
}