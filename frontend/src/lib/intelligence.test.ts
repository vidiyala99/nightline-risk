import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchExposure } from "./intelligence";

afterEach(() => vi.restoreAllMocks());

describe("fetchExposure", () => {
  it("returns parsed findings on 200", async () => {
    const body = {
      persona: "venue_operator",
      findings: [{
        id: "evidence_gap:incident:inc-1", persona: "venue_operator", kind: "evidence_gap",
        subject: { entity_type: "incident", entity_id: "inc-1", label: "Brawl", href: "/incidents/inc-1" },
        severity: "high", severity_rank: 3, why: [],
        recommended_action: { label: "Attach evidence", href: "/incidents/inc-1" },
        prediction: { claim: "x", falsifiable_by: "", horizon: "" }, venue_id: "v1",
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const res = await fetchExposure();
    expect(res.persona).toBe("venue_operator");
    expect(res.findings[0].kind).toBe("evidence_gap");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(fetchExposure()).rejects.toThrow();
  });
});
