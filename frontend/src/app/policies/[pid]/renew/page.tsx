"use client";

/**
 * /policies/[pid]/renew — broker-gated "start the renewal" confirm screen.
 *
 * Reached from the renewal_at_risk finding's CTA ("Start the renewal") so the
 * broker lands on exactly the action the card promised, scoped to this policy.
 * Mirrors the /policies/[pid]/endorse conventions (client component, useParams,
 * PageHeader, PlacementApiError) and the /renewals "Renew" mechanics (effective
 * date defaults to tomorrow; renewalsApi.renew creates the renewal submission).
 *
 * No YoY preview endpoint exists — the experience-rated numbers come back FROM
 * the renew POST, so we show the prior-term baseline as context and route to the
 * created submission on success.
 */
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { PageHeader } from "@/components/ui/PageHeader";
import { useAuth } from "@/contexts/AuthContext";
import { PlacementApiError, formatCurrency } from "@/lib/placement";
import { policiesApi, PolicyDetail } from "@/lib/policies";
import { renewalsApi } from "@/lib/renewals";

function tomorrowIso(): string {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)
    .toISOString()
    .slice(0, 10);
}

export default function RenewPolicyPage() {
  const params = useParams<{ pid: string }>();
  const router = useRouter();
  const pid = params?.pid;
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const [policy, setPolicy] = useState<PolicyDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [effectiveDate, setEffectiveDate] = useState(tomorrowIso);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pid || !isLoaded || !isBroker) return;
    let cancelled = false;
    policiesApi
      .getPolicy(pid)
      .then((p) => { if (!cancelled) setPolicy(p); })
      .catch((e) => {
        if (!cancelled)
          setLoadError(e instanceof PlacementApiError ? e.message : "Failed to load policy");
      });
    return () => { cancelled = true; };
  }, [pid, isLoaded, isBroker]);

  if (!isLoaded) return null;

  if (!isBroker) {
    return (
      <div className="page page-empty">
        <h3>Renewals are a broker surface.</h3>
        <p className="text-secondary">
          Operators request renewals from their broker via their own dashboard.
        </p>
      </div>
    );
  }

  const startRenewal = async () => {
    if (!pid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await renewalsApi.renew(pid, effectiveDate);
      router.push(`/submissions/${res.submission.id}`);
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "Renewal failed");
      setBusy(false);
    }
  };

  return (
    <div className="submission-wizard">
      <PageHeader
        eyebrow={`Policy · Renewal${policy ? ` · ${policy.id}` : ""}`}
        title="Start the renewal"
        subtitle="Creates an experience-rated renewal submission carrying forward this policy's coverage."
      />

      {loadError && <div className="submission-wizard__error">{loadError}</div>}

      {policy && (
        <div className="submission-detail__summary" style={{ marginBottom: 20 }}>
          <div>
            <div className="submission-detail__summary-label">Renewing</div>
            <div className="submission-detail__summary-value" style={{ fontSize: 13 }}>
              {policy.policy_number || policy.id}
            </div>
          </div>
          <div>
            <div className="submission-detail__summary-label">Prior Premium</div>
            <div className="submission-detail__summary-value">
              {formatCurrency(policy.annual_premium)}
            </div>
          </div>
          <div>
            <div className="submission-detail__summary-label">Expires</div>
            <div className="submission-detail__summary-value" style={{ fontSize: 12 }}>
              {policy.expiration_date}
            </div>
          </div>
          <div>
            <div className="submission-detail__summary-label">Coverage Lines</div>
            <div className="submission-detail__summary-value" style={{ fontSize: 12 }}>
              {policy.coverage_lines.length ? policy.coverage_lines.join(", ") : "—"}
            </div>
          </div>
        </div>
      )}

      <div className="submission-wizard__form">
        {error && <div className="submission-wizard__error">{error}</div>}

        <div className="submission-wizard__field">
          <label className="submission-wizard__label">Renewal Effective Date</label>
          <input
            type="date"
            className="input-field"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            required
          />
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => router.push(`/policies/${pid}`)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={startRenewal}
            disabled={busy || !policy}
          >
            {busy ? "Starting…" : "Start renewal"}
          </button>
        </div>
      </div>
    </div>
  );
}
