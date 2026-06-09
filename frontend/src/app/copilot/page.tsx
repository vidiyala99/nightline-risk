"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { PageHeader } from "@/components/ui/PageHeader";
import { CopilotPanel } from "@/components/copilot/CopilotPanel";

/**
 * /copilot — the conversational intelligence surface (spec §7). Operator-only:
 * the copilot answers questions grounded in the operator's own incidents,
 * claims, and policies, so non-operators are redirected to the dashboard.
 */
export default function CopilotPage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isOperator = role === "venue_operator";

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);
  useEffect(() => {
    if (isLoaded && isSignedIn && !isOperator) router.replace("/dashboard");
  }, [isLoaded, isSignedIn, isOperator, router]);

  if (!isLoaded || !isSignedIn || !isOperator) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="theme-venue">
      <PageHeader
        eyebrow="Operator"
        title="Copilot"
        subtitle="Ask about your incidents, claims, and policies. Grounded answers with sources you can open — and any action waits for your confirmation."
      />
      <CopilotPanel />
    </div>
  );
}
