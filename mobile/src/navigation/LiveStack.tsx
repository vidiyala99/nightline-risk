import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LiveTerminalScreen } from '../screens/LiveTerminalScreen';
import { RiskProfileDetailScreen } from '../screens/RiskProfileDetailScreen';
import { VenueProfileScreen } from '../screens/VenueProfileScreen';
import { ComplianceItemDetailScreen } from '../screens/ComplianceItemDetailScreen';

const Stack = createNativeStackNavigator();

export function LiveStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="LiveHome" component={LiveTerminalScreen} />
      <Stack.Screen name="RiskProfileDetail" component={RiskProfileDetailScreen} />
      <Stack.Screen name="VenueProfile" component={VenueProfileScreen} />
      <Stack.Screen name="ComplianceDetail" component={ComplianceItemDetailScreen} />
    </Stack.Navigator>
  );
}
