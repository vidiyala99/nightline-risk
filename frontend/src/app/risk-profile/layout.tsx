import { Suspense } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { SkeletonCard } from "@/components/ui/Skeleton";

/**
 * Risk Profile is a detail page reached from the most-trafficked paths in the
 * app (broker triage rows, operator risk cards, venues list, live terminal).
 * Like every other authed route it must render inside AppShell so the user
 * keeps the sidebar / bottom-nav and a predictable way back — without this
 * layout the page rendered bare (no chrome, browser-back the only escape).
 * Mirrors dashboard/layout.tsx to keep navigation placement consistent.
 */
export default function RiskProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppShell>
      <Suspense fallback={<RiskProfileSkeleton />}>{children}</Suspense>
    </AppShell>
  );
}

function RiskProfileSkeleton() {
  return (
    <div className="skeleton-grid">
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}
