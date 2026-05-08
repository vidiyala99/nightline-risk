import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LiveTerminalScreen } from '../screens/LiveTerminalScreen';
import { RiskProfileDetailScreen } from '../screens/RiskProfileDetailScreen';

const Stack = createNativeStackNavigator();

export function LiveStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="LiveHome" component={LiveTerminalScreen} />
      <Stack.Screen name="RiskProfileDetail" component={RiskProfileDetailScreen} />
    </Stack.Navigator>
  );
}
