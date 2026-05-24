"use client";

/**
 * /renewals — broker-gated page listing policies due for renewal.
 *
 * Lists policies expiring within 60 days via renewalsApi.due(60).
 * Lets the broker click "Renew" on a row (calls renewalsApi.renew).
 * After a successful renewal shows a YoY context panel (prior premium,
 * loss ratio, experience adjustment) and offers a link to the new
 * renewal submission (route /submissions/[sid] exists in this app).
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/ui/PageHeader";
import { useAuth } from "@/contexts/AuthContext";
import { renewalsApi, type RenewalDue, type RenewResult } from "@/lib/renewals";
import { formatLedgerMoney } from "@/lib/claim-tokens";

export default function RenewalsPage() {
  const router = useRouter();
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const [rows, setRows] = useState<RenewalDue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [result, setResult] = useState<RenewResult | null>(null);

  useEffect(() => {
    if (!isLoaded || !isBroker) return;
    let cancelled = false;
    renewalsApi
      .due(60)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load renewals");
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isBroker]);

  if (!isLoaded) {
    return null;
  }

  if (!isBroker) {
    return (
      <div className="page page-empty">
        <h3>Renewals are a broker surface.</h3>
        <p className="text-secondary">
          Operators manage their incidents and claim proposals via their
          respective dashboards.
        </p>
      </div>
    );
  }

  async function onRenew(policyId: string) {
    setBusyId(policyId);
    setError(null);
    setResult(null);
    try {
      const t = new Date();
      // effective_date = tomorrow
      const eff = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)
        .toISOString()
        .slice(0, 10);
      const res = await renewalsApi.renew(policyId, eff);
      setResult(res);
      // Remove the renewed policy from the due list
      setRows((prev) =>
        prev ? prev.filter((r) => r.policy_id !== policyId) : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Renew failed");
    } finally {
      setBusyId(null);
    }
  }

  function fmtPct(s: string) {
    const n = parseFloat(s);
    if (isNaN(n)) return s;
    return (n * 100).toFixed(1) + "%";
  }

  function fmtMultiplier(s: string) {
    const n = parseFloat(s);
    return Number.isNaN(n) ? s : `×${n.toFixed(2)}`;
  }

  function fmtMoney(s: string) {
    return formatLedgerMoney(parseFloat(s));
  }

  return (
    <div className="claims-portfolio">
      <PageHeader
        eyebrow="BROKER · RENEWALS"
        title="Renewals due"
        subtitle="Policies expiring within 60 days. Click Renew to open a renewal submission."
      />

      {/* Error banner */}
      {error && (
        <div className="policies-empty" role="alert" style={{ borderColor: "var(--state-error)", color: "var(--state-error)" }}>
          {error}
        </div>
      )}

      {/* YoY result panel — shown after a successful renew action */}
      {result && (
        <div className="policies-table-wrap renewals-yoy-panel" role="status" aria-live="polite">
          <div className="renewals-yoy-panel__header">
            <span className="renewals-yoy-panel__badge">Renewal submitted</span>
            <span className="renewals-yoy-panel__sub">
              New submission{" "}
              <button
                type="button"
                className="renewals-yoy-panel__link-btn"
                onClick={() => router.push("/submissions/" + result.submission.id)}
              >
                {result.submission.id.slice(0, 8)}&hellip;
              </button>{" "}
              · venue {result.submission.venue_id} · effective{" "}
              {result.submission.effective_date}
            </span>
          </div>
          <table className="policies-table" aria-label="Year-over-year context">
            <thead>
              <tr>
                <th scope="col">Prior annual premium</th>
                <th scope="col">Loss ratio</th>
                <th scope="col">Claims</th>
                <th scope="col">Experience adjustment</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="policies-table__mono">{fmtMoney(result.yoy_context.prior_annual_premium)}</td>
                <td className="policies-table__mono">{fmtPct(result.yoy_context.loss_ratio)}</td>
                <td className="policies-table__mono">{result.yoy_context.claim_count}</td>
                <td className="policies-table__mono">{fmtMultiplier(result.yoy_context.loss_adjustment)}</td>
              </tr>
            </tbody>
          </table>
          <div className="renewals-yoy-panel__footer">
            <button
              type="button"
              className="renewals-yoy-panel__go-btn"
              onClick={() => router.push("/submissions/" + result.submission.id)}
            >
              Go to renewal submission &rarr;
            </button>
            <button
              type="button"
              className="renewals-yoy-panel__dismiss-btn"
              onClick={() => setResult(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Due-list table */}
      {rows === null ? (
        <div className="claims-section__skeleton" aria-busy="true">
          <div /><div /><div /><div />
        </div>
      ) : rows.length === 0 ? (
        <div className="policies-empty">
          No policies expiring in the next 60 days. Check back closer to renewal
          season.
        </div>
      ) : (
        <div className="policies-table-wrap">
          <table className="policies-table" aria-label="Policies due for renewal">
            <thead>
              <tr>
                <th scope="col">Policy</th>
                <th scope="col">Venue</th>
                <th scope="col">Expires</th>
                <th scope="col" style={{ textAlign: "right" }}>Annual premium</th>
                <th scope="col" style={{ textAlign: "right" }}>Loss ratio</th>
                <th scope="col" style={{ textAlign: "right" }}>Projected adj.</th>
                <th scope="col">Claims</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.policy_id}>
                  <td className="policies-table__mono">
                    {r.policy_number ?? r.policy_id}
                  </td>
                  <td>{r.venue_id}</td>
                  <td className="policies-table__mono">{r.expiration_date}</td>
                  <td
                    className="policies-table__mono"
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  >
                    {fmtMoney(r.annual_premium)}
                  </td>
                  <td
                    className="policies-table__mono"
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  >
                    {fmtPct(r.loss_ratio)}
                  </td>
                  <td
                    className="policies-table__mono"
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  >
                    {fmtMultiplier(r.projected_loss_adjustment)}
                  </td>
                  <td className="policies-table__mono">{r.claim_count}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="renewals-renew-btn"
                      disabled={busyId === r.policy_id}
                      onClick={() => onRenew(r.policy_id)}
                    >
                      {busyId === r.policy_id ? "Renewing…" : "Renew"}
                    </button>
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
