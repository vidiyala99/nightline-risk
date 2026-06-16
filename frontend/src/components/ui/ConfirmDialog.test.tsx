import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

function setup(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Withdraw request?"
      body="This returns the request to the operator."
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    />,
  );
  return { onConfirm, onClose };
}

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const { onConfirm, onClose } = { onConfirm: vi.fn(), onClose: vi.fn() };
    render(<ConfirmDialog open={false} title="X" onConfirm={onConfirm} onClose={onClose} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders title, body, and default Confirm/Cancel labels", () => {
    setup();
    expect(screen.getByText("Withdraw request?")).toBeInTheDocument();
    expect(screen.getByText("This returns the request to the operator.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("uses custom confirm/cancel labels", () => {
    setup({ confirmLabel: "Withdraw", cancelLabel: "Keep" });
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument();
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    const { onConfirm, onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Caller closes on success — the dialog must NOT auto-close on confirm.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when the cancel button is clicked", () => {
    const { onConfirm, onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("marks the confirm button destructive via a stable data hook", () => {
    setup({ destructive: true, confirmLabel: "Delete" });
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute("data-variant", "destructive");
  });

  it("is non-destructive by default", () => {
    setup();
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveAttribute("data-variant", "default");
  });

  it("disables both buttons and shows the working label while busy", () => {
    setup({ busy: true });
    const confirm = screen.getByRole("button", { name: /working/i });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
