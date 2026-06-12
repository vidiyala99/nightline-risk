import { describe, it, expect } from "vitest";
import { normalizeHolder, matchHolder, type CertificateHolder } from "./policies";

const holders: CertificateHolder[] = [
  {
    certificate_holder: "ACME, LLC",
    certificate_holder_address: "2 New St",
    additional_insured: true,
    additional_insured_scope: "single_event",
    description_of_operations: "ops",
    times_used: 3,
    last_issued_at: "2026-05-01T00:00:00+00:00",
  },
];

describe("normalizeHolder", () => {
  it("collapses case, punctuation, and whitespace", () => {
    expect(normalizeHolder("ACME, LLC")).toBe(normalizeHolder("Acme LLC"));
    expect(normalizeHolder("  599 Johnson   LLC ")).toBe("599 johnson llc");
  });
});

describe("matchHolder", () => {
  it("matches a prior holder across spelling variants", () => {
    expect(matchHolder(holders, "Acme LLC")?.certificate_holder).toBe("ACME, LLC");
  });
  it("returns null for an unknown or empty holder", () => {
    expect(matchHolder(holders, "Brand New Tenant")).toBeNull();
    expect(matchHolder(holders, "")).toBeNull();
  });
});
