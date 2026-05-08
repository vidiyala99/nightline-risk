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
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

type Filter = 'all' | 'needs_review' | 'approved' | 'blocked';

interface RiskSignals {
  severity?: string;
  confidence?: number;
  explanation?: string;
  type?: string;
}

interface Packet {
  id: string;
  venue_id: string;
  status: string;
  risk_signals?: RiskSignals;
  memo?: { summary?: string };
  generated_at?: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ff4557',
  high:     '#ff4557',
  medium:   '#ff9500',
  low:      '#c8f000',
  unknown:  '#4a4f65',
};

const STATUS_COLOR: Record<string, string> = {
  needs_review: '#ff9500',
  approved:     '#00d97e',
  blocked:      '#ff4557',
  draft:        '#4a4f65',
  processing:   '#5b8af5',
};

const FILTER_LABELS: Record<Filter, string> = {
  all:          'All',
  needs_review: 'Pending',
  approved:     'Approved',
  blocked:      'Blocked',
};

export function BrokerReportsScreen({ navigation }: any) {
  const { signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const [packets, setPackets] = useState<Packet[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchPackets = useCallback(async () => {
    try {
      const data = await api.request<Packet[]>('/api/packets?limit=50');
      setPackets(Array.isArray(data) ? data : []);
    } catch {
      // keep stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchPackets();
  }, [fetchPackets]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchPackets();
  }, [fetchPackets]);

  const filtered = filter === 'all' ? packets : packets.filter(p => p.status === filter);

  const counts = {
    total:       packets.length,
    needs_review: packets.filter(p => p.status === 'needs_review').length,
    high_crit:   packets.filter(p => p.risk_signals?.severity === 'high' || p.risk_signals?.severity === 'critical').length,
    approved:    packets.filter(p => p.status === 'approved').length,
    blocked:     packets.filter(p => p.status === 'blocked').length,
  };

  if (loading) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color="#c8f000" size="large" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        {/* Title row */}
        <View style={styles.titleRow}>
          <Text style={styles.title}>Reports</Text>
          <Pressable onPress={signOut} hitSlop={10}>
            <Text style={styles.signOut}>SIGN OUT</Text>
          </Pressable>
        </View>

        {/* Stats bar: TOTAL | PENDING | HIGH/CRIT | APPROVED | BLOCKED */}
        <View style={styles.statsRow}>
          <View style={styles.statPill}>
            <Text style={[styles.statNum, { color: '#eeeef5' }]}>{counts.total}</Text>
            <Text style={styles.statLabel}>TOTAL</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statPill}>
            <Text style={[styles.statNum, { color: '#ff9500' }]}>{counts.needs_review}</Text>
            <Text style={styles.statLabel}>PENDING</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statPill}>
            <Text style={[styles.statNum, { color: '#ff4557' }]}>{counts.high_crit}</Text>
            <Text style={styles.statLabel}>HIGH/CRIT</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statPill}>
            <Text style={[styles.statNum, { color: '#00d97e' }]}>{counts.approved}</Text>
            <Text style={styles.statLabel}>APPROVED</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statPill}>
            <Text style={[styles.statNum, { color: '#ff4557' }]}>{counts.blocked}</Text>
            <Text style={styles.statLabel}>BLOCKED</Text>
          </View>
        </View>

        {/* Filter chips */}
        <View style={styles.filters}>
          {(['all', 'needs_review', 'approved', 'blocked'] as Filter[]).map(f => (
            <Pressable
              key={f}
              style={[styles.chip, filter === f && styles.chipActive]}
              onPress={() => setFilter(f)}
            >
              <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>
                {FILTER_LABELS[f]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* ── List ── */}
      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#c8f000"
          />
        }
        renderItem={({ item }) => {
          const severity      = item.risk_signals?.severity ?? 'unknown';
          const severityColor = SEVERITY_COLOR[severity] ?? '#4a4f65';
          const statusColor   = STATUS_COLOR[item.status] ?? '#4a4f65';
          const confidence    = item.risk_signals?.confidence ?? 0;
          const confidencePct = Math.round(confidence * 100);
          const riskType      = item.risk_signals?.type ?? '';
          const statusLabel   = item.status === 'needs_review'
            ? 'NEEDS REVIEW'
            : (item.status ?? '').toUpperCase().replace('_', ' ');
          const dateStr = item.generated_at
            ? new Date(item.generated_at).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: '2-digit',
              })
            : '';

          return (
            <Pressable
              style={({ pressed }) => [styles.card, { borderLeftColor: severityColor }, pressed && { opacity: 0.75 }]}
              onPress={() => navigation.navigate('ReportDetail', { packetId: item.id })}
            >
              {/* Row 1: venue_id (bold) + status badge */}
              <View style={styles.cardTopRow}>
                <Text style={styles.venueId} numberOfLines={1}>
                  {item.venue_id}
                </Text>
                <View
                  style={[
                    styles.statusBadge,
                    {
                      borderColor: `${statusColor}55`,
                      backgroundColor: `${statusColor}15`,
                    },
                  ]}
                >
                  <Text style={[styles.statusText, { color: statusColor }]}>
                    {statusLabel}
                  </Text>
                </View>
              </View>

              {/* Row 2: risk signal type label */}
              {riskType ? (
                <Text style={styles.riskType}>
                  {riskType.replace(/_/g, ' ')}
                </Text>
              ) : null}

              {/* Row 3: severity pill + confidence bar + pct */}
              <View style={styles.signalRow}>
                <View
                  style={[
                    styles.severityPill,
                    { backgroundColor: `${severityColor}18` },
                  ]}
                >
                  <Text style={[styles.severityText, { color: severityColor }]}>
                    {severity.toUpperCase()}
                  </Text>
                </View>
                <View style={styles.confidenceWrap}>
                  <View style={styles.confidenceTrack}>
                    <View
                      style={[
                        styles.confidenceFill,
                        {
                          width: `${confidencePct}%` as any,
                          backgroundColor: severityColor,
                        },
                      ]}
                    />
                  </View>
                  <Text style={[styles.confidenceNum, { color: severityColor }]}>
                    {confidencePct}%
                  </Text>
                </View>
              </View>

              {/* Row 4: memo summary (2 lines max) */}
              {item.memo?.summary ? (
                <Text style={styles.memo} numberOfLines={2}>
                  {item.memo.summary}
                </Text>
              ) : item.risk_signals?.explanation ? (
                <Text style={styles.memo} numberOfLines={2}>
                  {item.risk_signals.explanation}
                </Text>
              ) : null}

              {/* Row 5: generated date */}
              {dateStr ? (
                <Text style={styles.date}>{dateStr}</Text>
              ) : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No packets</Text>
            <Text style={styles.emptySub}>
              {filter === 'all'
                ? 'No underwriting packets yet.'
                : `No ${FILTER_LABELS[filter].toLowerCase()} packets.`}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#07080f' },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#07080f',
  },

  // ── Header ──────────────────────────────────────────────────────────────
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    gap: 14,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: '#eeeef5',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  signOut: {
    color: '#8b90a8',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
  },

  // ── Stats bar ────────────────────────────────────────────────────────────
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0d0f1c',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)',
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  statPill: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  statNum: {
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  statLabel: {
    color: '#4a4f65',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },

  // ── Filter chips ─────────────────────────────────────────────────────────
  filters: {
    flexDirection: 'row',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: '#0d0f1c',
  },
  chipActive: {
    backgroundColor: '#c8f000',
    borderColor: '#c8f000',
  },
  chipText: {
    color: '#4a4f65',
    fontSize: 12,
    fontWeight: '600',
  },
  chipTextActive: {
    color: '#07080f',
  },

  // ── List ─────────────────────────────────────────────────────────────────
  list: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 40,
    gap: 10,
  },

  // ── Card ─────────────────────────────────────────────────────────────────
  card: {
    backgroundColor: '#0d0f1c',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)',
    borderLeftWidth: 3,
    padding: 16,
    gap: 9,
  },

  // Top row: venue_id + status badge
  cardTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  venueId: {
    flex: 1,
    color: '#eeeef5',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  statusBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexShrink: 0,
  },
  statusText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
  },

  // Risk type label
  riskType: {
    color: '#4a4f65',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'lowercase',
  },

  // Severity + confidence row
  signalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  severityPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  severityText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
  },
  confidenceWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  confidenceTrack: {
    flex: 1,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  confidenceFill: {
    height: '100%',
    borderRadius: 2,
  },
  confidenceNum: {
    fontSize: 11,
    fontWeight: '700',
    width: 32,
    textAlign: 'right',
  },

  // Memo + date
  memo: {
    color: '#8b90a8',
    fontSize: 13,
    lineHeight: 18,
  },
  date: {
    color: '#2e3247',
    fontSize: 11,
  },

  // Empty state
  empty: {
    alignItems: 'center',
    paddingTop: 80,
    gap: 8,
  },
  emptyTitle: {
    color: '#eeeef5',
    fontSize: 18,
    fontWeight: '700',
  },
  emptySub: {
    color: '#4a4f65',
    fontSize: 14,
    textAlign: 'center',
  },
});
