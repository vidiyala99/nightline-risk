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
import { useAuth } from '../contexts/AuthContext';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';

type Filter = 'all' | 'open' | 'under_review' | 'closed';

const STATUS_ACCENT: Record<string, string> = {
  open: '#ff9500',
  under_review: '#5b8af5',
  closed: '#00d97e',
};

export function IncidentListScreen({ navigation, route }: any) {
  const { user, signOut } = useAuth();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';
  const insets = useSafeAreaInsets();
  const [incidents, setIncidents] = useState<any[]>([]);
  const initialFilter: Filter = (route?.params?.initialFilter as Filter) ?? 'all';
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Operator dashboard can override the listing venue via params (chip-row
  // selection). Brokers always see the global list. Falls back to tenant_id.
  const venueOverride: string | undefined = route?.params?.venueId;
  const effectiveVenueId = !isBroker ? (venueOverride ?? user?.tenant_id) : undefined;

  const fetchIncidents = useCallback(async () => {
    try {
      const endpoint = effectiveVenueId
        ? `/api/venues/${effectiveVenueId}/incidents`
        : '/api/incidents';
      const data = await api.request<any[]>(endpoint);
      setIncidents(data);
    } catch {
      // keep stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [effectiveVenueId]);

  useEffect(() => { fetchIncidents(); }, [fetchIncidents]);

  const filtered = filter === 'all' ? incidents : incidents.filter(i => i.status === filter);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#c8f000" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.titleRow}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={styles.title}>Incidents</Text>
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{filtered.length}</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {!isBroker && (
              <Pressable
                onPress={() => navigation.navigate('ReportIncident')}
                style={styles.addBtn}
              >
                <Text style={styles.addBtnText}>+</Text>
              </Pressable>
            )}
            <Text style={styles.signOut} onPress={signOut}>SIGN OUT</Text>
          </View>
        </View>
        <View style={styles.filters}>
          {(['all', 'open', 'under_review', 'closed'] as Filter[]).map(f => {
            const count = f === 'all' ? incidents.length : incidents.filter(i => i.status === f).length;
            const label = f === 'under_review' ? 'Review' : f.charAt(0).toUpperCase() + f.slice(1);
            return (
              <Pressable
                key={f}
                style={[styles.chip, filter === f && styles.chipActive]}
                onPress={() => setFilter(f)}
              >
                <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>
                  {label} {count}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchIncidents(); }} tintColor="#c8f000" />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => navigation.navigate('IncidentDetail', { incidentId: item.id })}
            style={({ pressed }) => [styles.card, { borderLeftColor: STATUS_ACCENT[item.status] ?? '#2e3247' }, pressed && { opacity: 0.75 }]}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.location}>{item.location}</Text>
              <Text style={styles.date}>
                {new Date(item.occurred_at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })}
              </Text>
            </View>
            <Text style={styles.summary} numberOfLines={2}>{item.summary}</Text>
            <View style={styles.cardFooter}>
              <StatusBadge status={item.status} />
              {item.injury_observed && (
                <View style={styles.flag}>
                  <Text style={styles.flagText}>INJURY</Text>
                </View>
              )}
              {item.police_called && (
                <View style={styles.flag}>
                  <Text style={styles.flagText}>POLICE</Text>
                </View>
              )}
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No incidents</Text>
            <Text style={styles.emptySub}>
              {filter === 'all' ? 'Clean sheet — keep it that way.' : `No ${filter.replace('_', ' ')} incidents.`}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07080f' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#07080f' },

  header: { paddingHorizontal: 20, paddingBottom: 16, gap: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  signOut: { color: '#8b90a8', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, paddingVertical: 4, paddingLeft: 12, fontFamily: 'JetBrainsMono_700Bold' },
  addBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#c8f000', alignItems: 'center', justifyContent: 'center' },
  addBtnText: { color: '#07080f', fontSize: 20, fontWeight: '800', lineHeight: 24 },
  title: { color: '#eeeef5', fontSize: 28, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'CormorantGaramond_700Bold' },
  countBadge: {
    backgroundColor: 'rgba(200,240,0,0.12)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  countText: { color: '#c8f000', fontSize: 12, fontWeight: '700', fontFamily: 'JetBrainsMono_700Bold' },

  filters: { flexDirection: 'row', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: '#0d0f1c',
  },
  chipActive: { backgroundColor: '#c8f000', borderColor: '#c8f000' },
  chipText: { color: '#4a4f65', fontSize: 12, fontWeight: '600', fontFamily: 'JetBrainsMono_400Regular' },
  chipTextActive: { color: '#07080f', fontFamily: 'JetBrainsMono_400Regular' },

  list: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  card: {
    backgroundColor: '#0d0f1c',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)',
    borderLeftWidth: 3,
    padding: 16,
    gap: 8,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  location: { color: '#eeeef5', fontSize: 15, fontWeight: '700', flex: 1, fontFamily: 'DMSans_600SemiBold' },
  date: { color: '#4a4f65', fontSize: 11, fontWeight: '600', letterSpacing: 0.3, fontFamily: 'JetBrainsMono_400Regular' },
  summary: { color: '#8b90a8', fontSize: 13, lineHeight: 19, fontFamily: 'DMSans_400Regular' },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  flag: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: 'rgba(255,69,87,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,69,87,0.3)',
  },
  flagText: { color: '#ff4557', fontSize: 9, fontWeight: '700', letterSpacing: 1, fontFamily: 'JetBrainsMono_700Bold' },

  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyTitle: { color: '#eeeef5', fontSize: 18, fontWeight: '700', fontFamily: 'DMSans_700Bold' },
  emptySub: { color: '#4a4f65', fontSize: 14, textAlign: 'center', fontFamily: 'DMSans_400Regular' },
});
