import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';


const VENUE_TYPES = [
  'bar',
  'nightclub',
  'music venue and bar',
  'nightclub and performance space',
  'outdoor music venue',
  'outdoor bar and music venue',
  'DIY music venue and bar',
  'restaurant and bar',
  'lounge',
];

export function VenueSetupScreen({ navigation, route }: any) {
  const { user, refreshUser } = useAuth();
  // isExtra=true means this is an additional venue (not the primary tenant_id one)
  const isExtra = route?.params?.isExtra === true;
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [capacity, setCapacity] = useState('');
  const [venueType, setVenueType] = useState('bar');
  const [yearsInOp, setYearsInOp] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!name.trim()) {
      Alert.alert('Missing info', 'Venue name is required');
      return;
    }
    if (!isExtra) {
      const tenantId = user?.tenant_id;
      if (!tenantId) {
        Alert.alert('Error', 'No venue ID found. Please sign out and sign back in.');
        return;
      }
    }
    setLoading(true);
    try {
      const body: Record<string, any> = {
        name: name.trim(),
        address: address.trim(),
        capacity: capacity ? parseInt(capacity, 10) : 300,
        venue_type: venueType,
        years_in_operation: yearsInOp ? parseInt(yearsInOp, 10) : 1,
      };
      if (!isExtra) body.id = user?.tenant_id;
      const result = await api.request<{ id: string }>('/api/venues', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (isExtra) {
        await api.request(`/api/auth/me/extra-venues/${result.id}`, { method: 'POST' });
        await refreshUser();
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Failed to create venue', e.message ?? 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.inner}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
          <Text style={styles.eyebrow}>VENUE SETUP</Text>
          <Text style={styles.title}>Tell us about{'\n'}your venue</Text>
          <Text style={styles.subtitle}>This information powers your risk profile and premium quote.</Text>
        </View>

        <View style={styles.form}>
          <View style={styles.inputWrap}>
            <Text style={styles.label}>VENUE NAME *</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Elsewhere Brooklyn"
              placeholderTextColor="#2e3247"
              autoCapitalize="words"
              value={name}
              onChangeText={setName}
            />
          </View>

          <View style={styles.inputWrap}>
            <Text style={styles.label}>ADDRESS</Text>
            <TextInput
              style={styles.input}
              placeholder="599 Johnson Ave, Brooklyn, NY"
              placeholderTextColor="#2e3247"
              value={address}
              onChangeText={setAddress}
            />
          </View>

          <View style={styles.row}>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.label}>CAPACITY</Text>
              <TextInput
                style={styles.input}
                placeholder="300"
                placeholderTextColor="#2e3247"
                keyboardType="numeric"
                value={capacity}
                onChangeText={setCapacity}
              />
            </View>
            <View style={[styles.inputWrap, { flex: 1 }]}>
              <Text style={styles.label}>YEARS OPEN</Text>
              <TextInput
                style={styles.input}
                placeholder="1"
                placeholderTextColor="#2e3247"
                keyboardType="numeric"
                value={yearsInOp}
                onChangeText={setYearsInOp}
              />
            </View>
          </View>

          <View style={styles.inputWrap}>
            <Text style={styles.label}>VENUE TYPE</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.typeScroll}>
              <View style={styles.typeRow}>
                {VENUE_TYPES.map((type) => (
                  <Pressable
                    key={type}
                    style={[styles.typeChip, venueType === type && styles.typeChipActive]}
                    onPress={() => setVenueType(type)}
                  >
                    <Text style={[styles.typeChipText, venueType === type && styles.typeChipTextActive]}>
                      {type}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          </View>

          <Pressable
            style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, loading && styles.btnDisabled]}
            onPress={handleCreate}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#07080f" />
            ) : (
              <Text style={styles.btnText}>CREATE VENUE</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07080f' },
  inner: { paddingHorizontal: 24, paddingTop: 60, paddingBottom: 48, gap: 32 },

  header: { gap: 6 },
  backBtn: { marginBottom: 16 },
  backText: { color: '#4a4f65', fontSize: 13, fontFamily: 'DMSans_400Regular' },
  eyebrow: {
    color: '#4a4f65',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2.5,
    marginBottom: 4,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  title: {
    color: '#eeeef5',
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1.5,
    lineHeight: 42,
    fontFamily: 'CormorantGaramond_700Bold',
  },
  subtitle: {
    color: '#4a4f65',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
    fontFamily: 'DMSans_400Regular',
  },

  form: { gap: 16 },
  row: { flexDirection: 'row', gap: 12 },
  inputWrap: { gap: 6 },
  label: {
    color: '#4a4f65',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  input: {
    backgroundColor: '#0d0f1c',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 16,
    color: '#eeeef5',
    fontSize: 15,
    fontFamily: 'DMSans_400Regular',
  },

  typeScroll: { marginTop: 2 },
  typeRow: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  typeChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#0d0f1c',
  },
  typeChipActive: { borderColor: '#c8f000', backgroundColor: 'rgba(200,240,0,0.06)' },
  typeChipText: { color: '#4a4f65', fontSize: 12, fontFamily: 'DMSans_400Regular' },
  typeChipTextActive: { color: '#c8f000' },

  btn: {
    backgroundColor: '#c8f000',
    borderRadius: 10,
    paddingVertical: 17,
    alignItems: 'center',
    marginTop: 8,
  },
  btnPressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#07080f', fontWeight: '800', fontSize: 13, letterSpacing: 1.5, fontFamily: 'DMSans_700Bold' },
});
