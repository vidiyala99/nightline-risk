"use client";

// Broker prospecting view of /market. The public page is a marketing map;
// for a logged-in broker, Market is a working surface: a list-first,
// filterable/sortable list of NYC prospects (live from /api/portfolio?source=
// prospect) whose rows drill into the prospect's estimated risk profile, where
// the "Get a quote" CTA seeds a submission. Sibling of the dashboard's
// BrokerTriage — same list grammar, different domain (leads, not the book).
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { authHeaders } from "@/lib/authFetch";
import { money, venueTypeLabel, type MarketVenue } from "@/lib/market";
import { TierBadge, type Tier as UiTier } from "@/components/ui/TierBadge";
import { useBreakpoint, useMounted } from "@/hooks/useBreakpoint";
import { Search, MapPin, List, ArrowUpRight } from "lucide-react";

const MarketMap = dynamic(() => import("./MarketMap"), {
  ssr: false,
  loading: () => <div className="market__map-loading">Loading map…</div>,
});

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface LikelyCarrier {
  id: string;
  name: string;
  market_type: string;
}

// Shape of a prospect row from /api/portfolio?source=prospect (see
// backend get_portfolio). Pitch fields are populated on prospects.
interface BrokerProspect {
  id: string;
  name: string;
  venue_type: string;
  address: string;
  tier: string;
  total_score: number;
  source: string;
  savings_low: string | null;
  savings_high: string | null;
  market_premium: string | null;
  borough: string | null;
  license_class: string | null;
  lat: number | null;
  lng: number | null;
  likely_carriers: LikelyCarrier[];
}

type SortKey = "savings" | "tier" | "score";

const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

