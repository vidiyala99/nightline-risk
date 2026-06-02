/**
 * Stack for the carrier adjuster desk (carrier persona, Phase 2).
 *
 * Screens:
 *   AdjusterQueue       — claims assigned to the carrier for adjudication
 *   AdjusterClaimDetail — decide coverage → reserve → payments → close
 */
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { AdjusterQueueScreen } from '../screens/AdjusterQueueScreen';
import { AdjusterClaimDetailScreen } from '../screens/AdjusterClaimDetailScreen';

const Stack = createNativeStackNavigator();

export function AdjustingStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="AdjusterQueue" component={AdjusterQueueScreen} />
      <Stack.Screen name="AdjusterClaimDetail" component={AdjusterClaimDetailScreen} />
    </Stack.Navigator>
  );
}
