// Operator Copilot — grounded conversational intelligence.
// Mirrors web frontend/src/lib/copilot.ts over the RN api client. The
// file-attachment confirm path (/message/confirm) is deferred for RN v1; the
// plain message + non-attachment confirm path is here.
import { api } from './client';
import type { Citation } from './intelligence';

export type AnswerType = 'answer' | 'clarify' | 'refuse' | 'propose_action';

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
  return api.request<CopilotReply>('/api/copilot/message', {
    method: 'POST',
    body: JSON.stringify(turn),
  });
}
