import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

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
  const res = await fetch(`${API_URL}/api/agents/runs`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`agents/runs ${res.status}`);
  return res.json();
}
