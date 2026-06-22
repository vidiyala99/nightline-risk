import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Colors } from '../theme/colors';
import { fetchAgentRuns, type AgentRun } from '../api/agents';

const POLL_MS = 30_000;
const MAX_ROWS = 8;

/**
 * Agent-oversight feed for the RN dashboard (parity with the web
 * AgentActivityPanel). Self-fetches, polls every 30s, self-hides on
 * empty/error. Scope is enforced by the API.
 */
export function AgentActivityCard() {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchAgentRuns()
        .then((r) => active && setRuns(r.runs))
        .catch(() => active && setError(true));
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  if (error || runs === null || runs.length === 0) return null;
  const rows = runs.slice(0, MAX_ROWS);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>AGENT ACTIVITY</Text>
        <Text style={styles.kpi}>{runs.length} recent runs</Text>
      </View>
      <View>
        {rows.map((r) => {
          const fellBack = r.outcome === 'fallback';
          const color = fellBack ? Colors.warning : Colors.textSecondary;
          return (
            <View key={r.id} style={[styles.row, { borderLeftColor: color }]}>
              <Text style={[styles.rowAgent, { color }]}>{r.agent_name}</Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {(r.entity_type ?? '—')}{r.entity_id ? ` · ${r.entity_id}` : ''} · {r.latency_ms}ms · ${r.cost_usd}
              </Text>
              <Text style={[styles.rowOutcome, { color }]}>
                {fellBack ? `fallback${r.fallback_reason ? ` · ${r.fallback_reason}` : ''}` : (r.outcome ?? r.status)}
                {r.auto_completed ? ' · auto' : ' · escalated'}
              </Text>
            </View>
          );
        })}
      </View>
      {runs.length > MAX_ROWS && <Text style={styles.more}>+{runs.length - MAX_ROWS} more</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle, borderRadius: 16, padding: 20, marginBottom: 12,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 12 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  kpi: { color: Colors.textSecondary, fontSize: 11, letterSpacing: 0.4, fontFamily: 'SpaceMono_400Regular' },
  row: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderSubtle },
  rowAgent: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'SpaceMono_700Bold' },
  rowMeta: { color: Colors.textSecondary, fontSize: 12, marginTop: 3, fontFamily: 'HankenGrotesk_400Regular' },
  rowOutcome: { fontSize: 11, marginTop: 4, fontFamily: 'HankenGrotesk_600SemiBold' },
  more: { color: Colors.textMuted, fontSize: 12, marginTop: 12, fontFamily: 'SpaceMono_400Regular' },
});
