import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { OperatorClaimsScreen } from '../screens/OperatorClaimsScreen';
import { IncidentDetailScreen } from '../screens/IncidentDetailScreen';
import { ClaimDetailScreen } from '../screens/ClaimDetailScreen';

const Stack = createNativeStackNavigator();

// Operator "Claims" tab — the claim-status tracker (mirrors web /claims operator
// branch). A claim row drills into the incident's "where this stands" view, which
// can open the proposal's ClaimDetail; both registered here so Back stays in the
// Claims tab rather than jumping to Incidents (back-stack integrity).
export function OperatorClaimsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="OperatorClaims" component={OperatorClaimsScreen} />
      <Stack.Screen name="IncidentDetail" component={IncidentDetailScreen} />
      <Stack.Screen name="ClaimDetail" component={ClaimDetailScreen} />
    </Stack.Navigator>
  );
}
