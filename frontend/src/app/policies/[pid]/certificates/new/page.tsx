"use client";

/**
 * /policies/[pid]/certificates/new — issue a Certificate of Insurance.
 *
 * Toggle for additional_insured surfaces the scope dropdown (the ISO
 * endorsement form mapping). On success, redirects back to policy detail.
 *
 * "Paper & Ink" — migrated to ds/ via the Field/Row helper pattern (see
 * the endorse form); explicit colours on every text element.
 */
import React, { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PlacementApiError, formatCurrency } from "@/lib/placement";
import { Policy, policiesApi, matchHolder, type CertificateHolder } from "@/lib/policies";
import { toastSuccess } from "@/lib/toast";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Input } from "@/components/ds/input";
import { Label } from "@/components/ds/label";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;

const controlClass =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50";

function Field({ label, hint, children }: { label: string; hint?: string | null; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label className="text-foreground">{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Row({ dt, dd }: { dt: string; dd: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{dt}</dt>
      <dd className="text-right font-medium text-foreground">{dd}</dd>
    </div>
  );
}

export default function IssueCertificatePage() {
  const params = useParams<{ pid: string }>();
  const router = useRouter();
  const pid = params?.pid;

  const [policy, setPolicy] = useState<Policy | null>(null);
  const [holder, setHolder] = useState("");
  const [holderAddress, setHolderAddress] = useState("");
  const [description, setDescription] = useState("Operations of the named insured");
  const [expiresOn, setExpiresOn] = useState("");
  const [ai, setAi] = useState(false);
  const [aiScope, setAiScope] = useState<"ongoing_operations" | "completed_operations" | "single_event">("ongoing_operations");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Auto-fill: prior holders across the broker's book. Picking one pre-fills the
  // recurring fields and reuses the canonical spelling (so the new COI supersedes
  // the prior one instead of minting a duplicate). Edited fields aren't clobbered.
  const [holders, setHolders] = useState<CertificateHolder[]>([]);
  const [addressTouched, setAddressTouched] = useState(false);
  const [descTouched, setDescTouched] = useState(false);
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);

  useEffect(() => {
    if (!pid) return;
    policiesApi.getPolicy(pid).then(p => {
      setPolicy(p);
      // Default the COI expiration to the policy's own expiration date.
      setExpiresOn(p.expiration_date);
    }).catch(e => {
      setError(e instanceof PlacementApiError ? e.message : "Failed to load policy");
    });
  }, [pid]);

  useEffect(() => {
    policiesApi.listCertificateHolders().then(setHolders).catch(() => {});
  }, []);

  function onHolderChange(value: string) {
    setHolder(value);
    const m = matchHolder(holders, value);
    if (!m) { setPrefilledFrom(null); return; }
    if (!addressTouched) setHolderAddress(m.certificate_holder_address);
    if (!descTouched) setDescription(m.description_of_operations);
    setAi(m.additional_insured);
    if (m.additional_insured_scope) setAiScope(m.additional_insured_scope as typeof aiScope);
    setPrefilledFrom(m.certificate_holder);
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pid) return;
    setError(null);
    setBusy(true);
    try {
      await policiesApi.issueCertificate(pid, {
        certificate_holder: holder,
        certificate_holder_address: holderAddress,
        description_of_operations: description,
        expires_on: expiresOn,
        additional_insured: ai,
        additional_insured_scope: ai ? aiScope : null,
      });
      toastSuccess(`Certificate issued${holder.trim() ? ` — for ${holder.trim()}` : ""}`);
      router.push(`/policies/${pid}`);
    } catch (e) {
      setError(e instanceof PlacementApiError ? e.message : "COI failed");
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <section className="py-10">
        <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-[#5A6E00]">
          <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
          Policy
        </span>
        <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
          Issue Certificate of Insurance
        </h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          {policy ? `For policy ${policy.policy_number ?? policy.id} · ${policy.venue_id}` : "Loading policy…"}
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* ── form ─────────────────────────────────────────────────────── */}
        <Card className="gap-4 p-6">
          <form id="coi-form" className="flex flex-col gap-4" onSubmit={submit}>
            {error && (
              <div role="alert" className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <Field label="Certificate Holder" hint={prefilledFrom ? `Pre-filled from a prior certificate to ${prefilledFrom} — edit any field to override.` : undefined}>
              <Input
                value={holder}
                onChange={e => onHolderChange(e.target.value)}
                placeholder="599 Johnson LLC"
                list="coi-holders"
                autoComplete="off"
                required
              />
              {holders.length > 0 && (
                <datalist id="coi-holders">
                  {holders.map(h => <option key={h.certificate_holder} value={h.certificate_holder} />)}
                </datalist>
              )}
            </Field>

            <Field label="Holder Address">
              <Input
                value={holderAddress}
                onChange={e => { setHolderAddress(e.target.value); setAddressTouched(true); }}
                placeholder="599 Johnson Ave, Brooklyn, NY 11237"
                required
              />
            </Field>

            <Field label="Description of Operations">
              <textarea
                className={controlClass}
                rows={2}
                value={description}
                onChange={e => { setDescription(e.target.value); setDescTouched(true); }}
                required
              />
            </Field>

            <Field label="Expires On">
              <Input type="date" value={expiresOn} onChange={e => setExpiresOn(e.target.value)} required />
            </Field>

            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={ai} onChange={e => setAi(e.target.checked)} className="size-4 accent-primary" />
              Add holder as Additional Insured
            </label>

            {ai && (
              <Field label="Additional Insured Scope (ISO endorsement form)">
                <select className={controlClass} value={aiScope} onChange={e => setAiScope(e.target.value as typeof aiScope)}>
                  <option value="ongoing_operations">Ongoing Operations (CG 20 10)</option>
                  <option value="completed_operations">Completed Operations (CG 20 26)</option>
                  <option value="single_event">Single Event (CG 20 37)</option>
                </select>
              </Field>
            )}
          </form>
        </Card>

        {/* ── action + summary ─────────────────────────────────────────── */}
        <Card className="h-fit gap-4 p-6 lg:sticky lg:top-6">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="flex-1 text-foreground" onClick={() => router.push(`/policies/${pid}`)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="coi-form" size="sm" className="flex-1 border border-foreground/15" disabled={busy}>
              {busy ? "Issuing…" : "Issue Certificate"}
            </Button>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Certificate</div>
            <dl className="flex flex-col gap-1.5">
              <Row dt="Holder" dd={holder.trim() || "—"} />
              <Row dt="Expires" dd={expiresOn || "—"} />
              <Row dt="Add'l insured" dd={ai ? aiScope.replace(/_/g, " ") : "No"} />
            </dl>
          </div>
          {policy && (
            <div className="border-t border-border pt-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current policy</div>
              <dl className="flex flex-col gap-1.5">
                <Row dt="Policy" dd={policy.policy_number || policy.id} />
                <Row dt="Venue" dd={policy.venue_id} />
                <Row dt="Coverage" dd={policy.coverage_lines.length ? policy.coverage_lines.join(", ") : "—"} />
                <Row dt="Premium" dd={formatCurrency(policy.annual_premium)} />
                <Row dt="Expires" dd={policy.expiration_date} />
              </dl>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
