import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Finding } from "@/lib/intelligence";

// next/link → a plain anchor so href/role assertions work without the App Router runtime.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Mock only fetchExposure; keep the real helpers (filterFindingsForVenue, etc.).
vi.mock("@/lib/intelligence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/intelligence")>()),
  fetchExposure: vi.fn(),
}));

import { fetchExposure } from "@/lib/intelligence";
import { ExposurePanel } from "./ExposurePanel";

const stalled = (id: string): Finding => ({
  id: `submission_stalled:submission:${id}`,
  persona: "broker",
  kind: "submission_stalled",
  subject: { entity_type: "submission", entity_id: id, label: id, href: `/submissions/${id}` },
  severity: "medium",
  severity_rank: 2,
  why: [{ source_id: id, source_type: "submission", excerpt: `Status 'open', no movement for 16 days.` }],
  recommended_action: { label: "Follow up on this submission", href: `/submissions/${id}` },
  prediction: { claim: "x", falsifiable_by: "submission_status", horizon: "effective_date" },
  venue_id: "venue-1",
});

/** Route the footer's queue fetches by URL. proposals → N pending rows;
 *  policy-requests → rows with the given statuses. */
function mockQueueFetch({ proposals = 0, requestStatuses = [] as string[] } = {}) {
  global.fetch = vi.fn((input: any) => {
    const url = String(input);
    if (url.includes("/api/claim-proposals")) {
      return Promise.resolve({ ok: true, json: async () => Array.from({ length: proposals }, () => ({})) } as Response);
    }
    if (url.includes("/api/policy-requests")) {
      return Promise.resolve({ ok: true, json: async () => requestStatuses.map((status) => ({ status })) } as Response);
    }
    return Promise.resolve({ ok: false, json: async () => [] } as Response);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.mocked(fetchExposure).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ExposurePanel — findings (existing behavior)", () => {
  it("renders findings with their subject and severity", async () => {
    vi.mocked(fetchExposure).mockResolvedValue({ persona: "broker", findings: [stalled("sub-demo-open")] });
    render(<ExposurePanel />);
    expect(await screen.findByText("sub-demo-open")).toBeInTheDocument();
  });

  it("shows the empty line when nothing needs attention and no queues are passed", async () => {
    vi.mocked(fetchExposure).mockResolvedValue({ persona: "broker", findings: [] });
    render(<ExposurePanel />);
    expect(await screen.findByText(/nothing needs your attention right now/i)).toBeInTheDocument();
  });

  it("does NOT render the queue footer for an operator (no brokerQueues prop)", async () => {
    vi.mocked(fetchExposure).mockResolvedValue({ persona: "venue_operator", findings: [stalled("inc-1")] });
    render(<ExposurePanel />);
    await screen.findByText("inc-1");
    expect(screen.queryByText(/your queues/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/proposals to decide/i)).not.toBeInTheDocument();
  });
});

describe("ExposurePanel — merged broker queue footer", () => {
  it("GUARDRAIL: header 'open' count is findings-only, never findings + queues", async () => {
    // 2 findings + 14 queued proposals. Header must read 2, NOT 16.
    vi.mocked(fetchExposure).mockResolvedValue({
      persona: "broker",
      findings: [stalled("sub-demo-open"), stalled("sub-demo-market")],
    });
    mockQueueFetch({ proposals: 14 });
    render(<ExposurePanel brokerQueues={{ expiringRenewals: 1 }} />);

    // Footer proves the queue data arrived...
    expect(await screen.findByRole("link", { name: /proposals to decide/i })).toBeInTheDocument();
    // ...yet the header count stays at the findings count.
    expect(screen.getByTestId("exposure-open-count")).toHaveTextContent("2");
    expect(screen.queryByTestId("exposure-open-count")).not.toHaveTextContent("16");
  });

  it("renders queue tiles with counts + deep-links; hides zero-count tiles", async () => {
    vi.mocked(fetchExposure).mockResolvedValue({ persona: "broker", findings: [stalled("sub-demo-open")] });
    mockQueueFetch({ proposals: 14, requestStatuses: [] }); // 0 open requests
    render(<ExposurePanel brokerQueues={{ expiringRenewals: 1 }} />);

    const proposals = await screen.findByRole("link", { name: /proposals to decide/i });
    expect(proposals).toHaveAttribute("href", "/work-queue");
    const renewals = screen.getByRole("link", { name: /renewals expiring/i });
    expect(renewals).toHaveAttribute("href", "/renewals");
    // 0 open requests → tile hidden
    expect(screen.queryByText(/open requests/i)).not.toBeInTheDocument();
  });

  it("renders the footer even when there are no findings (queues still need you)", async () => {
    vi.mocked(fetchExposure).mockResolvedValue({ persona: "broker", findings: [] });
    mockQueueFetch({ proposals: 14 });
    render(<ExposurePanel brokerQueues={{ expiringRenewals: 0 }} />);

    expect(await screen.findByRole("link", { name: /proposals to decide/i })).toBeInTheDocument();
    expect(screen.queryByText(/nothing needs your attention right now/i)).not.toBeInTheDocument();
  });

  it("falls back to the empty line when both findings and all queue counts are zero", async () => {
    vi.mocked(fetchExposure).mockResolvedValue({ persona: "broker", findings: [] });
    mockQueueFetch({ proposals: 0, requestStatuses: [] });
    render(<ExposurePanel brokerQueues={{ expiringRenewals: 0 }} />);

    expect(await screen.findByText(/nothing needs your attention right now/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/your queues/i)).not.toBeInTheDocument());
  });
});
