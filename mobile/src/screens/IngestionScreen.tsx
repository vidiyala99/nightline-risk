import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../theme/colors';
import { api } from '../api/client';

// Mobile equivalent of the web /ingestion run-history view
// (frontend/src/app/ingestion/page.tsx): read-only observability over the
// operational-data connectors (POS, ID scanner, staffing, NY State open data)
// that move venue risk scores. Each row is one connector run.
type IngestionStatus = 'running' | 'success' | 'error';

interface IngestionRun {
  id: string;
  source_system: string;
  status: IngestionStatus;
  started_at: string | null;
  finished_at: string | null;
  extracted: number;
  loaded: number;
  skipped: number;
  rejected: number;
  watermark: string | null;
  error: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  nyc_open_data: 'NY State Open Data',
  pos: 'Point of Sale',
  id_scanner: 'ID Scanner',
  staffing: 'Staffing',
};

const STATUS_COLOR: Record<IngestionStatus, string> = {
  success: Colors.success,
  error: Colors.error,
  running: Colors.info,
};

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function IngestionScreen() {
  const insets = useSafeAreaInsets();
  const [runs, setRuns] = useState<IngestionRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns(await api.request<IngestionRun[]>('/api/ingestion/runs?limit=50'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ingestion runs');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.retry} onPress={load}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (!runs) {
    return <View style={styles.center}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={{ paddingTop: 16, paddingBottom: insets.bottom + 24 }}
      data={runs}
      keyExtractor={(r) => r.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); load(); }}
          tintColor={Colors.accentInk}
        />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.eyebrow}>BROKER · DATA</Text>
          <Text style={styles.title}>Ingestion</Text>
          <Text style={styles.sub}>
            Operational-data connector runs — what each feed pulled, loaded, and rejected.
          </Text>
        </View>
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.emptyText}>No ingestion runs yet.</Text>
        </View>
      }
      renderItem={({ item }) => {
        const statusColor = STATUS_COLOR[item.status] ?? Colors.info;
        return (
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.source}>{SOURCE_LABEL[item.source_system] ?? item.source_system}</Text>
              <View style={[styles.statusPill, { borderColor: `${statusColor}66` }]}>
                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                <Text style={[styles.statusText, { color: statusColor }]}>{item.status}</Text>
              </View>
            </View>

            <View style={styles.metricsRow}>
              <Metric label="EXTRACTED" value={item.extracted} />
              <Metric label="LOADED" value={item.loaded} />
              <Metric label="SKIPPED" value={item.skipped} />
              <Metric label="REJECTED" value={item.rejected} danger={item.rejected > 0} />
            </View>

            <Text style={styles.started}>Started {fmtTime(item.started_at)}</Text>
            {!!item.error && <Text style={styles.errorLine}>{item.error}</Text>}
          </View>
        );
      }}
    />
  );
}

function Metric({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <View style={styles.metric}>
      <Text style={[styles.metricValue, danger && { color: Colors.error }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12, backgroundColor: Colors.bg },
  errorText: { color: Colors.error, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular', textAlign: 'center' },
  emptyText: { color: Colors.textMuted, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular' },
  retry: {
    paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
  },
  retryText: { color: Colors.accentInk, fontSize: 14, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },

  header: { paddingHorizontal: 20, marginBottom: 14 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  title: { color: Colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -1, fontFamily: 'BricolageGrotesque_700Bold', marginTop: 4 },
  sub: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 6, fontFamily: 'HankenGrotesk_400Regular' },

  card: {
    marginHorizontal: 16, marginBottom: 12, padding: 16, gap: 12,
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle, borderRadius: 14,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  source: { color: Colors.text, fontSize: 15, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth,
  },
  statusDot: { width: 6, height: 6, borderRadius: 999 },
  statusText: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: 'SpaceMono_700Bold' },

  metricsRow: { flexDirection: 'row', gap: 8 },
  metric: { flex: 1, alignItems: 'center' },
  metricValue: { color: Colors.text, fontSize: 18, fontWeight: '800', fontFamily: 'SpaceMono_700Bold' },
  metricLabel: { color: Colors.textMuted, fontSize: 9, letterSpacing: 1, marginTop: 2, fontFamily: 'SpaceMono_700Bold' },

  started: { color: Colors.textMuted, fontSize: 12, fontFamily: 'SpaceMono_400Regular' },
  errorLine: { color: Colors.error, fontSize: 12, fontFamily: 'HankenGrotesk_400Regular' },
});
