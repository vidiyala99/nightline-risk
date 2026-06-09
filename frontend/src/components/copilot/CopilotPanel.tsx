"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Send, ShieldCheck, Check, X, Sparkles } from "lucide-react";
import {
  sendCopilotMessage,
  confirmCompliance,
  type CopilotReply,
  type ProposedAction,
} from "@/lib/copilot";
import type { Citation } from "@/lib/intelligence";

/**
 * Risk Intelligence Copilot — the conversational surface of the intelligence
 * layer (spec §7). Where ExposurePanel pushes findings proactively, the Copilot
 * answers operator questions with grounded replies: every claim carries
 * click-through citations, and any state-changing suggestion arrives as a
 * confirm/dismiss proposal (never auto-executed). The compliance action also
 * gates on a required attachment before it can be confirmed.
 */

type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; reply: CopilotReply };

// source_type → human label for the citation chip. Unknown types fall back to
// the raw type so a new backend source never renders blank.
const SOURCE_LABEL: Record<string, string> = {
  incident: "Incident",
  packet: "Evidence packet",
  policy: "Policy",
  claim: "Claim",
  proposal: "Recommendation",
  submission: "Submission",
  quote: "Quote",
  finding: "Finding",
  statute: "Statute",
  document: "Document",
  clause: "Clause",
};

function sourceLabel(t: string): string {
  return SOURCE_LABEL[t] ?? t.replace(/_/g, " ");
}

// Starter prompts shown on the empty state — one per read intent, so the first
// click both teaches what the copilot answers and returns a grounded reply.
const SUGGESTIONS = [
  "What needs my attention?",
  "Why is my risk a C?",
  "Any open claims?",
  "What's the status of my reports?",
];

// A Citation may carry an href on some source types; the shared type doesn't
// declare one, so read it defensively rather than widening the interface.
function citationHref(c: Citation): string | null {
  const h = (c as Citation & { href?: string | null }).href;
  return typeof h === "string" && h.length > 0 ? h : null;
}

function CitationChip({ c }: { c: Citation }) {
  const href = citationHref(c);
  const label = sourceLabel(c.source_type);
  const inner = (
    <>
      <span className="copilot-cite__type">{label}</span>
      <span className="copilot-cite__excerpt" title={c.excerpt}>
        {c.excerpt}
      </span>
    </>
  );
  if (href) {
    return (
      <Link href={href} className="copilot-cite copilot-cite--link" title={c.excerpt}>
        {inner}
      </Link>
    );
  }
  return (
    <span className="copilot-cite" title={c.excerpt}>
      {inner}
    </span>
  );
}

