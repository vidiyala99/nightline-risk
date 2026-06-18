import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { BrokerVenuesScreen } from '../screens/BrokerVenuesScreen';
import { BrokerVenueDetailScreen } from '../screens/BrokerVenueDetailScreen';
import { RiskProfileDetailScreen } from '../screens/RiskProfileDetailScreen';
import { VenueProfileScreen } from '../screens/VenueProfileScreen';
import { IncidentListScreen } from '../screens/IncidentListScreen';
import { IncidentDetailScreen } from '../screens/IncidentDetailScreen';
import { BrokerComplianceScreen } from '../screens/BrokerComplianceScreen';
import { ComplianceItemDetailScreen } from '../screens/ComplianceItemDetailScreen';
import { LossRunScreen } from '../screens/LossRunScreen';

const Stack = createNativeStackNavigator();

export function BrokerVenuesStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="BrokerVenuesList" component={BrokerVenuesScreen} />
      <Stack.Screen name="VenueDetail" component={BrokerVenueDetailScreen} />
      {/* Full venue drill-down registered locally so the back-stack stays
          coherent inside THE BOOK stack (no cross-tab jumps to the Incidents
          tab root, no "where did my back go" surprises). */}
      <Stack.Screen name="RiskProfileDetail" component={RiskProfileDetailScreen} />
      <Stack.Screen name="VenueProfile" component={VenueProfileScreen} />
      <Stack.Screen name="IncidentList" component={IncidentListScreen} />
      <Stack.Screen name="IncidentDetail" component={IncidentDetailScreen} />
      <Stack.Screen name="ComplianceList" component={BrokerComplianceScreen} />
      <Stack.Screen name="ComplianceDetail" component={ComplianceItemDetailScreen} />
      <Stack.Screen name="LossRun" component={LossRunScreen} />
    </Stack.Navigator>
  );
}
