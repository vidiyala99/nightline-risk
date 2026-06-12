import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BackNavProvider, usePageBack, usePageBackState } from "./BackNavContext";

/**
 * Faithful stand-in for AppShell's single "up" affordance: a registered page
 * back wins over the generic "Back to home", and exactly one ever renders.
 * This mirrors the real gate in AppShell (`pageBack ? … : showBackHome ? … : null`)
 * so the test pins the contract without dragging in AppShell's auth/breakpoint
 * dependencies.
 */
function ShellBack() {
  const pageBack = usePageBackState();
  if (pageBack) {
    return (
      <button aria-label={pageBack.label} onClick={pageBack.onBack}>
        {pageBack.label}
      </button>
    );
  }
  return <a href="/dashboard">Back to home</a>;
}

function PageWithBack({ label, onBack }: { label: string; onBack?: () => void }) {
  usePageBack(label, onBack ?? (() => {}));
  return <div>page body</div>;
}

/** Every element whose text reads like a back affordance. The core invariant is
 *  that this is always exactly 1 — never the stacked double-back bug. */
function backAffordances() {
  return screen.getAllByText(/back/i);
}

describe("BackNavContext — single up-affordance contract", () => {
  it("shows 'Back to home' and nothing else when no page registers a back", () => {
    render(
      <BackNavProvider>
        <ShellBack />
      </BackNavProvider>,
    );
    expect(screen.getByText("Back to home")).toBeInTheDocument();
    expect(backAffordances()).toHaveLength(1);
  });

  it("a registered page back REPLACES 'Back to home' — exactly one back, never two", () => {
    render(
      <BackNavProvider>
        <ShellBack />
        <PageWithBack label="Back to Incidents" />
      </BackNavProvider>,
    );
    // This is the regression: brokers used to see BOTH the shell's "Back to
    // home" and the page's contextual back stacked together.
    expect(screen.getByRole("button", { name: "Back to Incidents" })).toBeInTheDocument();
    expect(screen.queryByText("Back to home")).not.toBeInTheDocument();
    expect(backAffordances()).toHaveLength(1);
  });

  it("invokes the latest onBack when the contextual back is clicked", () => {
    const onBack = vi.fn();
    render(
      <BackNavProvider>
        <ShellBack />
        <PageWithBack label="Back to desk" onBack={onBack} />
      </BackNavProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to desk" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("reverts to 'Back to home' once the page unmounts", () => {
    const { rerender } = render(
      <BackNavProvider>
        <ShellBack />
        <PageWithBack label="Back to risk profile" />
      </BackNavProvider>,
    );
    expect(screen.getByRole("button", { name: "Back to risk profile" })).toBeInTheDocument();

    rerender(
      <BackNavProvider>
        <ShellBack />
      </BackNavProvider>,
    );
    expect(screen.getByText("Back to home")).toBeInTheDocument();
    expect(backAffordances()).toHaveLength(1);
  });

  it("last registration wins, and a stale unmount does not clobber the active one", () => {
    const { rerender } = render(
      <BackNavProvider>
        <ShellBack />
        <PageWithBack label="Back to A" />
        <PageWithBack label="Back to B" />
      </BackNavProvider>,
    );
    // Mount order → B registers last → B is the active back.
    expect(screen.getByRole("button", { name: "Back to B" })).toBeInTheDocument();
    expect(backAffordances()).toHaveLength(1);

    // Unmount A (the stale one). Its cleanup must NOT clear B's registration.
    rerender(
      <BackNavProvider>
        <ShellBack />
        <PageWithBack label="Back to B" />
      </BackNavProvider>,
    );
    expect(screen.getByRole("button", { name: "Back to B" })).toBeInTheDocument();
    expect(backAffordances()).toHaveLength(1);
  });
});
