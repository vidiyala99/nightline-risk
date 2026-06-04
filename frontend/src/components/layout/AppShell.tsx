"use client";

import { ReactNode, Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  Building2,
  AlertTriangle,
  ArrowLeft,
  CheckSquare,
  FileSearch,
  FileSpreadsheet,
  LogOut,
  Bell,
  RefreshCw,
  ShieldCheck,
  Inbox,
  Database,
  TrendingUp,
  Users,
} from "lucide-react";
import { useAuth, useRole, useTenantId, roleHome } from "@/contexts/AuthContext";
import { useBreakpoint, useMounted } from "@/hooks/useBreakpoint";
import { MobileBottomNav } from "@/components/layout/MobileBottomNav";
import { MobileMoreSheet } from "@/components/layout/MobileMoreSheet";
import { SidebarNavItem } from "@/components/ui/SidebarNavItem";

interface AppShellProps {
  children: ReactNode;
}

const ROLE_LABELS: Record<string, string> = {
  broker: "Broker",
  admin: "Admin",
  venue_operator: "Venue Operator",
  carrier: "Carrier · Underwriting",
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

  const isBrokerNav = role === "broker" || role === "admin";
  // Carrier = Nightline's own underwriting desk. A focused persona: the desk is
  // their home. They don't see the broker/operator shells.
  const isCarrierNav = role === "carrier";
  // Staff = a venue's floor employee. The most focused persona: file a report,
  // see their own. No dashboard/claims/other-venue surfaces.
  const isStaffNav = role === "staff";

  const groups: Group[] = (isStaffNav
    ? [
        { label: "", items: [
          { href: "/report", label: "Report Incident", icon: AlertTriangle },
          { href: "/my-reports", label: "My Reports", icon: FileSpreadsheet },
        ] },
      ]
    : isCarrierNav
    ? [
        { label: "", items: [
          { href: "/underwriting", label: "Underwriting Desk", icon: Inbox },
          { href: "/adjusting", label: "Claims", icon: FileSpreadsheet },
        ] },
      ]
    : isBrokerNav
    ? [
        { label: "", items: [{ href: "/dashboard", label: "Home", icon: LayoutDashboard }] },
        { label: "Claims pipeline", items: [
          { href: "/work-queue", label: "Work Queue", icon: Inbox },
          { href: "/comms-review", label: "Review Queue", icon: Inbox },
          { href: "/claims", label: "Claims", icon: FileSpreadsheet },
        ] },
        { label: "Placement", items: [
          { href: "/submissions", label: "Submissions", icon: FileSearch },
          { href: "/policies", label: "Policies", icon: FileSpreadsheet },
          { href: "/renewals", label: "Renewals", icon: RefreshCw },
        ] },
        { label: "Book", items: [
          { href: "/book", label: "Financials", icon: TrendingUp },
          { href: "/venues", label: "Venues", icon: Building2 },
          { href: "/policy-requests", label: "Requests", icon: Inbox },
        ] },
        { label: "System", items: [
          { href: "/ingestion", label: "Ingestion", icon: Database },
        ] },
      ]
    : [
        { label: "", items: [
          { href: `/dashboard${venueQuery}`, label: "Home", icon: LayoutDashboard },
        ] },
        { label: "My venue", items: [
          // "Venue" → the venue's profile (its risk profile), not the roster.
          // Manage/edit/add lives on /venues, reachable from the profile.
          { href: contextVenueId ? `/risk-profile/${contextVenueId}` : "/venues", label: "Venue", icon: Building2 },
          { href: `/incidents${venueQuery}`, label: "Incidents", icon: AlertTriangle },
          { href: "/claims", label: "Claims", icon: FileSpreadsheet },
          { href: `/compliance${venueQuery}`, label: "Compliance", icon: CheckSquare },
          { href: "/comms-review", label: "Review Queue", icon: Inbox },
          { href: "/coverage", label: "Coverage", icon: ShieldCheck },
          { href: "/team", label: "Floor Team", icon: Users },
        ] },
        { label: "System", items: [
          { href: `/alerts${venueQuery}`, label: "Alerts", icon: Bell },
        ] },
      ]
  ).filter((g) => g.items.length > 0);

  // The operator's claim-journey screens (decision + claim-status) live under
  // /incidents/<id>/* by URL, but they belong to the claim flow — so they light
  // up "Claims", not "Incidents". The incident itself (/incidents/<id>) stays
  // under Incidents. Brokers never reach these operator-only routes.
  const isClaimFlow = /^\/incidents\/[^/]+\/(decision|claim-status)(\/|$)/.test(pathname ?? "");
  // The broker proposal-review screen (/underwriter/<id>) is reached from the
  // Work Queue and has no nav href of its own — light Work Queue so the broker
  // keeps their "where am I" anchor mid-decision.
  const isProposalReview = (pathname ?? "").startsWith("/underwriter");

  const isActive = (href: string) => {
    const base = href.split("?")[0];
    if (isClaimFlow) {
      if (base === "/claims") return true;
      if (base === "/incidents") return false;
    }
    if (isProposalReview && base === "/work-queue") return true;
    return pathname === base || pathname?.startsWith(base + "/");
  };

  const itemVariant: "full" | "rail" = variant === "rail" ? "rail" : "full";

  return (
    <>
      {groups.map((group) => (
        <div key={group.label} className="sidebar-nav__group">
          {variant !== "rail" && group.label && <div className="sidebar-nav__group-label">{group.label}</div>}
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
  const pathname = usePathname();
  const { signOut, user } = useAuth();
  const role = useRole();
  const tenantId = useTenantId();

  // Focused personas (staff, carrier) have a narrow nav, but web routes are
  // reachable by direct URL (or a stale one) — the sidebar alone isn't a guard.
  // Redirect them off any route outside their allowed set, to their own home.
  // This stops a staff user landing on /dashboard (operator policy info) or a
  // carrier landing on /dashboard / /policies. Operator/broker/admin: no guard
  // (full access). Mobile is already safe (their tab navigators omit the screens).
  useEffect(() => {
    if (!pathname) return;
    const FOCUSED_ALLOWED: Record<string, string[]> = {
      staff: ["/report", "/my-reports", "/settings"],
      carrier: ["/underwriting", "/adjusting", "/settings"],
    };
    const allowedList = role ? FOCUSED_ALLOWED[role] : undefined;
    if (!allowedList) return;
    const allowed = allowedList.some((p) => pathname === p || pathname.startsWith(p + "/"));
    if (!allowed) router.replace(roleHome(role));
  }, [role, pathname, router]);

  // Each persona gets an explicit "back to home" on every screen except home
  // itself. Focused personas (carrier, staff) keep a single-surface flow, so
  // they skip the back-home affordance.
  const homeHref = roleHome(role);
  const showBackHome =
    !!pathname && pathname !== homeHref && role !== "carrier" && role !== "staff";
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);

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
    router.push("/");
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
            onNavigate={() => {}}
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
      {/* Phone uses the bottom nav (+ More sheet) as its sole navigation, so the
          desktop/tablet sidebar is not rendered there — avoids a redundant
          hamburger-drawer duplicating the bottom nav. */}
      {!showBottomNav && (
        <aside
          className={`sidebar sidebar--${sidebarVariant}`}
          aria-label="Primary navigation"
        >
          {sidebarContent}
        </aside>
      )}

      <main className="main-content">
        {showBackHome && (
          <Link
            href={homeHref}
            className="appshell-back-home flex items-center gap-xs text-secondary text-sm"
            style={{ textDecoration: "none", padding: "16px clamp(20px, 4vw, 56px) 0", minHeight: 44 }}
          >
            <ArrowLeft size={14} aria-hidden="true" /> Back to home
          </Link>
        )}
        {children}
      </main>

      {showBottomNav && (
        <Suspense fallback={null}>
          <MobileBottomNav onMore={() => setMoreSheetOpen(true)} />
        </Suspense>
      )}

      {/* Phone "More" overflow — mirrors mobile MoreScreen. Tablet (md) and up
          use the sidebar (rail/full) above; phone has no sidebar at all. */}
      {showBottomNav && (
        <MobileMoreSheet open={moreSheetOpen} onClose={() => setMoreSheetOpen(false)} />
      )}
    </div>
  );
}
