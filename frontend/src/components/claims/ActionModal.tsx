"use client";

import { ReactNode, useEffect, useRef } from "react";
import { X } from "lucide-react";

interface ActionModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** When true, intercepts background click + Escape to confirm before
   *  dismissing (form has dirty state). Set by callers that hold user-
   *  typed values. */
  guardDismiss?: boolean;
  busy?: boolean;
}

/**
 * Lightweight modal shell. Centered card over a dim scrim. Closes on
 * Escape and background click (or asks first when guardDismiss=true and
 * the form has dirty state — handled by the caller via the prop's
 * guarding logic).
 *
 * Focus management: traps initial focus on the first focusable element
 * inside the body. Restores focus to the trigger on close (managed via
 * the calling page's ref pattern — this shell stays presentational).
 *
 * Motion: 180ms scale + opacity entry, suppressed by prefers-reduced-
 * motion. Exit is 120ms (exit faster than enter, per Material).
 */
export function ActionModal({
  open,
  title,
  subtitle,
  onClose,
  children,
  guardDismiss = false,
  busy = false,
}: ActionModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Escape key + body lock when open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        attemptClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy]);

  // Focus the first focusable element when opening.
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const focusable = dialogRef.current.querySelector<HTMLElement>(
      "input, select, textarea, button:not([disabled])",
    );
    focusable?.focus();
  }, [open]);

  if (!open) return null;

  function attemptClose() {
    if (busy) return;
    if (guardDismiss) {
      const ok = window.confirm("Discard your changes?");
      if (!ok) return;
    }
    onClose();
  }

  return (
    <div
      className="claim-modal-scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) attemptClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-modal-title"
        className="claim-modal"
      >
        <header className="claim-modal__header">
          <div>
            <h2 id="claim-modal-title" className="claim-modal__title">
              {title}
            </h2>
            {subtitle && <p className="claim-modal__subtitle">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="claim-modal__close"
            aria-label="Close"
            onClick={attemptClose}
            disabled={busy}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="claim-modal__body">{children}</div>
      </div>
    </div>
  );
}
