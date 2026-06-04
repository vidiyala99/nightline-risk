import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { WorkQueueScreen } from '../screens/WorkQueueScreen';
import { ClaimProposalsStack } from './ClaimProposalsStack';

// Broker Work Queue as a top-level tab (mirrors /work-queue on web). The triage
// list deep-links into the proposal detail via navigate('Proposals', { screen:
// 'ClaimProposalDetail' }), so the Proposals stack travels inside this tab's
// stack — keeping the back-stack local instead of jumping to the More tab.
const Stack = createNativeStackNavigator();

export function WorkQueueStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="WorkQueueHome" component={WorkQueueScreen} />
      <Stack.Screen name="Proposals" component={ClaimProposalsStack} />
    </Stack.Navigator>
  );
}
