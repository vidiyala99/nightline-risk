import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { Colors } from '../theme/colors';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { HandAccent } from '../components/HandAccent';

const STATUS_ACCENT: Record<string, string> = {
  open: Colors.warning,
  under_review: Colors.info,
  closed: Colors.success,
};

// Floor-staff "My Reports" — the incidents this staff member filed. Server
// scopes via /api/incidents/mine (reported_by_staff_id). Read-only.
export function MyReportsScreen() {
  const [incidents, setIncidents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.request<any[]>('/api/incidents/mine');
      setIncidents(Array.isArray(data) ? data : []);
    } catch {
      // keep stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Refresh on focus so a just-filed report appears when returning here.
  useFocusEffect(useCallback(() => { load(); }, [load]));

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
        <Text style={styles.title}>My Reports</Text>
        <HandAccent>what you've reported</HandAccent>
      </View>

      <FlatList
        data={incidents}
        keyExtractor={(i) => i.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor={Colors.accent}
          />
        }
        renderItem={({ item }) => (
          <View style={[styles.card, { borderLeftColor: STATUS_ACCENT[item.status] ?? Colors.border }]}>
            <View style={styles.cardHeader}>
              <Text style={styles.location}>{item.location}</Text>
              <Text style={styles.date}>
                {new Date(item.occurred_at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })}
              </Text>
            </View>
            <Text style={styles.summary} numberOfLines={2}>{item.summary}</Text>
            <View style={styles.cardFooter}>
              <StatusBadge status={item.status} />
            </View>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No reports yet</Text>
            <Text style={styles.emptySub}>When you file an incident, it shows up here.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },
  header: { paddingHorizontal: 20, paddingBottom: 16, gap: 6, paddingTop: 8 },
  title: { color: Colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'BricolageGrotesque_700Bold' },
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
  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyTitle: { color: Colors.text, fontSize: 18, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  emptySub: { color: Colors.textMuted, fontSize: 14, textAlign: 'center', fontFamily: 'HankenGrotesk_400Regular' },
});
