"use client";

import * as React from "react";
import { ActionModal } from "@/components/claims/ActionModal";
import { Button } from "@/components/ds/button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body copy — the question / consequences. */
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button + destructive framing. */
  destructive?: boolean;
  /** Disables both buttons + shows a working label on confirm. */
  busy?: boolean;
  /** May be async; the caller flips `busy` while it runs and closes on success. */
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

/**
 * A yes/no confirmation modal — the confirm sibling of PromptDialog. Built on
 * ActionModal (scrim / focus-trap / Escape / body-lock). `guardDismiss` is OFF:
 * a confirm holds no typed state, so Escape / scrim-click / Cancel just dismiss.
 *
 * `onConfirm` is NOT auto-closed — the caller closes on success, so a failed
 * async action keeps the dialog open and can surface a `toastError` (mirrors
 * `PromptDialog.onSubmit`). First fully-`ds/` modal (Paper & Ink Buttons).
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <ActionModal open={open} title={title} onClose={onClose} busy={busy}>
      <div className="flex flex-col gap-4">
        {body && <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-foreground"
            onClick={onClose}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            size="sm"
            data-variant={destructive ? "destructive" : "default"}
            className={destructive ? undefined : "border border-foreground/15"}
            onClick={() => onConfirm()}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </ActionModal>
  );
}
