/**
 * Open-questions answer/resolve loop — operator answers an AI memo's open
 * question; broker marks it resolved. Responses ride back on the packet payload
 * (packet.open_question_responses), so both personas read the same state.
 * Mirrors web frontend/src/lib/openQuestions.ts.
 */
import { api } from './client';

export interface OpenQuestionResponse {
  id: string;
  packet_id: string;
  question_index: number;
  question_text: string;
  answer: string;
  answered_by: string | null;
  answered_at: string | null;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
}

export const openQuestionsApi = {
  answer: (packetId: string, index: number, body: { question_text: string; answer: string }) =>
    api.request<OpenQuestionResponse>(
      `/api/packets/${packetId}/open-questions/${index}/answer`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  resolve: (packetId: string, index: number, body: { resolved?: boolean; question_text?: string } = {}) =>
    api.request<OpenQuestionResponse>(
      `/api/packets/${packetId}/open-questions/${index}/resolve`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
};

/** Index responses by question_index for quick lookup against memo.open_questions. */
export function byIndex(responses: OpenQuestionResponse[] | undefined): Map<number, OpenQuestionResponse> {
  const m = new Map<number, OpenQuestionResponse>();
  (responses ?? []).forEach((r) => m.set(r.question_index, r));
  return m;
}
