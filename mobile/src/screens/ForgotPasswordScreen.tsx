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
  navigation: NativeStackNavigationProp<AuthStackParamList, 'ForgotPassword'>;
};

const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export function ForgotPasswordScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSend() {
    if (!isValidEmail(email)) {
      setError('Enter a valid email address (e.g. you@venue.com).');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await accountApi.forgotPassword(email.trim());
      // Always show the same neutral confirmation (don't leak whether the
      // email is registered) — matches the web copy.
      setSent(true);
    } catch (e: any) {
      setError("Couldn't start the reset. Try again.");
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
          <Text style={styles.title}>Reset password</Text>
          <Text style={styles.sub}>
            Enter your email and we&apos;ll send a reset link.
          </Text>
        </View>

        {sent ? (
          <View style={styles.form}>
            <View style={styles.noticeBanner}>
              <Text style={styles.noticeText}>
                If that email is registered, a reset link has been sent. Open it,
                or paste the code on the next screen.
              </Text>
            </View>
            <Pressable style={styles.btn} onPress={() => navigation.navigate('ResetPassword')}>
              <Text style={styles.btnText}>I HAVE A CODE →</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.form}>
            <View style={styles.inputWrap}>
              <Text style={styles.inputLabel}>EMAIL</Text>
              <TextInput
                style={[styles.input, !!error && styles.inputError]}
                placeholder="operator@venue.com"
                placeholderTextColor={Colors.border}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                value={email}
                onChangeText={(v) => { setEmail(v); if (error) setError(null); }}
                onSubmitEditing={handleSend}
              />
            </View>

            {!!error && (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <Pressable
              style={[styles.btn, loading && styles.btnDisabled]}
              onPress={handleSend}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color={Colors.bg} />
              ) : (
                <Text style={styles.btnText}>SEND RESET LINK</Text>
              )}
            </Pressable>

            <Pressable
              onPress={() => navigation.navigate('ResetPassword')}
              style={styles.subLink}
            >
              <Text style={styles.subLinkText}>Already have a code? Reset here →</Text>
            </Pressable>
          </View>
        )}

        <Pressable onPress={() => navigation.navigate('Login')} style={styles.backLink}>
          <Text style={styles.backLinkText}>← Back to sign in</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 28 },

  head: { gap: 6 },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2.5, fontFamily: 'SpaceMono_700Bold' },
  title: { color: Colors.text, fontSize: 32, letterSpacing: -1, fontFamily: 'BricolageGrotesque_700Bold' },
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
  inputError: { borderColor: 'rgba(255,69,87,0.5)', borderWidth: 1, backgroundColor: 'rgba(255,69,87,0.04)' },

  errorBanner: {
    backgroundColor: 'rgba(255,69,87,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,69,87,0.22)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  errorText: { color: Colors.error, fontSize: 13, lineHeight: 19, fontFamily: 'HankenGrotesk_400Regular' },

  noticeBanner: {
    backgroundColor: 'rgba(200,240,0,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.2)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  noticeText: { color: Colors.text, fontSize: 13, lineHeight: 20, fontFamily: 'HankenGrotesk_400Regular' },

  btn: { backgroundColor: Colors.accent, borderRadius: 10, paddingVertical: 17, alignItems: 'center', marginTop: 4 },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: Colors.text, fontWeight: '800', fontSize: 13, letterSpacing: 1.5, fontFamily: 'HankenGrotesk_700Bold' },

  subLink: { alignItems: 'center', paddingVertical: 4 },
  subLinkText: { color: Colors.accentInk, fontSize: 13, fontFamily: 'HankenGrotesk_400Regular' },

  backLink: { alignItems: 'center', paddingVertical: 4 },
  backLinkText: { color: Colors.textMuted, fontSize: 13, fontFamily: 'HankenGrotesk_400Regular' },
});
