import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Shield, Eye, EyeOff, LogOut, Check } from 'lucide-react-native';
import { Colors } from '../theme/colors';
import { Fonts } from '../theme/typography';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirrors the web /settings surface: editable profile + change password wired
// to PATCH /api/auth/me and POST /api/auth/me/change-password. 2FA stays an
// honest "SOON" until there's a backend for it.
export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { user, signOut, refreshUser } = useAuth();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';
  const roleLabel = user?.role?.replace(/_/g, ' ') ?? '';

  // ── profile ──
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const nameValid = name.trim().length > 0;
  const emailValid = EMAIL_RE.test(email.trim());
  const dirty = name.trim() !== (user?.name ?? '') || email.trim().toLowerCase() !== (user?.email ?? '').toLowerCase();
  const canSaveProfile = dirty && nameValid && emailValid && !savingProfile;

  const saveProfile = async () => {
    setProfileError(null);
    setSavingProfile(true);
    try {
      await api.request('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      await refreshUser();
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2500);
    } catch (e: any) {
      setProfileError(messageFrom(e, "Couldn't save your changes."));
    } finally {
      setSavingProfile(false);
    }
  };

  // ── password ──
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busyPw, setBusyPw] = useState(false);
  const [pwDone, setPwDone] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const lengthOk = newPw.length >= 6;
  const matchOk = newPw === confirmPw;
  const canChangePw = oldPw.length > 0 && lengthOk && matchOk && !busyPw;

  const changePassword = async () => {
    setPwError(null);
    setBusyPw(true);
    try {
      await api.request('/api/auth/me/change-password', {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      });
      setOldPw(''); setNewPw(''); setConfirmPw('');
      setPwDone(true);
      setTimeout(() => setPwDone(false), 3000);
    } catch (e: any) {
      setPwError(messageFrom(e, "Couldn't change your password."));
    } finally {
      setBusyPw(false);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: 16, paddingBottom: insets.bottom + 24 }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Text style={styles.eyebrow}>SETTINGS · {isBroker ? 'BROKERAGE' : 'VENUE'}</Text>
        <Text style={styles.title}>Account</Text>
      </View>

      {/* Profile */}
      <View style={styles.card}>
        <View style={styles.profileRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(name || user?.name)?.[0]?.toUpperCase() ?? 'U'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName}>{name || 'Your name'}</Text>
            <Text style={styles.profileRole}>{roleLabel}</Text>
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>FULL NAME</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="words"
            autoComplete="name"
          />
          {!nameValid && <Text style={styles.errorText}>Name can't be empty.</Text>}
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>EMAIL</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={Colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />
          {email.trim().length > 0 && !emailValid && <Text style={styles.errorText}>Enter a valid email address.</Text>}
        </View>
        <View style={[styles.field, styles.fieldLast]}>
          <Text style={styles.fieldLabel}>ROLE</Text>
          <Text style={[styles.fieldValue, { textTransform: 'capitalize' }]}>{roleLabel || '—'}</Text>
        </View>

        {profileError && <Text style={styles.errorText}>{profileError}</Text>}
        <Pressable
          style={({ pressed }) => [styles.primaryBtn, (!canSaveProfile) && styles.btnDisabled, pressed && canSaveProfile && styles.primaryBtnPressed]}
          onPress={saveProfile}
          disabled={!canSaveProfile}
          accessibilityRole="button"
          accessibilityLabel="Save profile changes"
          accessibilityState={{ disabled: !canSaveProfile }}
        >
          {savingProfile ? (
            <ActivityIndicator color={Colors.accentInk} size="small" />
          ) : profileSaved ? (
            <><Check size={16} color={Colors.accentInk} /><Text style={styles.primaryBtnText}>Saved</Text></>
          ) : (
            <Text style={styles.primaryBtnText}>Save Changes</Text>
          )}
        </Pressable>
      </View>

      {/* Change password */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>CHANGE PASSWORD</Text>
        <Text style={styles.cardHint}>Use at least 6 characters. You'll stay signed in on this device.</Text>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>CURRENT PASSWORD</Text>
          <TextInput
            style={styles.input}
            value={oldPw}
            onChangeText={setOldPw}
            secureTextEntry={!showPw}
            autoCapitalize="none"
            autoComplete="current-password"
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>NEW PASSWORD</Text>
          <TextInput
            style={styles.input}
            value={newPw}
            onChangeText={setNewPw}
            secureTextEntry={!showPw}
            autoCapitalize="none"
            autoComplete="new-password"
          />
          {newPw.length > 0 && !lengthOk && <Text style={styles.errorText}>Must be at least 6 characters.</Text>}
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>CONFIRM NEW PASSWORD</Text>
          <TextInput
            style={styles.input}
            value={confirmPw}
            onChangeText={setConfirmPw}
            secureTextEntry={!showPw}
            autoCapitalize="none"
            autoComplete="new-password"
          />
          {confirmPw.length > 0 && !matchOk && <Text style={styles.errorText}>Passwords don't match.</Text>}
        </View>

        {pwError && <Text style={styles.errorText}>{pwError}</Text>}

        <View style={styles.pwActions}>
          <Pressable
            style={({ pressed }) => [styles.ghostBtn, pressed && styles.ghostBtnPressed]}
            onPress={() => setShowPw((s) => !s)}
            accessibilityRole="button"
            accessibilityLabel={showPw ? 'Hide passwords' : 'Show passwords'}
          >
            {showPw ? <EyeOff size={15} color={Colors.textSecondary} /> : <Eye size={15} color={Colors.textSecondary} />}
            <Text style={styles.ghostBtnText}>{showPw ? 'Hide' : 'Show'}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, styles.primaryBtnFlex, (!canChangePw) && styles.btnDisabled, pressed && canChangePw && styles.primaryBtnPressed]}
            onPress={changePassword}
            disabled={!canChangePw}
            accessibilityRole="button"
            accessibilityLabel="Change password"
            accessibilityState={{ disabled: !canChangePw }}
          >
            {busyPw ? (
              <ActivityIndicator color={Colors.accentInk} size="small" />
            ) : pwDone ? (
              <><Check size={16} color={Colors.accentInk} /><Text style={styles.primaryBtnText}>Updated</Text></>
            ) : (
              <Text style={styles.primaryBtnText}>Change Password</Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* Security — 2FA not yet wired */}
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

function messageFrom(e: any, fallback: string): string {
  const raw = typeof e?.message === 'string' ? e.message : '';
  // The api client throws the raw response text; surface a parsed FastAPI
  // detail when present, else a friendly fallback.
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.detail === 'string') return parsed.detail;
  } catch {
    /* not JSON */
  }
  return raw && raw.length < 120 ? raw : fallback;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.bg },
  header: { paddingHorizontal: 20, marginBottom: 16 },
  eyebrow: {
    color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2,
    fontFamily: Fonts.monoBold,
  },
  title: {
    color: Colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -1,
    fontFamily: Fonts.displayBold, marginTop: 4,
  },
  card: {
    marginHorizontal: 16, marginBottom: 12, padding: 16, gap: 12,
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle, borderRadius: 14,
  },
  cardHint: { color: Colors.textMuted, fontSize: 12, lineHeight: 17, fontFamily: Fonts.sansRegular, marginTop: -4 },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: {
    width: 56, height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.accentWash, borderWidth: 2, borderColor: Colors.accent,
  },
  avatarText: { color: Colors.accentInk, fontSize: 22, fontWeight: '800', fontFamily: Fonts.displayBold },
  profileName: { color: Colors.text, fontSize: 18, fontWeight: '700', fontFamily: Fonts.sansBold },
  profileRole: {
    color: Colors.textMuted, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase',
    fontFamily: Fonts.monoRegular, marginTop: 2,
  },
  field: {
    gap: 6, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(23,21,15,0.06)',
  },
  fieldLast: {},
  fieldLabel: { color: Colors.textMuted, fontSize: 10, letterSpacing: 1.5, fontFamily: Fonts.monoBold },
  fieldValue: { color: Colors.text, fontSize: 15, fontFamily: Fonts.sansRegular },
  input: {
    minHeight: 44, // touch-friendly-input
    borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: Colors.text,
    fontFamily: Fonts.sansRegular, backgroundColor: Colors.bg,
  },
  errorText: { color: Colors.error, fontSize: 12, lineHeight: 16, fontFamily: Fonts.sansRegular },
  primaryBtn: {
    minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.accent, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 11, marginTop: 4,
  },
  primaryBtnFlex: { flex: 1 },
  primaryBtnPressed: { opacity: 0.85 },
  primaryBtnText: { color: Colors.accentInk, fontSize: 14, fontWeight: '700', fontFamily: Fonts.sansBold },
  btnDisabled: { opacity: 0.4 },
  pwActions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  ghostBtn: {
    minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingHorizontal: 14, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
  },
  ghostBtnPressed: { backgroundColor: Colors.surfaceHover },
  ghostBtnText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '700', fontFamily: Fonts.sansBold },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  infoLabel: { color: Colors.text, fontSize: 15, fontWeight: '600', fontFamily: Fonts.sansSemiBold },
  infoSub: { color: Colors.textMuted, fontSize: 12, marginTop: 2, fontFamily: Fonts.sansRegular },
  soonPill: {
    color: Colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1,
    fontFamily: Fonts.monoBold, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle,
    borderRadius: 4, paddingHorizontal: 6, paddingVertical: 3, overflow: 'hidden',
  },
  signOut: {
    minHeight: 44, marginHorizontal: 16, marginTop: 4, padding: 16, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: `${Colors.error}55`,
  },
  signOutPressed: { backgroundColor: Colors.surfaceHover },
  signOutText: { color: Colors.error, fontSize: 15, fontWeight: '700', fontFamily: Fonts.sansBold },
});
