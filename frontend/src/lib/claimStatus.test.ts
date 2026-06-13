import { describe, it, expect } from "vitest";
import { deriveClaimStatus, type ClaimStatusResponse } from "@/lib/claimStatus";

const base: ClaimStatusResponse = {
  incident_status: "open",
  proposal: { exists: true, state: "approved" },
  claim: { exists: false, status: null },
};

describe("deriveClaimStatus — coverage-hold awareness", () => {
  it("approved + fileable → 'filing with the carrier' (unchanged)", () => {
    const v = deriveClaimStatus({ ...base, fileable: true, blockers: [] }, null);
    expect(v.headline).toMatch(/filing with the carrier/i);
    expect(v.tone).toBe("success");
  });

  it("approved but NOT fileable (no active policy) → on-hold, never 'ready/filing'", () => {
    const v = deriveClaimStatus(
      { ...base, fileable: false, blockers: ["no_active_policy"] },
      null,
    );
    expect(v.headline).not.toMatch(/filing with the carrier/i);
    expect(v.headline).toMatch(/hold|coverage/i);
    expect(v.tone).toBe("warning");
    expect(v.sent).toBe(true);
  });

  it("approved with fileability omitted → unchanged (back-compat)", () => {
    const v = deriveClaimStatus(base, null);
    expect(v.headline).toMatch(/filing with the carrier/i);
  });

  it("a filed claim is unaffected by a coverage blocker", () => {
    const v = deriveClaimStatus(
      {
        ...base,
        proposal: { exists: true, state: "filed_with_carrier" },
        fileable: false,
        blockers: ["no_active_policy"],
      },
      null,
    );
    expect(v.headline).toMatch(/filed with the carrier/i);
  });
});
