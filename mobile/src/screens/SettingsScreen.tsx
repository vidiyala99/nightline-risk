import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Shield, KeyRound, LogOut } from 'lucide-react-native';
import { Colors } from '../theme/colors';
import { useAuth } from '../contexts/AuthContext';

// Mirrors the web /settings surface (frontend/src/app/settings/page.tsx): a
// read-only profile plus account actions. Web's "save" is mocked and nothing
// persists, so this screen only wires the one real action — Sign Out.
export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';
  const roleLabel = user?.role?.replace(/_/g, ' ') ?? '';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: 16, paddingBottom: insets.bottom + 24 }}
    >
      <View style={styles.header}>
        <Text style={styles.eyebrow}>SETTINGS · {isBroker ? 'BROKERAGE' : 'VENUE'}</Text>
        <Text style={styles.title}>Account</Text>
      </View>

      {/* Profile */}
      <View style={styles.card}>
        <View style={styles.profileRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{user?.name?.[0]?.toUpperCase() ?? 'U'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName}>{user?.name ?? 'You'}</Text>
            <Text style={styles.profileRole}>{roleLabel}</Text>
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>FULL NAME</Text>
          <Text style={styles.fieldValue}>{user?.name ?? '—'}</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>EMAIL</Text>
          <Text style={styles.fieldValue}>{user?.email ?? '—'}</Text>
        </View>
        <View style={[styles.field, styles.fieldLast]}>
          <Text style={styles.fieldLabel}>ROLE</Text>
          <Text style={[styles.fieldValue, { textTransform: 'capitalize' }]}>{roleLabel || '—'}</Text>
        </View>
      </View>

      {/* Security — informational, mirrors the web cards (not yet wired). */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>SECURITY</Text>
        <View style={styles.infoRow}>
          <Shield size={18} color={Colors.accentInk} />
          <View style={{ flex: 1 }}>
            <Text style={styles.infoLabel}>Two-Factor Authentication</Text>
            <Text style={styles.infoSub}>Add an extra layer of security</Text>
          </View>
          <Text style={styles.soonPill}>SOON</Text>
        </View>
        <View style={[styles.infoRow, styles.infoRowLast]}>
          <KeyRound size={18} color={Colors.accentInk} />
          <View style={{ flex: 1 }}>
            <Text style={styles.infoLabel}>Password</Text>
            <Text style={styles.infoSub}>Last changed never</Text>
          </View>
          <Text style={styles.soonPill}>SOON</Text>
        </View>
      </View>

      {/* Account */}
      <Pressable
        style={({ pressed }) => [styles.signOut, pressed && styles.signOutPressed]}
        onPress={signOut}
        accessibilityRole="button"
        accessibilityLabel="Sign out"
      >
        <LogOut size={18} color={Colors.error} />
        <Text style={styles.signOutText}>Sign Out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.bg },
  header: { paddingHorizontal: 20, marginBottom: 16 },
  eyebrow: {
    color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2,
    fontFamily: 'SpaceMono_700Bold',
  },
  title: {
    color: Colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -1,
    fontFamily: 'BricolageGrotesque_700Bold', marginTop: 4,
  },
  card: {
    marginHorizontal: 16, marginBottom: 12, padding: 16, gap: 12,
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle, borderRadius: 14,
  },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: {
    width: 56, height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.accentWash, borderWidth: 2, borderColor: Colors.accent,
  },
  avatarText: { color: Colors.accentInk, fontSize: 22, fontWeight: '800', fontFamily: 'BricolageGrotesque_700Bold' },
  profileName: { color: Colors.text, fontSize: 18, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  profileRole: {
    color: Colors.textMuted, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase',
    fontFamily: 'SpaceMono_400Regular', marginTop: 2,
  },
  field: {
    gap: 4, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)',
  },
  fieldLast: {},
  fieldLabel: { color: Colors.textMuted, fontSize: 10, letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  fieldValue: { color: Colors.text, fontSize: 15, fontFamily: 'HankenGrotesk_400Regular' },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  infoRowLast: { paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)' },
  infoLabel: { color: Colors.text, fontSize: 15, fontWeight: '600', fontFamily: 'HankenGrotesk_600SemiBold' },
  infoSub: { color: Colors.textMuted, fontSize: 12, marginTop: 2, fontFamily: 'HankenGrotesk_400Regular' },
  soonPill: {
    color: Colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1,
    fontFamily: 'SpaceMono_700Bold', borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
    borderRadius: 4, paddingHorizontal: 6, paddingVertical: 3, overflow: 'hidden',
  },
  signOut: {
    marginHorizontal: 16, marginTop: 4, padding: 16, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: `${Colors.error}55`,
  },
  signOutPressed: { backgroundColor: Colors.surfaceHover },
  signOutText: { color: Colors.error, fontSize: 15, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
});
