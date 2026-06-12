"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { AlertTriangle, CheckCircle2, DollarSign, FileText, Upload, Minus, ChevronDown, ChevronRight, Eye, ClipboardCheck, Building2, Lock, TrendingDown } from "lucide-react";
import { toastSuccess, toastError } from "@/lib/toast";
import { estimatePremiumDeltaForFix } from "@/lib/risk";
import { usePageBack } from "@/components/layout/BackNavContext";

interface IngestedSource {
  id: string;
  source_type: string;
  excerpt: string;
  created_at: string;
}

interface PreviewChunk {
  section: string;
  clause: string;
  is_exclusion: boolean;
  content: string;
}

/** Client-side port of backend/app/policy_parser.py:chunk_policy_text.
 *  Kept structurally identical so the preview matches the server's parse exactly. */
function chunkPolicyText(text: string): PreviewChunk[] {
  const chunks: PreviewChunk[] = [];
  const sections = text.split(/\n## /);
  for (const section of sections) {
    const sectionMatch = section.match(/^([^\n]+)/);
    if (!sectionMatch) continue;
    const sectionTitle = sectionMatch[1].trim();
    const clauses = section.split(/\n### /);
    for (let i = 1; i < clauses.length; i++) {
      const clause = clauses[i];
      const clauseMatch = clause.match(/^([^\n]+)/);
      if (!clauseMatch) continue;
      const clauseTitle = clauseMatch[1].trim();
      const content = clause.trim();
      const isExclusion =
        sectionTitle.toUpperCase().includes("EXCLUSION") ||
        clauseTitle.toUpperCase().includes("EXCLUSION");
      chunks.push({
        section: sectionTitle,
        clause: clauseTitle,
        is_exclusion: isExclusion,
        content: `${sectionTitle} > ${content}`,
      });
    }
  }
  return chunks;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const TIER_COLOR: Record<string, string> = {
  A: "var(--tier-a)",
  B: "var(--tier-b)",
  C: "var(--tier-c)",
  D: "var(--tier-d)",
};

const FACTOR_EXPLANATIONS: Record<string, {
  label: string;
  good: { operator: string; broker: string };
  moderate: { operator: string; broker: string };
  poor: { operator: string; broker: string };
  action: string;
}> = {
  incident_history: {
    label: "Safety Record",
    good: {
      operator: "Your incident record is clean. Low frequency and quick resolution show underwriters you run a safe operation.",
      broker: "Incident record is clean. Low frequency and quick resolution indicate a safe operation.",
    },
    moderate: {
      operator: "A few open or recent incidents are moderately impacting your score. Closing them and documenting outcomes improves this factor.",
      broker: "A few open or recent incidents are moderately impacting the score. Closing them and documenting outcomes would improve this factor.",
    },
    poor: {
      operator: "Multiple unresolved incidents are the biggest drag on your score. Prioritize closing open cases and uploading evidence packets.",
      broker: "Multiple unresolved incidents are the biggest drag on the score. The venue should prioritize closing open cases and uploading evidence.",
    },
    action: "Close open incidents and upload supporting evidence to each report.",
  },
  compliance: {
    label: "Compliance",
    good: {
      operator: "All compliance actions are resolved. Your documentation is in good standing with underwriters.",
      broker: "All compliance actions are resolved. Documentation is in good standing with underwriters.",
    },
    moderate: {
      operator: "Some compliance items are pending. Clearing them shows proactive risk management.",
      broker: "Some compliance items are pending. Clearing them would show proactive risk management.",
    },
    poor: {
      operator: "Unresolved compliance actions signal gaps in your risk documentation. Address these first.",
      broker: "Unresolved compliance actions signal gaps in risk documentation.",
    },
    action: "Complete all pending compliance actions on the Compliance page.",
  },
  operational: {
    label: "Operational Health",
    good: {
      operator: "Your infrastructure and security setup are strong. Real-time data feeds give underwriters confidence in your operations.",
      broker: "Infrastructure and security setup are strong. Real-time data feeds give underwriters confidence in operations.",
    },
    moderate: {
      operator: "Some operational systems need attention. Degraded infrastructure signals reduce your score.",
      broker: "Some operational systems need attention. Degraded infrastructure signals reduce the score.",
    },
    poor: {
      operator: "Operational gaps — degraded feeds, low security rating — are significantly impacting your premium.",
      broker: "Operational gaps — degraded feeds, low security rating — are significantly impacting the premium.",
    },
    action: "Repair degraded infrastructure feeds and ensure all systems report in real-time.",
  },
  business_profile: {
    label: "Business Profile",
    good: {
      operator: "Your venue type, capacity management, and carrier history all contribute positively to your profile.",
      broker: "Venue type, capacity management, and carrier history all contribute positively to the profile.",
    },
    moderate: {
      operator: "Your business profile has some areas that underwriters view as higher risk.",
      broker: "The business profile has some areas that underwriters view as higher risk.",
    },
    poor: {
      operator: "Your venue type or operating history is a significant risk factor. Evidence-based documentation can offset this.",
      broker: "Venue type or operating history is a significant risk factor. Evidence-based documentation can offset this.",
    },
    action: "Maintain consistent carrier relationships and document your operational standards.",
  },
};

function getFactorTier(score: number): "good" | "moderate" | "poor" {
  if (score >= 85) return "good";
  if (score >= 65) return "moderate";
  return "poor";
}

function getFactorColor(score: number): string {
  if (score >= 85) return "var(--tier-a)";
  if (score >= 65) return "var(--state-warning)";
  return "var(--state-error)";
}

/** Where a factor's fix lives. Shared by the Factor Breakdown rows and the
 *  "What to Improve" advice so the operator's next-step text is a real
 *  deep-link, not just a sentence. Returns null when no surface exists
 *  (e.g. brokers don't get the operator-only floor terminal). */
function factorHref(key: string, venueId: string, isBroker: boolean): string | null {
  const v = encodeURIComponent(venueId);
  if (key === "incident_history") return `/incidents?venue=${v}`;
  if (key === "compliance") return `/compliance?venue=${v}`;
  // "operational" has no in-app fix surface — infra/sensor feeds are external
  // telemetry (live status already shows on the home "On the floor" section), so
  // it stays informational rather than bouncing the user back to home.
  if (key === "business_profile") return `/venues/${v}`;
  return null;
}

/** Icon paired with the score tier — supplements color so tier is conveyed twice (a11y: color-not-only). */
function FactorTierIcon({ tier, color }: { tier: "good" | "moderate" | "poor"; color: string }) {
  const props = { size: 14, style: { color }, "aria-hidden": true as const };
  if (tier === "good") return <CheckCircle2 {...props} />;
  if (tier === "moderate") return <Minus {...props} />;
  return <AlertTriangle {...props} />;
}

/** Visually-hidden label — keeps the input accessible to screen readers without changing layout. */
const SR_ONLY_STYLE: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

export default function RiskProfilePage() {
  const { venueId } = useParams<{ venueId: string }>();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isBroker = role === "broker" || role === "admin";

  const [riskData, setRiskData] = useState<any>(null);
  const [quoteData, setQuoteData] = useState<any>(null);
  const [venueName, setVenueName] = useState<string>("");
  const [venueMeta, setVenueMeta] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState(false);
  // Override-calibration aggregates for this venue. Null until first fetch
  // settles; absent fields rendered as "no signal yet" rather than zero.
  const [overrideStats, setOverrideStats] = useState<{
    override_total: number;
    override_approved: number;
    override_rejected: number;
    override_pending: number;
    override_right_rate: number | null;
    non_override_total: number;
    non_override_approved: number;
    non_override_rejected: number;
    non_override_right_rate: number | null;
    by_reason: Record<string, { total: number; approved: number; rejected: number; pending: number }>;
  } | null>(null);
  // Status-bucketed incident counts for the Incident History factor row.
  // `total` here MUST equal the unfiltered list at /incidents?venue=... and
  // the scoring engine's `incident_count` input — same `IncidentRecord` COUNT(*).
  const [incidentCounts, setIncidentCounts] = useState<{ total: number; open: number } | null>(null);
  // Broker action-hub: this venue's pending/needs-info proposals + open claims.
  const [hubDecisions, setHubDecisions] = useState<any[]>([]);
  const [hubClaims, setHubClaims] = useState<any[]>([]);

  // Master policy ingestion (broker-only) — see backend POST /api/venues/{id}/policy-docs
  const [policyText, setPolicyText] = useState("");
  const [sourceFile, setSourceFile] = useState("master_policy.md");
  const [uploadingPolicy, setUploadingPolicy] = useState(false);
  const [ingestedSources, setIngestedSources] = useState<IngestedSource[]>([]);
  const [showAdvancedPolicy, setShowAdvancedPolicy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const policyTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Recompute preview chunks whenever the textarea content changes.
  // Cheap (regex splits) so we don't need to memoize unless lists get huge.
  const previewChunks: PreviewChunk[] = policyText.trim() ? chunkPolicyText(policyText) : [];
  const hasNoHeadings = policyText.trim().length > 0 && previewChunks.length === 0;

  async function refreshIngestedSources() {
    if (!venueId) return;
    try {
      const res = await fetch(`${API_URL}/api/venues/${venueId}/sources`);
      if (!res.ok) return;
      const all: IngestedSource[] = await res.json();
      // Filter to policy-ingestion sources (id prefix matches the backend hash convention)
      setIngestedSources(all.filter(s => s.id.startsWith("ingested-")));
    } catch {
      // non-fatal
    }
  }

  async function handleUploadPolicy() {
    if (!policyText.trim()) {
      toastError("Paste the policy markdown before uploading.");
      return;
    }
    // F3: client-side validation — catch the no-heading case before a wasted round trip.
    if (previewChunks.length === 0) {
      toastError("No clauses detected. Use ## Section / ### Clause headings so the parser can extract content.");
      return;
    }
    setUploadingPolicy(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
      if (!token) {
        toastError("Sign in as a broker to upload policy documents.");
        return;
      }
      const res = await fetch(`${API_URL}/api/venues/${venueId}/policy-docs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ text: policyText, source_file: sourceFile || "master_policy.md" }),
      });
      if (res.status === 403) {
        toastError("Only brokers can upload policy documents.");
        return;
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        toastError(detail.detail || "Policy upload failed.");
        return;
      }
      const body = await res.json();
      // M7: distinguish "all new" / "some new" / "everything already on file"
      if (body.chunks_inserted === 0 && body.chunks_extracted > 0) {
        toastSuccess(`Policy is already up to date — ${body.chunks_extracted} clauses on file, no new content.`);
      } else if (body.chunks_inserted === body.chunks_extracted) {
        toastSuccess(`Ingested ${body.chunks_inserted} new clause${body.chunks_inserted === 1 ? "" : "s"}.`);
      } else {
        toastSuccess(`Ingested ${body.chunks_inserted} new clause${body.chunks_inserted === 1 ? "" : "s"}; ${body.chunks_extracted - body.chunks_inserted} already on file.`);
      }
      setPolicyText("");
      setShowPreview(false);
      await refreshIngestedSources();
    } catch (err) {
      toastError("Network error during policy upload.");
    } finally {
      setUploadingPolicy(false);
    }
  }

  function handleFileDrop(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      toastError("File too large. Markdown policies should be under 2MB; for larger PDFs, contact engineering.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      setPolicyText(text);
      setSourceFile(file.name || "master_policy.md");
      setShowPreview(true);
    };
    reader.onerror = () => toastError("Couldn't read file. Try pasting the markdown instead.");
    reader.readAsText(file);
  }

  useEffect(() => {
    if (isBroker && venueId) refreshIngestedSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBroker, venueId]);

  // F4: auto-focus the textarea once for new-venue brokers — but only after
  // the sources list has loaded and we've confirmed it's empty.
  const [hasAutoFocused, setHasAutoFocused] = useState(false);
  useEffect(() => {
    if (
      isBroker &&
      ingestedSources.length === 0 &&
      !hasAutoFocused &&
      policyTextareaRef.current
    ) {
      policyTextareaRef.current.focus();
      setHasAutoFocused(true);
    }
  }, [isBroker, ingestedSources.length, hasAutoFocused]);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    async function load() {
      try {
        // All of these endpoints are venue-access gated — the bearer token is
        // required for the owning operator + brokers; anonymous is already
        // bounced to /login above.
        const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
        const authH: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const [riskRes, quoteRes, venueRes, statsRes, countsRes] = await Promise.all([
          fetch(`${API_URL}/api/venues/${venueId}/risk-score`, { headers: authH }),
          fetch(`${API_URL}/api/venues/${venueId}/quote`, { headers: authH }),
          fetch(`${API_URL}/api/venues/${venueId}`, { headers: authH }),
          fetch(`${API_URL}/api/venues/${venueId}/override-stats`, { headers: authH }),
          fetch(`${API_URL}/api/venues/${venueId}/incidents/counts`, { headers: authH }),
        ]);
        // A signed-in user reading a venue they don't own gets 403 — don't render
        // a misleading empty "—/0" profile; surface an explicit access-denied state.
        if (riskRes.status === 403) {
          setAccessDenied(true);
          return;
        }
        // A network/server failure on the primary read must not silently render
        // an empty "—/0" profile — surface an honest, retryable error instead.
        if (!riskRes.ok) {
          setError(true);
          return;
        }
        if (riskRes.ok) setRiskData(await riskRes.json());
        if (quoteRes.ok) setQuoteData(await quoteRes.json());
        if (venueRes.ok) { const v = await venueRes.json(); setVenueName(v.name ?? venueId); setVenueMeta(v); }
        if (statsRes.ok) setOverrideStats(await statsRes.json());
        if (countsRes.ok) {
          const c = await countsRes.json();
          setIncidentCounts({ total: c.total ?? 0, open: c.open ?? 0 });
        }
        // Broker action-hub data — pending/needs-info proposals + open claims
        // for this venue. Broker-only (the claims endpoint is broker-gated) and
        // skipped for prospects (no claims/proposals exist yet).
        if (isBroker && !venueId.startsWith("prospect-")) {
          const [propRes, claimsRes] = await Promise.all([
            fetch(`${API_URL}/api/claim-proposals?venue_id=${encodeURIComponent(venueId)}`, { headers: authH }),
            fetch(`${API_URL}/api/claims?venue_id=${encodeURIComponent(venueId)}&open_only=true`, { headers: authH }),
          ]);
          if (propRes.ok) {
            const all = await propRes.json();
            setHubDecisions(
              all.filter((p: any) => p.state === "pending_broker_review" || p.state === "needs_more_info"),
            );
          }
          if (claimsRes.ok) setHubClaims(await claimsRes.json());
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    }
    if (venueId) load();
  }, [venueId]);

  // A prospect is a real NYC lead (not underwritten) — its figures are
  // estimates, so the operator/broker policy-ingestion tooling doesn't apply.
  const isProspect = venueId.startsWith("prospect-") || venueMeta?.source === "prospect";

  // Brokers reach this page from several surfaces (Book, Market, Venues) and
  // have no operator terminal to return to — /terminal is operator-only and
  // redirects brokers right back here, so a `/terminal/{id}` back link is a
  // no-op loop. Use history with a portfolio fallback; operators and prospects
  // each have a single stable origin.
  const backHref = isProspect || isBroker ? "/venues" : "/dashboard";
  const backLabel = isProspect ? "Back to Venues" : isBroker ? "Back" : "Back to Dashboard";
  const handleBack = () => {
    if (isBroker && !isProspect && typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push(backHref);
    }
  };
  // Register the single contextual back; AppShell renders it in place of "Back
  // to home" (no role gate — the back-nav contract dedupes for every persona).
  usePageBack(backLabel, handleBack);

  if (loading) {
    return (
      <div className="page-loading" role="status" aria-live="polite">
        <div className="loading-spinner" aria-hidden="true" />
        <span style={SR_ONLY_STYLE}>Loading risk profile…</span>
      </div>
    );
  }

  if (accessDenied) {
    // Signed-in, but this venue isn't theirs (backend 403). A permissions
    // boundary, not an error — calm ink treatment, no tier-d red, one primary
    // CTA back to their own surface.
    return (
      <div
        className="page-loading"
        role="alert"
        style={{ flexDirection: "column", gap: "var(--space-lg)", padding: "var(--space-xl)", textAlign: "center" }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 60,
            height: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--bg-elevated)",
            border: "1.5px solid var(--border-strong)",
            boxShadow: "var(--shadow-md)",
            color: "var(--text-secondary)",
          }}
        >
          <Lock size={26} strokeWidth={1.75} aria-hidden="true" />
        </div>
        <div style={{ maxWidth: 440, display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: "1.75rem", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.01em" }}>
            Not your venue
          </h1>
          <p style={{ fontFamily: "var(--font-body)", fontSize: "0.95rem", lineHeight: 1.6, color: "var(--text-secondary)", margin: 0 }}>
            You can only open the risk profile for venues you operate. If you manage this one, ask a broker to grant you access.
          </p>
        </div>
        <div style={{ display: "flex", gap: "var(--space-sm)", flexWrap: "wrap", justifyContent: "center" }}>
          <Link
            href="/dashboard"
            style={{
              display: "inline-flex", alignItems: "center", gap: "0.4rem",
              padding: "0.6rem 1.1rem",
              fontFamily: "var(--font-body)", fontWeight: 600, fontSize: "0.9rem",
              color: "var(--text-inverse)", background: "var(--brand-primary)",
              border: "1.5px solid var(--border-strong)", boxShadow: "var(--shadow-md)",
              textDecoration: "none",
            }}
          >
            Go to my dashboard
          </Link>
          <Link
            href="/incidents"
            style={{
              display: "inline-flex", alignItems: "center", gap: "0.4rem",
              padding: "0.6rem 1.1rem",
              fontFamily: "var(--font-body)", fontWeight: 600, fontSize: "0.9rem",
              color: "var(--text-primary)", background: "var(--bg-elevated)",
              border: "1.5px solid var(--border-strong)",
              textDecoration: "none",
            }}
          >
            Back to incidents
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    // Honest, retryable failure — separate from the 403 access-denied state
    // above, and never a misleading empty "—/0" profile.
    return (
      <div
        className="page-loading"
        role="alert"
        style={{ flexDirection: "column", gap: "var(--space-lg)", padding: "var(--space-xl)", textAlign: "center" }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 60, height: 60, display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--bg-elevated)", border: "1.5px solid var(--border-strong)",
            boxShadow: "var(--shadow-md)", color: "var(--state-warning)",
          }}
        >
          <AlertTriangle size={26} strokeWidth={1.75} aria-hidden="true" />
        </div>
        <div style={{ maxWidth: 440, display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: "1.75rem", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.01em" }}>
            Couldn&apos;t load this risk profile
          </h1>
          <p style={{ fontFamily: "var(--font-body)", fontSize: "0.95rem", lineHeight: 1.6, color: "var(--text-secondary)", margin: 0 }}>
            The score didn&apos;t come back. This is usually a temporary connection issue — try again.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.4rem",
            padding: "0.6rem 1.1rem", cursor: "pointer",
            fontFamily: "var(--font-body)", fontWeight: 600, fontSize: "0.9rem",
            color: "var(--text-inverse)", background: "var(--brand-primary)",
            border: "1.5px solid var(--border-strong)", boxShadow: "var(--shadow-md)",
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const tier = riskData?.tier ?? "—";
  const score = riskData?.total_score ?? 0;
  const tierColor = TIER_COLOR[tier] ?? "var(--text-secondary)";
  const factors: Record<string, number> = riskData?.factors
    ? Object.fromEntries(Object.entries(riskData.factors).map(([k, v]: [string, any]) => [k, typeof v === "object" ? v.score : v]))
    : {};
  const factorWeights: Record<string, number> = riskData?.factors
    ? Object.fromEntries(Object.entries(riskData.factors).map(([k, v]: [string, any]) => [k, typeof v === "object" && typeof v.weight === "number" ? v.weight : 0]))
    : {};
  // Projected total score if a single factor were fixed to 100. Weights may sum to 1 or 100; normalize.
  const weightSum = Object.values(factorWeights).reduce((a, b) => a + b, 0) || 1;
  function projectedTotalIfFixed(targetKey: string): number {
    const sum = Object.entries(factors).reduce((acc, [k, s]) => {
      const w = factorWeights[k] ?? 0;
      const used = k === targetKey ? 100 : Number(s);
      return acc + used * w;
    }, 0);
    return Math.round(sum / weightSum);
  }

  const goodFactors = Object.entries(factors).filter(([, v]) => getFactorTier(Number(v)) === "good");
  const moderateFactors = Object.entries(factors).filter(([, v]) => getFactorTier(Number(v)) === "moderate");
  const poorFactors = Object.entries(factors).filter(([, v]) => getFactorTier(Number(v)) === "poor");
  const needsAttention = [...poorFactors, ...moderateFactors];

  const savingsAnnual = quoteData?.savings_annual ?? 0;
  const hasImprovementHeadroom = ["B", "C", "D"].includes(tier);

  const isPolicyEmpty = isBroker && !isProspect && ingestedSources.length === 0;

  const masterPolicyCard = isBroker && !isProspect ? (
    <div
      className="card"
      style={
        isPolicyEmpty
          ? { borderColor: "var(--brand-primary)", boxShadow: "0 0 0 1px var(--brand-primary)22" }
          : undefined
      }
    >
      <div className="flex items-center gap-sm mb-lg" style={{ justifyContent: "space-between" }}>
        <div className="flex items-center gap-sm">
          <FileText size={16} className="text-secondary" aria-hidden="true" />
          <h3 className="rp-section-title text-xs uppercase tracking-wide text-secondary">Master Policy</h3>
        </div>
        {isPolicyEmpty && (
          <span
            className="text-xs font-mono"
            style={{
              color: "var(--accent-ink)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              fontSize: "0.65rem",
            }}
          >
            Onboarding · Step 1
          </span>
        )}
      </div>

      {ingestedSources.length > 0 && (
        <div className="mb-md">
          <p className="text-xs text-secondary mb-sm">
            {ingestedSources.length} clause{ingestedSources.length === 1 ? "" : "s"} on file. These are cited in generated underwriting memos for this venue.
          </p>
          <div className="flex flex-col gap-xs" style={{ maxHeight: 180, overflowY: "auto" }} role="list" aria-label="Ingested policy clauses">
            {ingestedSources.slice(0, 8).map(s => (
              <div key={s.id} role="listitem" className="p-sm" style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)" }}>
                <div className="flex items-center gap-sm mb-xs">
                  <span className="text-xs font-mono" style={{
                    color: s.source_type === "policy_exclusion" ? "var(--state-warning)" : "var(--accent-ink)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}>
                    {s.source_type.replace("_", " ")}
                  </span>
                </div>
                <p className="text-xs text-secondary" style={{ lineHeight: 1.5 }}>
                  {s.excerpt.length > 180 ? s.excerpt.slice(0, 180) + "…" : s.excerpt}
                </p>
              </div>
            ))}
          </div>
          {ingestedSources.length > 8 && (
            <p className="text-xs text-secondary mt-xs" style={{ fontStyle: "italic" }}>
              Showing 8 of {ingestedSources.length} clauses — scroll within the list to see the rest.
            </p>
          )}
        </div>
      )}

      {isPolicyEmpty && (
        <p className="text-xs text-secondary mb-md" style={{ lineHeight: 1.6 }}>
          Upload the carrier&apos;s master policy so every underwriting memo generated for this venue cites the actual contract language — not generic best-practice text.
        </p>
      )}

      <div className="flex flex-col gap-sm">
        {/* M1: drag-drop zone for .md/.txt uploads. Textarea remains as the paste-fallback below. */}
        <div
          onDragEnter={(e) => { e.preventDefault(); setIsDraggingFile(true); }}
          onDragOver={(e) => { e.preventDefault(); setIsDraggingFile(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsDraggingFile(false); }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingFile(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFileDrop(file);
          }}
          style={{
            border: `1px dashed ${isDraggingFile ? "var(--brand-primary)" : "var(--border-default)"}`,
            background: isDraggingFile ? "var(--brand-primary)11" : "var(--bg-elevated)",
            borderRadius: "var(--radius-sm)",
            padding: "var(--space-md)",
            textAlign: "center",
            transition: "border-color 150ms, background 150ms",
          }}
        >
          <Upload size={18} aria-hidden="true" style={{ color: "var(--text-tertiary)", marginBottom: 4 }} />
          <p className="text-xs text-secondary" style={{ margin: 0, lineHeight: 1.5 }}>
            Drop a <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.85em" }}>.md</code> or <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.85em" }}>.txt</code> file here, or paste markdown below.
          </p>
          <input
            type="file"
            accept=".md,.txt,text/markdown,text/plain"
            style={SR_ONLY_STYLE}
            id="rp-policy-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileDrop(file);
              e.target.value = "";
            }}
          />
          <label htmlFor="rp-policy-file" className="text-xs font-mono" style={{ color: "var(--accent-ink)", cursor: "pointer", textDecoration: "underline", display: "inline-block", marginTop: 4 }}>
            Browse files
          </label>
        </div>

        <label htmlFor="rp-policy-text" className="text-xs uppercase tracking-wide text-secondary mt-sm">
          Policy markdown
        </label>
        <textarea
          ref={policyTextareaRef}
          id="rp-policy-text"
          value={policyText}
          onChange={(e) => setPolicyText(e.target.value)}
          placeholder={"## Coverage Section\n\n### 4.2 Premises Liability\nThe carrier shall cover..."}
          disabled={uploadingPolicy}
          rows={8}
          className="rp-textarea"
          aria-describedby="rp-policy-text-help"
          aria-invalid={hasNoHeadings ? "true" : "false"}
        />
        <span id="rp-policy-text-help" className="text-xs text-secondary" style={{ lineHeight: 1.5 }}>
          Use <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.85em" }}>## Section</code> for top-level groups and <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.85em" }}>### Clause</code> for individual provisions. Re-uploading the same content is a no-op — clause IDs are content-hashed.
        </span>

        {/* F3 inline warning: surface the no-heading problem as the user types, not at submit time. */}
        {hasNoHeadings && (
          <p className="text-xs" role="alert" style={{ color: "var(--state-warning)", lineHeight: 1.5 }}>
            ⚠ No <code style={{ fontFamily: "var(--font-mono)" }}>## Section</code> / <code style={{ fontFamily: "var(--font-mono)" }}>### Clause</code> headings detected. Add headings before submitting or the parser will extract 0 clauses.
          </p>
        )}

        {/* M2: client-side preview using the same chunker as the backend. */}
        {previewChunks.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowPreview(v => !v)}
              className="text-xs font-mono"
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                padding: "var(--space-xs) 0",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
              aria-expanded={showPreview}
              aria-controls="rp-preview-list"
            >
              {showPreview ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              <Eye size={12} aria-hidden="true" />
              Preview {previewChunks.length} clause{previewChunks.length === 1 ? "" : "s"} that will be ingested
            </button>
            {showPreview && (
              <div id="rp-preview-list" className="flex flex-col gap-xs mt-xs" style={{ maxHeight: 200, overflowY: "auto" }}>
                {previewChunks.slice(0, 12).map((c, i) => (
                  <div key={i} className="p-sm" style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)" }}>
                    <span className="text-xs font-mono" style={{
                      color: c.is_exclusion ? "var(--state-warning)" : "var(--accent-ink)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}>
                      {c.is_exclusion ? "exclusion" : "policy"} · {c.section}
                    </span>
                    <p className="text-xs text-secondary mt-xs" style={{ lineHeight: 1.5 }}>
                      <strong style={{ color: "var(--text-primary)" }}>{c.clause}</strong> — {c.content.replace(`${c.section} > `, "").slice(0, 160)}{c.content.length > 160 ? "…" : ""}
                    </p>
                  </div>
                ))}
                {previewChunks.length > 12 && (
                  <p className="text-xs text-secondary" style={{ fontStyle: "italic" }}>
                    + {previewChunks.length - 12} more clause{previewChunks.length - 12 === 1 ? "" : "s"} (will be ingested but not previewed here)
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* M5: source filename is rarely useful — collapse behind an Advanced disclosure. */}
        <button
          type="button"
          onClick={() => setShowAdvancedPolicy(v => !v)}
          className="text-xs font-mono"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            padding: "var(--space-xs) 0",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            textAlign: "left",
          }}
          aria-expanded={showAdvancedPolicy}
          aria-controls="rp-advanced-policy"
        >
          {showAdvancedPolicy ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          Advanced
        </button>
        {showAdvancedPolicy && (
          <div id="rp-advanced-policy" className="flex flex-col gap-xs">
            <label htmlFor="rp-source-file" className="text-xs uppercase tracking-wide text-secondary">
              Source filename
            </label>
            <input
              id="rp-source-file"
              type="text"
              value={sourceFile}
              onChange={(e) => setSourceFile(e.target.value)}
              placeholder="master_policy.md"
              disabled={uploadingPolicy}
              className="rp-input"
              aria-describedby="rp-source-file-help"
            />
            <span id="rp-source-file-help" className="text-xs text-tertiary" style={{ lineHeight: 1.5 }}>
              Recorded in the audit trail for this upload. Defaults to <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.85em" }}>master_policy.md</code>.
            </span>
          </div>
        )}

        {/* M3: unified button label — same verb regardless of state. */}
        <button
          onClick={handleUploadPolicy}
          disabled={uploadingPolicy || !policyText.trim() || hasNoHeadings}
          aria-disabled={uploadingPolicy || !policyText.trim() || hasNoHeadings}
          aria-describedby="rp-ingest-hint"
          className="btn btn-secondary"
          style={{
            cursor: uploadingPolicy || !policyText.trim() || hasNoHeadings ? "not-allowed" : "pointer",
            opacity: uploadingPolicy || !policyText.trim() || hasNoHeadings ? 0.6 : 1,
            minHeight: 44,
          }}
        >
          {uploadingPolicy ? (
            <><div className="loading-spinner loading-spinner-sm" aria-hidden="true" />Ingesting…</>
          ) : (
            <><Upload size={14} aria-hidden="true" />Ingest Policy</>
          )}
        </button>

        {/* Say why the button is disabled (or, once valid, how many clauses
            are queued). Without this, a greyed-out button reads as "broken"
            — the no-headings case otherwise only surfaces in a post-click toast. */}
        <span
          id="rp-ingest-hint"
          className="text-xs text-tertiary"
          aria-live="polite"
          style={{ lineHeight: 1.5 }}
        >
          {uploadingPolicy
            ? "Uploading…"
            : !policyText.trim()
            ? "Paste policy markdown above to enable."
            : hasNoHeadings
            ? "Add ## Section or ### Clause headings — no clauses detected yet."
            : `${previewChunks.length} clause${previewChunks.length === 1 ? "" : "s"} ready to ingest.`}
        </span>
      </div>
    </div>
  ) : null;

  return (
    <div className="lc-shell theme-venue min-h-screen rp-page">
      {/* Page-scoped responsive rules: 1024px breakpoint for the two-column grid,
          responsive padding so 375px phones aren't choked by 32px outer padding,
          max-width cap so the page doesn't stretch on ultrawide monitors. */}
      <style>{`
        .rp-page { padding: var(--space-md); }
        @media (min-width: 640px) { .rp-page { padding: var(--space-lg); } }
        @media (min-width: 1024px) { .rp-page { padding: var(--space-xl); } }
        .rp-container { max-width: 1280px; margin: 0 auto; }
        .rp-grid { display: flex; flex-direction: column; gap: var(--space-lg); }
        /* Column wrappers collapse so their children become direct grid items,
           then grid-auto-flow:dense packs cards into whichever column has
           space. This keeps the narrative order while preventing the right
           column from looking empty when there are fewer right-side cards. */
        @media (min-width: 1024px) {
          /* Balanced two-column masonry. A fixed 1fr-1fr grid coupled card-row
             heights (tall card left a void beside a short one); two independent
             flex columns then left a long trailing gap when one column had more
             content. CSS multi-column lets the browser height-balance ALL cards
             across two columns, so neither a mid-content void nor a long trailing
             gap can form — robust to the conditional cards on this page. The
             rp-col wrappers dissolve (display:contents) so every card flows into
             the columns; break-inside keeps cards intact; margin spaces them
             (multi-column ignores flex/grid gap for intra-column spacing). */
          .rp-grid { display: block; column-count: 2; column-gap: var(--space-xl); }
          .rp-grid > .rp-col { display: contents; }
          .rp-grid > .rp-col > * { break-inside: avoid; margin-bottom: var(--space-lg); }
        }
        .rp-tier { font-size: clamp(4rem, 13vw, 7rem); font-weight: 500; font-style: italic; line-height: 0.85; letter-spacing: -0.06em; font-family: var(--font-display); text-shadow: 0 0 60px currentColor; opacity: 0.92; }
        .rp-score { font-size: clamp(2.75rem, 8vw, 4.5rem); font-weight: 700; font-style: normal; line-height: 0.9; letter-spacing: -0.03em; font-family: var(--font-body); font-variant-numeric: lining-nums tabular-nums; }
        .rp-input, .rp-textarea { background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
                                    padding: var(--space-sm); color: var(--text-primary); font-family: var(--font-mono); font-size: 0.75rem; width: 100%; }
        .rp-input:focus-visible, .rp-textarea:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; border-color: transparent; }
        .rp-textarea { resize: vertical; min-height: 120px; }
        .rp-section-title { margin: 0; font-weight: inherit; }

        /* Interactive factor rows — affordance mirrors the app's .lc-triage__row:
           hover tint + lime focus ring + a chevron that nudges on hover/focus. */
        .rp-factor-row { display: block; text-decoration: none; color: inherit; cursor: pointer;
          border-radius: var(--radius-md); padding: var(--space-sm); margin: calc(var(--space-sm) * -1);
          transition: background 0.15s ease; }
        .rp-factor-row:hover { background: rgba(23,21,15,0.05); }
        .rp-factor-row:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; }
        .rp-factor-chevron { transition: transform 0.15s ease, color 0.15s ease; }
        .rp-factor-row:hover .rp-factor-chevron,
        .rp-factor-row:focus-visible .rp-factor-chevron { color: var(--accent-ink); transform: translateX(2px); }

        /* "What to Improve" advice → deep-link to the fix. Inline, underlined
           on hover, with a chevron that nudges — reads as an action, not prose. */
        .rp-fix-link { display: inline-flex; align-items: center; gap: 2px; text-decoration: none;
          cursor: pointer; border-radius: var(--radius-sm); }
        .rp-fix-link:hover { text-decoration: underline; }
        .rp-fix-link:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; }
        .rp-fix-link:hover .rp-factor-chevron,
        .rp-fix-link:focus-visible .rp-factor-chevron { transform: translateX(2px); }

        /* Records & evidence — connective hub link tiles. */
        .rp-dossier-grid { display: grid; grid-template-columns: 1fr; gap: var(--space-sm); }
        @media (min-width: 640px) { .rp-dossier-grid { grid-template-columns: 1fr 1fr; } }
        .rp-dossier-tile { display: flex; align-items: center; gap: var(--space-sm); min-height: 56px;
          padding: var(--space-sm) var(--space-md); border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md); background: transparent; text-decoration: none; color: inherit;
          cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease; }
        .rp-dossier-tile:hover { background: rgba(23,21,15,0.05); border-color: var(--border-default); }
        .rp-dossier-tile:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; }
        .rp-dossier-icon { flex: 0 0 auto; color: var(--text-tertiary); }
        .rp-dossier-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .rp-dossier-label { font-size: 0.8125rem; font-weight: 600; color: var(--text-primary); }
        .rp-dossier-meta { font-size: 0.7rem; color: var(--text-tertiary); letter-spacing: -0.01em; }
        .rp-dossier-chevron { flex: 0 0 auto; color: var(--text-muted); transition: transform 0.15s ease, color 0.15s ease; }
        .rp-dossier-tile:hover .rp-dossier-chevron,
        .rp-dossier-tile:focus-visible .rp-dossier-chevron { color: var(--accent-ink); transform: translateX(2px); }

        @media (prefers-reduced-motion: reduce) {
          .rp-factor-row, .rp-factor-chevron, .rp-dossier-tile, .rp-dossier-chevron { transition: none; }
          .rp-factor-row:hover .rp-factor-chevron, .rp-factor-row:focus-visible .rp-factor-chevron,
          .rp-dossier-tile:hover .rp-dossier-chevron, .rp-dossier-tile:focus-visible .rp-dossier-chevron { transform: none; }
        }
      `}</style>
      <div className="rp-container">
        {/* Back nav is registered via usePageBack and rendered once by AppShell
            (see BackNavContext) — no page-level back button here, so brokers no
            longer see it stacked under the shell's "Back to home". */}
        <header className="mb-xl">
          <div className="flex items-center gap-sm mb-xs" style={{ flexWrap: "wrap" }}>
            {venueName && <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>{venueName}</p>}
            {/* P1: persona chip — makes the view-as context unambiguous */}
            <span
              className="text-xs font-mono"
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                border: `1px solid ${isBroker ? "var(--brand-secondary)" : "var(--brand-primary)"}33`,
                background: `${isBroker ? "var(--brand-secondary)" : "var(--brand-primary)"}14`,
                color: isBroker ? "var(--brand-secondary)" : "var(--accent-ink)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontSize: "0.65rem",
              }}
            >
              {isBroker ? "Viewing as broker" : "Your venue"}
            </span>
          </div>
          <h1 className="text-4xl font-bold glow-text">Risk Profile</h1>
          <p style={{ ...SR_ONLY_STYLE }} aria-live="polite">
            Tier {tier}, score {score} out of 100.
          </p>
          {/* Operator quick links — this is the venue-detail surface, so jump
              straight to the venue's incidents and claims from here. */}
          {!isBroker && (
            <div className="flex items-center gap-sm" style={{ marginTop: "var(--space-md)", flexWrap: "wrap" }}>
              <Link href={`/incidents?venue=${venueId}`} className="lc-chip" style={{ textDecoration: "none", minHeight: 36 }}>
                <AlertTriangle size={12} style={{ marginRight: 6, display: "inline" }} aria-hidden="true" /> Incidents
              </Link>
              <Link href="/claims" className="lc-chip" style={{ textDecoration: "none", minHeight: 36 }}>
                <FileText size={12} style={{ marginRight: 6, display: "inline" }} aria-hidden="true" /> Claims
              </Link>
              <Link href="/venues" className="lc-chip" style={{ textDecoration: "none", minHeight: 36 }}>
                <Building2 size={12} style={{ marginRight: 6, display: "inline" }} aria-hidden="true" /> Manage venue
              </Link>
            </div>
          )}
        </header>

        <div className="rp-grid">
        {/* Left column — at 1024px+ this wrapper collapses (display:contents)
            and its cards become direct grid children, so cards from both
            columns flow together into the 2-col grid. */}
        <div className="flex flex-col gap-lg rp-col">

          {/* Score hero — tier and score are responsive via clamp() so they don't overflow on 375px phones */}
          <div className="card" style={{ border: `1px solid ${tierColor}33` }}>
            <div className="flex items-center gap-xl">
              <div className="rp-tier" style={{ color: tierColor }} aria-hidden="true">
                {tier}
              </div>
              <div>
                <div className="rp-score" style={{ color: tierColor, display: "flex", alignItems: "center", gap: "10px" }}>
                  <span>{score}<span className="text-xl text-secondary font-normal"> / 100</span></span>
                  {isProspect && <span className="venue-prospect-badge" title="Estimated from public records — not live telemetry">EST.</span>}
                </div>
                <p className="text-xs font-mono text-secondary mt-xs">
                  {isProspect
                    ? `Tier ${tier} · Estimated from public records`
                    : `Tier ${tier} · Evidence-First Underwriting`}
                </p>
                {/* P3: surface savings to both personas with persona-appropriate framing */}
                {savingsAnnual > 0 && (
                  <p className="text-xs mt-xs" style={{ color: "var(--accent-ink)" }}>
                    {isBroker
                      ? `Customer saving $${savingsAnnual.toLocaleString()}/yr vs market`
                      : `Saving $${savingsAnnual.toLocaleString()}/yr vs market rate`}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Framing */}
          <div className="card">
            {isBroker ? (
              <>
                <h2 className="text-sm font-semibold mb-sm">
                  {isProspect ? "Estimated Risk Profile" : "Risk Intelligence Summary"}
                </h2>
                <p className="text-sm text-secondary" style={{ lineHeight: 1.7 }}>
                  {isProspect
                    ? "This profile is modeled from public license records — incident history, compliance items, and operational attributes are estimates, not the venue's real telemetry. Bind a quote to start collecting live data and convert this into an underwritten profile."
                    : "This venue's risk profile reflects their operational data, incident history, and compliance posture. Use this breakdown when discussing coverage terms or renewal pricing with the venue."}
                </p>
              </>
            ) : (
              <>
                <h2 className="text-sm font-semibold mb-sm">
                  {score >= 85 ? "Your profile is strong — keep it up." :
                   score >= 65 ? "Good foundation — a few areas to improve." :
                   "Action needed to lower your premium."}
                </h2>
                <p className="text-sm text-secondary" style={{ lineHeight: 1.7 }}>
                  {score >= 85
                    ? "Your operational data and incident record show underwriters you run a tight operation. Maintaining this keeps your premium low and your coverage secure."
                    : score >= 65
                    ? "You're in good standing but addressing the factors below could move you to a better tier and reduce your annual premium."
                    : "Your current score is driving a higher premium. The factors below are specific — addressing them directly will improve your rate at renewal."}
                </p>
              </>
            )}
          </div>

          {/* Factor breakdown */}
          <div className="card">
            <h3 className="rp-section-title text-xs uppercase tracking-wide text-secondary mb-lg">Factor Breakdown</h3>
            <div className="flex flex-col gap-lg">
              {Object.entries(factors).map(([key, val]) => {
                const s = Number(val);
                const color = getFactorColor(s);
                const info = FACTOR_EXPLANATIONS[key];
                const ft = getFactorTier(s);
                const label = info?.label ?? key.replace(/_/g, " ");
                // Drill into the evidence behind each factor. Only link rows with
                // a real destination — others stay static (no chevron, no cursor).
                const href = factorHref(key, venueId, isBroker);

                const showIncidentCounts = key === "incident_history" && incidentCounts !== null;
                // Risk-language chip: the 0-100 score is inverted from risk
                // (higher score = lower risk, like a credit score). Risk verbs
                // make the row read direction-correctly for an insurance audience.
                const tierWord = ft === "good" ? "LOW RISK" : ft === "moderate" ? "MODERATE" : "HIGH RISK";
                const body = (
                  <>
                    {/* Header: label on the left, tier chip on the right. The
                        chip pairs the tier word with the 0-100 score so the
                        bare number can't be misread as a count of items. */}
                    <div className="flex items-center justify-between mb-xs" style={{ gap: 8 }}>
                      <span className="text-xs uppercase tracking-wide text-secondary">{label}</span>
                      <span className="flex items-center gap-xs">
                        <span
                          className="text-xs font-mono"
                          style={{
                            color,
                            border: `1px solid ${color}55`,
                            background: `${color}14`,
                            padding: "2px 8px",
                            borderRadius: 6,
                            letterSpacing: "0.05em",
                            fontWeight: 700,
                          }}
                          aria-label={`${ft}, ${s} out of 100`}
                        >
                          <FactorTierIcon tier={ft} color={color} /> {tierWord} · {s}/100
                        </span>
                        {href && <ChevronRight size={14} className="rp-factor-chevron" style={{ color: "var(--text-muted)" }} aria-hidden="true" />}
                      </span>
                    </div>
                    <div className="capacity-bar-track" style={{ height: 4, background: "var(--bg-elevated)", borderRadius: 2, overflow: "hidden" }} aria-hidden="true">
                      <div style={{ width: `${s}%`, height: "100%", background: color, borderRadius: 2 }} />
                    </div>
                    {showIncidentCounts && (
                      incidentCounts!.total === 0 ? (
                        <p
                          className="text-xs font-mono mt-xs"
                          style={{ color: "var(--text-muted)", fontStyle: "italic" }}
                        >
                          No incidents on file
                        </p>
                      ) : (
                        <p
                          className="text-xs font-mono mt-xs"
                          style={{ color: "var(--text-primary)", letterSpacing: "-0.01em" }}
                          aria-label={`${incidentCounts!.total} incidents total${incidentCounts!.open > 0 ? `, ${incidentCounts!.open} still open` : ""}`}
                        >
                          <span style={{ fontWeight: 700 }}>
                            {incidentCounts!.total} {incidentCounts!.total === 1 ? "incident" : "incidents"}
                          </span>
                          {incidentCounts!.open > 0 && (
                            <span style={{ color: "var(--state-warning)", marginLeft: 6 }}>
                              · {incidentCounts!.open} open
                            </span>
                          )}
                        </p>
                      )
                    )}
                  </>
                );

                if (!href) return <div key={key}>{body}</div>;
                return (
                  <Link
                    key={key}
                    href={href}
                    aria-label={`View ${label.toLowerCase()}`}
                    className="rp-factor-row"
                  >
                    {body}
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Decisions awaiting you — the broker's action surface for this
              venue. Pending/needs-info proposals + open claims, each linking to
              the existing decision UI. Turns the Risk Profile from a read-only
              hub into the place a broker acts. Broker-only, non-prospect. */}
          {isBroker && !isProspect && (
            <div className="card">
              <div className="flex items-center gap-sm mb-md">
                <ClipboardCheck size={16} className="text-secondary" aria-hidden="true" />
                <h3 className="rp-section-title text-xs uppercase tracking-wide text-secondary">Decisions awaiting you</h3>
              </div>
              {hubDecisions.length === 0 && hubClaims.length === 0 ? (
                <p className="text-xs text-secondary" style={{ lineHeight: 1.6 }}>
                  No proposals or open claims for this venue right now.
                </p>
              ) : (
                <div className="rp-dossier-grid" style={{ gridTemplateColumns: "1fr" }}>
                  {hubDecisions.map((p) => {
                    const awaiting = p.state === "needs_more_info";
                    return (
                      <Link
                        key={p.id}
                        href={`/underwriter/${p.packet_id}`}
                        className="rp-dossier-tile"
                        aria-label={`Review claim proposal — ${awaiting ? "info requested, awaiting operator" : "pending your review"}`}
                      >
                        <FileText size={18} className="rp-dossier-icon" aria-hidden="true" />
                        <span className="rp-dossier-body">
                          <span className="rp-dossier-label">Claim proposal</span>
                          <span
                            className="rp-dossier-meta font-mono"
                            style={{ color: awaiting ? "var(--state-warning)" : "var(--accent-ink)" }}
                          >
                            {awaiting ? "Info requested · awaiting operator" : "Pending your review"}
                          </span>
                        </span>
                        <ChevronRight size={16} className="rp-dossier-chevron" aria-hidden="true" />
                      </Link>
                    );
                  })}
                  {hubClaims.map((c) => (
                    <Link
                      key={c.id}
                      href={`/claims/${c.id}`}
                      className="rp-dossier-tile"
                      aria-label={`Open claim ${c.id}`}
                    >
                      <DollarSign size={18} className="rp-dossier-icon" aria-hidden="true" />
                      <span className="rp-dossier-body">
                        <span className="rp-dossier-label">Open claim</span>
                        <span className="rp-dossier-meta font-mono">{(c.status ?? "").replace(/_/g, " ")}</span>
                      </span>
                      <ChevronRight size={16} className="rp-dossier-chevron" aria-hidden="true" />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Records & evidence — connective hub. Complements the diagnostic
              factor rows above by giving the broker one launchpad into the
              venue's underlying records. Links to existing surfaces only.
              Broker-only: operators get the Incidents/Claims quick-links in the
              header above; prospects have no records. */}
          {isBroker && !isProspect && (
            <div className="card">
              <h3 className="rp-section-title text-xs uppercase tracking-wide text-secondary mb-md">Records &amp; evidence</h3>
              <p className="text-xs text-secondary mb-lg" style={{ lineHeight: 1.6 }}>
                Dig into the records behind the score.
              </p>
              <div className="rp-dossier-grid">
                <Link href={`/risk-profile/${encodeURIComponent(venueId)}/loss-run`} className="rp-dossier-tile" aria-label="View the loss run — claims history">
                  <TrendingDown size={18} className="rp-dossier-icon" aria-hidden="true" />
                  <span className="rp-dossier-body">
                    <span className="rp-dossier-label">Loss run</span>
                    <span className="rp-dossier-meta font-mono">Claims history · exportable CSV</span>
                  </span>
                  <ChevronRight size={16} className="rp-dossier-chevron" aria-hidden="true" />
                </Link>
                <Link href={`/incidents?venue=${encodeURIComponent(venueId)}`} className="rp-dossier-tile" aria-label="View incidents and evidence packets">
                  <AlertTriangle size={18} className="rp-dossier-icon" aria-hidden="true" />
                  <span className="rp-dossier-body">
                    <span className="rp-dossier-label">Incidents &amp; evidence packets</span>
                    {incidentCounts !== null && (
                      <span className="rp-dossier-meta font-mono">
                        {incidentCounts.total} total{incidentCounts.open > 0 ? ` · ${incidentCounts.open} open` : ""}
                      </span>
                    )}
                  </span>
                  <ChevronRight size={16} className="rp-dossier-chevron" aria-hidden="true" />
                </Link>
                <Link href={`/compliance?venue=${encodeURIComponent(venueId)}`} className="rp-dossier-tile" aria-label="View compliance records">
                  <ClipboardCheck size={18} className="rp-dossier-icon" aria-hidden="true" />
                  <span className="rp-dossier-body">
                    <span className="rp-dossier-label">Compliance</span>
                  </span>
                  <ChevronRight size={16} className="rp-dossier-chevron" aria-hidden="true" />
                </Link>
                <Link href={`/venues/${encodeURIComponent(venueId)}`} className="rp-dossier-tile" aria-label="View business profile">
                  <Building2 size={18} className="rp-dossier-icon" aria-hidden="true" />
                  <span className="rp-dossier-body">
                    <span className="rp-dossier-label">Business profile</span>
                  </span>
                  <ChevronRight size={16} className="rp-dossier-chevron" aria-hidden="true" />
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* Right column — also collapses at 1024px+; see note on left column. */}
        <div className="flex flex-col gap-lg rp-col">

          {/* P2: empty-state onboarding placement — Master Policy is Step 1 for a new venue */}
          {isPolicyEmpty && masterPolicyCard}

          {/* Prospect context — a real NYC lead, not yet underwritten. Replaces
              the policy-ingestion tooling (which doesn't apply) and carries the
              "get a quote" conversion path the venue card no longer does. */}
          {isProspect && (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
              <div className="flex items-center gap-sm" style={{ justifyContent: "space-between" }}>
                <h3 className="rp-section-title text-xs uppercase tracking-wide text-secondary">Prospect</h3>
                <span className="venue-prospect-badge">Estimated</span>
              </div>
              <p className="text-sm text-secondary" style={{ margin: 0 }}>
                Real NYC licensee, not yet on your book. Figures below are modeled
                estimates from public license data — not live telemetry.
              </p>
              {(venueMeta?.savings_low || venueMeta?.savings_high) && (
                <div>
                  <span className="text-xs uppercase tracking-wide text-secondary">Est. annual savings</span>
                  <div className="lc-numeral" style={{ color: "var(--accent-ink)", fontSize: "1.5rem" }}>
                    ${Math.round(Number(venueMeta.savings_low || 0)).toLocaleString()}–${Math.round(Number(venueMeta.savings_high || 0)).toLocaleString()}/yr
                  </div>
                </div>
              )}
              {Array.isArray(venueMeta?.likely_carriers) && venueMeta.likely_carriers.length > 0 && (
                <div>
                  <span className="text-xs uppercase tracking-wide text-secondary">Likely carriers</span>
                  <div className="market-card__chips" style={{ marginTop: 6 }}>
                    {venueMeta.likely_carriers.map((c: any) => (
                      <span key={c.id} className={`market-chip market-chip--${c.market_type === "admitted" ? "admitted" : "es"}`}>{c.name}</span>
                    ))}
                  </div>
                </div>
              )}
              <Link href={`/submissions/new?prospect=${encodeURIComponent(venueId)}`} className="btn btn-primary" style={{ textAlign: "center", textDecoration: "none" }}>
                Get a quote →
              </Link>
            </div>
          )}

          {/* What's working */}
          {goodFactors.length > 0 && (
            <div className="card">
              <div className="flex items-center gap-sm mb-lg">
                <CheckCircle2 size={16} style={{ color: "var(--accent-ink)" }} aria-hidden="true" />
                <h3 className="rp-section-title text-xs uppercase tracking-wide text-secondary">What's Working</h3>
              </div>
              <div className="flex flex-col gap-md">
                {goodFactors.map(([key]) => {
                  const info = FACTOR_EXPLANATIONS[key];
                  return (
                    <div key={key}>
                      <p className="text-sm font-semibold mb-xs">{info?.label}</p>
                      <p className="text-sm text-secondary" style={{ lineHeight: 1.6 }}>{info?.good?.[isBroker ? "broker" : "operator"]}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* What to improve / risk exposure */}
          {needsAttention.length > 0 && (
            <div className="card">
              <div className="flex items-center gap-sm mb-lg">
                <AlertTriangle size={16} style={{ color: isBroker ? "var(--state-error)" : "var(--state-warning)" }} aria-hidden="true" />
                <h3 className="rp-section-title text-xs uppercase tracking-wide text-secondary">
                  {isBroker ? "Risk Exposure" : "What to Improve"}
                </h3>
              </div>
              <div className="flex flex-col gap-lg">
                {needsAttention.map(([key, val]) => {
                  const s = Number(val);
                  const info = FACTOR_EXPLANATIONS[key];
                  const ft = getFactorTier(s);
                  const color = getFactorColor(s);
                  const w = factorWeights[key] ?? 0;
                  const weightPct = weightSum > 0 ? Math.round((w / weightSum) * 100) : null;
                  const projected = projectedTotalIfFixed(key);
                  const delta = projected - Number(score);
                  return (
                    <div key={key} style={{ borderLeft: `2px solid ${color}`, paddingLeft: "var(--space-md)" }}>
                      <div className="flex items-center justify-between mb-xs" style={{ gap: 8, flexWrap: "wrap" }}>
                        <p className="text-sm font-semibold" style={{ margin: 0 }}>{info?.label}</p>
                        <span className="text-xs font-mono" style={{ color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
                          <span style={{ color }}>{s}</span>
                          {" → 100  ·  "}
                          {delta > 0 ? <span style={{ color: "var(--accent-ink)" }}>+{delta} to total</span> : "no change"}
                          {weightPct != null && <> · weighted {weightPct}%</>}
                        </span>
                      </div>
                      {(() => {
                        // Turn the abstract score lift into a concrete incentive:
                        // estimate the annual-premium saving from fixing this factor.
                        // Hidden for prospects (estimated venues) and when unknown.
                        const saving = isProspect
                          ? 0
                          : estimatePremiumDeltaForFix(Number(score), projected, Number(quoteData?.annual_premium ?? 0));
                        return saving > 0 ? (
                          <p className="text-xs font-mono mb-xs" style={{ color: "var(--accent-ink)", display: "flex", alignItems: "center", gap: "0.3rem", margin: "0 0 var(--space-xs)" }}>
                            <TrendingDown size={12} aria-hidden="true" />
                            Resolve to save ~${saving.toLocaleString()}/yr
                            <span style={{ color: "var(--text-tertiary)" }}>· est.</span>
                          </p>
                        ) : null;
                      })()}
                      <p className="text-sm text-secondary mb-xs" style={{ lineHeight: 1.6 }}>{info?.[ft]?.[isBroker ? "broker" : "operator"]}</p>
                      {!isBroker && info?.action && (() => {
                        // Make the next-step a real deep-link to where the fix
                        // lives, not just advice text. Falls back to static text
                        // when the factor has no actionable surface.
                        const fixHref = factorHref(key, venueId, isBroker);
                        if (!fixHref) return <p className="text-xs font-mono" style={{ color }}>→ {info.action}</p>;
                        return (
                          <Link
                            href={fixHref}
                            className="rp-fix-link text-xs font-mono"
                            style={{ color }}
                            aria-label={`Fix ${info?.label ?? key}: ${info.action}`}
                          >
                            → {info.action}
                            <ChevronRight size={12} className="rp-factor-chevron" aria-hidden="true" />
                          </Link>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Premium impact */}
          {quoteData && (
            <div className="card">
              <div className="flex items-center gap-sm mb-lg">
                <DollarSign size={16} className="text-secondary" aria-hidden="true" />
                <h3 className="rp-section-title text-xs uppercase tracking-wide text-secondary">Premium Impact</h3>
              </div>
              <div className="flex flex-col gap-sm">
                <div className="flex justify-between items-center py-sm" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <span className="text-sm text-secondary">Annual Premium</span>
                  <span className="lc-numeral" style={{ color: tierColor, fontSize: "1.75rem" }}>${(quoteData.annual_premium ?? 0).toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center py-sm" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <span className="text-sm text-secondary">Monthly</span>
                  <span className="text-sm font-mono text-secondary">${(quoteData.monthly_premium ?? 0).toLocaleString()}/mo</span>
                </div>
                {savingsAnnual > 0 && (
                  <div className="flex justify-between items-center py-sm" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                    <span className="text-sm text-secondary">vs. Market Rate</span>
                    <span className="text-sm font-bold font-mono" style={{ color: "var(--accent-ink)" }}>-${savingsAnnual.toLocaleString()}/yr saved</span>
                  </div>
                )}
                {!isBroker && hasImprovementHeadroom && (
                  <div className="mt-sm p-md" style={{ background: "rgba(200,240,0,0.05)", border: "1px solid rgba(200,240,0,0.2)", borderRadius: "var(--radius-sm)" }}>
                    <p className="text-xs text-secondary" style={{ lineHeight: 1.6 }}>
                      <span style={{ color: "var(--accent-ink)", fontWeight: 600 }}>Improvement opportunity:</span> Moving up a tier typically reduces your annual premium. Address the factors flagged above and we'll provide a personalized estimate at renewal.
                    </p>
                  </div>
                )}

                {quoteData?.coverage_breakdown && (
                  <div style={{ marginTop: 18 }}>
                    <span className="lc-stat-label" style={{ display: "block", marginBottom: 8 }}>Coverage</span>
                    {Object.entries(quoteData.coverage_breakdown as Record<string, { included?: boolean; optional?: boolean }>).map(([key, line]) => {
                      const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                      const isIncluded = line.included === true;
                      return (
                        <div key={key} className="lc-cov-row">
                          <span className="lc-cov-row__name">{label}</span>
                          <span className="lc-cov-row__check" data-included={isIncluded ? "true" : "false"}>
                            {isIncluded ? "✓ included" : "+ add-on"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {(venueMeta?.current_carrier || quoteData?.renewal_date || venueMeta?.renewal_date) && (
                  <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border-subtle)" }}>
                    {venueMeta?.current_carrier && (
                      <div className="lc-cov-row">
                        <span className="lc-cov-row__name">Carrier</span>
                        <span className="lc-cov-row__check">{venueMeta.current_carrier}</span>
                      </div>
                    )}
                    {(quoteData?.renewal_date || venueMeta?.renewal_date) && (
                      <div className="lc-cov-row">
                        <span className="lc-cov-row__name">Renewal</span>
                        <span className="lc-cov-row__check">{quoteData?.renewal_date ?? venueMeta?.renewal_date}</span>
                      </div>
                    )}
                    <div className="lc-cov-row">
                      <span className="lc-cov-row__name">Term</span>
                      <span className="lc-cov-row__check">12 months</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Master Policy ingestion — broker-only.
              Uploaded chunks are scoped to this venue and fed to the retriever
              so generated memos cite the carrier's actual policy language. */}
          {/* Populated-state placement: Master Policy lives at the bottom of the right column once a venue has clauses on file */}
          {!isPolicyEmpty && masterPolicyCard}

          {/* Override Calibration — broker QA metric, not operator-facing. */}
          {isBroker && overrideStats && (() => {
            const right = overrideStats.override_right_rate;
            const baseline = overrideStats.non_override_right_rate;
            const decided = overrideStats.override_approved + overrideStats.override_rejected;
            // Color the rate against the baseline — only meaningful if both exist
            const rateColor =
              right == null
                ? "var(--text-secondary)"
                : baseline == null
                ? "var(--accent-ink)"
                : right >= baseline
                ? "var(--accent-ink)"
                : right >= baseline * 0.6
                ? "var(--state-warning)"
                : "var(--state-error)";
            return (
              <section className="card">
                <div
                  className="flex items-center justify-between mb-lg"
                  style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}
                >
                  <div>
                    <h3 className="rp-section-title text-xs uppercase tracking-wide text-secondary">
                      Override Calibration
                    </h3>
                    <p className="text-xs text-secondary" style={{ margin: "4px 0 0" }}>
                      How often this venue's operator overrides of the claim recommender are validated by broker decisions
                    </p>
                  </div>
                </div>

                {overrideStats.override_total === 0 ? (
                  <p className="text-sm text-secondary" style={{ fontStyle: "italic" }}>
                    No operator overrides recorded yet for this venue. Stats appear once the operator proposes a claim against a "don't file" recommendation.
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-lg mb-lg">
                      {/* Headline: override approval rate */}
                      <div className="p-md" style={{ border: `1px solid ${rateColor}55`, borderRadius: "var(--radius-sm)" }}>
                        <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>Override approval rate</p>
                        <p className="text-3xl font-bold font-mono" style={{ color: rateColor, margin: "4px 0" }}>
                          {right == null ? "—" : `${Math.round(right * 100)}%`}
                        </p>
                        <p className="text-xs text-secondary" style={{ margin: 0 }}>
                          {right == null
                            ? `${overrideStats.override_pending} pending · no decisions yet`
                            : `${overrideStats.override_approved} of ${decided} decided overrides approved`}
                        </p>
                      </div>
                      {/* Baseline */}
                      <div className="p-md" style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" }}>
                        <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>Baseline (non-overrides)</p>
                        <p className="text-3xl font-bold font-mono text-secondary" style={{ margin: "4px 0" }}>
                          {baseline == null ? "—" : `${Math.round(baseline * 100)}%`}
                        </p>
                        <p className="text-xs text-secondary" style={{ margin: 0 }}>
                          {baseline == null
                            ? "No decided non-override proposals to compare"
                            : `${overrideStats.non_override_approved} of ${overrideStats.non_override_approved + overrideStats.non_override_rejected} decided non-overrides approved`}
                        </p>
                      </div>
                    </div>

                    {/* Reason breakdown — actionable signal: which override reasons hold up */}
                    {Object.keys(overrideStats.by_reason).length > 0 && (
                      <div>
                        <p className="text-xs uppercase tracking-wide text-secondary mb-sm">By override reason</p>
                        <div className="flex flex-col gap-sm">
                          {Object.entries(overrideStats.by_reason).map(([reason, counts]) => {
                            const reasonDecided = counts.approved + counts.rejected;
                            const reasonRate = reasonDecided > 0 ? counts.approved / reasonDecided : null;
                            return (
                              <div
                                key={reason}
                                className="flex items-center justify-between p-sm"
                                style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" }}
                              >
                                <div>
                                  <p className="text-sm font-semibold" style={{ margin: 0 }}>
                                    {reason.replace(/_/g, " ")}
                                  </p>
                                  <p className="text-xs text-secondary" style={{ margin: 0 }}>
                                    {counts.total} total · {counts.approved} approved · {counts.rejected} rejected
                                    {counts.pending > 0 ? ` · ${counts.pending} pending` : ""}
                                  </p>
                                </div>
                                <span
                                  className="text-sm font-mono font-bold"
                                  style={{
                                    color:
                                      reasonRate == null
                                        ? "var(--text-secondary)"
                                        : reasonRate >= 0.7
                                        ? "var(--accent-ink)"
                                        : reasonRate >= 0.4
                                        ? "var(--state-warning)"
                                        : "var(--state-error)",
                                  }}
                                >
                                  {reasonRate == null ? "—" : `${Math.round(reasonRate * 100)}%`}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <p className="text-xs text-tertiary mt-md" style={{ fontStyle: "italic", lineHeight: 1.5 }}>
                      Every operator override becomes labeled training data for the next rubric version. Patterns that
                      hold up here strengthen the recommender; patterns that don't get re-weighted at the next rubric bump.
                    </p>
                  </>
                )}
              </section>
            );
          })()}

        </div>
        </div>
      </div>
    </div>
  );
}
