/**
 * Mobile typed client for the broker to-do feed.
 *
 * MIRROR OF frontend/src/lib/tasks.ts — a derived, prioritized "needs your
 * attention" list: renewal reminders (expiring policies, bucketed by urgency)
 * + pending operator PolicyRequests. Routed through `api.request`.
 */
import { api } from './client';
import { Colors } from '../theme/colors';

export type TaskKind = 'renewal' | 'request';
export type TaskUrgency = 'overdue' | 'urgent' | 'soon' | 'upcoming' | 'action';

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

export const URGENCY_LABEL: Record<TaskUrgency, string> = {
  overdue: 'Overdue',
  urgent: 'Urgent',
  action: 'Action needed',
  soon: 'Soon',
  upcoming: 'Upcoming',
};

export const URGENCY_COLOR: Record<TaskUrgency, string> = {
  overdue: Colors.error,
  urgent: Colors.error,
  action: Colors.warning,
  soon: Colors.warning,
  upcoming: Colors.info,
};

export const tasksApi = {
  list: () => api.request<BrokerTask[]>('/api/broker/tasks'),
};
