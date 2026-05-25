import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { DashboardScreen } from '../screens/DashboardScreen';
import { RiskProfileDetailScreen } from '../screens/RiskProfileDetailScreen';
import { VenueSetupScreen } from '../screens/VenueSetupScreen';
import { CoverageScreen } from '../screens/CoverageScreen';

const Stack = createNativeStackNavigator();

export function DashboardStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="DashboardHome" component={DashboardScreen} />
      <Stack.Screen name="RiskProfileDetail" component={RiskProfileDetailScreen} />
      <Stack.Screen name="VenueSetup" component={VenueSetupScreen} />
      <Stack.Screen name="Coverage" component={CoverageScreen} />
    </Stack.Navigator>
  );
}
