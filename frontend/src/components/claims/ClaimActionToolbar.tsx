"use client";

import { Coins, FileWarning, Lock, RotateCcw, ShieldCheck } from "lucide-react";

import {
  ACTION_PRIORITY,
  type ActionEmphasis,
  type ActionId,
  type ClaimStatus,
} from "@/lib/claim-tokens";

interface ClaimActionToolbarProps {
  status: ClaimStatus;
  busy?: boolean;
  onRecordReserve: () => void;
  onRecordPayment: () => void;
  onCloseClaim: () => void;
  onReopenClaim: () => void;
  onAttachDefensePackage: () => void;
}

interface Spec {
  id: ActionId;
  label: string;
  Icon: typeof Coins;
  /** Single keyboard shortcut letter rendered as a hint on the button.
   *  Plan §A: distinctive detail option (c). */
  shortcut: string;
  handler: (p: ClaimActionToolbarProps) => () => void;
  /** Visually separate destructive actions (close, reopen) from money
   *  recording actions. Plan §D. */
  destructive?: boolean;
}

const SPECS: Spec[] = [
  {
    id: "record_reserve",
    label: "Record reserve",
    Icon: Lock,
    shortcut: "R",
    handler: (p) => p.onRecordReserve,
  },
  {
    id: "record_payment",
    label: "Record payment",
    Icon: Coins,
    shortcut: "P",
    handler: (p) => p.onRecordPayment,
  },
  {
    id: "attach_defense_package",
    label: "Attach defense package",
    Icon: ShieldCheck,
    shortcut: "D",
    handler: (p) => p.onAttachDefensePackage,
  },
  {
    id: "close_claim",
    label: "Close claim",
    Icon: FileWarning,
    shortcut: "C",
    handler: (p) => p.onCloseClaim,
    destructive: true,
  },
  {
    id: "reopen_claim",
    label: "Reopen claim",
    Icon: RotateCcw,
    shortcut: "O",
    handler: (p) => p.onReopenClaim,
    destructive: true,
  },
];

/**
 * Maps `ActionEmphasis` to the existing button class set in styles.css —
 * primary is filled lime, secondary outline, tertiary text-only. The class
 * names are stable across the rest of the app so this avoids defining a
 * new visual language.
 */
function buttonClass(emphasis: ActionEmphasis): string | null {
  switch (emphasis) {
    case "primary":
      return "btn btn-primary btn-sm claim-action-btn claim-action-btn--primary";
    case "secondary":
      return "btn btn-sm claim-action-btn claim-action-btn--secondary";
    case "tertiary":
      return "btn btn-sm claim-action-btn claim-action-btn--tertiary";
    case "hidden":
      return null;
  }
}

/**
 * State-gated toolbar. Reads ACTION_PRIORITY[status] and renders the
 * visible actions in primary→secondary→tertiary order. Destructive
 * actions (close, reopen) move to the right edge with a margin-left auto
 * gap so they're visually separated from money-recording actions.
 *
 * Keyboard shortcuts: each visible button gets a single-letter hint shown
 * in a corner glyph. The page registers the actual key handler — this
 * component just labels.
 */
export function ClaimActionToolbar(props: ClaimActionToolbarProps) {
  const priority = ACTION_PRIORITY[props.status];

  const order: ActionEmphasis[] = ["primary", "secondary", "tertiary"];
  const moneyButtons: React.ReactNode[] = [];
  const destructiveButtons: React.ReactNode[] = [];

  for (const tier of order) {
    for (const spec of SPECS) {
      if (priority[spec.id] !== tier) continue;
      const cls = buttonClass(tier);
      if (!cls) continue;
      const node = (
        <button
          key={spec.id}
          type="button"
          className={cls}
          onClick={spec.handler(props)}
          disabled={props.busy}
          aria-keyshortcuts={spec.shortcut}
        >
          <spec.Icon size={14} aria-hidden style={{ marginRight: 6, verticalAlign: "-2px" }} />
          {spec.label}
          <span className="claim-action-btn__hint" aria-hidden>
            {spec.shortcut}
          </span>
        </button>
      );
      (spec.destructive ? destructiveButtons : moneyButtons).push(node);
    }
  }

  if (moneyButtons.length === 0 && destructiveButtons.length === 0) return null;

  return (
    <div className="claim-action-toolbar" role="toolbar" aria-label="Claim actions">
      {moneyButtons}
      {destructiveButtons.length > 0 && (
        <div className="claim-action-toolbar__divider" aria-hidden />
      )}
      {destructiveButtons}
    </div>
  );
}
