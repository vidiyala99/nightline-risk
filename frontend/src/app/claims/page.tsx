"use client";

/**
 * /claims — carrier-side claims list across the broker's whole book.
 *
 * No cross-policy endpoint exists yet (plan §slice-4 follow-up); until it
 * lands, the page aggregates per-policy by listing the broker's policies
 * first and fetching claims for each. Throttled to 4 parallel requests so
 * a broker with a large book doesn't fan out hundreds of fetches at once.
 *
 * When the backend ships `GET /api/claims?status=&venue_id=`, this entire
 * useEffect collapses to a single call.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { ClaimStatusPill } from "@/components/claims/ClaimStatusPill";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAuth } from "@/contexts/AuthContext";
import { claimsApi, totalPaidFromClaim, type Claim } from "@/lib/claims";
import { formatLedgerMoney, isClosedStatus } from "@/lib/claim-tokens";
import { policiesApi, type Policy } from "@/lib/policies";

interface Row extends Claim {
  policy: Policy;
}

type Filter = "open" | "all" | "closed";

export default function CarrierClaimsListPage() {
  const router = useRouter();
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");

  useEffect(() => {
    if (!isLoaded || !isBroker) return;
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        // One cross-policy call replaces the per-policy aggregation that
        // shipped in slice 2. Policy metadata (venue, policy_number) is
        // fetched in parallel only for the policies actually referenced
        // by returned claims — typically far fewer than total policies.
        // PolicyDetail upcasts to Policy here since Row only needs the
        // base shape; the table never reads endorsements/certificates.
        const claims = await claimsApi.listClaims();
        const policyIds = Array.from(new Set(claims.map((c) => c.policy_id)));
        const policies = await Promise.all(
          policyIds.map((pid) =>
            policiesApi.getPolicy(pid).catch(() => null),
          ),
        );
        const policyById = new Map<string, Policy>();
        for (const p of policies) {
          if (p) policyById.set(p.id, p as Policy);
        }
        const all: Row[] = [];
        for (const c of claims) {
          const policy = policyById.get(c.policy_id);
          if (policy) all.push({ ...c, policy });
        }
        if (!cancelled) setRows(all);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load claims");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isBroker]);

  const visible = useMemo(() => {
    if (!rows) return [];
    if (filter === "all") return rows;
    if (filter === "closed") return rows.filter((r) => isClosedStatus(r.status));
    return rows.filter((r) => !isClosedStatus(r.status));
  }, [rows, filter]);

  if (!isLoaded) {
    return null;
  }

  if (!isBroker) {
    return (
      <div className="page page-empty">
        <h3>Carrier claims are a broker surface.</h3>
        <p className="text-secondary">
          Operators see their reported incidents under{" "}
          <Link href="/incidents">Incidents</Link> and any claim recommendations
          under <Link href="/claim-proposals">Claim Proposals</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="claims-portfolio">
      <PageHeader
        eyebrow="BROKER · PORTFOLIO"
        title="Carrier claims"
        subtitle="Every reported loss across your book of bound policies."
      />

      <div className="claims-portfolio__filters" role="group" aria-label="Filter by status">
        {(["open", "closed", "all"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            className={
              filter === f
                ? "claims-portfolio__filter claims-portfolio__filter--active"
                : "claims-portfolio__filter"
            }
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
          >
            {f === "open" ? "Open" : f === "closed" ? "Closed" : "All"}
            {rows && (
              <span className="claims-portfolio__filter-count">
                {f === "all"
                  ? rows.length
                  : f === "closed"
                    ? rows.filter((r) => isClosedStatus(r.status)).length
                    : rows.filter((r) => !isClosedStatus(r.status)).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {error ? (
        <div className="policies-empty" role="alert">
          {error}
        </div>
      ) : rows === null ? (
        <div className="claims-section__skeleton" aria-busy="true">
          <div /><div /><div /><div />
        </div>
      ) : visible.length === 0 ? (
        <div className="policies-empty">
          {rows.length === 0
            ? "No carrier claims in your book yet. File one from a policy detail page."
            : "No claims match the current filter."}
        </div>
      ) : (
        <div className="policies-table-wrap">
          <table className="policies-table" aria-label="Carrier claims portfolio">
            <thead>
              <tr>
                <th scope="col">Claim</th>
                <th scope="col">Venue</th>
                <th scope="col">Policy</th>
                <th scope="col">Coverage</th>
                <th scope="col">Status</th>
                <th scope="col" style={{ textAlign: "right" }}>Reserve</th>
                <th scope="col" style={{ textAlign: "right" }}>Paid</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => router.push(`/claims/${r.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(`/claims/${r.id}`);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td className="policies-table__mono">
                    {r.carrier_claim_number ?? r.id}
                  </td>
                  <td>{r.policy.venue_id}</td>
                  <td className="policies-table__mono">{r.policy.policy_number ?? r.policy.id}</td>
                  <td>{r.coverage_line.toUpperCase()}</td>
                  <td><ClaimStatusPill status={r.status} reopenCount={r.reopen_count} /></td>
                  <td
                    className="policies-table__mono"
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatLedgerMoney(r.current_reserve)}
                  </td>
                  <td
                    className="policies-table__mono"
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatLedgerMoney(totalPaidFromClaim(r))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
