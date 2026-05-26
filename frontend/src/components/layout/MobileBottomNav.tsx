"use client";

// Mobile bottom nav — role-aware primary set capped at 5 (4 destinations + More).
// Keep in sync with the React Native tab bar in
// mobile/src/navigation/TabNavigator.tsx (same order, icons, labels).

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  AlertTriangle,
  CheckSquare,
  Building2,
  FileSpreadsheet,
  Menu,
} from "lucide-react";
import { useRole, useTenantId } from "@/contexts/AuthContext";

type NavIcon = typeof LayoutDashboard;
type PrimaryItem = { key: string; href: string; label: string; icon: NavIcon };

const OPERATOR_PRIMARY: PrimaryItem[] = [
  { key: "dashboard",  href: "/dashboard",  label: "Dashboard",  icon: LayoutDashboard },
  { key: "incidents",  href: "/incidents",  label: "Incidents",  icon: AlertTriangle },
  { key: "compliance", href: "/compliance", label: "Compliance", icon: CheckSquare },
  { key: "venues",     href: "/venues",     label: "Venues",     icon: Building2 },
];

const BROKER_PRIMARY: PrimaryItem[] = [
  { key: "dashboard",  href: "/dashboard",  label: "Portfolio",  icon: LayoutDashboard },
  { key: "incidents",  href: "/incidents",  label: "Incidents",  icon: AlertTriangle },
  { key: "claims",     href: "/claims",     label: "Claims",     icon: FileSpreadsheet },
  { key: "compliance", href: "/compliance", label: "Compliance", icon: CheckSquare },
];

export function MobileBottomNav({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tenantId = useTenantId();
  const role = useRole();

  const primary = role === "broker" || role === "admin" ? BROKER_PRIMARY : OPERATOR_PRIMARY;

  // Mirror the venue-context priority used in AppShell NavLinks so deep links
  // keep their venue when switching via bottom-nav.
  const queryVenueId = searchParams.get("venue");
  const terminalMatch = pathname?.match(/^\/terminal\/([^/]+)/);
  const contextVenueId = queryVenueId ?? terminalMatch?.[1] ?? tenantId ?? null;
  const venueQuery = contextVenueId ? `?venue=${encodeURIComponent(contextVenueId)}` : "";

  return (
    <nav className="mobile-bottom-nav" aria-label="Primary (mobile)">
      {primary.map(({ key, href, label, icon: Icon }) => {
        const fullHref = `${href}${venueQuery}`;
        const isActive = pathname === href || pathname?.startsWith(href + "/");
        return (
          <Link
            key={key}
            href={fullHref}
            className={`mobile-bottom-nav__item${isActive ? " active" : ""}`}
            aria-current={isActive ? "page" : undefined}
            aria-label={label}
          >
            <Icon size={20} aria-hidden />
            <span className="mobile-bottom-nav__label">{label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        className="mobile-bottom-nav__item"
        onClick={onMore}
        aria-label="More navigation"
      >
        <Menu size={20} aria-hidden />
        <span className="mobile-bottom-nav__label">More</span>
      </button>
    </nav>
  );
}
