/**
 * Typed client for the broker to-do feed (GET /api/broker/tasks).
 *
 * A derived, prioritized "needs your attention" list — renewal reminders
 * (expiring policies, bucketed by urgency) + pending operator PolicyRequests.
 * Sibling to lib/policyRequests.ts.
 */
import { authHeaders } from "@/lib/authFetch";
import { PlacementApiError } from "@/lib/placement";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export type TaskKind = "renewal" | "request";
export type TaskUrgency = "overdue" | "urgent" | "soon" | "upcoming" | "action";

export interface BrokerTask {
  id: string;
  kind: TaskKind;
  urgency: TaskUrgency;
  title: string;
  venue_id: string;
  due_date: string | null;
  days_until?: number;
  note?: string;
  ref_id: string;
}

export const URGENCY_TONE: Record<TaskUrgency, "danger" | "warning" | "info" | "neutral" | "success"> = {
  overdue: "danger",
  urgent: "danger",
  action: "warning",
  soon: "warning",
  upcoming: "info",
};

export const URGENCY_LABEL: Record<TaskUrgency, string> = {
  overdue: "Overdue",
  urgent: "Urgent",
  action: "Action needed",
  soon: "Soon",
  upcoming: "Upcoming",
};

export const tasksApi = {
  list: async (): Promise<BrokerTask[]> => {
    const res = await fetch(`${API_URL}/api/broker/tasks`, { headers: authHeaders() });
    if (!res.ok) {
      throw new PlacementApiError(res.status, "Failed to load tasks");
    }
    return (await res.json()) as BrokerTask[];
  },
};
