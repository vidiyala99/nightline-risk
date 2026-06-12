"use client";

import { useEffect, useState } from "react";
import { ActionModal } from "@/components/claims/ActionModal";

export type PromptField =
  | { name: string; label: string; type: "text" | "date"; required?: boolean; placeholder?: string; defaultValue?: string; help?: string }
  | { name: string; label: string; type: "textarea"; required?: boolean; placeholder?: string; defaultValue?: string; help?: string }
  | { name: string; label: string; type: "select"; required?: boolean; options: { value: string; label: string }[]; defaultValue?: string; help?: string };

export interface PromptDialogProps {
  open: boolean;
  title: string;
  subtitle?: string;
  submitLabel?: string;
  fields: PromptField[];
  busy?: boolean;
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
}

/** Names of required fields that are still blank — pure, so it's unit-testable. */
export function missingRequired(
  fields: PromptField[],
  values: Record<string, string>,
): string[] {
  return fields
    .filter((f) => f.required && !(values[f.name] ?? "").trim())
    .map((f) => f.name);
}

function initialValues(fields: PromptField[]): Record<string, string> {
  const v: Record<string, string> = {};
  for (const f of fields) {
    v[f.name] = f.defaultValue ?? (f.type === "select" ? f.options[0]?.value ?? "" : "");
  }
  return v;
}

/**
 * A small accessible form modal — replaces chained `window.prompt()` data entry
 * with a single proper form (labeled fields, validation, one submit). Reuses
 * ActionModal for the scrim / focus-trap / Escape handling.
 */
export function PromptDialog({
  open, title, subtitle, submitLabel = "Confirm", fields, busy = false, onSubmit, onClose,
}: PromptDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(fields));
  const [showErrors, setShowErrors] = useState(false);

  // Reset to defaults each time the dialog opens.
  useEffect(() => {
    if (open) {
      setValues(initialValues(fields));
      setShowErrors(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const missing = missingRequired(fields, values);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (missing.length > 0) {
      setShowErrors(true);
      return;
    }
    onSubmit(values);
  }

  const set = (name: string, val: string) => setValues((v) => ({ ...v, [name]: val }));

  return (
    <ActionModal open={open} title={title} subtitle={subtitle} onClose={onClose} busy={busy} guardDismiss>
      <form onSubmit={submit} className="flex flex-col gap-md">
        {fields.map((f) => {
          const invalid = showErrors && missing.includes(f.name);
          return (
            <div key={f.name} className="submission-wizard__field">
              <label htmlFor={`pd-${f.name}`} className="submission-wizard__label">
                {f.label}{f.required && " *"}
              </label>
              {f.type === "select" ? (
                <select id={`pd-${f.name}`} className="input-field" value={values[f.name]}
                        onChange={(e) => set(f.name, e.target.value)} disabled={busy}>
                  {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.type === "textarea" ? (
                <textarea id={`pd-${f.name}`} className="input-field" rows={2} value={values[f.name]}
                          placeholder={f.placeholder} disabled={busy}
                          aria-invalid={invalid} onChange={(e) => set(f.name, e.target.value)} />
              ) : (
                <input id={`pd-${f.name}`} type={f.type} className="input-field" value={values[f.name]}
                       placeholder={f.placeholder} disabled={busy}
                       aria-invalid={invalid} onChange={(e) => set(f.name, e.target.value)} />
              )}
              {f.help && <span className="text-xs text-secondary" style={{ marginTop: 2 }}>{f.help}</span>}
              {invalid && <span className="text-xs" role="alert" style={{ color: "var(--state-warning)", marginTop: 2 }}>Required.</span>}
            </div>
          );
        })}
        <div className="flex gap-sm" style={{ justifyContent: "flex-end", marginTop: 4 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Working…" : submitLabel}</button>
        </div>
      </form>
    </ActionModal>
  );
}
