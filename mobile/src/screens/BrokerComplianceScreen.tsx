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
import { useResponsive } from '../hooks/useResponsive';

const SEVERITY_COLOR: Record<string, string> = {
  urgent: Colors.error,
  high: Colors.error,
  medium: Colors.warning,
  low: Colors.textMuted,
};

interface PortfolioVenue {
  id: string;
  name?: string;
  venue_id?: string;
  venue_type?: string;
  address?: string;
  compliance_actions?: number;
}

interface ComplianceItem {
  id?: string;
  title?: string;
  description?: string;
  severity?: string;
  priority?: string;
  action?: string;
}

export function BrokerComplianceScreen({ navigation, route }: any) {
  const filterVenueId: string | undefined = route?.params?.venueId;
  const { isTablet } = useResponsive();
  const tabletCap = isTablet
    ? { maxWidth: 720 as const, alignSelf: 'center' as const, width: '100%' as const }
    : null;

  // Portfolio mode (no filter): list of venues with pending counts.
  const [venues, setVenues] = useState<PortfolioVenue[]>([]);
  // Scoped mode (filter set): the actual queue items for that venue.
  const [items, setItems] = useState<ComplianceItem[]>([]);
  const [scopedVenueName, setScopedVenueName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      if (filterVenueId) {
        // Scoped: fetch live state for the actual compliance items.
        const [live, venue] = await Promise.all([
          api.request<any>(`/api/venues/${filterVenueId}/live`).catch(() => ({})),
          api.request<{ name?: string }>(`/api/venues/${filterVenueId}`).catch(() => null),
        ]);
        setItems(Array.isArray(live?.compliance_queue) ? live.compliance_queue : []);
        setScopedVenueName(venue?.name ?? null);
      } else {
        // Portfolio: list venues with pending compliance counts.
        const portfolio = await api.request<PortfolioVenue[]>('/api/portfolio');
        setVenues(portfolio.filter(v => (v.compliance_actions ?? 0) > 0));
      }
    } catch {
      // keep stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filterVenueId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  const subtitle = filterVenueId
    ? scopedVenueName ?? 'Pending actions for venue'
    : 'Pending actions across portfolio';

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Compliance</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
        {filterVenueId && (
          <Pressable onPress={() => navigation.goBack()} style={styles.backLink}>
            <Text style={styles.backLinkText}>← Back to portfolio</Text>
          </Pressable>
        )}
      </View>

      {filterVenueId ? (
        <FlatList
          data={items}
          keyExtractor={(item, idx) => item.id ?? `idx-${idx}`}
          contentContainerStyle={[styles.list, tabletCap]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); fetchData(); }}
              tintColor={Colors.accent}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>✓</Text>
              <Text style={styles.emptyTitle}>All Clear</Text>
              <Text style={styles.emptySub}>
                No pending compliance actions for {scopedVenueName ?? 'this venue'}.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const sev = (item.severity ?? item.priority ?? 'low').toLowerCase();
            const sevColor = SEVERITY_COLOR[sev] ?? Colors.textMuted;
            const label = item.title ?? item.description ?? item.action ?? item.id ?? '';
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.itemRow,
                  { borderLeftColor: sevColor },
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() =>
                  navigation.navigate('ComplianceDetail', {
                    venueId: filterVenueId,
                    venueName: scopedVenueName ?? undefined,
                    itemId: item.id,
                  })
                }
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.itemTitle}>{label}</Text>
                  {!!item.description && item.description !== label && (
                    <Text style={styles.itemDesc} numberOfLines={2}>{item.description}</Text>
                  )}
                </View>
                <Text style={[styles.itemSev, { color: sevColor }]}>{sev.toUpperCase()}</Text>
              </Pressable>
            );
          }}
        />
      ) : (
        <FlatList
          data={venues}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, tabletCap]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); fetchData(); }}
              tintColor={Colors.accent}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>✓</Text>
              <Text style={styles.emptyTitle}>All Clear</Text>
              <Text style={styles.emptySub}>No pending compliance actions across portfolio.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.venueCard, pressed && { opacity: 0.75 }]}
              onPress={() => navigation.push('ComplianceList', { venueId: item.id })}
            >
              <View style={styles.venueCardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.venueName}>{item.name ?? item.venue_id ?? item.id}</Text>
                  {!!item.venue_type && (
                    <Text style={styles.venueType}>
                      {item.venue_type.replace(/_/g, ' ').toUpperCase()}
                    </Text>
                  )}
                </View>
                <View style={styles.countBadge}>
                  <Text style={styles.countNum}>{item.compliance_actions ?? 0}</Text>
                  <Text style={styles.countLabel}>PENDING</Text>
                </View>
              </View>
              {!!item.address && (
                <Text style={styles.address} numberOfLines={1}>{item.address}</Text>
              )}
              <Text style={styles.tapHint}>Tap to view items →</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },

  header: { paddingHorizontal: 20, paddingBottom: 16, gap: 6 },
  title: { color: Colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'CormorantGaramond_700Bold' },
  subtitle: { color: Colors.textMuted, fontSize: 13, fontFamily: 'DMSans_400Regular' },
  backLink: { paddingTop: 4 },
  backLinkText: { color: Colors.textSecondary, fontSize: 12, fontFamily: 'DMSans_500Medium' },

  list: { paddingHorizontal: 20, paddingBottom: 48, gap: 10, flexGrow: 1 },

  // Portfolio mode — venue cards
  venueCard: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  venueCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  venueName: { color: Colors.text, fontSize: 16, fontWeight: '700', fontFamily: 'DMSans_600SemiBold' },
  venueType: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginTop: 2, fontFamily: 'JetBrainsMono_700Bold' },
  address: { color: Colors.textMuted, fontSize: 12, fontFamily: 'DMSans_400Regular' },
  tapHint: { color: Colors.accentInk, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'JetBrainsMono_700Bold' },
  countBadge: { alignItems: 'center', backgroundColor: 'rgba(255,149,0,0.1)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  countNum: { color: Colors.warning, fontSize: 22, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'JetBrainsMono_700Bold' },
  countLabel: { color: Colors.warning, fontSize: 8, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },

  // Scoped mode — item rows
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderLeftWidth: 3,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  itemTitle: { color: Colors.text, fontSize: 14, fontWeight: '600', fontFamily: 'DMSans_600SemiBold' },
  itemDesc: { color: Colors.textSecondary, fontSize: 12, lineHeight: 16, fontFamily: 'DMSans_400Regular' },
  itemSev: { fontSize: 9, fontWeight: '700', letterSpacing: 1, fontFamily: 'JetBrainsMono_700Bold' },

  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 100, gap: 10 },
  emptyIcon: { fontSize: 48, color: Colors.accentInk },
  emptyTitle: { color: Colors.text, fontSize: 20, fontWeight: '700', fontFamily: 'DMSans_700Bold' },
  emptySub: { color: Colors.textMuted, fontSize: 14, textAlign: 'center', paddingHorizontal: 40, fontFamily: 'DMSans_400Regular' },
});
