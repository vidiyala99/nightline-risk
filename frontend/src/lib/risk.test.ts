import { describe, it, expect } from "vitest";
import { getFactorTier, factorLabel, riskAttentionLine, estimatePremiumDeltaForFix } from "@/lib/risk";

describe("estimatePremiumDeltaForFix", () => {
  it("scales the annual premium by the score lift", () => {
    // 57 -> 80 on an $18,000 premium: 18000 * 23/57 ≈ 7263
    expect(estimatePremiumDeltaForFix(57, 80, 18000)).toBe(7263);
  });
  it("clamps a negative delta to 0 (a fix never costs more)", () => {
    expect(estimatePremiumDeltaForFix(80, 57, 18000)).toBe(0);
  });
  it("returns 0 when the premium is unknown/0", () => {
    expect(estimatePremiumDeltaForFix(57, 80, 0)).toBe(0);
  });
  it("returns 0 when the current score is 0 (avoids divide-by-zero)", () => {
    expect(estimatePremiumDeltaForFix(0, 80, 18000)).toBe(0);
  });
});

describe("getFactorTier", () => {
  it("buckets scores at the 80 / 55 boundaries", () => {
    expect(getFactorTier(80)).toBe("good");
    expect(getFactorTier(79)).toBe("moderate");
    expect(getFactorTier(55)).toBe("moderate");
    expect(getFactorTier(54)).toBe("poor");
  });
});

describe("factorLabel", () => {
  it("maps known keys and humanizes unknown ones", () => {
    expect(factorLabel("incident_history")).toBe("Safety record");
    expect(factorLabel("operational")).toBe("Operational health");
    expect(factorLabel("crowd_density")).toBe("Crowd density");
  });
});

describe("riskAttentionLine", () => {
  it("names the lowest-scoring poor factor, prioritizing poor over moderate", () => {
    const r = riskAttentionLine({ incident_history: 100, operational: 24, business_profile: 70 });
    expect(r).toEqual({ text: "Operational health needs attention", tier: "poor" });
  });

  it("counts additional factors sharing the worst tier", () => {
    const r = riskAttentionLine({ operational: 24, compliance: 40, business_profile: 70 });
    expect(r.text).toBe("Operational health needs attention · +1 more");
  });

  it("accepts the API's { score, weight } factor shape", () => {
    const r = riskAttentionLine({
      incident_history: { score: 100, weight: 0.4 },
      business_profile: { score: 75, weight: 0.2 },
    } as Record<string, { score: number; weight: number }>);
    expect(r).toEqual({ text: "Business profile could be stronger", tier: "moderate" });
  });

  it("reports all-healthy and handles an empty map", () => {
    expect(riskAttentionLine({ a: 90, b: 100 }).tier).toBe("good");
    expect(riskAttentionLine({})).toEqual({ text: "No risk factors yet", tier: "good" });
  });
});
