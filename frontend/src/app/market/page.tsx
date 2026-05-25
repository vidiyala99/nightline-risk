"use client";

// Public NYC nightlife "opportunity map" — no auth gate (like /evals).
// Hero aggregate + Leaflet map of real venues + drill-down card whose CTA
// funnels operators into the platform. All figures are estimates (see the
// methodology note rendered on the card).
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { PageHeader } from "@/components/ui/PageHeader";
import { useAuth } from "@/contexts/AuthContext";
import {
  loadMarket,
  money,
  venueTypeLabel,
  type MarketData,
  type MarketVenue,
} from "@/lib/market";

const MarketMap = dynamic(() => import("./MarketMap"), {
  ssr: false,
  loading: () => <div className="market__map-loading">Loading map…</div>,
});

export default function MarketPage() {
  const { user } = useAuth();
  const [data, setData] = useState<MarketData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [borough, setBorough] = useState("all");
  const [vtype, setVtype] = useState("all");
  const [selected, setSelected] = useState<MarketVenue | null>(null);

  useEffect(() => {
    loadMarket()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load market data"));
  }, []);

  const venues = useMemo(() => {
    if (!data) return [];
    return data.venues.filter(
      (v) =>
        (borough === "all" || v.borough === borough) &&
        (vtype === "all" || v.venue_type === vtype),
    );
  }, [data, borough, vtype]);

  // Operators go straight to a real submission; everyone else signs up first.
  const ctaHref = user?.role === "venue_operator" ? "/submissions/new" : "/login";

  if (error) {
    return (
      <div className="page page-empty">
        <h3>{error}</h3>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <div className="claims-section__skeleton" aria-busy="true">
          <div />
          <div />
          <div />
        </div>
      </div>
    );
  }

  const agg = data.aggregate;

  return (
    <div className="market">
      <PageHeader
        eyebrow="NYC NIGHTLIFE · OPPORTUNITY MAP"
        title="Where Nightline saves nightlife venues money"
        subtitle="Real NYC on-premises nightlife licensees (NY State Liquor Authority open data). Estimated savings vs. current market pricing."
      />

      <section className="market__stats" aria-label="Market summary">
        <div className="market__stat">
          <span className="market__stat-value">{agg.venue_count}</span>
          <span className="market__stat-label">venues mapped</span>
        </div>
        <div className="market__stat">
          <span className="market__stat-value">{money(agg.total_market_premium)}</span>
          <span className="market__stat-label">est. premium at market</span>
        </div>
        <div className="market__stat">
          <span className="market__stat-value">
            {money(agg.total_savings_low)}–{money(agg.total_savings_high)}
          </span>
          <span className="market__stat-label">modeled annual savings</span>
        </div>
      </section>

      <div className="market__filters" role="group" aria-label="Filters">
        <select value={borough} onChange={(e) => setBorough(e.target.value)} aria-label="Borough">
          <option value="all">All boroughs</option>
          {agg.by_borough.map((b) => (
            <option key={b.borough} value={b.borough}>
              {b.borough} ({b.count})
            </option>
          ))}
        </select>
        <select value={vtype} onChange={(e) => setVtype(e.target.value)} aria-label="Venue type">
          <option value="all">All types</option>
          {agg.by_type.map((t) => (
            <option key={t.venue_type} value={t.venue_type}>
              {venueTypeLabel(t.venue_type)} ({t.count})
            </option>
          ))}
        </select>
        <span className="market__count">{venues.length} shown</span>
      </div>

      <div className="market__body">
        <div className="market__map">
          <MarketMap venues={venues} selectedId={selected?.id ?? null} onSelect={setSelected} />
        </div>

        <aside className="market__panel">
          {selected ? (
            <div className="market-card">
              <h3 className="market-card__name">{selected.name}</h3>
              <p className="market-card__addr">
                {selected.address} · {selected.borough}
              </p>
              <p className="market-card__type">
                {venueTypeLabel(selected.venue_type)} · {selected.license_class}
              </p>

              <div className="market-card__carriers">
                <span className="market-card__label">Likely carriers (inferred)</span>
                <div className="market-card__chips">
                  {selected.likely_carriers.map((c) => (
                    <span
                      key={c.id}
                      className={`market-chip market-chip--${c.market_type === "admitted" ? "admitted" : "es"}`}
                    >
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>

              <dl className="market-card__nums">
                <div>
                  <dt>Current (market)</dt>
                  <dd>~{money(selected.market_premium)}/yr</dd>
                </div>
                <div>
                  <dt>Nightline est.</dt>
                  <dd>
                    {money(selected.ts_low)}–{money(selected.ts_high)}/yr
                  </dd>
                </div>
                <div className="market-card__save">
                  <dt>Est. savings</dt>
                  <dd>
                    {money(selected.savings_low)}–{money(selected.savings_high)}/yr
                  </dd>
                </div>
              </dl>

              <Link href={ctaHref} className="btn btn-primary market-card__cta">
                See your real quote →
              </Link>
              <p className="market-card__foot">{data.methodology_note}</p>
            </div>
          ) : (
            <div className="market-card market-card--empty">
              <p>Select a venue on the map to see its estimated savings and likely carriers.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