export function CopilotPanel() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Proposals the operator dismissed — keyed so a re-rendered reply hides its
  // confirm/dismiss affordance once acted on.
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest turn in view as the transcript grows.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  // Single funnel for any request that yields a reply: append the reply, clear
  // pending, surface errors. The optional userText is appended first so the
  // transcript reads in order.
  async function run(fn: () => Promise<CopilotReply>, userText?: string) {
    if (pending) return;
    setError(null);
    setPending(true);
    if (userText !== undefined) {
      setMessages((m) => [...m, { role: "user", text: userText }]);
    }
    try {
      const reply = await fn();
      setMessages((m) => [...m, { role: "assistant", reply }]);
    } catch {
      setError("The copilot couldn't respond. Try again.");
    } finally {
      setPending(false);
    }
  }

  function sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    void run(() => sendCopilotMessage({ message: trimmed }), trimmed);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendText(text);
  }

  function confirmAction(action: ProposedAction, msgIndex: number) {
    // Non-attachment actions confirm by echoing the action back to the model.
    void run(() => sendCopilotMessage({ message: "", confirm_action: action }));
    setDismissed((d) => new Set(d).add(msgIndex));
  }

  function onFilePicked(action: ProposedAction, msgIndex: number, file: File | null) {
    if (!file) return;
    void run(() => confirmCompliance(action, file));
    setDismissed((d) => new Set(d).add(msgIndex));
  }

  function dismiss(msgIndex: number) {
    setDismissed((d) => new Set(d).add(msgIndex));
  }

  // Index of the last assistant message — its container gets aria-live so a
  // screen reader announces the newest grounded reply.
  const lastAssistant = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  })();

  return (
    <section className="copilot" aria-label="Risk intelligence copilot">
      <div className="copilot__log">
        {messages.length === 0 && !pending && (
          <div className="copilot__empty">
            <Sparkles size={22} className="copilot__empty-icon" aria-hidden />
            <p className="copilot__empty-lead">
              Grounded answers about your venue — exposure, risk, claims,
              compliance. Every reply cites its sources, and any action waits
              for your confirmation.
            </p>
            <div className="copilot__suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="copilot-suggestion"
                  onClick={() => sendText(s)}
                  disabled={pending}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="copilot-turn copilot-turn--user">
              <div className="lc-card copilot-bubble copilot-bubble--user">
                <div className="lc-card__inner copilot-bubble__inner">{m.text}</div>
              </div>
            </div>
          ) : (
            <div
              key={i}
              className="copilot-turn copilot-turn--assistant"
              aria-live={i === lastAssistant ? "polite" : undefined}
            >
              <div className="lc-card copilot-bubble copilot-bubble--assistant">
                <div className="lc-card__inner copilot-bubble__inner">
                  <p className="copilot-bubble__text">{m.reply.text}</p>

                  {m.reply.link && (
                    <Link href={m.reply.link.href} className="copilot-bubble__link">
                      {m.reply.link.label} →
                    </Link>
                  )}

                  {m.reply.citations.length > 0 && (
                    <div className="copilot-cites" aria-label="Sources">
                      {m.reply.citations.map((c, ci) => (
                        <CitationChip key={`${c.source_id}-${ci}`} c={c} />
                      ))}
                    </div>
                  )}

                  {m.reply.answer_type === "propose_action" &&
                    m.reply.proposed_action &&
                    !dismissed.has(i) && (
                      <ProposalAffordance
                        action={m.reply.proposed_action}
                        onConfirm={() => confirmAction(m.reply.proposed_action!, i)}
                        onDismiss={() => dismiss(i)}
                        onFile={(file) => onFilePicked(m.reply.proposed_action!, i, file)}
                        fileInputRef={fileInputRef}
                        pending={pending}
                      />
                    )}

                  {m.reply.followups.length > 0 && (
                    <div className="copilot-followups" aria-label="Quick asks">
                      {m.reply.followups.map((f, fi) => (
                        <button
                          key={fi}
                          type="button"
                          className="lc-triage__chip copilot-followup"
                          onClick={() => sendText(f)}
                          disabled={pending}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ),
        )}

        {pending && (
          <div className="copilot-turn copilot-turn--assistant">
            <div className="copilot-pending" aria-live="polite">
              <span className="copilot-pending__dot" aria-hidden />
              <span className="copilot-pending__dot" aria-hidden />
              <span className="copilot-pending__dot" aria-hidden />
              <span className="copilot-pending__label">Thinking…</span>
            </div>
          </div>
        )}

        {error && (
          <p className="copilot__error" role="alert">
            {error}
          </p>
        )}
        <div ref={logEndRef} aria-hidden />
      </div>

      <form className="copilot__composer" onSubmit={onSubmit}>
        <label htmlFor="copilot-input" className="copilot__label">
          Ask the copilot
        </label>
        <div className="copilot__composer-row">
          <input
            id="copilot-input"
            className="input-field copilot__input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. What's the status of the Friday incident?"
            autoComplete="off"
            disabled={pending}
          />
          <button
            type="submit"
            className="btn-primary copilot__send"
            disabled={pending || input.trim().length === 0}
          >
            <Send size={16} aria-hidden /> Send
          </button>
        </div>
      </form>
    </section>
  );
}

function ProposalAffordance({
  action,
  onConfirm,
  onDismiss,
  onFile,
  fileInputRef,
  pending,
}: {
  action: ProposedAction;
  onConfirm: () => void;
  onDismiss: () => void;
  onFile: (file: File | null) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  pending: boolean;
}) {
  const needsFile = action.requires_attachment === true;
  return (
    <div className="copilot-proposal" role="group" aria-label="Proposed action">
      <div className="copilot-proposal__head">
        <ShieldCheck size={15} aria-hidden className="copilot-proposal__icon" />
        <span className="copilot-proposal__summary">{action.summary}</span>
      </div>
      {!action.gating_passed && (
        <p className="copilot-proposal__gate">
          This action has open prerequisites — confirming will surface what's still needed.
        </p>
      )}
      <div className="copilot-proposal__actions">
        {needsFile ? (
          <>
            <input
              ref={fileInputRef}
              id={`copilot-file-${action.target_id}`}
              className="copilot-proposal__file"
              type="file"
              aria-label={`Attach a file to confirm: ${action.summary}`}
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              disabled={pending}
            />
            <button
              type="button"
              className="btn-ghost copilot-proposal__btn"
              onClick={onDismiss}
              disabled={pending}
            >
              <X size={15} aria-hidden /> Dismiss
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn-primary copilot-proposal__btn"
              onClick={onConfirm}
              disabled={pending}
            >
              <Check size={15} aria-hidden /> Confirm
            </button>
            <button
              type="button"
              className="btn-ghost copilot-proposal__btn"
              onClick={onDismiss}
              disabled={pending}
            >
              <X size={15} aria-hidden /> Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
}
