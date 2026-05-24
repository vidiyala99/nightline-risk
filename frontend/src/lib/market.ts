// Client + types for the public NYC nightlife market map.
// Reads the static snapshot at /nyc_market.json (produced by
// backend/scripts/build_nyc_market.py). Mirrors the static-JSON fetch
// pattern used by the /evals scoreboard. Money fields are strings.

export interface LikelyCarrier {
  id: string;
  name: string;
  market_type: string; // "admitted" | "e&s"
}

export interface MarketVenue {
  id: string;
  name: string;
  address: string;
  borough: string;
  lat: number;
  lng: number;
  license_class: string;
  venue_type: string;
  market_premium: string;
  ts_low: string;
  ts_high: string;
  savings_low: string;
  savings_high: string;
  savings_mid: string;
  likely_carriers: LikelyCarrier[];
}

export interface MarketAggregate {
  venue_count: number;
  total_market_premium: string;
  total_savings_low: string;
  total_savings_high: string;
  by_borough: { borough: string; count: number }[];
  by_type: { venue_type: string; count: number }[];
}

export interface MarketData {
  generated_at: string;
  methodology_note: string;
  aggregate: MarketAggregate;
  venues: MarketVenue[];
}

export async function loadMarket(): Promise<MarketData> {
  const res = await fetch("/nyc_market.json");
  if (!res.ok) throw new Error(`Failed to load market data (${res.status})`);
  return res.json() as Promise<MarketData>;
}

// ─── Display helpers ──────────────────────────────────────────────────────

/** Format a money string ("12000.00") as "$12,000". */
export function money(s: string): string {
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Human label for an internal venue_type. */
export function venueTypeLabel(t: string): string {
  return t
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
