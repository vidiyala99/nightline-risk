import React, { useCallback, useEffect, useState } from 'react';
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';
import { useResponsive } from '../hooks/useResponsive';
import { StatCard } from '../components/StatCard';
import { QuickActionTile } from '../components/QuickActionTile';
import { tierColor as getTierColor } from '../theme/tiers';

interface PortfolioVenue {
  id: string;
  name: string;
  venue_type: string;
  address: string;
  capacity: number;
  current_capacity: number | null;
  renewal_date: string;
  current_carrier: string;
  tier: string;
  total_score: number;
  open_incidents: number;
  compliance_actions: number;
  has_degraded_infra: boolean;
}

export function BrokerPortfolioScreen({ navigation }: any) {
  const { user } = useAuth();
  const { isTablet } = useResponsive();
  const [venues, setVenues] = useState<PortfolioVenue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchPortfolio = useCallback(async () => {
    try {
      // Book only — the 300 real prospect venues live on the Venues tab
      // (filterable), so they don't flood the live portfolio dashboard.
      const data = await api.request<PortfolioVenue[]>('/api/portfolio?source=book');
      setVenues(data);
    } catch {
      // keep stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchPortfolio(); }, [fetchPortfolio]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  const totalVenues = venues.length;
  const openIncidents = venues.reduce((s, v) => s + (v.open_incidents ?? 0), 0);
  const complianceActions = venues.reduce((s, v) => s + (v.compliance_actions ?? 0), 0);

  const filteredVenues = searchQuery.trim().length === 0
    ? venues
    : venues.filter(v => {
        const q = searchQuery.toLowerCase();
        return (
          (v.name ?? '').toLowerCase().includes(q) ||
          (v.venue_type ?? '').toLowerCase().includes(q)
        );
      });

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.name}>{user?.name}</Text>
          <Text style={styles.role}>BROKER · NIGHTLINE RISK</Text>
        </View>
      </View>

      {/* Stats bar: 3 cards */}
      <View style={styles.statsRow}>
        <StatCard
          value={totalVenues}
          label="TOTAL VENUES"
          onPress={() => navigation.getParent()?.navigate('Venues')}
        />
        <StatCard
          value={openIncidents}
          label="OPEN INCIDENTS"
          tone={openIncidents > 0 ? 'error' : 'default'}
          onPress={() => navigation.getParent()?.navigate('Incidents')}
        />
        <StatCard
          value={complianceActions}
          label="COMPLIANCE"
          tone={complianceActions > 0 ? 'warning' : 'default'}
          onPress={() => navigation.getParent()?.navigate('Compliance')}
        />
      </View>

      {/* Quick actions — two-up compact row */}
      <View style={styles.actionRow}>
        <QuickActionTile label="RENEWALS DUE" onPress={() => navigation.navigate('Renewals')} />
        <QuickActionTile label="POLICY REQUESTS" onPress={() => navigation.navigate('PolicyRequests')} />
      </View>

      {/* Search bar */}
      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="Search venues..."
          placeholderTextColor={Colors.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
      </View>

      <Text style={styles.sectionEyebrow}>
        THE BOOK —{' '}
        {searchQuery.trim().length > 0
          ? `${filteredVenues.length} of ${totalVenues} VENUES`
          : `${totalVenues} VENUES`}
      </Text>

      <FlatList
        data={filteredVenues}
        keyExtractor={item => item.id}
        contentContainerStyle={[
          styles.list,
          isTablet && { maxWidth: 720, alignSelf: 'center', width: '100%' },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchPortfolio(); }}
            tintColor={Colors.accent}
          />
        }
        renderItem={({ item }) => {
          const tier = item.tier ?? '—';
          const score = item.total_score ?? 0;
          const tierColor = getTierColor(tier);
          const capacity = item.current_capacity ?? 0;
          const maxCapacity = item.capacity ?? 0;
          const capacityPct = maxCapacity > 0 ? Math.min(capacity / maxCapacity, 1) : 0;
          const capacityBarColor =
            capacityPct > 0.85 ? Colors.error : capacityPct > 0.6 ? Colors.warning : Colors.accent;

          const venueTypeLabel = (item.venue_type ?? '').replace(/_/g, ' ').toUpperCase();

          return (
            <Pressable
              style={({ pressed }) => [
                styles.venueCard,
                { borderLeftColor: tierColor },
                pressed && { opacity: 0.75 },
              ]}
              onPress={() =>
                navigation.navigate('VenueDetail', {
                  venueId: item.id,
                  venueName: item.name ?? item.id,
                })
              }
            >
              {/* Venue type label */}
              <Text style={[styles.venueTypeLabel, { color: tierColor }]}>
                {venueTypeLabel}
              </Text>

              {/* Venue name */}
              <Text style={styles.venueName}>{item.name}</Text>

              {/* Address */}
              {!!item.address && (
                <Text style={styles.venueAddress} numberOfLines={1}>
                  · {item.address}
                </Text>
              )}

              {/* Score row */}
              <View style={styles.scoreRow}>
                <Text style={styles.scoreLarge}>
                  <Text style={{ color: Colors.text }}>{score}</Text>
                  <Text style={styles.scoreOf}>/100</Text>
                </Text>
                <View style={[styles.tierPill, { borderColor: tierColor }]}>
                  <Text style={[styles.tierPillText, { color: tierColor }]}>Tier {tier}</Text>
                </View>
              </View>

              {/* Live capacity — operator-only floor data; null for brokers */}
              {item.current_capacity != null && maxCapacity > 0 && (
                <View style={styles.capacitySection}>
                  <View style={styles.capacityLabelRow}>
                    <Text style={styles.capacityHeading}>LIVE CAPACITY</Text>
                    <Text style={styles.capacityNumbers}>{capacity} / {maxCapacity}</Text>
                  </View>
                  <View style={styles.capacityTrack}>
                    <View
                      style={[
                        styles.capacityFill,
                        {
                          width: `${capacityPct * 100}%` as any,
                          backgroundColor: capacityBarColor,
                        },
                      ]}
                    />
                  </View>
                </View>
              )}

              {/* Bottom row: carrier · renewal | degraded infra | open incidents pill */}
              <View style={styles.bottomRow}>
                <Text style={styles.bottomMeta} numberOfLines={1}>
                  {item.current_carrier ? item.current_carrier : '—'}
                  {item.renewal_date ? ` · ${item.renewal_date}` : ''}
                </Text>
                <View style={styles.bottomRight}>
                  {item.has_degraded_infra && (
                    <Text style={styles.degradedTag}>DEGRADED INFRA</Text>
                  )}
                  {(item.open_incidents ?? 0) > 0 && (
                    <View style={styles.incidentPill}>
                      <Text style={styles.incidentPillText}>
                        {item.open_incidents} OPEN →
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {searchQuery.trim().length > 0 ? 'No venues match' : 'No venues'}
            </Text>
            <Text style={styles.emptySub}>
              {searchQuery.trim().length > 0
                ? `No venues match "${searchQuery}".`
                : 'Portfolio is empty.'}
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

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 14,
  },
  name: { color: Colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5, fontFamily: 'BricolageGrotesque_700Bold' },
  role: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, marginTop: 4, fontFamily: 'SpaceMono_700Bold' },
  signOut: { color: Colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, paddingTop: 6, fontFamily: 'SpaceMono_700Bold' },

  // Stats bar
  statsRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, marginBottom: 12 },

  // Quick actions — two-up compact row
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 20,
    marginBottom: 12,
  },

  // Search bar
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginBottom: 12,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 8,
  },
  searchIcon: {
    color: Colors.textMuted,
    fontSize: 16,
  },
  searchInput: {
    flex: 1,
    color: Colors.text,
    fontFamily: 'HankenGrotesk_400Regular',
    fontSize: 14,
    padding: 0,
    margin: 0,
  },

  // Section eyebrow
  sectionEyebrow: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    paddingHorizontal: 20,
    marginBottom: 10,
    fontFamily: 'SpaceMono_700Bold',
  },

  // Venue list
  list: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },

  // Venue card
  venueCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderLeftWidth: 3,
    padding: 16,
    gap: 6,
  },

  venueTypeLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    fontFamily: 'SpaceMono_700Bold',
  },
  venueName: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
    fontFamily: 'HankenGrotesk_600SemiBold',
  },
  venueAddress: {
    color: Colors.textMuted,
    fontSize: 11,
    marginTop: -2,
    fontFamily: 'HankenGrotesk_600SemiBold',
  },

  // Score row
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  scoreLarge: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -1,
    color: Colors.text,
    fontFamily: 'SpaceMono_700Bold',
  },
  scoreOf: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.textMuted,
    fontFamily: 'HankenGrotesk_500Medium',
  },
  tierPill: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tierPillText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: 'SpaceMono_700Bold',
  },

  // Capacity
  capacitySection: { gap: 6, marginTop: 2 },
  capacityLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  capacityHeading: {
    color: Colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.5,
    fontFamily: 'SpaceMono_700Bold',
  },
  capacityNumbers: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'SpaceMono_400Regular',
  },
  capacityTrack: {
    height: 4,
    backgroundColor: Colors.borderSubtle,
    borderRadius: 2,
    overflow: 'hidden',
  },
  capacityFill: { height: '100%', borderRadius: 2 },

  // Bottom row
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
    gap: 8,
  },
  bottomMeta: {
    flex: 1,
    color: Colors.textMuted,
    fontSize: 11,
    fontFamily: 'SpaceMono_400Regular',
  },
  bottomRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  degradedTag: {
    color: Colors.warning,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'SpaceMono_700Bold',
  },
  incidentPill: {
    backgroundColor: 'rgba(255,69,87,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,69,87,0.35)',
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  incidentPillText: {
    color: Colors.error,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: 'SpaceMono_700Bold',
  },

  // Empty state
  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyTitle: { color: Colors.text, fontSize: 18, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  emptySub: { color: Colors.textMuted, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular' },
});
