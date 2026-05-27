import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../theme/colors';
import { api } from '../api/client';
import { money, venueTypeLabel as typeLabel } from '../lib/format';

// Mobile equivalent of the web /market opportunity map. RN can't render the
// Leaflet map, so this is the card-list view of the same data: real NYC
// nightlife prospects (source=prospect from the shared portfolio rollup) with
// estimated savings vs market. Read-only browsing — no per-card navigation,
// matching the web card whose only CTA is a sign-up funnel that's moot here.
interface Prospect {
  id: string;
  name: string;
  venue_type: string;
  address: string;
  tier: string;
  total_score: number;
  source: string;
  savings_low: string | null;
  savings_high: string | null;
  market_premium: string | null;
}

const TIER_COLOR: Record<string, string> = {
  A: Colors.tierA, B: Colors.tierB, C: Colors.tierC, D: Colors.tierD,
};

export function MarketScreen() {
  const insets = useSafeAreaInsets();
  const [prospects, setProspects] = useState<Prospect[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [vtype, setVtype] = useState('all');

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.request<Prospect[]>('/api/portfolio?source=prospect');
      setProspects(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load prospects');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const types = useMemo(() => {
    if (!prospects) return [];
    return Array.from(new Set(prospects.map((p) => p.venue_type))).sort();
  }, [prospects]);

  const visible = useMemo(() => {
    if (!prospects) return [];
    return vtype === 'all' ? prospects : prospects.filter((p) => p.venue_type === vtype);
  }, [prospects, vtype]);

  const totalSavingsLow = useMemo(
    () => visible.reduce((sum, p) => sum + (Number(p.savings_low) || 0), 0),
    [visible],
  );

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.retry} onPress={load}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (!prospects) {
    return <View style={styles.center}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={{ paddingTop: 16, paddingBottom: insets.bottom + 24 }}
      data={visible}
      keyExtractor={(p) => p.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); load(); }}
          tintColor={Colors.accentInk}
        />
      }
      ListHeaderComponent={
        <View>
          <View style={styles.header}>
            <Text style={styles.eyebrow}>NYC NIGHTLIFE · OPPORTUNITY MAP</Text>
            <Text style={styles.title}>Market</Text>
            <Text style={styles.sub}>
              Real NYC nightlife licensees. Estimated savings vs current market pricing.
            </Text>
          </View>

          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statNum}>{visible.length}</Text>
              <Text style={styles.statLabel}>PROSPECTS</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={[styles.statNum, { color: Colors.accentInk }]}>{money(String(totalSavingsLow))}</Text>
              <Text style={styles.statLabel}>EST. SAVINGS+/YR</Text>
            </View>
          </View>

          {types.length > 0 && (
            <FlatList
              horizontal
              showsHorizontalScrollIndicator={false}
              data={['all', ...types]}
              keyExtractor={(t) => t}
              contentContainerStyle={styles.chipsRow}
              renderItem={({ item }) => {
                const active = vtype === item;
                return (
                  <Pressable
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setVtype(item)}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {item === 'all' ? 'All types' : typeLabel(item)}
                    </Text>
                  </Pressable>
                );
              }}
            />
          )}
        </View>
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.emptyText}>No prospects match this filter.</Text>
        </View>
      }
      renderItem={({ item }) => {
        const tierColor = TIER_COLOR[item.tier] ?? Colors.textMuted;
        return (
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={[styles.cardType, { color: tierColor }]}>{typeLabel(item.venue_type)}</Text>
              <Text style={[styles.tierPill, { color: tierColor }]}>Tier {item.tier} · {item.total_score}</Text>
            </View>
            <Text style={styles.cardName}>{item.name}</Text>
            {!!item.address && <Text style={styles.cardAddr} numberOfLines={1}>{item.address}</Text>}

            <View style={styles.numsRow}>
              <View style={styles.numCol}>
                <Text style={styles.numLabel}>CURRENT (MARKET)</Text>
                <Text style={styles.numValue}>~{money(item.market_premium)}/yr</Text>
              </View>
              <View style={styles.numCol}>
                <Text style={styles.numLabel}>EST. SAVINGS</Text>
                <Text style={[styles.numValue, { color: Colors.accentInk }]}>
                  {money(item.savings_low)}–{money(item.savings_high)}/yr
                </Text>
              </View>
            </View>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12, backgroundColor: Colors.bg },
  errorText: { color: Colors.error, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular', textAlign: 'center' },
  emptyText: { color: Colors.textMuted, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular' },
  retry: {
    paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
  },
  retryText: { color: Colors.accentInk, fontSize: 14, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },

  header: { paddingHorizontal: 20, marginBottom: 14 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  title: { color: Colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -1, fontFamily: 'BricolageGrotesque_700Bold', marginTop: 4 },
  sub: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 6, fontFamily: 'HankenGrotesk_400Regular' },

  statsRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginBottom: 14 },
  statCard: {
    flex: 1, padding: 14, borderRadius: 12, backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
  },
  statNum: { color: Colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'SpaceMono_700Bold' },
  statLabel: { color: Colors.textMuted, fontSize: 9, letterSpacing: 1, marginTop: 4, fontFamily: 'SpaceMono_700Bold' },

  chipsRow: { paddingHorizontal: 16, gap: 8, paddingBottom: 14 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.accentWash, borderColor: Colors.accent },
  chipText: { color: Colors.textSecondary, fontSize: 12, fontWeight: '700', fontFamily: 'SpaceMono_700Bold' },
  chipTextActive: { color: Colors.accentInk },

  card: {
    marginHorizontal: 16, marginBottom: 12, padding: 16, gap: 6,
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle, borderRadius: 14,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardType: { fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', fontFamily: 'SpaceMono_700Bold' },
  tierPill: { fontSize: 12, fontWeight: '700', fontFamily: 'SpaceMono_700Bold' },
  cardName: { color: Colors.text, fontSize: 18, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  cardAddr: { color: Colors.textMuted, fontSize: 12, fontFamily: 'HankenGrotesk_400Regular' },
  numsRow: {
    flexDirection: 'row', gap: 16, marginTop: 8, paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)',
  },
  numCol: { flex: 1, gap: 3 },
  numLabel: { color: Colors.textMuted, fontSize: 9, letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },
  numValue: { color: Colors.text, fontSize: 14, fontWeight: '700', fontFamily: 'SpaceMono_700Bold' },
});
