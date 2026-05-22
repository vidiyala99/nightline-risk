/**
 * Stack for operator-side ClaimProposals (the AI-recommendation surface,
 * distinct from carrier-side Claims which live in CarrierClaimsStack).
 * Renamed from ClaimsStack on 2026-05-22 to match the web vocabulary
 * split — see ADR-0004.
 */
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ClaimsListScreen } from '../screens/ClaimsListScreen';
import { ClaimDetailScreen } from '../screens/ClaimDetailScreen';

const Stack = createNativeStackNavigator();

export function ClaimProposalsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="ClaimProposalsList" component={ClaimsListScreen} />
      <Stack.Screen name="ClaimProposalDetail" component={ClaimDetailScreen} />
    </Stack.Navigator>
  );
}
