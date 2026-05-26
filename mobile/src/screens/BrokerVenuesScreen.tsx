import React, { useCallback, useState } from 'react';
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
  source?: 'book' | 'prospect';
  savings_low?: string;
  savings_high?: string;
}

type SourceFilter = 'all' | 'book' | 'prospect';

function fmtMoney0(s?: string): string {
  if (!s) return '—';
  const n = Number(s);
  return Number.isNaN(n) ? '—' : `$${Math.round(n).toLocaleString('en-US')}`;
}

export function BrokerVenuesScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

  const filteredVenues = venues.filter(v => {
    if (sourceFilter !== 'all' && (v.source ?? 'book') !== sourceFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return v.name.toLowerCase().includes(q)
        || (v.address?.toLowerCase().includes(q) ?? false)
        || (v.venue_type?.toLowerCase().includes(q) ?? false);
    }
    return true;
  });

  const bookCount = venues.filter(v => (v.source ?? 'book') === 'book').length;
  const prospectCount = venues.filter(v => v.source === 'prospect').length;

  const fetchVenues = useCallback(async () => {
    try {
      const data = await api.request<Venue[]>('/api/venues');
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

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.eyebrow}>INSURED PORTFOLIO</Text>
        <Text style={styles.title}>Venues</Text>
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

      <View style={styles.filterBar}>
        {([['all', 'All', venues.length], ['book', 'Book', bookCount], ['prospect', 'Prospects', prospectCount]] as const).map(
          ([key, label, count]) => {
            const active = sourceFilter === key;
            return (
              <Pressable key={key} onPress={() => setSourceFilter(key)} style={[styles.chip, active && styles.chipActive]}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
                <Text style={[styles.chipCount, active && styles.chipCountActive]}>{count}</Text>
              </Pressable>
            );
          },
        )}
      </View>

      <Text style={styles.sectionEyebrow}>
        {searchQuery.trim()
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
          const isProspect = item.source === 'prospect';
          return (
            <Pressable
              style={({ pressed }) => [styles.card, isProspect && styles.cardProspect, pressed && { opacity: 0.75 }]}
              onPress={() => navigation.navigate('VenueDetail', { venueId: item.id, venueName: item.name })}
            >
              <View style={styles.cardTopRow}>
                {item.venue_type ? (
                  <Text style={styles.venueType} numberOfLines={1}>{item.venue_type.toUpperCase()}</Text>
                ) : <View />}
                {isProspect && <Text style={styles.prospectBadge}>PROSPECT</Text>}
              </View>
              <Text style={styles.venueName}>{item.name}</Text>
              {!!item.address && (
                <Text style={styles.venueAddress} numberOfLines={1}>{item.address}</Text>
              )}
              <View style={styles.metaRow}>
                {!!item.capacity && (
                  <Text style={styles.metaItem}>CAP {item.capacity.toLocaleString()}</Text>
                )}
                {!!item.renewal_date && (
                  <Text style={styles.metaItem}> · Renewal {item.renewal_date}</Text>
                )}
              </View>
              {isProspect && (item.savings_low || item.savings_high) && (
                <Text style={styles.prospectSavings}>
                  Est. savings {fmtMoney0(item.savings_low)}–{fmtMoney0(item.savings_high)}/yr
                </Text>
              )}
              <Text style={styles.viewDetail}>{isProspect ? 'View profile →' : 'View details →'}</Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {searchQuery.trim() ? 'No matches' : 'No venues'}
            </Text>
            <Text style={styles.emptySub}>
              {searchQuery.trim()
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

  header: { paddingHorizontal: 20, paddingBottom: 16 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold', marginBottom: 4 },
  title: { color: Colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -1, fontFamily: 'BricolageGrotesque_700Bold' },

  searchWrap: {
    marginHorizontal: 20,
    marginBottom: 16,
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
  venueName: { color: Colors.text, fontSize: 18, fontWeight: '700', letterSpacing: -0.3, fontFamily: 'HankenGrotesk_600SemiBold' },
  venueAddress: { color: Colors.textMuted, fontSize: 11, fontFamily: 'HankenGrotesk_400Regular' },

  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  metaItem: { color: Colors.textSecondary, fontSize: 11, fontFamily: 'SpaceMono_400Regular' },

  viewDetail: { color: Colors.accentInk, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontFamily: 'SpaceMono_700Bold', marginTop: 6 },

  filterBar: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginBottom: 14, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  chipActive: { borderColor: Colors.accent },
  chipText: { color: Colors.textSecondary, fontFamily: 'HankenGrotesk_500Medium', fontSize: 12 },
  chipTextActive: { color: Colors.accentInk },
  chipCount: { color: Colors.textSecondary, fontFamily: 'SpaceMono_700Bold', fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: 'rgba(23,21,15,0.06)' },
  chipCountActive: { color: Colors.accentInk },

  cardProspect: { borderStyle: 'dashed', borderColor: 'rgba(200,240,0,0.25)' },
  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  prospectBadge: {
    color: Colors.accentInk, fontSize: 9, fontFamily: 'SpaceMono_700Bold', letterSpacing: 1,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.accent, borderRadius: 999,
    paddingHorizontal: 7, paddingVertical: 1, overflow: 'hidden',
  },
  prospectSavings: { color: Colors.accentInk, fontSize: 12, fontFamily: 'SpaceMono_700Bold', marginTop: 4 },

  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyTitle: { color: Colors.text, fontSize: 18, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  emptySub: { color: Colors.textMuted, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular' },
});
