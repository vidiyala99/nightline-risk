import React, { useCallback, useMemo, useState } from 'react';
import { HandAccent } from "../components/HandAccent";
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../api/client';

interface Venue {
  id: string;
  name: string;
  venue_type?: string;
  address?: string;
  capacity?: number;
  renewal_date?: string;
  current_carrier?: string;
  // From /api/portfolio — live risk posture for the roster.
  tier?: string;
  total_score?: number;
  borough?: string;
}

const TIER_COLOR: Record<string, string> = {
  A: Colors.tierA, B: Colors.tierB, C: Colors.tierC, D: Colors.tierD,
};
const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
type SortKey = 'tier' | 'score' | 'renewal' | 'name';
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'tier', label: 'Tier' },
  { key: 'score', label: 'Score' },
  { key: 'renewal', label: 'Renewal' },
  { key: 'name', label: 'Name' },
];

export function BrokerVenuesScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [vtype, setVtype] = useState('all');
  const [borough, setBorough] = useState('all');
  const [sort, setSort] = useState<SortKey>('tier');

  const types = useMemo(
    () => Array.from(new Set(venues.map(v => v.venue_type).filter(Boolean))).sort() as string[],
    [venues],
  );
  const boroughs = useMemo(
    () => Array.from(new Set(venues.map(v => v.borough).filter(Boolean))).sort() as string[],
    [venues],
  );

  const filteredVenues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const out = venues.filter(v => {
      if (vtype !== 'all' && v.venue_type !== vtype) return false;
      if (borough !== 'all' && v.borough !== borough) return false;
      if (q) {
        const hay = `${v.name} ${v.address ?? ''} ${v.venue_type ?? ''} ${v.borough ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return [...out].sort((a, b) => {
      if (sort === 'score') return (b.total_score ?? 0) - (a.total_score ?? 0);
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'renewal') return (a.renewal_date || '9999').localeCompare(b.renewal_date || '9999');
      const t = (TIER_ORDER[a.tier ?? ''] ?? 9) - (TIER_ORDER[b.tier ?? ''] ?? 9);
      return t !== 0 ? t : (b.total_score ?? 0) - (a.total_score ?? 0);
    });
  }, [venues, searchQuery, vtype, borough, sort]);

  const fetchVenues = useCallback(async () => {
    try {
      // Portfolio rollup carries tier/score/borough so the roster can sort and
      // filter on risk posture (parity with the dashboard Book + Market).
      const data = await api.request<Venue[]>('/api/portfolio?source=book');
      setVenues(Array.isArray(data) ? data : []);
    } catch {
      // keep stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchVenues(); }, [fetchVenues]));

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  const filtersActive = searchQuery.trim() !== '' || vtype !== 'all' || borough !== 'all';

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.eyebrow}>INSURED PORTFOLIO</Text>
        <Text style={styles.title}>Venues</Text>
        <HandAccent>your book</HandAccent>
      </View>

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
        />
      </View>

      {types.length > 0 && (
        <View style={styles.filterGroup}>
          <Text style={styles.filterLabel}>TYPE</Text>
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={['all', ...types]}
            keyExtractor={(t) => t}
            contentContainerStyle={styles.chipsRow}
            renderItem={({ item }) => {
              const active = vtype === item;
              return (
                <Pressable style={[styles.chip, active && styles.chipActive]} onPress={() => setVtype(item)}>
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {item === 'all' ? 'All types' : item}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
      )}

      {boroughs.length > 0 && (
        <View style={styles.filterGroup}>
          <Text style={styles.filterLabel}>BOROUGH</Text>
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={['all', ...boroughs]}
            keyExtractor={(b) => b}
            contentContainerStyle={styles.chipsRow}
            renderItem={({ item }) => {
              const active = borough === item;
              return (
                <Pressable style={[styles.chip, active && styles.chipActive]} onPress={() => setBorough(item)}>
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {item === 'all' ? 'All boroughs' : item}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
      )}

      <View style={styles.filterGroup}>
        <Text style={styles.filterLabel}>SORT</Text>
        <View style={styles.sortRow}>
          {SORT_OPTIONS.map((opt) => {
            const active = sort === opt.key;
            return (
              <Pressable
                key={opt.key}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setSort(opt.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text style={styles.sectionEyebrow}>
        {filtersActive
          ? `${filteredVenues.length} OF ${venues.length} VENUES`
          : `${filteredVenues.length} VENUES`}
      </Text>

      <FlatList
        data={filteredVenues}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchVenues(); }}
            tintColor={Colors.accent}
          />
        }
        renderItem={({ item }) => {
          const tierColor = TIER_COLOR[item.tier ?? ''] ?? Colors.textMuted;
          return (
          <Pressable
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.75 }]}
            onPress={() => navigation.navigate('VenueDetail', { venueId: item.id, venueName: item.name, isProspect: false })}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}${item.tier ? `, Tier ${item.tier}` : ''}`}
          >
            <View style={styles.cardTopRow}>
              {item.venue_type ? (
                <Text style={styles.venueType} numberOfLines={1}>{item.venue_type.toUpperCase()}</Text>
              ) : <View />}
              {!!item.tier && (
                <Text style={[styles.tierPill, { color: tierColor }]}>
                  Tier {item.tier}{item.total_score != null ? ` · ${item.total_score}` : ''}
                </Text>
              )}
            </View>
            <Text style={styles.venueName}>{item.name}</Text>
            {(!!item.address || !!item.borough) && (
              <Text style={styles.venueAddress} numberOfLines={1}>
                {[item.address, item.borough].filter(Boolean).join(' · ')}
              </Text>
            )}
            <View style={styles.metaRow}>
              {!!item.capacity && (
                <Text style={styles.metaItem}>CAP {item.capacity.toLocaleString()}</Text>
              )}
              {!!item.renewal_date && (
                <Text style={styles.metaItem}> · Renewal {item.renewal_date}</Text>
              )}
            </View>
            <Text style={styles.viewDetail}>View details →</Text>
          </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {filtersActive ? 'No matches' : 'No venues'}
            </Text>
            <Text style={styles.emptySub}>
              {filtersActive
                ? 'No venues match this view.'
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

  header: { paddingHorizontal: 20, paddingBottom: 16 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold', marginBottom: 4 },
  title: { color: Colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -1, fontFamily: 'BricolageGrotesque_700Bold' },

  searchWrap: {
    marginHorizontal: 20,
    marginBottom: 14,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    height: 44,
    gap: 10,
  },
  searchIcon: { color: Colors.textMuted, fontSize: 18 },
  searchInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 14,
    fontFamily: 'HankenGrotesk_400Regular',
    paddingVertical: 0,
  },

  filterGroup: { marginBottom: 2 },
  filterLabel: {
    color: Colors.textMuted, fontSize: 9, letterSpacing: 1.5,
    fontFamily: 'SpaceMono_700Bold', paddingHorizontal: 20, marginBottom: 6,
  },
  chipsRow: { paddingHorizontal: 20, gap: 8, paddingBottom: 12 },
  sortRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingBottom: 12, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.accentWash, borderColor: Colors.accent },
  chipText: { color: Colors.textSecondary, fontSize: 12, fontWeight: '700', fontFamily: 'SpaceMono_700Bold' },
  chipTextActive: { color: Colors.accentInk },

  sectionEyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, paddingHorizontal: 20, marginBottom: 12, fontFamily: 'SpaceMono_700Bold' },

  list: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    padding: 16,
    gap: 4,
  },
  venueType: { color: Colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  tierPill: { fontSize: 11, fontWeight: '700', fontFamily: 'SpaceMono_700Bold' },
  venueName: { color: Colors.text, fontSize: 18, fontWeight: '700', letterSpacing: -0.3, fontFamily: 'HankenGrotesk_600SemiBold' },
  venueAddress: { color: Colors.textMuted, fontSize: 11, fontFamily: 'HankenGrotesk_400Regular' },

  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  metaItem: { color: Colors.textSecondary, fontSize: 11, fontFamily: 'SpaceMono_400Regular' },

  viewDetail: { color: Colors.accentInk, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'SpaceMono_700Bold', marginTop: 6 },

  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },

  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyTitle: { color: Colors.text, fontSize: 18, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  emptySub: { color: Colors.textMuted, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular' },
});
