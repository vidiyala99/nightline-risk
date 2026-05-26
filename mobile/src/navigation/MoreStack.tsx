import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MoreScreen } from '../screens/MoreScreen';
import { LiveStack } from './LiveStack';
import { ClaimProposalsStack } from './ClaimProposalsStack';
import { ReportsStack } from './ReportsStack';
import { BrokerVenuesStack } from './BrokerVenuesStack';
import { SubmissionsStack } from './SubmissionsStack';
import { PoliciesStack } from './PoliciesStack';

// Overflow destinations live under the "More" tab as a nested stack rather than
// as hidden tabs — a hidden tab still reserves its flex slot and leaves dead
// horizontal space in the bar. MoreScreen navigates into these by route name.

const Stack = createNativeStackNavigator();

export function OperatorMoreStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreHome" component={MoreScreen} />
      <Stack.Screen name="Live" component={LiveStack} />
      <Stack.Screen name="Proposals" component={ClaimProposalsStack} />
      <Stack.Screen name="Reports" component={ReportsStack} />
    </Stack.Navigator>
  );
}

export function BrokerMoreStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreHome" component={MoreScreen} />
      <Stack.Screen name="Submissions" component={SubmissionsStack} />
      <Stack.Screen name="Policies" component={PoliciesStack} />
      <Stack.Screen name="Venues" component={BrokerVenuesStack} />
      <Stack.Screen name="Proposals" component={ClaimProposalsStack} />
      <Stack.Screen name="Reports" component={ReportsStack} />
    </Stack.Navigator>
  );
}
