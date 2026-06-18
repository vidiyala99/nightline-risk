import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { DashboardScreen } from '../screens/DashboardScreen';
import { RiskProfileDetailScreen } from '../screens/RiskProfileDetailScreen';
import { VenueProfileScreen } from '../screens/VenueProfileScreen';
import { VenueSetupScreen } from '../screens/VenueSetupScreen';
import { CoverageScreen } from '../screens/CoverageScreen';
import { IncidentDetailScreen } from '../screens/IncidentDetailScreen';
import { ComplianceItemDetailScreen } from '../screens/ComplianceItemDetailScreen';

const Stack = createNativeStackNavigator();

export function DashboardStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="DashboardHome" component={DashboardScreen} />
      <Stack.Screen name="RiskProfileDetail" component={RiskProfileDetailScreen} />
      <Stack.Screen name="VenueProfile" component={VenueProfileScreen} />
      <Stack.Screen name="VenueSetup" component={VenueSetupScreen} />
      <Stack.Screen name="Coverage" component={CoverageScreen} />
      {/* Registered locally so the exposure feed's findings drill in within the
          dashboard stack (coherent back-stack, no cross-tab jumps). */}
      <Stack.Screen name="IncidentDetail" component={IncidentDetailScreen} />
      <Stack.Screen name="ComplianceDetail" component={ComplianceItemDetailScreen} />
    </Stack.Navigator>
  );
}
