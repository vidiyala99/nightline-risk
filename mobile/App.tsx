import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';

import {
  CormorantGaramond_700Bold,
  CormorantGaramond_600SemiBold_Italic,
} from '@expo-google-fonts/cormorant-garamond';

import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';

import {
  JetBrainsMono_400Regular,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';

import { AuthProvider, useAuth } from './src/contexts/AuthContext';
import { TabNavigator } from './src/navigation/TabNavigator';
import { AuthStack } from './src/navigation/AuthStack';
import { ThemedAlertProvider } from './src/components/ThemedAlert';

enableScreens();

function RootNavigator() {
  const { isSignedIn, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#07080f' }}>
        <ActivityIndicator color="#c8f000" />
      </View>
    );
  }

  return isSignedIn ? <TabNavigator /> : <AuthStack />;
}

export default function App() {
  const [fontsLoaded] = useFonts({
    CormorantGaramond_700Bold,
    CormorantGaramond_600SemiBold_Italic,
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_700Bold,
  });

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#07080f' }}>
        <ActivityIndicator color="#c8f000" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <ThemedAlertProvider>
        <AuthProvider>
          <NavigationContainer>
            <StatusBar style="dark" />
            <RootNavigator />
          </NavigationContainer>
        </AuthProvider>
      </ThemedAlertProvider>
    </SafeAreaProvider>
  );
}
