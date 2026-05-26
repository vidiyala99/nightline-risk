import React, { useState } from 'react';
import { Colors } from "../theme/colors";
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
import * as Haptics from 'expo-haptics';
import { useAuth } from '../contexts/AuthContext';
import { AuthStackParamList } from '../navigation/AuthStack';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Login'>;
};

export function LoginScreen({ navigation }: Props) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailTouched, setEmailTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const isValidEmail = (val: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());

  const emailInvalid = emailTouched && email.length > 0 && !isValidEmail(email);

  function clearError() {
    if (error) setError(null);
  }

  async function handleLogin() {
    if (!email || !password) {
      setError('Please enter your email and password.');
      return;
    }
    if (!isValidEmail(email)) {
      setEmailTouched(true);
      setError('Enter a valid email address (e.g. you@venue.com).');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError('Invalid email or password. Check your credentials and try again.');
    } finally {
      setLoading(false);
    }
  }

  const hasError = !!error;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        <View style={styles.brandBlock}>
          <Text style={styles.eyebrow}>RISK OS</Text>
          <Text style={styles.wordmark}>Third{'\n'}Space</Text>
          <Text style={styles.tagline}>Keep venues alive.</Text>
        </View>

        <View style={styles.form}>
          <View style={styles.inputWrap}>
            <Text style={styles.inputLabel}>EMAIL</Text>
            <TextInput
              style={[styles.input, (hasError || emailInvalid) && styles.inputError]}
              placeholder="operator@venue.com"
              placeholderTextColor={Colors.border}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              value={email}
              onChangeText={(v) => { setEmail(v); clearError(); }}
              onBlur={() => setEmailTouched(true)}
            />
            {emailInvalid && (
              <Text style={styles.fieldError}>Enter a valid email (e.g. you@venue.com)</Text>
            )}
          </View>
          <View style={styles.inputWrap}>
            <Text style={styles.inputLabel}>PASSWORD</Text>
            <View style={styles.passwordWrap}>
              <TextInput
                style={[styles.input, styles.passwordInput, hasError && styles.inputError]}
                placeholder="••••••••"
                placeholderTextColor={Colors.border}
                secureTextEntry={!showPassword}
                value={password}
                onChangeText={(v) => { setPassword(v); clearError(); }}
                onSubmitEditing={handleLogin}
              />
              <Pressable onPress={() => setShowPassword(v => !v)} style={styles.eyeBtn}>
                <Text style={styles.eyeText}>{showPassword ? 'HIDE' : 'SHOW'}</Text>
              </Pressable>
            </View>
          </View>

          {hasError && (
            <View style={styles.errorBanner}>
              <View style={styles.errorIconBadge}>
                <Text style={styles.errorIconText}>!</Text>
              </View>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [
              styles.btn,
              hasError && styles.btnErrorState,
              pressed && styles.btnPressed,
              loading && styles.btnDisabled,
            ]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={Colors.bg} />
            ) : (
              <Text style={[styles.btnText, hasError && styles.btnTextError]}>
                SIGN IN
              </Text>
            )}
          </Pressable>
        </View>

        <Pressable onPress={() => navigation.navigate('Register')} style={styles.createLink}>
          <Text style={styles.createLinkText}>Create account →</Text>
        </Pressable>

        <View style={styles.demoSection}>
          <Text style={styles.demoLabel}>DEMO ACCESS</Text>
          <View style={styles.demoRow}>
            <Pressable
              style={({ pressed }) => [styles.demoBtn, pressed && styles.demoBtnPressed]}
              onPress={() => { setEmail('venue@elsewhere.com'); setPassword('demo123'); clearError(); }}
            >
              <Text style={styles.demoBtnRole}>VENUE OPS</Text>
              <Text style={styles.demoBtnSub}>Elsewhere Brooklyn</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.demoBtn, pressed && styles.demoBtnPressed]}
              onPress={() => { setEmail('broker@thirdspace.risk'); setPassword('demo123'); clearError(); }}
            >
              <Text style={styles.demoBtnRole}>BROKER</Text>
              <Text style={styles.demoBtnSub}>Nightline Risk</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  inner: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 28, paddingTop: 80, paddingBottom: 48 },

  brandBlock: { gap: 6 },
  eyebrow: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2.5,
    marginBottom: 8,
    fontFamily: 'SpaceMono_700Bold',
  },
  wordmark: {
    color: Colors.text,
    fontSize: 60,
    fontWeight: '800',
    letterSpacing: -2,
    lineHeight: 58,
    fontFamily: 'BricolageGrotesque_700Bold',
  },
  tagline: {
    color: Colors.accentInk,
    fontSize: 20,
    marginTop: 8,
    fontFamily: 'Caveat_600SemiBold',
  },

  form: { gap: 14 },
  inputWrap: { gap: 6 },
  inputLabel: {
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
  passwordWrap: { position: 'relative' },
  passwordInput: { paddingRight: 64 },
  eyeBtn: { position: 'absolute', right: 16, top: 0, bottom: 0, justifyContent: 'center' },
  eyeText: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },

  inputError: {
    borderColor: 'rgba(255,69,87,0.5)',
    borderWidth: 1,
    backgroundColor: 'rgba(255,69,87,0.04)',
  },
  fieldError: {
    color: Colors.error,
    fontSize: 11,
    fontFamily: 'HankenGrotesk_400Regular',
    marginTop: 2,
  },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: 'rgba(255,69,87,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,69,87,0.22)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  errorIconBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(255,69,87,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  errorIconText: {
    color: Colors.error,
    fontSize: 11,
    fontWeight: '800',
    fontFamily: 'SpaceMono_700Bold',
    lineHeight: 13,
  },
  errorText: {
    flex: 1,
    color: Colors.error,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: 'HankenGrotesk_400Regular',
  },

  btn: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 17,
    alignItems: 'center',
    marginTop: 4,
  },
  btnErrorState: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,69,87,0.4)',
  },
  btnPressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: Colors.text, fontWeight: '800', fontSize: 13, letterSpacing: 1.5, fontFamily: 'HankenGrotesk_700Bold' },
  btnTextError: { color: Colors.error },

  createLink: { alignItems: 'center', paddingVertical: 4 },
  createLinkText: { color: Colors.accentInk, fontSize: 13, fontFamily: 'HankenGrotesk_400Regular' },

  demoSection: { gap: 12 },
  demoLabel: {
    color: Colors.border,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    textAlign: 'center',
    fontFamily: 'SpaceMono_700Bold',
  },
  demoRow: { flexDirection: 'row', gap: 10 },
  demoBtn: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.2)',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 12,
    gap: 2,
  },
  demoBtnPressed: { backgroundColor: 'rgba(200,240,0,0.06)' },
  demoBtnRole: { color: Colors.accentInk, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  demoBtnSub: { color: Colors.textMuted, fontSize: 12, fontFamily: 'HankenGrotesk_400Regular' },
});
