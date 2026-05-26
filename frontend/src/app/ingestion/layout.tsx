import { Suspense } from "react";
import { AppShell } from "@/components/layout/AppShell";

export default function IngestionLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>
    </AppShell>
  );
}
