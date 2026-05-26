import React, { useEffect, useMemo, useState } from 'react';
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';
import {
  STATE_LABEL,
  STATE_COLOR,
  type ClaimProposal,
  type ClaimState,
} from '../types/claims';

type Filter = 'all' | ClaimState;

export function ClaimsListScreen({ navigation }: any) {
  const { user } = useAuth();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';

  const [proposals, setProposals] = useState<ClaimProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    async function load() {
      try {
        const all = await api.request<ClaimProposal[]>('/api/claim-proposals');
        const scope = isBroker ? all : all.filter(p => {
          const ids = new Set([user?.tenant_id, ...(user?.extra_venue_ids ?? [])].filter(Boolean));
          return ids.has(p.venue_id);
        });
        setProposals(scope);
      } catch {
        // non-fatal
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [isBroker, user]);

  const visible = useMemo(() => {
    const list = filter === 'all' ? proposals : proposals.filter(p => p.state === filter);
    return [...list].sort((a, b) => new Date(b.proposed_at).getTime() - new Date(a.proposed_at).getTime());
  }, [proposals, filter]);

  const pendingCount = proposals.filter(p => p.state === 'pending_broker_review').length;
  const overrideCount = proposals.filter(p => p.override_recommendation).length;
  const pageTitle = isBroker ? 'Claims Portfolio' : 'My Claims';
  const subtitle = isBroker
    ? `${proposals.length} proposals · ${pendingCount} pending · ${overrideCount} overrides`
    : `${proposals.length} proposals · ${pendingCount} awaiting review`;

  const FILTERS: Filter[] = ['all', 'pending_broker_review', 'approved', 'rejected_by_broker', 'filed_with_carrier'];

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.title}>{pageTitle}</Text>
        <Text style={s.subtitle}>{subtitle}</Text>
      </View>

      {/* Filter chips */}
      <FlatList
        horizontal
        data={FILTERS}
        keyExtractor={f => f}
        showsHorizontalScrollIndicator={false}
        style={s.filterList}
        contentContainerStyle={s.filterRow}
        renderItem={({ item: f }) => (
          <Pressable
            style={[s.chip, filter === f && s.chipActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[s.chipText, filter === f && s.chipTextActive]}>
              {f === 'all' ? 'All' : f === 'pending_broker_review' ? 'Pending' : STATE_LABEL[f as ClaimState]}
            </Text>
          </Pressable>
        )}
      />

      {loading ? (
        <View style={s.centered}><ActivityIndicator color={Colors.accentInk} /></View>
      ) : visible.length === 0 ? (
        <View style={s.centered}>
          <Text style={s.emptyIcon}>📋</Text>
          <Text style={s.emptyText}>
            {proposals.length === 0
              ? isBroker
                ? 'No claim proposals yet.'
                : "You haven't proposed any claims yet."
              : 'No proposals match this filter.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={p => p.id}
          contentContainerStyle={s.list}
          renderItem={({ item: p }) => {
            const col = STATE_COLOR[p.state] ?? Colors.textMuted;
            return (
              <Pressable
                style={[s.row, p.override_recommendation && s.rowOverride]}
                onPress={() => navigation.navigate('ClaimDetail', { packetId: p.packet_id })}
              >
                <View style={s.rowLeft}>
                  <Text style={s.venueName}>{p.venue_id.replace(/-/g, ' ')}</Text>
                  <Text style={s.date}>{new Date(p.proposed_at).toLocaleDateString()}</Text>
                  {p.override_recommendation && p.override_reason && (
                    <Text style={s.overrideTag}>
                      ⚠ OVERRIDE · {p.override_reason.replace(/_/g, ' ')}
                    </Text>
                  )}
                </View>
                <View style={s.rowRight}>
                  <View style={[s.stateBadge, { borderColor: col }]}>
                    <Text style={[s.stateText, { color: col }]}>
                      {STATE_LABEL[p.state]}
                    </Text>
                  </View>
                  <Text style={s.arrow}>›</Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  header: { paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16 },
  title: { color: Colors.text, fontSize: 26, fontFamily: 'CormorantGaramond_700Bold', letterSpacing: -0.5 },
  subtitle: { color: Colors.textMuted, fontSize: 12, fontFamily: 'JetBrainsMono_400Regular', marginTop: 4 },
  filterList: { flexGrow: 0, flexShrink: 0, alignSelf: 'stretch' },
  filterRow: { paddingHorizontal: 20, paddingBottom: 12, gap: 8, alignItems: 'center' },
  chip: {
    alignSelf: 'center',
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 100,
    borderWidth: 1, borderColor: Colors.borderSubtle,
  },
  chipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(200,240,0,0.08)' },
  chipText: { color: Colors.textMuted, fontSize: 12, fontFamily: 'DMSans_600SemiBold' },
  chipTextActive: { color: Colors.accentInk },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  emptyIcon: { fontSize: 36 },
  emptyText: { color: Colors.textMuted, fontSize: 14, fontFamily: 'DMSans_400Regular', textAlign: 'center', paddingHorizontal: 40 },
  list: { paddingHorizontal: 20, paddingBottom: 40 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(23,21,15,0.06)',
    gap: 12,
  },
  rowOverride: { backgroundColor: 'rgba(255,149,0,0.04)' },
  rowLeft: { flex: 1, gap: 3 },
  venueName: { color: Colors.text, fontSize: 14, fontFamily: 'DMSans_600SemiBold', textTransform: 'capitalize' },
  date: { color: Colors.textMuted, fontSize: 11, fontFamily: 'JetBrainsMono_400Regular' },
  overrideTag: { color: Colors.warning, fontSize: 10, fontFamily: 'JetBrainsMono_700Bold', letterSpacing: 0.5 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stateBadge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  stateText: { fontSize: 9, fontFamily: 'JetBrainsMono_700Bold', letterSpacing: 1, textTransform: 'uppercase' },
  arrow: { color: Colors.textMuted, fontSize: 20 },
});
