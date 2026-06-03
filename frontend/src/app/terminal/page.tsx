"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth, useRole, useTenantId } from "@/contexts/AuthContext";

function TerminalRedirectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const tenantId = useTenantId();
  const venueParam = searchParams.get("venue");

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { router.push("/"); return; }
    const target = venueParam ?? tenantId;
    // Hard role gate: terminal is operator-only. Brokers get sent to the
    // broker-appropriate detail view (risk profile) or back to the book.
    if (role && role !== "venue_operator") {
      router.replace(target ? `/risk-profile/${target}` : "/dashboard");
      return;
    }
    if (!target) { router.replace("/venues"); return; }
    // The live terminal was retired — the risk profile is the venue-detail surface.
    router.replace(`/risk-profile/${target}`);
  }, [isLoaded, isSignedIn, role, tenantId, venueParam, router]);

  return <div className="page-loading"><div className="loading-spinner" /></div>;
}

// Wrap in Suspense so static prerender doesn't bail out on useSearchParams().
export default function TerminalRedirect() {
  return (
    <Suspense fallback={<div className="page-loading"><div className="loading-spinner" /></div>}>
      <TerminalRedirectInner />
    </Suspense>
  );
}
