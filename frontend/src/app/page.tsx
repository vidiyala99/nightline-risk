"use client";

import { useEffect, useState } from "react";
import { Upload, AlertTriangle, Wifi, WifiOff, ArrowRight } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const fallbackLiveState = {
  venue_id: "elsewhere-brooklyn",
  current_capacity: 482,
  max_capacity: 500,
  premium_impact: 0,
  infrastructure: [
    { name: "DOOR_ID_SCANNER", status: "ACTIVE", detail: "[482/HR]", is_degraded: false },
    { name: "GUESTLIST_SYNC", status: "ACTIVE", detail: "[REALTIME]", is_degraded: false },
    { name: "CAMERA_REAR", status: "DEGRADED", detail: "[12% LOSS]", is_degraded: true },
  ],
  compliance_queue: [
    {
      id: "INCIDENT_99A8B1",
      title: "Upload rear-bar security footage",
      description: "Upload verified security footage (23:10-23:18) to preserve claims defensibility for the rear-bar brawl.",
      severity: "URGENT",
    },
  ],
};

export default function HomePage() {
  const [liveState, setLiveState] = useState(fallbackLiveState);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleUpload = async (itemId: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadingId(itemId);
    setUploadError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`${API_URL}/api/venues/elsewhere-brooklyn/compliance/${itemId}/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(`Upload failed with status ${res.status}`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingId(null);
    }
  };

  useEffect(() => {
    const fetchState = async () => {
      try {
        const res = await fetch(`${API_URL}/api/venues/elsewhere-brooklyn/live`);
        const data = await res.json();
        setLiveState(data);
      } catch (err) {
        console.error(err);
      }
    };
    fetchState();
    const interval = setInterval(fetchState, 5000);
    return () => clearInterval(interval);
  }, []);

  const capacityPercent = (liveState.current_capacity / liveState.max_capacity) * 100;
  const capacityColor = capacityPercent >= 95 ? "var(--state-error)" : capacityPercent >= 80 ? "var(--state-warning)" : "var(--brand-primary)";

  return (
    <div className="min-h-screen bg-dark">
      <div className="grid" style={{ gridTemplateColumns: "320px 1fr", minHeight: "100vh" }}>
        {/* Sidebar */}
        <aside className="bg-base border" style={{ borderRight: "1px solid var(--border-subtle)", padding: "var(--space-xl)" }}>
          <div className="flex flex-col gap-xl" style={{ height: "100%" }}>
            <div>
              <div className="text-sm font-mono text-muted tracking-wide mb-sm">SYS.INIT // VEN_01H9X</div>
              <h1 className="text-3xl font-bold uppercase" style={{ fontFamily: "var(--font-display)" }}>Elsewhere Brooklyn</h1>
            </div>

            <div className="flex-1">
              <h2 className="text-sm uppercase tracking-wide text-muted mb-lg">Active Coverage</h2>
              <div className="text-4xl font-bold text-accent mb-sm">LIVE</div>
              <div className="text-sm font-mono text-muted mb-xl">Renewal: Oct 2026</div>

              <div className="bg-surface border p-md mb-md">
                <div className="text-xs font-mono text-muted mb-sm">DOOR_CAPACITY // MAIN_ROOM</div>
                <div className="text-2xl font-bold">
                  {liveState.current_capacity}
                  <span className="text-lg font-normal text-muted"> / {liveState.max_capacity}</span>
                </div>
                <div className="capacity-bar mt-sm">
                  <div className="capacity-fill" style={{ width: `${capacityPercent}%`, backgroundColor: capacityColor }} />
                </div>
              </div>
            </div>

            <button className="btn btn-primary w-full">Ping Broker</button>
            <a href="/dashboard" className="btn btn-ghost w-full flex items-center justify-center gap-sm">
              Dashboard <ArrowRight size={16} />
            </a>
          </div>
        </aside>

        {/* Main */}
        <main className="p-3xl">
          <div className="flex justify-between items-end mb-3xl">
            <div>
              <div className="text-sm font-mono text-accent mb-md">&gt; PREMIUM_IMPACT_ANALYSIS</div>
              <div className="text-4xl font-bold">{(liveState.premium_impact ?? 0).toFixed(2)}%</div>
            </div>
            <div className="text-right">
              <div className="text-4xl font-bold text-accent">{String(liveState.compliance_queue?.length ?? 0).padStart(2, "0")}</div>
              <div className="text-sm font-mono text-muted">PENDING_ACTION</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2xl">
            {/* Compliance Queue */}
            <section>
              <div className="flex justify-between items-center border pb-md mb-lg">
                <h3 className="text-lg font-semibold uppercase">Compliance Queue</h3>
                {(liveState.compliance_queue?.length ?? 0) > 0 && (
                  <span className="badge badge-error">URGENT</span>
                )}
              </div>

              <div className="flex flex-col gap-lg">
                {(liveState.compliance_queue?.length ?? 0) === 0 ? (
                  <div className="p-xl border border-dashed text-center text-muted font-mono">NO PENDING ACTIONS</div>
                ) : (
                  liveState.compliance_queue?.map((item: any) => (
                    <div key={item.id} className="card bento-card">
                      <h4 className="text-xl font-bold uppercase mb-md">{item.id}</h4>
                      <p className="text-sm mb-xl">{item.description}</p>
                      <div className="relative">
                        <input
                          type="file"
                          accept="video/*,image/*"
                          onChange={(e) => handleUpload(item.id, e)}
                          className="visually-hidden"
                          id={`upload-${item.id}`}
                        />
                        <label htmlFor={`upload-${item.id}`} className="btn btn-secondary">
                          {uploadingId === item.id ? "Uploading..." : "Execute Upload"}
                        </label>
                      </div>
                      {uploadError && uploadingId !== item.id && (
                        <p className="text-sm text-error mt-sm">{uploadError}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Infrastructure */}
            <section>
              <div className="border pb-md mb-lg">
                <h3 className="text-lg font-semibold uppercase">Infrastructure Sync</h3>
              </div>

              <div className="flex flex-col gap-sm">
                {liveState.infrastructure?.map((item: any, i: number) => (
                  <div
                    key={i}
                    className={`flex justify-between items-center p-md border ${
                      item.is_degraded ? "border-error bg-error/5" : "border-subtle"
                    }`}
                  >
                    <span className="font-mono text-sm">{item.name}</span>
                    <span className={`font-mono text-sm ${item.is_degraded ? "text-error" : "text-accent"}`}>
                      {item.status} {item.detail}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
