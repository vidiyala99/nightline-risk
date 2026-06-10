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
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../contexts/AuthContext';
import { AuthStackParamList } from '../navigation/AuthStack';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Register'>;
};

const isValidEmail = (val: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());

export function RegisterScreen({ navigation }: Props) {
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const emailInvalid = emailTouched && email.length > 0 && !isValidEmail(email);
  const passwordShort = passwordTouched && password.length > 0 && password.length < 6;

  function clearError() {
    if (error) setError(null);
  }

  async function handleRegister() {
    if (!name.trim()) {
      setError('Please enter your full name.');
      return;
    }
    if (!email.trim() || !isValidEmail(email)) {
      setEmailTouched(true);
      setError('Enter a valid email address (e.g. you@venue.com).');
      return;
    }
    if (password.length < 6) {
      setPasswordTouched(true);
      setError('Password must be at least 6 characters.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Public sign-up always creates a venue operator; the backend ignores any
      // client role (escalation guard). Privileged accounts are provisioned out-of-band.
      await signUp(email.trim(), password, name.trim(), 'venue_operator');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg: string = e.message ?? '';
      if (msg.toLowerCase().includes('already exists')) {
        setError('An account with this email already exists. Try signing in.');
      } else {
        setError('Registration failed. Please try again.');
      }
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
      <ScrollView
        contentContainerStyle={styles.inner}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brandBlock}>
          <Text style={styles.eyebrow}>RISK OS</Text>
          <Text style={styles.wordmark}>Create{'\n'}Account</Text>
          <Text style={styles.tagline}>Join the network.</Text>
        </View>

        <View style={styles.form}>
          <View style={styles.inputWrap}>
            <Text style={styles.inputLabel}>FULL NAME</Text>
            <TextInput
              style={styles.input}
              placeholder="Your name"
              placeholderTextColor={Colors.border}
              autoCapitalize="words"
              value={name}
              onChangeText={(v) => { setName(v); clearError(); }}
            />
          </View>

          <View style={styles.inputWrap}>
            <Text style={styles.inputLabel}>EMAIL</Text>
            <TextInput
              style={[styles.input, (hasError || emailInvalid) && styles.inputError]}
              placeholder="you@venue.com"
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
                style={[styles.input, styles.passwordInput, (hasError || passwordShort) && styles.inputError]}
                placeholder="Min. 6 characters"
                placeholderTextColor={Colors.border}
                secureTextEntry={!showPassword}
                value={password}
                onChangeText={(v) => { setPassword(v); clearError(); }}
                onBlur={() => setPasswordTouched(true)}
              />
              <Pressable onPress={() => setShowPassword(v => !v)} style={styles.eyeBtn}>
                <Text style={styles.eyeText}>{showPassword ? 'HIDE' : 'SHOW'}</Text>
              </Pressable>
            </View>
            {passwordShort && (
              <Text style={styles.fieldError}>At least 6 characters required</Text>
            )}
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
            onPress={handleRegister}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={Colors.bg} />
            ) : (
              <Text style={[styles.btnText, hasError && styles.btnTextError]}>
                CREATE ACCOUNT
              </Text>
            )}
          </Pressable>
        </View>

        <Pressable onPress={() => navigation.goBack()} style={styles.backLink}>
          <Text style={styles.backLinkText}>← Already have an account? Sign in</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  inner: { paddingHorizontal: 28, paddingTop: 80, paddingBottom: 48, gap: 40 },

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
    fontSize: 52,
    fontWeight: '800',
    letterSpacing: -2,
    lineHeight: 52,
    fontFamily: 'BricolageGrotesque_700Bold',
  },
  tagline: {
    color: Colors.accentInk,
    fontSize: 20,
    marginTop: 8,
    fontFamily: 'Caveat_600SemiBold',
  },

  form: { gap: 16 },
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

  backLink: { alignItems: 'center', paddingVertical: 8 },
  backLinkText: { color: Colors.textMuted, fontSize: 13, fontFamily: 'HankenGrotesk_400Regular' },
});
