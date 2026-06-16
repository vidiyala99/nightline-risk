"use client";

/**
 * /tasks — broker to-do feed. Turns pull-only renewals + the requests queue
 * into one prioritized "needs your attention" list: expiring policies
 * (bucketed by urgency) + pending operator PolicyRequests. Each row links to
 * the surface where it gets actioned (/renewals or /policy-requests).
 *
 * "Paper & Ink" — migrated to the ds/ primitives. PageHeader/StatusPill are
 * replaced inline (the shared legacy components still serve un-migrated pages);
 * every text element carries an explicit colour (the migration rule).
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ds/badge";
import { useAuth } from "@/contexts/AuthContext";
import {
  BrokerTask,
  URGENCY_LABEL,
  URGENCY_TONE,
  tasksApi,
} from "@/lib/tasks";
import { REQUEST_TYPE_LABEL, type PolicyRequestType } from "@/lib/policyRequests";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;

// StatusPill tone → ds Badge variant.
const TONE_VARIANT = {
  neutral: "muted",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "destructive",
} as const;

// Urgency → coloured left rail on each row.
const RAIL: Record<BrokerTask["urgency"], string> = {
  overdue: "bg-destructive",
  urgent: "bg-destructive",
  action: "bg-warning",
  soon: "bg-warning",
  upcoming: "bg-info",
};

function taskTitle(t: BrokerTask): string {
  if (t.kind === "renewal") return `Renewal — ${t.title}`;
  return `${REQUEST_TYPE_LABEL[t.title as PolicyRequestType] ?? t.title} request`;
}

function taskSubtitle(t: BrokerTask): string {
  if (t.kind === "renewal") {
    const d = t.days_until ?? 0;
    const when = d <= 0 ? `expired ${-d}d ago` : `expires in ${d}d`;
    return `${t.venue_id} · ${when} (${t.due_date})`;
  }
  return `${t.venue_id}${t.note ? ` · ${t.note}` : ""}`;
}

export default function TasksPage() {
  const router = useRouter();
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const [tasks, setTasks] = useState<BrokerTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTasks(await tasksApi.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks");
    }
  }, []);

  useEffect(() => {
    if (!isLoaded || !isBroker) return;
    load();
  }, [isLoaded, isBroker, load]);

  if (!isLoaded) return null;

  if (!isBroker) {
    return (
      <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-20 text-center">
          <h3 className="text-lg font-semibold text-foreground">Tasks is a broker surface.</h3>
          <p className="text-sm text-muted-foreground">
            Your renewals and requests are managed by your broker.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <section className="py-10">
        <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-[#5A6E00]">
          <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
          Broker · To-do
        </span>
        <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
          Tasks
        </h1>
        <p className="mt-2 max-w-[60ch] text-[15px] text-muted-foreground">
          Renewals coming due and requests awaiting your decision — most urgent first.
        </p>
      </section>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {tasks === null ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl border border-border bg-muted/40" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border py-20 text-center">
          <p className="text-sm text-muted-foreground">Nothing needs your attention right now. You&rsquo;re caught up.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => router.push(t.kind === "renewal" ? "/renewals" : "/policy-requests")}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40"
            >
              <span className={`h-10 w-1 shrink-0 rounded-full ${RAIL[t.urgency]}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{taskTitle(t)}</span>
                <span className="block truncate text-sm text-muted-foreground">{taskSubtitle(t)}</span>
              </span>
              <Badge variant={TONE_VARIANT[URGENCY_TONE[t.urgency]]}>{URGENCY_LABEL[t.urgency]}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
