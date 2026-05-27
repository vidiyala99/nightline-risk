import { describe, it, expect } from "vitest";
import { money, venueTypeLabel } from "@/lib/market";

describe("money", () => {
  it("formats a money string as rounded USD with separators", () => {
    expect(money("12000.00")).toBe("$12,000");
    expect(money("999999.49")).toBe("$999,999");
    expect(money("0")).toBe("$0");
  });

  it("returns the original string when it isn't numeric", () => {
    expect(money("n/a")).toBe("n/a");
  });
});

describe("venueTypeLabel", () => {
  it("humanizes an internal venue_type", () => {
    expect(venueTypeLabel("night_club")).toBe("Night Club");
    expect(venueTypeLabel("bar")).toBe("Bar");
    expect(venueTypeLabel("live_music_venue")).toBe("Live Music Venue");
  });
});
