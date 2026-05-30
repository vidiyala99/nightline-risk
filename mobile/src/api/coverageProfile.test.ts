import { isProfileComplete } from "./coverageProfile";

describe("isProfileComplete", () => {
  it("true with carrier answer + a line", () => {
    expect(isProfileComplete({ current_carrier: "Hiscox", coverage_interest: ["gl"] })).toBe(true);
  });
  it("true with uninsured sentinel + a line", () => {
    expect(isProfileComplete({ current_carrier: "uninsured", coverage_interest: ["gl"] })).toBe(true);
  });
  it("false without a carrier answer", () => {
    expect(isProfileComplete({ current_carrier: null, coverage_interest: ["gl"] })).toBe(false);
  });
  it("false with no coverage line", () => {
    expect(isProfileComplete({ current_carrier: "uninsured", coverage_interest: [] })).toBe(false);
  });
});
