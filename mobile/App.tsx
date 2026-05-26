import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';

import { BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque';
import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
} from '@expo-google-fonts/hanken-grotesk';
import {
  SpaceMono_400Regular,
  SpaceMono_700Bold,
} from '@expo-google-fonts/space-mono';
import { Caveat_600SemiBold, Caveat_700Bold } from '@expo-google-fonts/caveat';

import { Colors } from './src/theme/colors';
import { AuthProvider, useAuth } from './src/contexts/AuthContext';
import { TabNavigator } from './src/navigation/TabNavigator';
import { AuthStack } from './src/navigation/AuthStack';
import { ThemedAlertProvider } from './src/components/ThemedAlert';

enableScreens();

function RootNavigator() {
  const { isSignedIn, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg }}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  return isSignedIn ? <TabNavigator /> : <AuthStack />;
}

export default function App() {
  const [fontsLoaded] = useFonts({
    BricolageGrotesque_700Bold,
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
    SpaceMono_400Regular,
    SpaceMono_700Bold,
    Caveat_600SemiBold,
    Caveat_700Bold,
  });

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg }}>
        <ActivityIndicator color={Colors.accentInk} />
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
