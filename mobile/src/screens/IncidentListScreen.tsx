import React, { useCallback, useEffect, useState } from 'react';
import { HandAccent } from "../components/HandAccent";
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
import * as Haptics from 'expo-haptics';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';

type Filter = 'all' | 'open' | 'under_review' | 'closed';

const STATUS_ACCENT: Record<string, string> = {
  open: Colors.warning,
  under_review: Colors.info,
  closed: Colors.success,
};

export function IncidentListScreen({ navigation, route }: any) {
  const { user } = useAuth();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';
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
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={styles.title}>Incidents</Text>
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{filtered.length}</Text>
            </View>
          </View>
          {!isBroker && (
            <Pressable
              onPress={() => navigation.navigate('ReportIncident')}
              style={styles.addBtn}
            >
              <Text style={styles.addBtnText}>+</Text>
            </Pressable>
          )}
        </View>
        <HandAccent>tonight's floor</HandAccent>
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
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchIncidents(); }} tintColor={Colors.accent} />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => navigation.navigate('IncidentDetail', { incidentId: item.id })}
            style={({ pressed }) => [styles.card, { borderLeftColor: STATUS_ACCENT[item.status] ?? Colors.border }, pressed && { opacity: 0.75 }]}
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
  root: { flex: 1, backgroundColor: Colors.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },

  header: { paddingHorizontal: 20, paddingBottom: 16, gap: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  signOut: { color: Colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, paddingVertical: 4, paddingLeft: 12, fontFamily: 'SpaceMono_700Bold' },
  addBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center' },
  addBtnText: { color: Colors.text, fontSize: 20, fontWeight: '800', lineHeight: 24 },
  title: { color: Colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'BricolageGrotesque_700Bold' },
  countBadge: {
    backgroundColor: 'rgba(200,240,0,0.12)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  countText: { color: Colors.accentInk, fontSize: 12, fontWeight: '700', fontFamily: 'SpaceMono_700Bold' },

  filters: { flexDirection: 'row', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  chipText: { color: Colors.textMuted, fontSize: 12, fontWeight: '600', fontFamily: 'SpaceMono_400Regular' },
  chipTextActive: { color: Colors.text, fontFamily: 'SpaceMono_400Regular' },

  list: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderLeftWidth: 3,
    padding: 16,
    gap: 8,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  location: { color: Colors.text, fontSize: 15, fontWeight: '700', flex: 1, fontFamily: 'HankenGrotesk_600SemiBold' },
  date: { color: Colors.textMuted, fontSize: 11, fontWeight: '600', letterSpacing: 0.3, fontFamily: 'SpaceMono_400Regular' },
  summary: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19, fontFamily: 'HankenGrotesk_400Regular' },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  flag: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: 'rgba(255,69,87,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,69,87,0.3)',
  },
  flagText: { color: Colors.error, fontSize: 9, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },

  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyTitle: { color: Colors.text, fontSize: 18, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  emptySub: { color: Colors.textMuted, fontSize: 14, textAlign: 'center', fontFamily: 'HankenGrotesk_400Regular' },
});
