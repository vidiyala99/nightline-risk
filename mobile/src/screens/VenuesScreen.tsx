import React, { useCallback, useState } from 'react';
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';
import { useAlert } from '../components/ThemedAlert';

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
  onDelete,
  onPress,
}: {
  venue: VenueData;
  isPrimary: boolean;
  onSave: (id: string, updates: Partial<VenueData>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onPress: () => void;
}) {
  const alert = useAlert();
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
      alert.show({ title: 'Save failed', message: e.message ?? 'Something went wrong', variant: 'error' });
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
            <TextInput style={styles.input} value={name} onChangeText={setName} placeholderTextColor={Colors.border} />
          </View>
          <View style={styles.inputWrap}>
            <Text style={styles.label}>ADDRESS</Text>
            <TextInput style={styles.input} value={address} onChangeText={setAddress} placeholderTextColor={Colors.border} />
          </View>
          <View style={styles.editRow}>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.label}>CAPACITY</Text>
              <TextInput style={styles.input} value={capacity} onChangeText={setCapacity} keyboardType="numeric" placeholderTextColor={Colors.border} />
            </View>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.label}>YEARS OPEN</Text>
              <TextInput style={styles.input} value={yearsInOp} onChangeText={setYearsInOp} keyboardType="numeric" placeholderTextColor={Colors.border} />
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
              {saving ? <ActivityIndicator color={Colors.bg} size="small" /> : <Text style={styles.saveBtnText}>SAVE</Text>}
            </Pressable>
          </View>
          {!isPrimary && (
            <Pressable
              style={styles.deleteBtn}
              onPress={() =>
                alert.show({
                  title: 'Delete venue?',
                  message: `Are you sure you want to delete "${venue.name}"? This cannot be undone.`,
                  variant: 'warning',
                  buttons: [
                    { label: 'Cancel', style: 'cancel' },
                    { label: 'Delete', style: 'destructive', onPress: () => onDelete(venue.id) },
                  ],
                })
              }
            >
              <Text style={styles.deleteBtnText}>DELETE VENUE</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

export function VenuesScreen({ navigation }: any) {
  const { user, refreshUser } = useAuth();
  const alert = useAlert();
  const insets = useSafeAreaInsets();
  const [venues, setVenues] = useState<VenueData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadVenues = useCallback(async () => {
    if (!user?.tenant_id) { setLoading(false); return; }
    try {
      const primary = await api.request<VenueData>(`/api/venues/${user.tenant_id}`);
      const extraIds: string[] = user.extra_venue_ids ?? [];
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
  }, [user?.tenant_id, user?.extra_venue_ids]);

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

  async function handleDelete(venueId: string) {
    try {
      await api.request(`/api/venues/${venueId}`, { method: 'DELETE' });
      await api.request(`/api/auth/me/extra-venues/${venueId}`, { method: 'DELETE' });
      await refreshUser();
      setVenues((prev) => prev.filter((v) => v.id !== venueId));
    } catch (e: any) {
      alert.show({ title: 'Cannot delete', message: e.message ?? 'Something went wrong', variant: 'error' });
    }
  }

  function onRefresh() {
    setRefreshing(true);
    loadVenues();
  }

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>YOUR VENUES</Text>
          <Text style={styles.title}>Properties</Text>
        </View>
        <Pressable
          style={styles.addBtn}
          onPress={() => navigation.navigate('VenueSetupExtra', { isExtra: true })}
        >
          <Text style={styles.addBtnText}>+ ADD</Text>
        </Pressable>
      </View>

      {venues.length === 0 ? (
        <Pressable
          style={styles.emptyCard}
          onPress={() => navigation.navigate('VenueSetupExtra', { isExtra: true })}
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
            onDelete={handleDelete}
            onPress={() => navigation.navigate('Live')}
          />
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 32, gap: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold', marginBottom: 4 },
  title: { color: Colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -1, fontFamily: 'CormorantGaramond_700Bold' },
  addBtn: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(200,240,0,0.4)', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  addBtnText: { color: Colors.accentInk, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },

  card: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(23,21,15,0.10)',
    borderRadius: 16,
    padding: 20,
    gap: 16,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardHeaderLeft: { flex: 1, gap: 4 },
  primaryBadge: { color: Colors.accentInk, fontSize: 9, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  venueName: { color: Colors.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.5, fontFamily: 'CormorantGaramond_700Bold' },
  venueId: { color: Colors.border, fontSize: 10, fontFamily: 'JetBrainsMono_400Regular' },
  editBtn: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(23,21,15,0.14)', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  editBtnText: { color: Colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },

  detailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  detailItem: { flex: 1, minWidth: '40%', gap: 2 },
  detailLabel: { color: Colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  detailValue: { color: Colors.text, fontSize: 14, fontFamily: 'DMSans_400Regular' },

  editForm: { gap: 14 },
  editRow: { flexDirection: 'row', gap: 12 },
  inputWrap: { gap: 6 },
  label: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold' },
  input: {
    backgroundColor: Colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(23,21,15,0.10)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: Colors.text,
    fontSize: 14,
    fontFamily: 'DMSans_400Regular',
  },
  typeRow: { flexDirection: 'row', gap: 8 },
  typeChip: { borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: Colors.bg },
  typeChipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(200,240,0,0.06)' },
  typeChipText: { color: Colors.textMuted, fontSize: 12, fontFamily: 'DMSans_400Regular' },
  typeChipTextActive: { color: Colors.accentInk },
  editActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  cancelBtn: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  cancelBtnText: { color: Colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1, fontFamily: 'JetBrainsMono_700Bold' },
  saveBtn: { flex: 2, backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  saveBtnText: { color: Colors.bg, fontSize: 12, fontWeight: '800', letterSpacing: 1.5, fontFamily: 'DMSans_700Bold' },

  deleteBtn: {
    marginTop: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,80,80,0.3)',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  deleteBtnText: {
    color: Colors.error,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  viewLive: {
    color: Colors.accentInk,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'JetBrainsMono_700Bold',
    marginTop: 4,
  },
  emptyCard: { backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, borderRadius: 16, padding: 24, gap: 8 },
  emptyHeading: { color: Colors.text, fontSize: 18, fontWeight: '700', fontFamily: 'CormorantGaramond_700Bold' },
  emptyBody: { color: Colors.textMuted, fontSize: 13, fontFamily: 'DMSans_400Regular' },
});
