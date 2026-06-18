import { describe, expect, it } from "vitest";
import { reserveAdequacy } from "./claim-tokens";

const hint = { low: "3000", high: "8000", chain_ladder_mean: "5500" };

describe("reserveAdequacy", () => {
  it("flags below-advisory as danger when no money paid", () => {
    expect(reserveAdequacy("1000", "0", hint)).toEqual({
      label: expect.stringContaining("Below advisory"),
      tone: "danger",
    });
  });

  it("flags within-advisory as neutral", () => {
    expect(reserveAdequacy("5000", "0", hint)?.tone).toBe("neutral");
  });

  it("flags above-advisory as success", () => {
    expect(reserveAdequacy("9000", "0", hint)?.tone).toBe("success");
  });

  it("switches to incurred-delta once money is paid", () => {
    // reserve 10000 vs incurred 4000 -> over-reserved headroom (success)
    expect(reserveAdequacy("10000", "4000", hint)?.tone).toBe("success");
    // reserve 3000 vs incurred 5000 -> gap (danger)
    expect(reserveAdequacy("3000", "5000", hint)?.tone).toBe("danger");
  });

  it("returns null with no hint and no money paid", () => {
    expect(reserveAdequacy("1000", "0", null)).toBeNull();
    expect(reserveAdequacy("1000", "0", undefined)).toBeNull();
  });

  it("returns null on unparseable reserve", () => {
    expect(reserveAdequacy("", "0", hint)).toBeNull();
  });
});
