import React, { useState } from 'react';
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
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
import { useAlert } from '../components/ThemedAlert';


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
  const alert = useAlert();
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
      alert.show({ title: 'Missing info', message: 'Venue name is required.', variant: 'warning' });
      return;
    }
    if (!isExtra) {
      const tenantId = user?.tenant_id;
      if (!tenantId) {
        alert.show({ title: 'No venue ID', message: 'Please sign out and sign back in.', variant: 'error' });
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
      alert.show({ title: 'Failed to create venue', message: e.message ?? 'Something went wrong', variant: 'error' });
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
              placeholderTextColor={Colors.border}
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
              placeholderTextColor={Colors.border}
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
                placeholderTextColor={Colors.border}
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
                placeholderTextColor={Colors.border}
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
              <ActivityIndicator color={Colors.bg} />
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
  root: { flex: 1, backgroundColor: Colors.bg },
  inner: { paddingHorizontal: 24, paddingTop: 60, paddingBottom: 48, gap: 32 },

  header: { gap: 6 },
  backBtn: { marginBottom: 16 },
  backText: { color: Colors.textMuted, fontSize: 13, fontFamily: 'HankenGrotesk_400Regular' },
  eyebrow: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2.5,
    marginBottom: 4,
    fontFamily: 'SpaceMono_700Bold',
  },
  title: {
    color: Colors.text,
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1.5,
    lineHeight: 42,
    fontFamily: 'BricolageGrotesque_700Bold',
  },
  subtitle: {
    color: Colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
    fontFamily: 'HankenGrotesk_400Regular',
  },

  form: { gap: 16 },
  row: { flexDirection: 'row', gap: 12 },
  inputWrap: { gap: 6 },
  label: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'SpaceMono_700Bold',
  },
  input: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(23,21,15,0.10)',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 16,
    color: Colors.text,
    fontSize: 15,
    fontFamily: 'HankenGrotesk_400Regular',
  },

  typeScroll: { marginTop: 2 },
  typeRow: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  typeChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: Colors.surface,
  },
  typeChipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(200,240,0,0.06)' },
  typeChipText: { color: Colors.textMuted, fontSize: 12, fontFamily: 'HankenGrotesk_400Regular' },
  typeChipTextActive: { color: Colors.accentInk },

  btn: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 17,
    alignItems: 'center',
    marginTop: 8,
  },
  btnPressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: Colors.text, fontWeight: '800', fontSize: 13, letterSpacing: 1.5, fontFamily: 'HankenGrotesk_700Bold' },
});