function num(s: string | null | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(s: string | null | undefined): string {
  if (s == null || s === "") return "—";
  return money(s);
}

/** Adapt a prospect row to the MarketVenue shape MarketMap consumes. Only
 *  id/name/lat/lng/savings_mid are read by the map; the rest are filled to
 *  satisfy the type. Rows without coordinates are dropped before mapping. */
function toMarketVenue(p: BrokerProspect): MarketVenue {
  const mid = (num(p.savings_low) + num(p.savings_high)) / 2;
  return {
    id: p.id,
    name: p.name,
    address: p.address ?? "",
    borough: p.borough ?? "",
    lat: p.lat ?? 0,
    lng: p.lng ?? 0,
    license_class: p.license_class ?? "",
    venue_type: p.venue_type,
    market_premium: p.market_premium ?? "0",
    ts_low: "0",
    ts_high: "0",
    savings_low: p.savings_low ?? "0",
    savings_high: p.savings_high ?? "0",
    savings_mid: String(mid),
    likely_carriers: p.likely_carriers ?? [],
  };
}

export function MarketBrokerView() {
  const router = useRouter();
  const bp = useBreakpoint();
  const mounted = useMounted();
  const isPhone = mounted && (bp === "xs" || bp === "sm");

  const [rows, setRows] = useState<BrokerProspect[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [borough, setBorough] = useState("all");
  const [vtype, setVtype] = useState("all");
  const [sort, setSort] = useState<SortKey>("savings");
  const [view, setView] = useState<"list" | "map">("list");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/portfolio?source=prospect`, {
          headers: authHeaders(),
        });
        if (!res.ok) throw new Error(`Failed to load prospects (${res.status})`);
        const data: BrokerProspect[] = await res.json();
        if (!cancelled) setRows(data.filter((r) => r.source === "prospect"));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load prospects");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const boroughs = useMemo(
    () => Array.from(new Set(rows.map((r) => r.borough).filter(Boolean))).sort() as string[],
    [rows],
  );
  const types = useMemo(
    () => Array.from(new Set(rows.map((r) => r.venue_type).filter(Boolean))).sort(),
    [rows],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (borough !== "all" && r.borough !== borough) return false;
      if (vtype !== "all" && r.venue_type !== vtype) return false;
      if (q) {
        const hay = `${r.name} ${r.address ?? ""} ${r.venue_type} ${r.borough ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      if (sort === "savings") return num(b.savings_high) - num(a.savings_high);
      if (sort === "score") return b.total_score - a.total_score;
      // tier A→D, then score desc as tiebreaker
      const t = (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9);
      return t !== 0 ? t : b.total_score - a.total_score;
    });
    return sorted;
  }, [rows, query, borough, vtype, sort]);

  const totals = useMemo(
    () => ({
      count: visible.length,
      savingsLow: visible.reduce((s, r) => s + num(r.savings_low), 0),
      savingsHigh: visible.reduce((s, r) => s + num(r.savings_high), 0),
      premium: visible.reduce((s, r) => s + num(r.market_premium), 0),
    }),
    [visible],
  );

  const mapVenues = useMemo(
    () => visible.filter((r) => r.lat != null && r.lng != null).map(toMarketVenue),
    [visible],
  );

  // The map is a desktop-only enhancement; phones stay list-only and never
  // load Leaflet. Force list view whenever we're at phone width.
  const showMap = view === "map" && !isPhone;

  return (
    <div className="market mbk">
      <style>{`
        .mbk__head { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-md); margin-bottom:var(--space-lg); }
        .mbk__title { font-family:var(--font-display); font-size:clamp(1.75rem,4vw,2.5rem); font-style:italic; letter-spacing:-0.02em; margin:0; }
        .mbk__kpi { font-family:var(--font-mono); font-size:0.8rem; color:var(--text-secondary); }
        .mbk__kpi b { color:var(--text-primary); }
        .mbk__kpi .save { color:var(--accent-ink); font-weight:700; }
        .mbk__controls { display:flex; flex-wrap:wrap; gap:var(--space-sm); align-items:center; margin-bottom:var(--space-lg); }
        .mbk__search { display:flex; align-items:center; gap:6px; flex:1 1 220px; min-height:44px; padding:0 12px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--bg-elevated); }
        .mbk__search input { flex:1; border:none; background:none; outline:none; color:var(--text-primary); font-size:0.875rem; }
        .mbk select { min-height:44px; padding:0 12px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--bg-elevated); color:var(--text-primary); font-size:0.85rem; }
        .mbk__viewtoggle { display:inline-flex; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); overflow:hidden; }
        .mbk__viewtoggle button { min-height:44px; padding:0 14px; background:var(--bg-elevated); border:none; color:var(--text-secondary); cursor:pointer; display:inline-flex; align-items:center; gap:6px; font-size:0.8rem; }
        .mbk__viewtoggle button[data-active="true"] { background:var(--brand-primary)22; color:var(--accent-ink); font-weight:700; }
        .mbk__row { display:flex; align-items:center; gap:var(--space-md); width:100%; text-align:left; padding:var(--space-md); border:1px solid var(--border-subtle); border-left:3px solid var(--tier-color,var(--border-default)); border-radius:var(--radius-md); background:var(--bg-surface); margin-bottom:var(--space-sm); cursor:pointer; text-decoration:none; color:inherit; transition:background 0.15s ease; }
        .mbk__row:hover { background:rgba(23,21,15,0.04); }
        .mbk__row:focus-visible { outline:2px solid var(--brand-primary); outline-offset:2px; }
        .mbk__row-main { flex:1 1 auto; min-width:0; }
        .mbk__row-name { font-weight:600; font-size:0.95rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .mbk__row-sub { font-size:0.8rem; color:var(--text-tertiary); }
        .mbk__chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
        .mbk__row-meta { display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex:0 0 auto; }
        .mbk__row-save { font-family:var(--font-mono); font-size:0.8rem; color:var(--accent-ink); font-weight:700; white-space:nowrap; }
        .mbk__score { font-family:var(--font-mono); font-size:0.85rem; color:var(--text-secondary); }
        .mbk__empty { padding:var(--space-xl); text-align:center; color:var(--text-secondary); }
        .mbk__map { height:60vh; min-height:420px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); overflow:hidden; }
      `}</style>

      <div className="mbk__head">
        <h1 className="mbk__title">Prospects</h1>
        <span className="mbk__kpi">
          <b>{totals.count}</b> NYC leads
          {totals.savingsHigh > 0 && (
            <>
              {" · "}
              <span className="save">
                {fmtMoney(String(totals.savingsLow))}–{fmtMoney(String(totals.savingsHigh))}/yr
              </span>{" "}
              modeled savings
            </>
          )}
        </span>
      </div>

      <div className="mbk__controls" role="group" aria-label="Filters">
        <span className="mbk__search">
          <Search size={14} aria-hidden />
          <input
            placeholder="Search prospects, types, addresses…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search prospects"
          />
        </span>
        <select value={borough} onChange={(e) => setBorough(e.target.value)} aria-label="Borough">
          <option value="all">All boroughs</option>
          {boroughs.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select value={vtype} onChange={(e) => setVtype(e.target.value)} aria-label="Venue type">
          <option value="all">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {venueTypeLabel(t)}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
          <option value="savings">Sort: savings</option>
          <option value="tier">Sort: tier</option>
          <option value="score">Sort: score</option>
        </select>
        {!isPhone && (
          <span className="mbk__viewtoggle" role="group" aria-label="View">
            <button type="button" data-active={view === "list"} onClick={() => setView("list")} aria-pressed={view === "list"}>
              <List size={14} aria-hidden /> List
            </button>
            <button type="button" data-active={view === "map"} onClick={() => setView("map")} aria-pressed={view === "map"}>
              <MapPin size={14} aria-hidden /> Map
            </button>
          </span>
        )}
      </div>

      {loading ? (
        <div className="claims-section__skeleton" aria-busy="true">
          <div />
          <div />
          <div />
        </div>
      ) : error ? (
        <div className="mbk__empty">{error}</div>
      ) : visible.length === 0 ? (
        <div className="mbk__empty">No prospects match this view.</div>
      ) : showMap ? (
        <div className="mbk__map">
          <MarketMap
            venues={mapVenues}
            selectedId={null}
            onSelect={(v) => router.push(`/risk-profile/${v.id}`)}
          />
        </div>
      ) : (
        <div role="list">
          {visible.map((p) => (
            <a
              key={p.id}
              role="listitem"
              href={`/risk-profile/${p.id}`}
              className="mbk__row"
              style={{ ["--tier-color" as string]: `var(--tier-${p.tier.toLowerCase()})` }}
              aria-label={`Open risk profile for ${p.name}, Tier ${p.tier}`}
            >
              <div className="mbk__row-main">
                <div className="mbk__row-name">{p.name}</div>
                <div className="mbk__row-sub">
                  {venueTypeLabel(p.venue_type)}
                  {p.borough ? ` · ${p.borough}` : ""}
                </div>
                {p.likely_carriers?.length > 0 && (
                  <div className="mbk__chips">
                    {p.likely_carriers.slice(0, 3).map((c) => (
                      <span
                        key={c.id}
                        className={`market-chip market-chip--${c.market_type === "admitted" ? "admitted" : "es"}`}
                      >
                        {c.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="mbk__row-meta">
                <TierBadge tier={p.tier as UiTier} />
                <span className="mbk__row-save">
                  {fmtMoney(p.savings_low)}–{fmtMoney(p.savings_high)}/yr
                </span>
                <span className="mbk__score">
                  {p.total_score} <ArrowUpRight size={11} aria-hidden />
                </span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
