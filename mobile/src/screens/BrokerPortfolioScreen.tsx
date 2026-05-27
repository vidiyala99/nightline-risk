import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AlertTriangle, ArrowUpRight, CheckSquare, WifiOff } from 'lucide-react-native';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';
import { useResponsive } from '../hooks/useResponsive';
import { StatCard } from '../components/StatCard';
import { QuickActionTile } from '../components/QuickActionTile';
import { tierColor as getTierColor } from '../theme/tiers';
import { classifyVenue, daysUntil, BUCKET_ORDER, BUCKET_LABEL, type Bucket } from '../lib/triage';

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

type TaggedVenue = PortfolioVenue & { _bucket: Bucket; _daysToRenew: number | null };
type Filter = 'all' | 'tonight' | 'watchlist' | 'renewals';

function inRenewalWindow(days: number | null): boolean {
  return days != null && days <= 30 && days >= -7;
}

export function BrokerPortfolioScreen({ navigation }: any) {
  const { user } = useAuth();
  const { isTablet } = useResponsive();
  const [venues, setVenues] = useState<PortfolioVenue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

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

  const totalVenues = venues.length;
  const openIncidents = venues.reduce((s, v) => s + (v.open_incidents ?? 0), 0);
  const complianceActions = venues.reduce((s, v) => s + (v.compliance_actions ?? 0), 0);

  // Search → tag with bucket + days-to-renewal (mirrors web BrokerTriage).
  const tagged: TaggedVenue[] = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matched = q.length === 0
      ? venues
      : venues.filter(v =>
          (v.name ?? '').toLowerCase().includes(q) ||
          (v.venue_type ?? '').toLowerCase().includes(q) ||
          (v.address ?? '').toLowerCase().includes(q),
        );
    return matched.map(v => ({
      ...v,
      _bucket: classifyVenue(v),
      _daysToRenew: daysUntil(v.renewal_date),
    }));
  }, [venues, searchQuery]);

  const counts = useMemo(() => ({
    all: tagged.length,
    tonight: tagged.filter(v => v._bucket === 'tonight').length,
    watchlist: tagged.filter(v => v._bucket === 'watchlist').length,
    renewals: tagged.filter(v => inRenewalWindow(v._daysToRenew)).length,
  }), [tagged]);

  // Group into urgency buckets for filter=all; single section otherwise.
  const sections = useMemo(() => {
    if (filter === 'renewals') {
      const items = tagged
        .filter(v => inRenewalWindow(v._daysToRenew))
        .sort((a, b) => (a._daysToRenew ?? 0) - (b._daysToRenew ?? 0));
      return items.length ? [{ bucket: 'tonight' as Bucket, title: 'Renewals 30d', data: items }] : [];
    }
    if (filter !== 'all') {
      const items = tagged.filter(v => v._bucket === filter).sort((a, b) => a.total_score - b.total_score);
      return items.length ? [{ bucket: filter as Bucket, title: BUCKET_LABEL[filter as Bucket], data: items }] : [];
    }
    return BUCKET_ORDER
      .map(bucket => ({
        bucket,
        title: BUCKET_LABEL[bucket],
        data: tagged.filter(v => v._bucket === bucket).sort((a, b) => a.total_score - b.total_score),
      }))
      .filter(g => g.data.length > 0);
  }, [tagged, filter]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  const chips: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'tonight', label: 'Tonight', count: counts.tonight },
    { key: 'watchlist', label: 'Watchlist', count: counts.watchlist },
    { key: 'renewals', label: 'Renewals 30d', count: counts.renewals },
  ];

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.name}>{user?.name}</Text>
        <Text style={styles.role}>BROKER · NIGHTLINE RISK</Text>
      </View>

      {/* Stats bar: 3 cards */}
      <View style={styles.statsRow}>
        <StatCard value={totalVenues} label="TOTAL VENUES" onPress={() => navigation.getParent()?.navigate('Venues')} />
        <StatCard value={openIncidents} label="OPEN INCIDENTS" tone={openIncidents > 0 ? 'error' : 'default'} onPress={() => navigation.getParent()?.navigate('Incidents')} />
        <StatCard value={complianceActions} label="COMPLIANCE" tone={complianceActions > 0 ? 'warning' : 'default'} onPress={() => navigation.getParent()?.navigate('Compliance')} />
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
          placeholder="Search venues, types, addresses…"
          placeholderTextColor={Colors.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
      </View>

      {/* KPI + urgency chips */}
      <View style={styles.kpiRow}>
        <Text style={styles.kpiText}>
          THE BOOK · {String(totalVenues).padStart(2, '0')} VENUES
        </Text>
        {counts.tonight > 0 && (
          <Text style={styles.kpiHi}>{counts.tonight} NEED EYES</Text>
        )}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        style={styles.chipScroll}
      >
        {chips.map(c => {
          const active = filter === c.key;
          return (
            <Pressable
              key={c.key}
              onPress={() => setFilter(c.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {c.label} · {c.count}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <SectionList
        sections={sections}
        keyExtractor={item => item.id}
        stickySectionHeadersEnabled
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
        renderSectionHeader={({ section }) => {
          const critical = (section as any).bucket === 'tonight' && filter !== 'renewals';
          return (
            <View style={styles.groupHead}>
              <Text style={[styles.groupLabel, critical && { color: Colors.error }]}>
                {(section as any).title}
              </Text>
              <Text style={styles.groupCount}>{String(section.data.length).padStart(2, '0')}</Text>
            </View>
          );
        }}
        renderItem={({ item }) => {
          const tier = item.tier ?? '—';
          const tColor = getTierColor(tier);
          const isTonight = item._bucket === 'tonight';
          const renewalSoon = item._daysToRenew != null && item._daysToRenew <= 14;
          const capLabel = item.current_capacity != null
            ? `${item.current_capacity}/${item.capacity.toLocaleString()}`
            : `${(item.capacity ?? 0).toLocaleString()} cap`;
          const typeLabel = (item.venue_type ?? '').replace(/_/g, ' ').toUpperCase();

          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}`}
              onPress={() => navigation.navigate('VenueDetail', { venueId: item.id, venueName: item.name ?? item.id })}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
            >
              <View style={[styles.dot, { backgroundColor: tColor, opacity: isTonight ? 1 : 0.4 }]} />

              <View style={styles.rowMain}>
                <View style={styles.titleRow}>
                  <Text style={styles.venueName} numberOfLines={1}>{item.name}</Text>
                  {item.open_incidents > 0 && (
                    <View style={styles.badge}>
                      <AlertTriangle size={10} color={Colors.error} />
                      <Text style={[styles.badgeText, { color: Colors.error }]}>{item.open_incidents}</Text>
                    </View>
                  )}
                  {item.compliance_actions > 0 && (
                    <View style={styles.badge}>
                      <CheckSquare size={10} color={Colors.accentInk} />
                      <Text style={[styles.badgeText, { color: Colors.accentInk }]}>{item.compliance_actions}</Text>
                    </View>
                  )}
                  {item.has_degraded_infra && (
                    <View style={styles.badge}>
                      <WifiOff size={10} color={Colors.warning} />
                      <Text style={[styles.badgeText, { color: Colors.warning }]}>DEG</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.rowSub} numberOfLines={1}>{typeLabel} · {capLabel}</Text>
              </View>

              <View style={styles.meta}>
                <Text style={[styles.score, { color: tColor }]}>{item.total_score ?? 0}</Text>
                <Text style={[styles.days, renewalSoon && { color: Colors.warning }]}>
                  {item._daysToRenew != null
                    ? (item._daysToRenew < 0 ? `${Math.abs(item._daysToRenew)}d past` : `${item._daysToRenew}d`)
                    : `Tier ${tier}`}
                </Text>
              </View>

              <ArrowUpRight size={14} color={Colors.textMuted} />
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No venues match this view</Text>
            <Text style={styles.emptySub}>
              {searchQuery.trim().length > 0 ? `Nothing matches "${searchQuery}".` : 'Try a different filter.'}
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

  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 14 },
  name: { color: Colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5, fontFamily: 'BricolageGrotesque_700Bold' },
  role: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, marginTop: 4, fontFamily: 'SpaceMono_700Bold' },

  statsRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, marginBottom: 12 },
  actionRow: { flexDirection: 'row', gap: 10, marginHorizontal: 20, marginBottom: 12 },

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
  searchIcon: { color: Colors.textMuted, fontSize: 16 },
  searchInput: { flex: 1, color: Colors.text, fontFamily: 'HankenGrotesk_400Regular', fontSize: 14, padding: 0, margin: 0 },

  kpiRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, marginBottom: 8 },
  kpiText: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  kpiHi: { color: Colors.error, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },

  chipScroll: { maxHeight: 44, marginBottom: 4 },
  chipRow: { paddingHorizontal: 20, gap: 8, alignItems: 'center' },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    minHeight: 32,
    justifyContent: 'center',
  },
  chipActive: { borderColor: Colors.accent, backgroundColor: Colors.accentWash },
  chipText: { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'SpaceMono_700Bold' },
  chipTextActive: { color: Colors.accentInk },

  list: { paddingHorizontal: 20, paddingBottom: 40 },

  groupHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.bg,
    paddingVertical: 8,
    marginTop: 4,
  },
  groupLabel: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  groupCount: { color: Colors.textMuted, fontSize: 11, fontFamily: 'SpaceMono_400Regular' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(23,21,15,0.06)',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowMain: { flex: 1, minWidth: 0, gap: 3 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  venueName: {
    flexShrink: 1,
    color: Colors.text,
    fontSize: 17,
    fontStyle: 'italic',
    letterSpacing: -0.3,
    fontFamily: 'BricolageGrotesque_700Bold',
  },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'SpaceMono_700Bold' },
  rowSub: { color: Colors.textMuted, fontSize: 10, letterSpacing: 1, fontFamily: 'SpaceMono_400Regular' },

  meta: { alignItems: 'flex-end', gap: 2 },
  score: { fontSize: 18, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'SpaceMono_700Bold' },
  days: { color: Colors.textMuted, fontSize: 10, fontFamily: 'SpaceMono_400Regular' },

  empty: { alignItems: 'center', paddingTop: 60, gap: 8 },
  emptyTitle: { color: Colors.text, fontSize: 16, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  emptySub: { color: Colors.textMuted, fontSize: 13, textAlign: 'center', paddingHorizontal: 30, fontFamily: 'HankenGrotesk_400Regular' },
});
