"use client";

import { ReactNode, Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  Building2,
  AlertTriangle,
  CheckSquare,
  FileSearch,
  FileSpreadsheet,
  LogOut,
  Activity,
  Bell,
  Menu,
  X,
  RefreshCw,
  ShieldCheck,
  Inbox,
  ListChecks,
  Database,
} from "lucide-react";
import { useAuth, useRole, useTenantId } from "@/contexts/AuthContext";
import { useBreakpoint, useMounted } from "@/hooks/useBreakpoint";
import { MobileBottomNav } from "@/components/layout/MobileBottomNav";
import { SidebarNavItem } from "@/components/ui/SidebarNavItem";

interface AppShellProps {
  children: ReactNode;
}

const ROLE_LABELS: Record<string, string> = {
  broker: "Broker",
  admin: "Admin",
  venue_operator: "Venue Operator",
};

type NavVariant = "full" | "rail" | "drawer";

interface NavLinksProps {
  role: string | null;
  tenantId: string | null;
  onNavigate: () => void;
  variant?: NavVariant;
}

// Reads useSearchParams() — must be wrapped in <Suspense> by the caller, or
// any page that goes through this layout will fail static prerender.
function NavLinks({ role, tenantId, onNavigate, variant = "full" }: NavLinksProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Priority: ?venue= query > /terminal/<id> path > primary tenantId.
  const queryVenueId = searchParams.get("venue");
  const terminalVenueMatch = pathname?.match(/^\/terminal\/([^/]+)/);
  const pathVenueId = terminalVenueMatch?.[1];
  const contextVenueId = queryVenueId ?? pathVenueId ?? tenantId ?? null;
  const venueQuery = contextVenueId ? `?venue=${encodeURIComponent(contextVenueId)}` : "";

  type Item = { href: string; label: string; icon: typeof LayoutDashboard; roles?: string[]; badge?: number };
  type Group = { label: string; items: Item[] };

  const portfolioItems: Item[] = [
    { href: `/dashboard${venueQuery}`, label: role === "venue_operator" ? "Dashboard" : "The Book", icon: LayoutDashboard },
    { href: "/venues", label: "Venues", icon: Building2, roles: ["broker", "admin", "venue_operator"] },
    { href: "/submissions", label: "Submissions", icon: FileSearch, roles: ["broker", "admin"] },
    { href: "/policies", label: "Policies", icon: FileSpreadsheet, roles: ["broker", "admin"] },
    { href: "/coverage", label: "Coverage", icon: ShieldCheck, roles: ["venue_operator"] },
    { href: "/renewals", label: "Renewals", icon: RefreshCw, roles: ["broker", "admin"] },
    ...(role === "venue_operator" && contextVenueId
      ? [{ href: `/terminal/${contextVenueId}`, label: "Live Terminal", icon: Activity } as Item]
      : []),
  ];

  const operationsItems: Item[] = [
    { href: `/incidents${venueQuery}`, label: "Incidents", icon: AlertTriangle },
    { href: `/compliance${venueQuery}`, label: "Compliance", icon: CheckSquare },
    { href: "/claims", label: "Claims", icon: FileSpreadsheet, roles: ["broker", "admin"] },
    { href: "/claim-proposals", label: "Claim Proposals", icon: FileSpreadsheet, roles: ["broker", "admin"] },
    { href: "/policy-requests", label: "Requests", icon: Inbox, roles: ["broker", "admin"] },
    { href: "/tasks", label: "Tasks", icon: ListChecks, roles: ["broker", "admin"] },
    { href: `/alerts${venueQuery}`, label: "Alerts", icon: Bell },
  ];

  const underwritingItems: Item[] = [
    { href: "/underwriter", label: "Reports", icon: FileSearch, roles: ["broker", "admin"] },
    { href: "/ingestion", label: "Ingestion", icon: Database, roles: ["broker", "admin"] },
  ];

  const filterByRole = (items: Item[]) =>
    items.filter((item) => !item.roles || item.roles.includes(role || ""));

  const groups: Group[] = [
    { label: "Portfolio", items: filterByRole(portfolioItems) },
    { label: "Operations", items: filterByRole(operationsItems) },
    { label: "Underwriting", items: filterByRole(underwritingItems) },
  ].filter((g) => g.items.length > 0);

  const isActive = (href: string) => {
    const base = href.split("?")[0];
    return pathname === base || pathname?.startsWith(base + "/");
  };

  const itemVariant: "full" | "rail" = variant === "rail" ? "rail" : "full";

  return (
    <>
      {groups.map((group) => (
        <div key={group.label} className="sidebar-nav__group">
          {variant !== "rail" && <div className="sidebar-nav__group-label">{group.label}</div>}
          {group.items.map((item) => (
            <SidebarNavItem
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={isActive(item.href)}
              badge={item.badge}
              variant={itemVariant}
              onClick={onNavigate}
            />
          ))}
        </div>
      ))}
    </>
  );
}

