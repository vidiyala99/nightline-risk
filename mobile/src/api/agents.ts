// Agent-oversight feed — mirrors web frontend/src/lib/agents.ts over the RN api client.
import { api } from './client';

export interface AgentRun {
  id: string;
  agent_name: string;
  agent_kind: string;
  provider: string;
  model: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  outcome: string | null;
  fallback_reason: string | null;
  confidence: string | null;
  cost_usd: string;
  latency_ms: number;
  auto_completed: boolean;
  created_at: string;
}

export interface AgentRunsResponse {
  runs: AgentRun[];
}

export async function fetchAgentRuns(): Promise<AgentRunsResponse> {
  return api.request<AgentRunsResponse>('/api/agents/runs');
}
