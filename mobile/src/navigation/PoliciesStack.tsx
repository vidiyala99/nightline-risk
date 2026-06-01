import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { PoliciesListScreen } from '../screens/PoliciesListScreen';
import { PolicyDetailScreen } from '../screens/PolicyDetailScreen';
import { EndorsePolicyScreen } from '../screens/EndorsePolicyScreen';
import { IssueCertificateScreen } from '../screens/IssueCertificateScreen';

const Stack = createNativeStackNavigator();

export function PoliciesStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="PoliciesList" component={PoliciesListScreen} />
      <Stack.Screen name="PolicyDetail" component={PolicyDetailScreen} />
      <Stack.Screen name="EndorsePolicy" component={EndorsePolicyScreen} />
      <Stack.Screen name="IssueCertificate" component={IssueCertificateScreen} />
    </Stack.Navigator>
  );
}
