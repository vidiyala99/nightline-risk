"use client";

/**
 * /tasks — broker to-do feed. Turns pull-only renewals + the requests queue
 * into one prioritized "needs your attention" list: expiring policies
 * (bucketed by urgency) + pending operator PolicyRequests. Each row links to
 * the surface where it gets actioned (/renewals or /policy-requests).
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { useAuth } from "@/contexts/AuthContext";
import {
  BrokerTask,
  URGENCY_LABEL,
  URGENCY_TONE,
  tasksApi,
} from "@/lib/tasks";
import { REQUEST_TYPE_LABEL, type PolicyRequestType } from "@/lib/policyRequests";

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
      <div className="page page-empty">
        <h3>Tasks is a broker surface.</h3>
        <p className="text-secondary">
          Your renewals and requests are managed by your broker.
        </p>
      </div>
    );
  }

  return (
    <div className="claims-portfolio">
      <PageHeader
        eyebrow="BROKER · TO-DO"
        title="Tasks"
        subtitle="Renewals coming due and requests awaiting your decision — most urgent first."
      />

      {error && (
        <div className="policies-empty" role="alert" style={{ borderColor: "var(--state-error)", color: "var(--state-error)" }}>
          {error}
        </div>
      )}

      {tasks === null ? (
        <div className="claims-section__skeleton" aria-busy="true"><div /><div /><div /></div>
      ) : tasks.length === 0 ? (
        <div className="policies-empty">Nothing needs your attention right now. You&rsquo;re caught up.</div>
      ) : (
        <div className="task-list">
          {tasks.map((t) => (
            <button
              key={t.id}
              type="button"
              className="task-row"
              onClick={() => router.push(t.kind === "renewal" ? "/renewals" : "/policy-requests")}
            >
              <span className={`task-row__rail task-row__rail--${t.urgency}`} aria-hidden />
              <span className="task-row__body">
                <span className="task-row__title">{taskTitle(t)}</span>
                <span className="task-row__sub">{taskSubtitle(t)}</span>
              </span>
              <StatusPill tone={URGENCY_TONE[t.urgency]}>{URGENCY_LABEL[t.urgency]}</StatusPill>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
