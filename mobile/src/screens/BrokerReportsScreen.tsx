import React, { useCallback, useEffect, useState } from 'react';
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useResponsive } from '../hooks/useResponsive';

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
  critical: Colors.error,
  high:     Colors.error,
  medium:   Colors.warning,
  low:      Colors.accent,
  unknown:  Colors.textMuted,
};

const STATUS_COLOR: Record<string, string> = {
  needs_review: Colors.warning,
  approved:     Colors.success,
  blocked:      Colors.error,
  draft:        Colors.textMuted,
  processing:   Colors.info,
};

const FILTER_LABELS: Record<Filter, string> = {
  all:          'All',
  needs_review: 'Pending',
  approved:     'Approved',
  blocked:      'Blocked',
};

function EmptyState({ filter, totalPackets }: { filter: Filter; totalPackets: number }) {
  const isGlobalEmpty = filter === 'all' && totalPackets === 0;
  const filterLabel = FILTER_LABELS[filter]?.toLowerCase() ?? filter;

  const title = isGlobalEmpty
    ? 'No Reports Yet'
    : `No ${filterLabel} reports`;

  const subtitle = isGlobalEmpty
    ? 'Underwriting packets will appear here as incidents are filed and processed.'
    : "Try switching to 'All' to see all packets.";

  return (
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>□</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySub}>{subtitle}</Text>
    </View>
  );
}

export function BrokerReportsScreen({ navigation }: any) {
  const { user } = useAuth();
  const isOperator = user?.role === 'venue_operator';
  const { isTablet } = useResponsive();
  const tabletCap = isTablet
    ? { maxWidth: 720 as const, alignSelf: 'center' as const, width: '100%' as const }
    : null;

  const operatorVenues = React.useMemo(() => {
    if (!isOperator || !user) return null;
    const ids = new Set<string>();
    if (user.tenant_id) ids.add(user.tenant_id);
    (user.extra_venue_ids ?? []).forEach(v => ids.add(v));
    return ids;
  }, [isOperator, user]);

  const [packets, setPackets] = useState<Packet[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchPackets = useCallback(async () => {
    try {
      const data = await api.request<Packet[]>('/api/packets?limit=50');
      const all = Array.isArray(data) ? data : [];
      setPackets(operatorVenues ? all.filter(p => operatorVenues.has(p.venue_id)) : all);
    } catch {
      // keep stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [operatorVenues]);

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
      <View style={styles.centered}>
        <ActivityIndicator color={Colors.accentInk} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* ── Header ── */}
      <View style={styles.header}>
        {/* Title row */}
        <View style={styles.titleRow}>
          <Text style={styles.title}>{isOperator ? 'My Reports' : 'Reports'}</Text>
        </View>

        {/* Stats bar: TOTAL | PENDING | HIGH/CRIT | APPROVED | BLOCKED */}
        <View style={styles.statsRow}>
          <View style={styles.statPill}>
            <Text style={[styles.statNum, { color: Colors.text }]}>{counts.total}</Text>
            <Text style={styles.statLabel}>TOTAL</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statPill}>
            <Text style={[styles.statNum, { color: Colors.warning }]}>{counts.needs_review}</Text>
            <Text style={styles.statLabel}>PENDING</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statPill}>
            <Text style={[styles.statNum, { color: Colors.error }]}>{counts.high_crit}</Text>
            <Text style={styles.statLabel}>HIGH/CRIT</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statPill}>
            <Text style={[styles.statNum, { color: Colors.success }]}>{counts.approved}</Text>
            <Text style={styles.statLabel}>APPROVED</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statPill}>
            <Text style={[styles.statNum, { color: Colors.error }]}>{counts.blocked}</Text>
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
        contentContainerStyle={[styles.list, tabletCap]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.accent}
          />
        }
        renderItem={({ item }) => {
          const severity      = item.risk_signals?.severity ?? 'unknown';
          const severityColor = SEVERITY_COLOR[severity] ?? Colors.textMuted;
          const statusColor   = STATUS_COLOR[item.status] ?? Colors.textMuted;
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
          <EmptyState filter={filter} totalPackets={packets.length} />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: Colors.bg },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.bg,
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
    color: Colors.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
    fontFamily: 'CormorantGaramond_700Bold',
  },
  signOut: {
    color: Colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    fontFamily: 'JetBrainsMono_700Bold',
  },

  // ── Stats bar ────────────────────────────────────────────────────────────
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
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
    fontFamily: 'JetBrainsMono_700Bold',
  },
  statLabel: {
    color: Colors.textMuted,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    backgroundColor: Colors.borderSubtle,
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
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  chipActive: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  chipText: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'DMSans_500Medium',
  },
  chipTextActive: {
    color: Colors.bg,
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
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
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
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.1,
    fontFamily: 'DMSans_600SemiBold',
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
    fontFamily: 'JetBrainsMono_700Bold',
  },

  // Risk type label
  riskType: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'lowercase',
    fontFamily: 'DMSans_500Medium',
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
    fontFamily: 'JetBrainsMono_700Bold',
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
    backgroundColor: Colors.borderSubtle,
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
    fontFamily: 'JetBrainsMono_700Bold',
  },

  // Memo + date
  memo: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'DMSans_400Regular',
  },
  date: {
    color: Colors.border,
    fontSize: 11,
    fontFamily: 'JetBrainsMono_400Regular',
  },

  // Empty state
  empty: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyIcon: {
    color: Colors.border,
    fontSize: 36,
    marginBottom: 4,
  },
  emptyTitle: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
    fontFamily: 'DMSans_700Bold',
  },
  emptySub: {
    color: Colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    fontFamily: 'DMSans_400Regular',
  },
});
