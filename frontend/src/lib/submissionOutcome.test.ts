import { describe, it, expect } from "vitest";
import { SUBMISSION_OUTCOME_CONFIG, placementApi } from "./placement";

// The submissions kanban marks a submission lost / declined / withdrawn — three
// terminal outcomes that hit DISTINCT APIs so win/loss reporting can tell them
// apart. A data-driven map keeps the dispatch honest (a swap would mis-report).
describe("SUBMISSION_OUTCOME_CONFIG", () => {
  it("maps each outcome to its distinct verb + API method", () => {
    expect(SUBMISSION_OUTCOME_CONFIG.lost).toEqual({ verb: "Mark lost", method: "loseSubmission" });
    expect(SUBMISSION_OUTCOME_CONFIG.declined).toEqual({ verb: "Mark declined", method: "declineSubmission" });
    expect(SUBMISSION_OUTCOME_CONFIG.withdrawn).toEqual({ verb: "Withdraw", method: "withdrawSubmission" });
  });

  it("points every outcome at a real placementApi function", () => {
    for (const { method } of Object.values(SUBMISSION_OUTCOME_CONFIG)) {
      expect(typeof placementApi[method]).toBe("function");
    }
  });
});
