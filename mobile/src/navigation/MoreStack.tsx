import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MoreScreen } from '../screens/MoreScreen';
import { LiveStack } from './LiveStack';
import { ClaimProposalsStack } from './ClaimProposalsStack';
import { ReportsStack } from './ReportsStack';
import { BrokerVenuesStack } from './BrokerVenuesStack';
import { PoliciesStack } from './PoliciesStack';
import { TasksScreen } from '../screens/TasksScreen';
import { BookScreen } from '../screens/BookScreen';
import { CarrierDetailScreen } from '../screens/CarrierDetailScreen';
import { VenuesStack } from './VenuesStack';
import { AlertsScreen } from '../screens/AlertsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TeamScreen } from '../screens/TeamScreen';
import { MarketScreen } from '../screens/MarketScreen';
import { IngestionScreen } from '../screens/IngestionScreen';
import { BrokerVenueDetailScreen } from '../screens/BrokerVenueDetailScreen';
import { RiskProfileDetailScreen } from '../screens/RiskProfileDetailScreen';
import { VenueProfileScreen } from '../screens/VenueProfileScreen';
import { IncidentListScreen } from '../screens/IncidentListScreen';
import { IncidentDetailScreen } from '../screens/IncidentDetailScreen';
import { ReportIncidentScreen } from '../screens/ReportIncidentScreen';
import { BrokerComplianceScreen } from '../screens/BrokerComplianceScreen';
import { LossRunScreen } from '../screens/LossRunScreen';
import { CommsReviewScreen } from '../screens/CommsReviewScreen';
import { CopilotScreen } from '../screens/CopilotScreen';

// Overflow destinations live under the "More" tab as a nested stack rather than
// as hidden tabs — a hidden tab still reserves its flex slot and leaves dead
// horizontal space in the bar. MoreScreen navigates into these by route name.

const Stack = createNativeStackNavigator();

export function OperatorMoreStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreHome" component={MoreScreen} />
      <Stack.Screen name="Copilot" component={CopilotScreen} />
      <Stack.Screen name="Alerts" component={AlertsScreen} />
      <Stack.Screen name="Live" component={LiveStack} />
      <Stack.Screen name="Venues" component={VenuesStack} />
      <Stack.Screen name="Team" component={TeamScreen} />
      <Stack.Screen name="CommsReview" component={CommsReviewScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
    </Stack.Navigator>
  );
}

export function BrokerMoreStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreHome" component={MoreScreen} />
      <Stack.Screen name="Book" component={BookScreen} />
      <Stack.Screen name="CarrierDetail" component={CarrierDetailScreen} />
      <Stack.Screen name="Tasks" component={TasksScreen} />
      <Stack.Screen name="Policies" component={PoliciesStack} />
      <Stack.Screen name="Venues" component={BrokerVenuesStack} />
      <Stack.Screen name="Proposals" component={ClaimProposalsStack} />
      <Stack.Screen name="Reports" component={ReportsStack} />
      <Stack.Screen name="Market" component={MarketScreen} />
      <Stack.Screen name="VenueDetail" component={BrokerVenueDetailScreen} />
      <Stack.Screen name="RiskProfileDetail" component={RiskProfileDetailScreen} />
      <Stack.Screen name="LossRun" component={LossRunScreen} />
      <Stack.Screen name="VenueProfile" component={VenueProfileScreen} />
      {/* Incidents/Compliance live here now (demoted from broker tabs): the
          MoreScreen rows open IncidentList/ComplianceList unscoped (= all
          items), and these same routes serve venue-scoped drill-down from Risk
          Profile etc. so its back-stack stays local. ReportIncident is the
          IncidentList "report" affordance and must be registered alongside. */}
      <Stack.Screen name="IncidentList" component={IncidentListScreen} />
      <Stack.Screen name="IncidentDetail" component={IncidentDetailScreen} />
      <Stack.Screen name="ReportIncident" component={ReportIncidentScreen} />
      <Stack.Screen name="ComplianceList" component={BrokerComplianceScreen} />
      <Stack.Screen name="Ingestion" component={IngestionScreen} />
      <Stack.Screen name="CommsReview" component={CommsReviewScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
    </Stack.Navigator>
  );
}
