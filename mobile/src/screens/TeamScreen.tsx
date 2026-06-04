import React, { useCallback, useState } from 'react';
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
import { useFocusEffect } from '@react-navigation/native';

import { Colors } from '../theme/colors';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useAlert } from '../components/ThemedAlert';
import { HandAccent } from '../components/HandAccent';

// The set-password link opens the WEB app's reset page (the staff member taps it
// in their email/SMS). Canonical web URL — see project memory.
const WEB_URL = 'https://nightline-app.vercel.app';

// Operator's "Floor Team" — provision staff logins for the venue and view them.
// Mirrors the web /team page. Each new staff member gets a set-password link.
export function TeamScreen() {
  const { user } = useAuth();
  const alert = useAlert();
  const venueId = user?.tenant_id;

  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [invite, setInvite] = useState<{ name: string; url: string } | null>(null);

  const load = useCallback(async () => {
    if (!venueId) { setLoading(false); return; }
    try {
      const data = await api.request<any[]>(`/api/venues/${venueId}/staff`);
      setStaff(Array.isArray(data) ? data : []);
    } catch {
      // keep stale
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function add() {
    if (!name.trim() || !email.trim()) {
      alert.show({ title: 'Missing info', message: 'Name and email are required.', variant: 'warning' });
      return;
    }
    setSubmitting(true);
    try {
      const data = await api.request<any>(`/api/venues/${venueId}/staff`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      const url = `${WEB_URL}/reset-password?token=${encodeURIComponent(data.set_password_token)}`;
      setInvite({ name: data.name, url });
      setName(''); setEmail('');
      load();
    } catch (e: any) {
      alert.show({ title: 'Could not add', message: e.message ?? 'Failed to add staff.', variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Floor Team</Text>
        <HandAccent>give your staff a login</HandAccent>

        {!venueId ? (
          <Text style={styles.emptySub}>Your account isn't linked to a venue yet.</Text>
        ) : (
          <>
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>NAME</Text>
              <TextInput style={styles.input} placeholder="e.g., Dana Ruiz" placeholderTextColor={Colors.border} value={name} onChangeText={setName} autoCapitalize="words" />
            </View>
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>WORK EMAIL</Text>
              <TextInput style={styles.input} placeholder="name@venue.com" placeholderTextColor={Colors.border} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
            </View>
            <Pressable
              style={({ pressed }) => [styles.addBtn, pressed && styles.addPressed, submitting && { opacity: 0.5 }]}
              onPress={add}
              disabled={submitting}
            >
              {submitting ? <ActivityIndicator color={Colors.text} /> : <Text style={styles.addText}>ADD TO TEAM</Text>}
            </Pressable>

            {invite && (
              <View style={styles.invite}>
                <Text style={styles.inviteTitle}>Set-password link for {invite.name}</Text>
                <Text style={styles.inviteHint}>Send this to {invite.name} so they can sign in. Expires in 1 hour. Long-press to copy.</Text>
                <Text style={styles.inviteUrl} selectable>{invite.url}</Text>
              </View>
            )}

            <Text style={[styles.fieldLabel, { marginTop: 24 }]}>YOUR TEAM · {staff.length}</Text>
            {staff.length > 0 ? staff.map((s) => (
              <View key={s.id} style={styles.staffRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.staffName}>{s.name}</Text>
                  <Text style={styles.staffEmail}>{s.email}</Text>
                </View>
                <View style={styles.staffBadge}><Text style={styles.staffBadgeText}>STAFF</Text></View>
              </View>
            )) : (
              <Text style={styles.emptySub}>No staff yet. Add your floor team above.</Text>
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 40, paddingTop: 8 },
  title: { color: Colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5, fontFamily: 'BricolageGrotesque_700Bold' },
  fieldGroup: { marginTop: 18 },
  fieldLabel: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, marginBottom: 8, fontFamily: 'SpaceMono_700Bold' },
  input: {
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(23,21,15,0.10)',
    borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: Colors.text, fontSize: 15,
    fontFamily: 'HankenGrotesk_400Regular',
  },
  addBtn: { backgroundColor: Colors.accent, borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 18 },
  addPressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  addText: { color: Colors.text, fontWeight: '800', fontSize: 13, letterSpacing: 1.5, fontFamily: 'HankenGrotesk_700Bold' },
  invite: {
    marginTop: 16, padding: 16, borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(200,240,0,0.4)', backgroundColor: 'rgba(200,240,0,0.06)',
  },
  inviteTitle: { color: Colors.text, fontSize: 14, fontWeight: '700', fontFamily: 'HankenGrotesk_600SemiBold' },
  inviteHint: { color: Colors.textSecondary, fontSize: 12, marginTop: 4, fontFamily: 'HankenGrotesk_400Regular' },
  inviteUrl: { color: Colors.textSecondary, fontSize: 11, marginTop: 8, fontFamily: 'SpaceMono_400Regular' },
  copyBtn: { marginTop: 10, alignSelf: 'flex-start', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(200,240,0,0.4)', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  copyText: { color: Colors.accentInk, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  staffRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16, marginTop: 10,
    backgroundColor: Colors.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
  },
  staffName: { color: Colors.text, fontSize: 15, fontWeight: '700', fontFamily: 'HankenGrotesk_600SemiBold' },
  staffEmail: { color: Colors.textMuted, fontSize: 12, marginTop: 2, fontFamily: 'HankenGrotesk_400Regular' },
  staffBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: 'rgba(200,240,0,0.12)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(200,240,0,0.28)' },
  staffBadgeText: { color: Colors.accentInk, fontSize: 9, fontWeight: '700', letterSpacing: 0.8, fontFamily: 'SpaceMono_700Bold' },
  emptySub: { color: Colors.textMuted, fontSize: 14, marginTop: 16, fontFamily: 'HankenGrotesk_400Regular' },
});
