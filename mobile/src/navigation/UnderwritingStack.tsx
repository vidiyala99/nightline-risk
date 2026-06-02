/**
 * Stack for the carrier underwriting desk (carrier persona, Phase 1).
 *
 * Screens:
 *   UnderwritingDesk      — submissions awaiting the carrier's decision
 *   UnderwriteDecision    — quote-at-terms / decline for one submission
 */
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { UnderwritingDeskScreen } from '../screens/UnderwritingDeskScreen';
import { UnderwriteDecisionScreen } from '../screens/UnderwriteDecisionScreen';

const Stack = createNativeStackNavigator();

export function UnderwritingStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="UnderwritingDesk" component={UnderwritingDeskScreen} />
      <Stack.Screen name="UnderwriteDecision" component={UnderwriteDecisionScreen} />
    </Stack.Navigator>
  );
}
