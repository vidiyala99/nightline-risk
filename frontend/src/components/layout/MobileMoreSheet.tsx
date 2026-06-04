"use client";

// Mobile "More" overflow sheet — mirrors mobile/src/screens/MoreScreen.tsx.
// On phone widths the bottom nav (+ this sheet) is the *only* navigation; there
// is no sidebar/hamburger, so every off-tab destination must live here.
// Broker overflow matches RN row-for-row. Operator overflow differs by platform:
// web surfaces Coverage (its own route), RN surfaces Live Terminal (web reaches
// the floor via /terminal elsewhere) — both keep their persona's screens reachable.

import Link from "next/link";
import { useEffect } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  Building2,
  CheckSquare,
  ChevronRight,
  Database,
  FileSearch,
  FileSpreadsheet,
  FileText,
  ListChecks,
  LogOut,
  MapPin,
  Settings,
  ShieldCheck,
  TrendingUp,
  X,
} from "lucide-react";
import { useRole, useAuth } from "@/contexts/AuthContext";

type LucideIcon = typeof Activity;
type Row = { href: string; label: string; description: string; icon: LucideIcon };

const OPERATOR_OVERFLOW: Row[] = [
  { href: "/alerts",          label: "Alerts",          description: "Real-time liability detections",  icon: Bell },
  { href: "/venues",          label: "Venues",          description: "Your venue profile & roster",      icon: Building2 },
  { href: "/coverage",        label: "Coverage",        description: "Coverage lines & limits",          icon: ShieldCheck },
  { href: "/settings",        label: "Settings",        description: "Account and preferences",          icon: Settings },
];

const STAFF_OVERFLOW: Row[] = [
  { href: "/settings",        label: "Settings",        description: "Account and preferences",          icon: Settings },
];

const BROKER_OVERFLOW: Row[] = [
  { href: "/book",            label: "Book Financials", description: "Premium, commission & loss ratio",       icon: TrendingUp },
  { href: "/policies",        label: "Policies",        description: "Your in-force book",                     icon: FileSpreadsheet },
  { href: "/tasks",           label: "Tasks",           description: "Renewals & requests needing attention", icon: ListChecks },
  { href: "/incidents",       label: "Incidents",       description: "Operator-filed incidents to review",     icon: AlertTriangle },
  { href: "/compliance",      label: "Compliance",      description: "Venue compliance items",                 icon: CheckSquare },
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
  const isStaff = role === "staff";
  const rows = isStaff ? STAFF_OVERFLOW : isBroker ? BROKER_OVERFLOW : OPERATOR_OVERFLOW;

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
              <span className="mobile-more-sheet__who">{user.name} · {isBroker ? "BROKER" : isStaff ? "STAFF" : "OPERATOR"}</span>
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
