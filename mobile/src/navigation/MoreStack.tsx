import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MoreScreen } from '../screens/MoreScreen';
import { LiveStack } from './LiveStack';
import { ClaimProposalsStack } from './ClaimProposalsStack';
import { ReportsStack } from './ReportsStack';
import { BrokerVenuesStack } from './BrokerVenuesStack';
import { SubmissionsStack } from './SubmissionsStack';
import { PoliciesStack } from './PoliciesStack';
import { TasksScreen } from '../screens/TasksScreen';
import { AlertsScreen } from '../screens/AlertsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { MarketScreen } from '../screens/MarketScreen';
import { IngestionScreen } from '../screens/IngestionScreen';
import { BrokerVenueDetailScreen } from '../screens/BrokerVenueDetailScreen';
import { RiskProfileDetailScreen } from '../screens/RiskProfileDetailScreen';
import { VenueProfileScreen } from '../screens/VenueProfileScreen';
import { IncidentListScreen } from '../screens/IncidentListScreen';
import { IncidentDetailScreen } from '../screens/IncidentDetailScreen';
import { BrokerComplianceScreen } from '../screens/BrokerComplianceScreen';

// Overflow destinations live under the "More" tab as a nested stack rather than
// as hidden tabs — a hidden tab still reserves its flex slot and leaves dead
// horizontal space in the bar. MoreScreen navigates into these by route name.

const Stack = createNativeStackNavigator();

export function OperatorMoreStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreHome" component={MoreScreen} />
      <Stack.Screen name="Alerts" component={AlertsScreen} />
      <Stack.Screen name="Live" component={LiveStack} />
      <Stack.Screen name="Proposals" component={ClaimProposalsStack} />
      <Stack.Screen name="Reports" component={ReportsStack} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
    </Stack.Navigator>
  );
}

export function BrokerMoreStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreHome" component={MoreScreen} />
      <Stack.Screen name="Tasks" component={TasksScreen} />
      <Stack.Screen name="Submissions" component={SubmissionsStack} />
      <Stack.Screen name="Policies" component={PoliciesStack} />
      <Stack.Screen name="Venues" component={BrokerVenuesStack} />
      <Stack.Screen name="Proposals" component={ClaimProposalsStack} />
      <Stack.Screen name="Reports" component={ReportsStack} />
      <Stack.Screen name="Market" component={MarketScreen} />
      <Stack.Screen name="VenueDetail" component={BrokerVenueDetailScreen} />
      <Stack.Screen name="RiskProfileDetail" component={RiskProfileDetailScreen} />
      <Stack.Screen name="VenueProfile" component={VenueProfileScreen} />
      {/* Venue-scoped drill-down targets registered locally so back-stack
          stays on the originating stack (e.g. Risk Profile → Active Incidents
          → back returns to Risk Profile, NOT the Incidents tab root). */}
      <Stack.Screen name="IncidentList" component={IncidentListScreen} />
      <Stack.Screen name="IncidentDetail" component={IncidentDetailScreen} />
      <Stack.Screen name="ComplianceList" component={BrokerComplianceScreen} />
      <Stack.Screen name="Ingestion" component={IngestionScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
    </Stack.Navigator>
  );
}
