import { describe, it, expect } from "vitest";
import { approvalResultLink, type PolicyRequest } from "@/lib/policyRequests";

function req(overrides: Partial<PolicyRequest>): PolicyRequest {
  return {
    id: "preq-1", policy_id: "pol-1", venue_id: "v1", request_type: "renewal",
    status: "approved", requested_by: "op", note: "", payload: {},
    decided_by: "b1", decision_note: null, decided_at: "2026-05-30",
    result_entity_type: null, result_entity_id: null,
    created_at: "2026-05-30", updated_at: "2026-05-30", ...overrides,
  };
}

describe("approvalResultLink", () => {
  it("links a renewal to its created submission", () => {
    expect(approvalResultLink(req({ result_entity_type: "submission", result_entity_id: "sub-9" })))
      .toEqual({ href: "/submissions/sub-9", label: "View renewal" });
  });

  it("links a certificate to the policy detail (where COIs live), not the coi id", () => {
    expect(approvalResultLink(req({
      policy_id: "pol-7", result_entity_type: "certificate", result_entity_id: "coi-3",
    }))).toEqual({ href: "/policies/pol-7", label: "View certificate" });
  });

  it("links a cancellation to the cancelled policy", () => {
    expect(approvalResultLink(req({ result_entity_type: "policy", result_entity_id: "pol-7" })))
      .toEqual({ href: "/policies/pol-7", label: "View policy" });
  });

  it("returns null when not approved (e.g. still pending)", () => {
    expect(approvalResultLink(req({
      status: "pending", result_entity_type: "submission", result_entity_id: "sub-9",
    }))).toBeNull();
  });

  it("returns null when approved but no result was recorded (coverage_change)", () => {
    expect(approvalResultLink(req({ result_entity_type: null, result_entity_id: null }))).toBeNull();
  });
});
