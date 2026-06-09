import { Suspense } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { SkeletonCard } from "@/components/ui/Skeleton";

export default function CopilotLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppShell>
      <Suspense fallback={<CopilotSkeleton />}>{children}</Suspense>
    </AppShell>
  );
}

function CopilotSkeleton() {
  return (
    <div className="skeleton-grid">
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}
