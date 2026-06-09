import { describe, it, expect, vi } from "vitest";
import { sendCopilotMessage } from "./copilot";

describe("sendCopilotMessage", () => {
  it("posts to /api/copilot/message and returns the reply", async () => {
    const reply = { answer_type: "answer", text: "ok", citations: [], followups: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => reply }));
    const r = await sendCopilotMessage({ message: "hi" });
    expect(r.text).toBe("ok");
  });

  it("throws on non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(sendCopilotMessage({ message: "hi" })).rejects.toThrow();
  });
});
