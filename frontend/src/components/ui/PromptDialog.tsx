"use client";

import { useEffect, useState } from "react";
import { ActionModal } from "@/components/claims/ActionModal";
import { Button } from "@/components/ds/button";
import { Input } from "@/components/ds/input";
import { Label } from "@/components/ds/label";

// Shared field chrome for the textarea/select (matches the ds/ Input look).
const fieldClass =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50";

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
      <form onSubmit={submit} className="flex flex-col gap-4">
        {fields.map((f) => {
          const invalid = showErrors && missing.includes(f.name);
          return (
            <div key={f.name} className="grid gap-2">
              <Label htmlFor={`pd-${f.name}`} className="text-foreground">
                {f.label}{f.required && " *"}
              </Label>
              {f.type === "select" ? (
                <select id={`pd-${f.name}`} className={fieldClass} value={values[f.name]}
                        onChange={(e) => set(f.name, e.target.value)} disabled={busy}>
                  {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.type === "textarea" ? (
                <textarea id={`pd-${f.name}`} className={fieldClass} rows={3} value={values[f.name]}
                          placeholder={f.placeholder} disabled={busy}
                          aria-invalid={invalid} onChange={(e) => set(f.name, e.target.value)} />
              ) : (
                <Input id={`pd-${f.name}`} type={f.type} value={values[f.name]}
                       placeholder={f.placeholder} disabled={busy}
                       aria-invalid={invalid} onChange={(e) => set(f.name, e.target.value)} />
              )}
              {f.help && <span className="text-xs text-muted-foreground">{f.help}</span>}
              {invalid && <span className="text-xs text-destructive" role="alert">Required.</span>}
            </div>
          );
        })}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" className="text-foreground" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" className="border border-foreground/15" disabled={busy}>
            {busy ? "Working…" : submitLabel}
          </Button>
        </div>
      </form>
    </ActionModal>
  );
}
