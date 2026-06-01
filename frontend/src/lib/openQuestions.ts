/**
 * Open-questions answer/resolve loop. Operator answers an AI memo's open
 * question; broker marks it resolved. Responses ride back on the packet payload
 * (packet.open_question_responses). Mirrors mobile src/api/openQuestions.ts.
 *
 * NOTE: web fetch must attach authHeaders() + Content-Type manually — there's no
 * shared wrapper, and a missing auth header 401s silently.
 */
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

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

export async function answerOpenQuestion(
  packetId: string,
  index: number,
  body: { question_text: string; answer: string },
): Promise<OpenQuestionResponse> {
  const res = await fetch(`${API_URL}/api/packets/${packetId}/open-questions/${index}/answer`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Couldn't save your answer.");
  return res.json();
}

export async function resolveOpenQuestion(
  packetId: string,
  index: number,
  body: { resolved?: boolean; question_text?: string } = {},
): Promise<OpenQuestionResponse> {
  const res = await fetch(`${API_URL}/api/packets/${packetId}/open-questions/${index}/resolve`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Couldn't resolve this question.");
  return res.json();
}

/** Index responses by question_index for lookup against memo.open_questions. */
export function byIndex(responses: OpenQuestionResponse[] | undefined): Map<number, OpenQuestionResponse> {
  const m = new Map<number, OpenQuestionResponse>();
  (responses ?? []).forEach((r) => m.set(r.question_index, r));
  return m;
}
