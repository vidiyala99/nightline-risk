import { authHeaders } from "@/lib/authFetch";
import type { Citation } from "@/lib/intelligence";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export type AnswerType = "answer" | "clarify" | "refuse" | "propose_action";

export interface ProposedAction {
  kind: string;
  target_id: string;
  summary: string;
  gating_passed: boolean;
  requires_attachment?: boolean;
}

export interface ReplyLink {
  label: string;
  href: string;
}

export interface CopilotReply {
  answer_type: AnswerType;
  text: string;
  citations: Citation[];
  proposed_action?: ProposedAction | null;
  followups: string[];
  link?: ReplyLink | null;
}

export interface CopilotTurn {
  message: string;
  confirm_action?: ProposedAction;
}

export async function sendCopilotMessage(turn: CopilotTurn): Promise<CopilotReply> {
  const res = await fetch(`${API_URL}/api/copilot/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(turn),
  });
  if (!res.ok) throw new Error(`copilot failed: ${res.status}`);
  return (await res.json()) as CopilotReply;
}

export async function confirmCompliance(action: ProposedAction, file: File): Promise<CopilotReply> {
  const fd = new FormData();
  fd.append("confirm_action", JSON.stringify(action));
  fd.append("file", file);
  const res = await fetch(`${API_URL}/api/copilot/message/confirm`, {
    method: "POST",
    headers: authHeaders(),
    body: fd,
  });
  if (!res.ok) throw new Error(`copilot confirm failed: ${res.status}`);
  return (await res.json()) as CopilotReply;
}
