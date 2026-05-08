import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';

const VENUE_TYPES = [
  'bar', 'nightclub', 'music venue and bar', 'nightclub and performance space',
  'outdoor music venue', 'outdoor bar and music venue', 'DIY music venue and bar',
  'restaurant and bar', 'lounge',
];

interface VenueData {
  id: string;
  name: string;
  address?: string;
  capacity?: number;
  venue_type?: string;
  years_in_operation?: number;
}

function VenueCard({
  venue,
  isPrimary,
  onSave,
  onPress,
}: {
  venue: VenueData;
  isPrimary: boolean;
  onSave: (id: string, updates: Partial<VenueData>) => Promise<void>;
  onPress: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(venue.name);
  const [address, setAddress] = useState(venue.address ?? '');
  const [capacity, setCapacity] = useState(String(venue.capacity ?? ''));
  const [venueType, setVenueType] = useState(venue.venue_type ?? 'bar');
  const [yearsInOp, setYearsInOp] = useState(String(venue.years_in_operation ?? ''));

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(venue.id, {
        name: name.trim() || venue.name,
        address: address.trim(),
        capacity: capacity ? parseInt(capacity, 10) : venue.capacity,
        venue_type: venueType,
        years_in_operation: yearsInOp ? parseInt(yearsInOp, 10) : venue.years_in_operation,
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEditing(false);
    } catch (e: any) {
      Alert.alert('Save failed', e.message ?? 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderLeft}>
          {isPrimary && <Text style={styles.primaryBadge}>PRIMARY</Text>}
          <Text style={styles.venueName}>{venue.name}</Text>
          <Text style={styles.venueId}>{venue.id}</Text>
        </View>
        {!editing && (
          <Pressable onPress={() => setEditing(true)} style={styles.editBtn}>
            <Text style={styles.editBtnText}>EDIT</Text>
          </Pressable>
        )}
      </View>

      {!editing ? (
        <Pressable onPress={onPress} style={styles.detailGrid}>
          <View style={styles.detailItem}>
            <Text style={styles.detailLabel}>TYPE</Text>
            <Text style={styles.detailValue}>{venue.venue_type ?? '—'}</Text>
          </View>
          <View style={styles.detailItem}>
            <Text style={styles.detailLabel}>CAPACITY</Text>
            <Text style={styles.detailValue}>{venue.capacity ?? '—'}</Text>
          </View>
          <View style={styles.detailItem}>
            <Text style={styles.detailLabel}>YEARS OPEN</Text>
            <Text style={styles.detailValue}>{venue.years_in_operation ?? '—'}</Text>
          </View>
          {venue.address ? (
            <View style={[styles.detailItem, { flex: 2 }]}>
              <Text style={styles.detailLabel}>ADDRESS</Text>
              <Text style={styles.detailValue}>{venue.address}</Text>
            </View>
          ) : null}
          <View style={[styles.detailItem, { flex: 2 }]}>
            <Text style={styles.viewLive}>View Live Terminal →</Text>
          </View>
        </Pressable>
      ) : (
        <View style={styles.editForm}>
          <View style={styles.inputWrap}>
            <Text style={styles.label}>VENUE NAME</Text>
            <TextInput style={styles.input} value={name} onChangeText={setName} placeholderTextColor="#2e3247" />
          </View>
          <View style={styles.inputWrap}>
            <Text style={styles.label}>ADDRESS</Text>
            <TextInput style={styles.input} value={address} onChangeText={setAddress} placeholderTextColor="#2e3247" />
          </View>
          <View style={styles.editRow}>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.label}>CAPACITY</Text>
              <TextInput style={styles.input} value={capacity} onChangeText={setCapacity} keyboardType="numeric" placeholderTextColor="#2e3247" />
            </View>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.label}>YEARS OPEN</Text>
              <TextInput style={styles.input} value={yearsInOp} onChangeText={setYearsInOp} keyboardType="numeric" placeholderTextColor="#2e3247" />
            </View>
          </View>
          <View style={styles.inputWrap}>
            <Text style={styles.label}>VENUE TYPE</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.typeRow}>
                {VENUE_TYPES.map((t) => (
                  <Pressable
                    key={t}
                    style={[styles.typeChip, venueType === t && styles.typeChipActive]}
                    onPress={() => setVenueType(t)}
                  >
                    <Text style={[styles.typeChipText, venueType === t && styles.typeChipTextActive]}>{t}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          </View>
          <View style={styles.editActions}>
            <Pressable onPress={() => setEditing(false)} style={styles.cancelBtn}>
              <Text style={styles.cancelBtnText}>CANCEL</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              disabled={saving}
              style={[styles.saveBtn, saving && { opacity: 0.5 }]}
            >
              {saving ? <ActivityIndicator color="#07080f" size="small" /> : <Text style={styles.saveBtnText}>SAVE</Text>}
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

export function VenuesScreen({ navigation }: any) {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [venues, setVenues] = useState<VenueData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadVenues = useCallback(async () => {
    if (!user?.tenant_id) { setLoading(false); return; }
    try {
      // Load primary venue
      const primary = await api.request<VenueData>(`/api/venues/${user.tenant_id}`);
      // Load additional venue IDs from local storage
      const stored = await AsyncStorage.getItem(`extra_venues_${user.tenant_id}`);
      const extraIds: string[] = stored ? JSON.parse(stored) : [];
      const extras = await Promise.all(
        extraIds.map((id) => api.request<VenueData>(`/api/venues/${id}`).catch(() => null))
      );
      setVenues([{ ...primary, id: user.tenant_id }, ...extras.filter(Boolean) as VenueData[]]);
    } catch {
      setVenues([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.tenant_id]);

  useFocusEffect(useCallback(() => {
    loadVenues();
  }, [loadVenues]));

  async function handleSave(venueId: string, updates: Partial<VenueData>) {
    const updated = await api.request<VenueData>(`/api/venues/${venueId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    setVenues((prev) => prev.map((v) => v.id === venueId ? { ...v, ...updated } : v));
  }

  function onRefresh() {
    setRefreshing(true);
    loadVenues();
  }

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color="#c8f000" /></View>;
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#c8f000" />}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>YOUR VENUES</Text>
          <Text style={styles.title}>Properties</Text>
        </View>
        <Pressable
          style={styles.addBtn}
          onPress={() => navigation.navigate('VenueSetupExtra')}
        >
          <Text style={styles.addBtnText}>+ ADD</Text>
        </Pressable>
      </View>

      {venues.length === 0 ? (
        <Pressable
          style={styles.emptyCard}
          onPress={() => navigation.navigate('VenueSetupExtra')}
        >
          <Text style={styles.emptyHeading}>No venue yet</Text>
          <Text style={styles.emptyBody}>Tap to add your first venue.</Text>
        </Pressable>
      ) : (
        venues.map((v, i) => (
          <VenueCard
            key={v.id}
            venue={v}
            isPrimary={i === 0}
            onSave={handleSave}
            onPress={() => navigation.navigate('Live')}
          />
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07080f' },
  content: { paddingHorizontal: 20, paddingBottom: 32, gap: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#07080f' },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 },
  eyebrow: { color: '#4a4f65', fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold', marginBottom: 4 },
  title: { color: '#eeeef5', fontSize: 32, fontWeight: '800', letterSpacing: -1, fontFamily: 'CormorantGaramond_700Bold' },
  addBtn: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(200,240,0,0.4)', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  addBtnText: { color: '#c8f000', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },

  card: {
    backgroundColor: '#0d0f1c',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 16,
    padding: 20,
    gap: 16,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardHeaderLeft: { flex: 1, gap: 4 },
  primaryBadge: { color: '#c8f000', fontSize: 9, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  venueName: { color: '#eeeef5', fontSize: 20, fontWeight: '700', letterSpacing: -0.5, fontFamily: 'CormorantGaramond_700Bold' },
  venueId: { color: '#2e3247', fontSize: 10, fontFamily: 'JetBrainsMono_400Regular' },
  editBtn: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  editBtnText: { color: '#8b90a8', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },

  detailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  detailItem: { flex: 1, minWidth: '40%', gap: 2 },
  detailLabel: { color: '#4a4f65', fontSize: 9, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  detailValue: { color: '#eeeef5', fontSize: 14, fontFamily: 'DMSans_400Regular' },

  editForm: { gap: 14 },
  editRow: { flexDirection: 'row', gap: 12 },
  inputWrap: { gap: 6 },
  label: { color: '#4a4f65', fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  input: {
    backgroundColor: '#07080f',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: '#eeeef5',
    fontSize: 14,
    fontFamily: 'DMSans_400Regular',
  },
  typeRow: { flexDirection: 'row', gap: 8 },
  typeChip: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.1)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: '#07080f' },
  typeChipActive: { borderColor: '#c8f000', backgroundColor: 'rgba(200,240,0,0.06)' },
  typeChipText: { color: '#4a4f65', fontSize: 12, fontFamily: 'DMSans_400Regular' },
  typeChipTextActive: { color: '#c8f000' },
  editActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  cancelBtn: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.1)', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  cancelBtnText: { color: '#4a4f65', fontSize: 12, fontWeight: '700', letterSpacing: 1, fontFamily: 'JetBrainsMono_700Bold' },
  saveBtn: { flex: 2, backgroundColor: '#c8f000', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  saveBtnText: { color: '#07080f', fontSize: 12, fontWeight: '800', letterSpacing: 1.5, fontFamily: 'DMSans_700Bold' },

  viewLive: {
    color: '#c8f000',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'JetBrainsMono_700Bold',
    marginTop: 4,
  },
  emptyCard: { backgroundColor: '#0d0f1c', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.07)', borderRadius: 16, padding: 24, gap: 8 },
  emptyHeading: { color: '#eeeef5', fontSize: 18, fontWeight: '700', fontFamily: 'CormorantGaramond_700Bold' },
  emptyBody: { color: '#4a4f65', fontSize: 13, fontFamily: 'DMSans_400Regular' },
});
