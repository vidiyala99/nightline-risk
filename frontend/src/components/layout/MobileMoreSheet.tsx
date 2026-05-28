"use client";

// Mobile "More" overflow sheet — mirrors mobile/src/screens/MoreScreen.tsx
// (same row set, same role split, same card layout). Used in place of the
// desktop sidebar drawer when the bottom-nav More button is tapped on phone
// widths, so the web experience matches the React Native app.

import Link from "next/link";
import { useEffect } from "react";
import {
  Activity,
  Bell,
  Building2,
  ChevronRight,
  Database,
  FileSearch,
  FileSpreadsheet,
  FileText,
  ListChecks,
  LogOut,
  MapPin,
  Send,
  Settings,
  X,
} from "lucide-react";
import { useRole, useAuth } from "@/contexts/AuthContext";

type LucideIcon = typeof Activity;
type Row = { href: string; label: string; description: string; icon: LucideIcon };

const OPERATOR_OVERFLOW: Row[] = [
  { href: "/alerts",          label: "Alerts",          description: "Real-time liability detections",  icon: Bell },
  { href: "/terminal",        label: "Live Terminal",   description: "Real-time venue floor activity",  icon: Activity },
  { href: "/claim-proposals", label: "Claim Proposals", description: "Incidents recommended for filing", icon: FileText },
  { href: "/underwriter",     label: "Reports",         description: "Risk and loss reporting",          icon: FileSearch },
  { href: "/settings",        label: "Settings",        description: "Account and preferences",          icon: Settings },
];

const BROKER_OVERFLOW: Row[] = [
  { href: "/tasks",           label: "Tasks",           description: "Renewals & requests needing attention", icon: ListChecks },
  { href: "/submissions",     label: "Submissions",     description: "Place venue risk out to carriers",       icon: Send },
  { href: "/policies",        label: "Policies",        description: "Your in-force book",                     icon: FileSpreadsheet },
  { href: "/venues",          label: "Venues",          description: "Book and prospect venues",               icon: Building2 },
  { href: "/market",          label: "Market",          description: "NYC nightlife prospects & savings",      icon: MapPin },
  { href: "/claim-proposals", label: "Claim Proposals", description: "Operator-filed proposals",               icon: FileText },
  { href: "/underwriter",     label: "Reports",         description: "Underwriting and loss reports",          icon: FileSearch },
  { href: "/ingestion",       label: "Ingestion",       description: "Operational-data connector runs",        icon: Database },
  { href: "/settings",        label: "Settings",        description: "Account and preferences",                icon: Settings },
];

export function MobileMoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const role = useRole();
  const { signOut, user } = useAuth();
  const isBroker = role === "broker" || role === "admin";
  const rows = isBroker ? BROKER_OVERFLOW : OPERATOR_OVERFLOW;

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="mobile-more-sheet__backdrop" onClick={onClose} aria-hidden />
      <aside className="mobile-more-sheet" role="dialog" aria-label="More navigation">
        <header className="mobile-more-sheet__head">
          <div>
            <span className="mobile-more-sheet__eyebrow">NAVIGATION</span>
            <h2 className="mobile-more-sheet__title">More</h2>
            {user?.name && (
              <span className="mobile-more-sheet__who">{user.name} · {isBroker ? "BROKER" : "OPERATOR"}</span>
            )}
          </div>
          <button className="mobile-more-sheet__close" onClick={onClose} aria-label="Close">
            <X size={22} />
          </button>
        </header>

        <div className="mobile-more-sheet__list">
          {rows.map(({ href, label, description, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="mobile-more-sheet__row"
              onClick={onClose}
            >
              <span className="mobile-more-sheet__row-icon">
                <Icon size={20} aria-hidden />
              </span>
              <span className="mobile-more-sheet__row-text">
                <span className="mobile-more-sheet__row-label">{label}</span>
                <span className="mobile-more-sheet__row-desc">{description}</span>
              </span>
              <ChevronRight size={18} aria-hidden />
            </Link>
          ))}
        </div>

        <button
          className="mobile-more-sheet__signout"
          onClick={() => { onClose(); signOut(); }}
        >
          <LogOut size={16} aria-hidden />
          <span>Sign Out</span>
        </button>
      </aside>
    </>
  );
}
