import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentActivityPanel } from "./AgentActivityPanel";

afterEach(() => vi.restoreAllMocks());

function mockRuns(runs: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ runs }),
  })) as unknown as typeof fetch);
}

test("renders a fallback chip for a fell-back run", async () => {
  mockRuns([{
    id: "arun-1", agent_name: "risk", agent_kind: "pipeline", provider: "groq",
    model: "m", entity_type: "incident", entity_id: "inc-A", status: "fell_back",
    outcome: "fallback", fallback_reason: "groq_timeout", confidence: null,
    cost_usd: "0.0020", latency_ms: 12, auto_completed: false,
    created_at: "2026-06-22T00:00:00Z",
  }]);
  render(<AgentActivityPanel />);
  expect(await screen.findByText(/fallback/i)).toBeInTheDocument();
});

test("self-hides when there are no runs", async () => {
  mockRuns([]);
  const { container } = render(<AgentActivityPanel />);
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});
