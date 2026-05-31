import { Suspense } from "react";
import { AppShell } from "@/components/layout/AppShell";

export default function ClaimStatusLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <Suspense fallback={<div className="page-loading"><div className="loading-spinner" /></div>}>{children}</Suspense>
    </AppShell>
  );
}
