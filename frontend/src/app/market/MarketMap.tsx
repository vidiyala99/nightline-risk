"use client";

// Leaflet map of NYC nightlife venues. Loaded via next/dynamic with
// ssr:false from page.tsx (Leaflet touches `window` at import time).
// Uses CircleMarkers colored by savings opportunity — no marker-icon assets.
import "leaflet/dist/leaflet.css";

import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";

import type { MarketVenue } from "@/lib/market";

function savingsColor(savingsMid: string): string {
  const n = Number(savingsMid);
  if (n >= 3000) return "#16a34a"; // strong opportunity
  if (n >= 1500) return "#65a30d";
  if (n > 0) return "#ca8a04";
  return "#9ca3af"; // none modeled
}

interface Props {
  venues: MarketVenue[];
  selectedId: string | null;
  onSelect: (v: MarketVenue) => void;
}

export default function MarketMap({ venues, selectedId, onSelect }: Props) {
  return (
    <MapContainer
      center={[40.73, -73.95]}
      zoom={11}
      scrollWheelZoom
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {venues.map((v) => {
        const c = savingsColor(v.savings_mid);
        const selected = v.id === selectedId;
        return (
          <CircleMarker
            key={v.id}
            center={[v.lat, v.lng]}
            radius={selected ? 9 : 6}
            pathOptions={{
              color: c,
              fillColor: c,
              fillOpacity: selected ? 0.9 : 0.65,
              weight: selected ? 3 : 1,
            }}
            eventHandlers={{ click: () => onSelect(v) }}
          >
            <Tooltip>{v.name}</Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
