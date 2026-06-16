"use client";

/**
 * /coverage — venue operator's read-only "My Coverage" surface.
 *
 * Operators can't transact policy lifecycle (bind/cancel/renew/COI are
 * broker-gated), and until now had no way to even see their policy. This
 * page shows their venue's coverage and lets them *ask* — raising a
 * PolicyRequest that lands in the broker's queue (the propose→decide
 * pattern, same shape as claim proposals).
 *
 * Broker/admin land here too but are pointed at the queue instead.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/contexts/AuthContext";
import { PolicyRequestModal } from "@/components/PolicyRequestModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Badge } from "@/components/ds/badge";
import {
  CoveragePolicy,
  PolicyRequest,
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TONE,
  REQUEST_TYPE_LABEL,
  policyRequestsApi,
} from "@/lib/policyRequests";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;
const SCRIPT = { fontFamily: "var(--font-caveat)" } as const;
const TONE_VARIANT = {
  neutral: "muted", info: "info", success: "success", warning: "warning", danger: "destructive",
} as const;

function fmtMoney(s: string): string {
  const n = parseFloat(s);
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(n);
}

const POLICY_STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  active: "success",
  bound_pending_number: "info",
  cancelled: "danger",
  non_renewed: "warning",
  lapsed: "warning",
  expired: "neutral",
};

export default function CoveragePage() {
  const router = useRouter();
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const venueIds = useMemo(() => {
    if (!user) return [] as string[];
    const ids = new Set<string>();
    if (user.tenant_id) ids.add(user.tenant_id);
    (user.extra_venue_ids || []).forEach((v) => ids.add(v));
    return [...ids];
  }, [user]);

  const [policies, setPolicies] = useState<CoveragePolicy[] | null>(null);
  const [requests, setRequests] = useState<PolicyRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modalPolicy, setModalPolicy] = useState<CoveragePolicy | null>(null);
  const [withdrawId, setWithdrawId] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const load = useCallback(async () => {
    if (venueIds.length === 0) {
      setPolicies([]);
      return;
    }
    setError(null);
    try {
      const [policyLists, requestLists] = await Promise.all([
        Promise.all(venueIds.map((v) => policyRequestsApi.coverageForVenue(v))),
        Promise.all(venueIds.map((v) => policyRequestsApi.list({ venue_id: v }))),
      ]);
      setPolicies(policyLists.flat());
      setRequests(requestLists.flat());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load coverage");
    }
  }, [venueIds]);

  useEffect(() => {
    if (!isLoaded || isBroker) return;
    load();
  }, [isLoaded, isBroker, load]);

  // Opens a ConfirmDialog (was a native window.confirm).
  const onCancelRequest = (id: string) => setWithdrawId(id);

  async function runWithdraw() {
    if (!withdrawId) return;
    setWithdrawing(true);
    try {
      await policyRequestsApi.cancel(withdrawId);
      setWithdrawId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not withdraw the request");
    } finally {
      setWithdrawing(false);
    }
  }

  if (!isLoaded) return null;

  if (isBroker) {
    return (
      <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
        <div className="mt-10 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-20 text-center">
          <h3 className="text-lg font-semibold text-foreground">Coverage is the operator&rsquo;s view.</h3>
          <p className="text-sm text-muted-foreground">
            Operators see and manage their own policy here. Head to{" "}
            <button className="text-[#5A6E00] hover:underline" onClick={() => router.push("/policy-requests")}>Policy Requests</button>{" "}
            to action what they&rsquo;ve asked for.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <section className="py-10">
        <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-[#5A6E00]">
          <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
          Venue · Coverage
        </span>
        <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
          My <span className="text-[#5A6E00]" style={SCRIPT}>safety net</span>
        </h1>
        <p className="mt-2 max-w-[60ch] text-[15px] text-muted-foreground">
          Your active policy and anything you&apos;ve asked your broker to action.
        </p>
      </section>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {policies === null ? (
        <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
          {[0, 1].map((i) => <div key={i} className="h-40 animate-pulse rounded-xl border border-border bg-muted/40" />)}
        </div>
      ) : policies.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          No coverage on file yet. Once your broker binds a policy for your venue, it&rsquo;ll show up here.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {policies.map((p) => (
            <Card key={p.id} className="gap-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">{p.carrier_id}</div>
                  <div className="truncate font-mono text-sm font-semibold text-foreground">{p.policy_number ?? p.id}</div>
                </div>
                <Badge variant={TONE_VARIANT[POLICY_STATUS_TONE[p.status] ?? "neutral"]}>
                  {p.status.replace(/_/g, " ")}
                </Badge>
              </div>
              <dl className="flex flex-col gap-1.5 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Annual premium</dt><dd className="font-mono text-foreground">{fmtMoney(p.annual_premium)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Effective</dt><dd className="font-mono text-foreground">{p.effective_date}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Expires</dt><dd className="font-mono text-foreground">{p.expiration_date}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Lines</dt><dd className="text-right text-foreground">{p.coverage_lines.map((l) => l.toUpperCase()).join(", ") || "—"}</dd></div>
              </dl>
              <Button type="button" size="sm" className="w-full border border-foreground/15" onClick={() => setModalPolicy(p)}>
                Request an action
              </Button>
            </Card>
          ))}
        </div>
      )}

      {/* Request history */}
      {requests.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-base font-semibold text-foreground">Your requests</h2>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-sm" aria-label="Your policy requests">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-4 py-3 text-left font-medium">Type</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium">Note</th>
                  <th scope="col" className="px-4 py-3 text-left font-medium">Sent</th>
                  <th scope="col" className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-foreground">{REQUEST_TYPE_LABEL[r.request_type]}</td>
                    <td className="px-4 py-3"><Badge variant={TONE_VARIANT[REQUEST_STATUS_TONE[r.status]]}>{REQUEST_STATUS_LABEL[r.status]}</Badge></td>
                    <td className="px-4 py-3 text-muted-foreground">{r.decision_note || r.note || "—"}</td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">{r.created_at.slice(0, 10)}</td>
                    <td className="px-4 py-3 text-right">
                      {r.status === "pending" && (
                        <button type="button" className="text-xs text-destructive hover:underline" onClick={() => onCancelRequest(r.id)}>
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {modalPolicy && (
        <PolicyRequestModal
          policy={modalPolicy}
          open={modalPolicy !== null}
          onClose={() => setModalPolicy(null)}
          onSubmitted={load}
        />
      )}

      {withdrawId && (
        <ConfirmDialog
          open
          title="Withdraw request"
          body="Withdraw this coverage request? It returns to you and is removed from the broker's queue."
          confirmLabel="Withdraw"
          busy={withdrawing}
          onConfirm={runWithdraw}
          onClose={() => setWithdrawId(null)}
        />
      )}
    </div>
  );
}
