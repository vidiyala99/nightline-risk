/**
 * Mobile typed client for venue liability alerts.
 *
 * MIRROR OF the alert fetch/feedback calls in frontend/src/app/alerts/page.tsx.
 * Alerts are venue-scoped real-time anomaly detections the operator confirms
 * or dismisses. Routed through `api.request`.
 */
import { api } from './client';
import { Colors } from '../theme/colors';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type AlertFeedback = 'confirmed' | 'false_alarm';

export interface Alert {
  id: string;
  venue_id: string;
  zone: string;
  event_type: string;
  severity: Severity;
  confidence: number;
  description: string;
  detected_at: string;
  feedback?: AlertFeedback | null;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: Colors.error,
  high: Colors.warning,
  medium: Colors.tierB,
  low: Colors.textMuted,
};

export const alertsApi = {
  listForVenue: (venueId: string) =>
    api.request<Alert[]>(`/api/venues/${venueId}/alerts`),

  sendFeedback: (alertId: string, feedback: AlertFeedback) =>
    api.request<unknown>(`/api/alerts/${alertId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ feedback }),
    }),
};
