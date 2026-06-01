import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { BrokerPortfolioScreen } from '../screens/BrokerPortfolioScreen';
import { BrokerVenueDetailScreen } from '../screens/BrokerVenueDetailScreen';
import { RiskProfileDetailScreen } from '../screens/RiskProfileDetailScreen';
import { VenueProfileScreen } from '../screens/VenueProfileScreen';
import { RenewalsScreen } from '../screens/RenewalsScreen';
import { PolicyRequestsScreen } from '../screens/PolicyRequestsScreen';
import { IncidentListScreen } from '../screens/IncidentListScreen';
import { IncidentDetailScreen } from '../screens/IncidentDetailScreen';
import { BrokerComplianceScreen } from '../screens/BrokerComplianceScreen';
import { LossRunScreen } from '../screens/LossRunScreen';

const Stack = createNativeStackNavigator();

export function PortfolioStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="PortfolioList" component={BrokerPortfolioScreen} />
      <Stack.Screen name="VenueDetail" component={BrokerVenueDetailScreen} />
      <Stack.Screen name="RiskProfileDetail" component={RiskProfileDetailScreen} />
      <Stack.Screen name="VenueProfile" component={VenueProfileScreen} />
      {/* Venue-scoped drill-down targets registered locally so the back-stack
          stays inside this stack (Risk Profile → Active Incidents → back =
          Risk Profile, not the Incidents tab root). */}
      <Stack.Screen name="IncidentList" component={IncidentListScreen} />
      <Stack.Screen name="IncidentDetail" component={IncidentDetailScreen} />
      <Stack.Screen name="ComplianceList" component={BrokerComplianceScreen} />
      <Stack.Screen name="LossRun" component={LossRunScreen} />
      <Stack.Screen name="Renewals" component={RenewalsScreen} />
      <Stack.Screen name="PolicyRequests" component={PolicyRequestsScreen} />
    </Stack.Navigator>
  );
}