export function AppShell({ children }: AppShellProps) {
  const router = useRouter();
  const { signOut, user } = useAuth();
  const role = useRole();
  const tenantId = useTenantId();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Breakpoint gating. SSR + first paint render as "full" sidebar.
  const bp = useBreakpoint();
  const mounted = useMounted();
  const sidebarVariant: NavVariant = !mounted
    ? "full"
    : bp === "lg" || bp === "xl"
      ? "full"
      : bp === "md"
        ? "rail"
        : "drawer";
  const showBottomNav = mounted && (bp === "xs" || bp === "sm");

  const handleSignOut = () => {
    signOut();
    router.push("/login");
  };

  const sidebarContent = (
    <>
      <div className="sidebar-brand">
        <div className="sidebar-brand__mark">
          <span className="sidebar-brand__logo"><img src="/nightline-mark.svg" alt="Nightline" width={36} height={36} /></span>
          <div className="sidebar-brand__text">
            <h1>Nightline</h1>
            <p>Risk OS</p>
          </div>
        </div>
        <span className="sidebar-mission">Keep venues alive.</span>
      </div>

      <div className="sidebar-user">
        <span className="user-name">{user?.name}</span>
        <span className="user-role">{ROLE_LABELS[user?.role ?? ""] ?? user?.role}</span>
      </div>

      <nav className="sidebar-nav">
        <Suspense fallback={null}>
          <NavLinks
            role={role}
            tenantId={tenantId}
            onNavigate={() => setMobileOpen(false)}
            variant={sidebarVariant}
          />
        </Suspense>
      </nav>

      <div className="sidebar-footer">
        <button
          onClick={handleSignOut}
          className={`sidebar-nav-item sidebar-nav-item--${sidebarVariant}`}
          title={sidebarVariant === "rail" ? "Sign Out" : undefined}
          aria-label="Sign Out"
        >
          <LogOut size={18} />
          <span className="sidebar-nav-item__label">Sign Out</span>
        </button>
      </div>
    </>
  );

  return (
    <div
      className="app-shell"
      data-sidebar-variant={sidebarVariant}
      data-bottom-nav={showBottomNav ? "on" : "off"}
    >
      {/* Mobile top bar — visible only when sidebar is in drawer mode */}
      <div className="mobile-nav-bar">
        <span className="brand">Nightline</span>
        <button className="hamburger" onClick={() => setMobileOpen(o => !o)} aria-label="Menu">
          {mobileOpen ? <X size={22} color="var(--text-primary)" /> : <Menu size={22} color="var(--text-primary)" />}
        </button>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && <div className="sidebar-overlay" onClick={() => setMobileOpen(false)} />}

      <aside
        className={`sidebar sidebar--${sidebarVariant}${mobileOpen ? " open" : ""}`}
        aria-label="Primary navigation"
      >
        {sidebarContent}
      </aside>

      <main className="main-content">
        {children}
      </main>

      {showBottomNav && (
        <Suspense fallback={null}>
          <MobileBottomNav onMore={() => setMobileOpen(true)} />
        </Suspense>
      )}
    </div>
  );
}
