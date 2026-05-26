"use client";

// Leaflet map of NYC nightlife venues. Loaded via next/dynamic with
// ssr:false from page.tsx (Leaflet touches `window` at import time).
// Dark CARTO basemap to match the editorial dark theme; CircleMarkers
// colored by savings opportunity (brand-aligned), with an on-map legend.
import "leaflet/dist/leaflet.css";

import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";

import type { MarketVenue } from "@/lib/market";

// Savings opportunity → color, aligned to the brand palette so the map
// reads as part of the product, not a bolted-on widget. High contrast on
// the dark basemap (WCAG data-contrast).
const SAVINGS_BANDS = [
  { min: 3000, color: "#1F8F4E", label: "Strong ($3k+)" },
  { min: 1500, color: "#6f8a00", label: "Moderate" },
  { min: 1, color: "#B45309", label: "Light" },
  { min: -Infinity, color: "#78716c", label: "None modeled" },
] as const;

function savingsColor(savingsMid: string): string {
  const n = Number(savingsMid);
  return (SAVINGS_BANDS.find((b) => n >= b.min) ?? SAVINGS_BANDS[3]).color;
}

interface Props {
  venues: MarketVenue[];
  selectedId: string | null;
  onSelect: (v: MarketVenue) => void;
}

export default function MarketMap({ venues, selectedId, onSelect }: Props) {
  return (
    <div className="market__map-wrap">
      <MapContainer
        center={[40.73, -73.95]}
        zoom={11}
        scrollWheelZoom
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://carto.com/attributions">CARTO</a> · &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
        />
        {venues.map((v) => {
          const c = savingsColor(v.savings_mid);
          const selected = v.id === selectedId;
          return (
            <CircleMarker
              key={v.id}
              center={[v.lat, v.lng]}
              radius={selected ? 10 : 6}
              pathOptions={{
                color: selected ? "#c8f000" : "#17150F",
                fillColor: c,
                fillOpacity: selected ? 0.95 : 0.85,
                weight: selected ? 3 : 1.25,
              }}
              eventHandlers={{ click: () => onSelect(v) }}
            >
              <Tooltip className="market-tooltip">{v.name}</Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>

      <div className="market-legend" aria-hidden>
        <span className="market-legend__title">Est. annual savings</span>
        {SAVINGS_BANDS.map((b) => (
          <span key={b.label} className="market-legend__item">
            <span className="market-legend__dot" style={{ background: b.color }} />
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}
