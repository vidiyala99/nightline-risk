import React, { useCallback, useEffect, useState } from 'react';
import { Colors } from '../theme/colors';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api/client';

interface Venue {
  id?: string;
  name?: string;
  venue_type?: string;
  address?: string;
  capacity?: number;
  years_in_operation?: number;
  security_level?: string;
  current_carrier?: string;
  renewal_date?: string;
}

function humanize(value?: string): string {
  if (!value) return '—';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function VenueProfileScreen({ navigation, route }: any) {
  const insets = useSafeAreaInsets();
  const venueId: string = route?.params?.venueId ?? '';
  const passedName: string | undefined = route?.params?.venueName;

  const [venue, setVenue] = useState<Venue | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchVenue = useCallback(async () => {
    if (!venueId) { setLoading(false); return; }
    try {
      setVenue(await api.request<Venue>(`/api/venues/${venueId}`));
    } catch {
      setVenue(null);
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  useEffect(() => { fetchVenue(); }, [fetchVenue]);

  const name = venue?.name ?? passedName ?? 'Venue';

  const rows: { label: string; value: string }[] = [
    { label: 'VENUE TYPE', value: humanize(venue?.venue_type) },
    { label: 'ADDRESS', value: venue?.address || '—' },
    { label: 'CAPACITY', value: venue?.capacity != null ? `${venue.capacity.toLocaleString()} pax` : '—' },
    { label: 'YEARS IN OPERATION', value: venue?.years_in_operation != null ? String(venue.years_in_operation) : '—' },
    { label: 'SECURITY LEVEL', value: humanize(venue?.security_level) },
    { label: 'CURRENT CARRIER', value: venue?.current_carrier || '—' },
    { label: 'RENEWAL DATE', value: venue?.renewal_date || '—' },
  ];

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}
    >
      <Pressable
        onPress={() => navigation.goBack()}
        style={styles.backBtn}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <Text style={styles.backText}>← Back</Text>
      </Pressable>

      <Text style={styles.eyebrow}>BUSINESS PROFILE</Text>
      <Text style={styles.title}>{name}</Text>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={Colors.accentInk} /></View>
      ) : !venue ? (
        <View style={styles.card}>
          <Text style={styles.value}>Venue details unavailable.</Text>
        </View>
      ) : (
        <View style={styles.card}>
          {rows.map((row, i) => (
            <View key={row.label} style={[styles.row, i > 0 && styles.rowDivider]}>
              <Text style={styles.label}>{row.label}</Text>
              <Text style={styles.value}>{row.value}</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
  centered: { paddingVertical: 40, alignItems: 'center' },

  backBtn: { paddingVertical: 6 },
  backText: { color: Colors.textSecondary, fontSize: 13, fontFamily: 'HankenGrotesk_500Medium' },

  eyebrow: {
    color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2,
    fontFamily: 'SpaceMono_700Bold', marginTop: 4,
  },
  title: {
    color: Colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5,
    fontFamily: 'BricolageGrotesque_700Bold', marginBottom: 4,
  },

  card: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 14,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 14,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(23,21,15,0.06)',
  },
  label: {
    color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5,
    fontFamily: 'SpaceMono_700Bold',
  },
  value: {
    flex: 1, textAlign: 'right',
    color: Colors.text, fontSize: 14,
    fontFamily: 'HankenGrotesk_600SemiBold',
  },
});
