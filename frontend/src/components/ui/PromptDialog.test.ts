import { describe, it, expect } from "vitest";
import { missingRequired, type PromptField } from "./PromptDialog";

const fields: PromptField[] = [
  { name: "reason", label: "Reason", type: "text", required: true },
  { name: "date", label: "Date", type: "date", required: true },
  { name: "note", label: "Note", type: "text" },
];

describe("missingRequired", () => {
  it("flags blank required fields (and ignores optional ones)", () => {
    expect(missingRequired(fields, { reason: "", date: "", note: "" })).toEqual(["reason", "date"]);
  });
  it("treats whitespace-only as blank", () => {
    expect(missingRequired(fields, { reason: "   ", date: "2026-01-01" })).toEqual(["reason"]);
  });
  it("returns empty when all required are filled", () => {
    expect(missingRequired(fields, { reason: "x", date: "2026-01-01" })).toEqual([]);
  });
});
