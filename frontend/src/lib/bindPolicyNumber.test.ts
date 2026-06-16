import { describe, it, expect } from "vitest";
import { bindPolicyNumberArg } from "./policies";

// The bind dialog must preserve the old window.prompt contract: a blank
// submission means "assign the policy number later" (undefined), NOT an empty
// string sent to the API. Cancelling the dialog (no submit) makes no call at
// all — that's the call-site's responsibility, not this pure mapping.
describe("bindPolicyNumberArg", () => {
  it("maps a blank value to undefined (assign later)", () => {
    expect(bindPolicyNumberArg("")).toBeUndefined();
  });

  it("treats whitespace-only as blank (assign later)", () => {
    expect(bindPolicyNumberArg("   ")).toBeUndefined();
  });

  it("trims and returns a real carrier policy number", () => {
    expect(bindPolicyNumberArg("  BW-2026-00123 ")).toBe("BW-2026-00123");
  });
});
