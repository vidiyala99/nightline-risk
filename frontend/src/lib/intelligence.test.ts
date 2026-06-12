import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchExposure,
  findingToAdvicePayload,
  recordCoverageAdvice,
  filterFindingsForVenue,
  type Finding,
} from "./intelligence";

afterEach(() => vi.restoreAllMocks());

function _finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "coverage_exclusion_review:policy:pol-1",
    persona: "broker",
    kind: "coverage_exclusion_review",
    subject: { entity_type: "policy", entity_id: "pol-1", label: "POL-1", href: "/policies/pol-1/gaps" },
    severity: "high",
    severity_rank: 3,
    why: [
      { source_id: "ingested-1", source_type: "policy_exclusion", excerpt: "A&B excluded", node_id: "node-ab" },
      { source_id: "ingested-2", source_type: "policy_exclusion", excerpt: "Liquor excluded", node_id: "node-liq" },
    ],
    recommended_action: { label: "Review excluded exposure (E&O)", href: "/policies/pol-1/gaps" },
    prediction: { claim: "This venue's exposure to assault & battery is excluded.", falsifiable_by: "claim_outcome", horizon: "on_claim" },
    venue_id: "v1",
    ...over,
  };
}

describe("findingToAdvicePayload", () => {
  it("maps an exclusion finding to an exclusion_review advice payload with node_ids", () => {
    const p = findingToAdvicePayload(_finding());
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("exclusion_review");
    expect(p!.policy_id).toBe("pol-1");
    expect(p!.venue_id).toBe("v1");
    expect(p!.cited_node_ids).toEqual(["node-ab", "node-liq"]);
  });

  it("maps a coverage_gap_eo finding to a gap advice payload", () => {
    const p = findingToAdvicePayload(_finding({ kind: "coverage_gap_eo", why: [] }));
    expect(p!.kind).toBe("gap");
    expect(p!.cited_node_ids).toEqual([]);
  });

  it("maps a renewal_term_drift finding to a renewal_drift advice payload", () => {
    const p = findingToAdvicePayload(_finding({ kind: "renewal_term_drift", why: [] }));
    expect(p!.kind).toBe("renewal_drift");
  });

  it("returns null for a non-coverage finding kind", () => {
    expect(findingToAdvicePayload(_finding({ kind: "evidence_gap" }))).toBeNull();
  });

  it("returns null when the subject is not a policy", () => {
    expect(findingToAdvicePayload(_finding({
      subject: { entity_type: "incident", entity_id: "inc-1", label: "x", href: "/x" },
    }))).toBeNull();
  });
});

describe("filterFindingsForVenue", () => {
  const fs = [_finding({ venue_id: "v1" }), _finding({ venue_id: "v2" }), _finding({ venue_id: "v1" })];
  it("keeps only the named venue's findings", () => {
    expect(filterFindingsForVenue(fs, "v1")).toHaveLength(2);
    expect(filterFindingsForVenue(fs, "v2")).toHaveLength(1);
  });
  it("returns all findings when no venue is given (book-wide)", () => {
    expect(filterFindingsForVenue(fs)).toHaveLength(3);
  });
});

describe("recordCoverageAdvice", () => {
  it("POSTs and returns the advice record on 201", async () => {
    const rec = { id: "covadvice-abc", status: "surfaced", policy_id: "pol-1" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rec), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await recordCoverageAdvice({
      venue_id: "v1", policy_id: "pol-1", kind: "exclusion_review",
      summary: "s", cited_node_ids: ["node-ab"],
    });
    expect(out.id).toBe("covadvice-abc");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/coverage-advice"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    await expect(recordCoverageAdvice({
      venue_id: "v1", policy_id: "pol-1", kind: "exclusion_review",
      summary: "s", cited_node_ids: [],
    })).rejects.toThrow();
  });
});

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
