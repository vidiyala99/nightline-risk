import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Colors } from '../theme/colors';
import { accountApi } from '../api/account';
import { AuthStackParamList } from '../navigation/AuthStack';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'ResetPassword'>;
};

export function ResetPasswordScreen({ navigation }: Props) {
  const [token, setToken] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lengthOk = newPw.length >= 6;
  const matchOk = newPw === confirmPw;
  const canSubmit = !!token.trim() && lengthOk && matchOk && !loading;

  async function handleSubmit() {
    setError(null);
    if (!token.trim()) { setError('Paste the reset code from your email.'); return; }
    if (!lengthOk) { setError('Password must be at least 6 characters.'); return; }
    if (!matchOk) { setError("Passwords don't match."); return; }
    setLoading(true);
    try {
      await accountApi.resetPassword(token.trim(), newPw);
      // Bounce back to sign-in; user logs in with the new password.
      navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
    } catch (e: any) {
      setError("Couldn't reset your password. The code may be invalid or expired.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        <View style={styles.head}>
          <Text style={styles.eyebrow}>RISK OS</Text>
          <Text style={styles.title}>Set a new password</Text>
          <Text style={styles.sub}>Paste the code from your reset email, then choose a new password.</Text>
        </View>

        <View style={styles.form}>
          <View style={styles.inputWrap}>
            <Text style={styles.inputLabel}>RESET CODE</Text>
            <TextInput
              style={styles.input}
              placeholder="paste from email"
              placeholderTextColor={Colors.border}
              autoCapitalize="none"
              autoCorrect={false}
              value={token}
              onChangeText={(v) => { setToken(v); if (error) setError(null); }}
            />
          </View>

          <View style={styles.inputWrap}>
            <Text style={styles.inputLabel}>NEW PASSWORD</Text>
            <View style={styles.passwordWrap}>
              <TextInput
                style={[styles.input, styles.passwordInput]}
                placeholder="••••••••"
                placeholderTextColor={Colors.border}
                secureTextEntry={!showPw}
                value={newPw}
                onChangeText={(v) => { setNewPw(v); if (error) setError(null); }}
              />
              <Pressable onPress={() => setShowPw(v => !v)} style={styles.eyeBtn}>
                <Text style={styles.eyeText}>{showPw ? 'HIDE' : 'SHOW'}</Text>
              </Pressable>
            </View>
            {newPw.length > 0 && !lengthOk && (
              <Text style={styles.fieldError}>Must be at least 6 characters.</Text>
            )}
          </View>

          <View style={styles.inputWrap}>
            <Text style={styles.inputLabel}>CONFIRM PASSWORD</Text>
            <TextInput
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={Colors.border}
              secureTextEntry={!showPw}
              value={confirmPw}
              onChangeText={(v) => { setConfirmPw(v); if (error) setError(null); }}
              onSubmitEditing={handleSubmit}
            />
            {confirmPw.length > 0 && !matchOk && (
              <Text style={styles.fieldError}>Passwords don&apos;t match.</Text>
            )}
          </View>

          {!!error && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Pressable
            style={[styles.btn, !canSubmit && styles.btnDisabled]}
            onPress={handleSubmit}
            disabled={!canSubmit}
          >
            {loading ? (
              <ActivityIndicator color={Colors.bg} />
            ) : (
              <Text style={styles.btnText}>RESET PASSWORD</Text>
            )}
          </Pressable>
        </View>

        <Pressable onPress={() => navigation.navigate('Login')} style={styles.backLink}>
          <Text style={styles.backLinkText}>← Back to sign in</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 24 },

  head: { gap: 6 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2.5, fontFamily: 'SpaceMono_700Bold' },
  title: { color: Colors.text, fontSize: 30, letterSpacing: -1, fontFamily: 'BricolageGrotesque_700Bold' },
  sub: { color: Colors.textSecondary, fontSize: 14, lineHeight: 20, fontFamily: 'HankenGrotesk_400Regular' },

  form: { gap: 14 },
  inputWrap: { gap: 6 },
  inputLabel: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
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
  passwordWrap: { position: 'relative' },
  passwordInput: { paddingRight: 64 },
  eyeBtn: { position: 'absolute', right: 16, top: 0, bottom: 0, justifyContent: 'center' },
  eyeText: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  fieldError: { color: Colors.error, fontSize: 11, fontFamily: 'HankenGrotesk_400Regular', marginTop: 2 },

  errorBanner: {
    backgroundColor: 'rgba(255,69,87,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,69,87,0.22)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  errorText: { color: Colors.error, fontSize: 13, lineHeight: 19, fontFamily: 'HankenGrotesk_400Regular' },

  btn: { backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 17, alignItems: 'center', marginTop: 4 },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: Colors.text, fontWeight: '800', fontSize: 13, letterSpacing: 1.5, fontFamily: 'HankenGrotesk_700Bold' },

  backLink: { alignItems: 'center', paddingVertical: 4 },
  backLinkText: { color: Colors.textMuted, fontSize: 13, fontFamily: 'HankenGrotesk_400Regular' },
});
