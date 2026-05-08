import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { VenuesScreen } from '../screens/VenuesScreen';
import { VenueSetupScreen } from '../screens/VenueSetupScreen';

const Stack = createNativeStackNavigator();

export function VenuesStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="VenuesList" component={VenuesScreen} />
      <Stack.Screen name="VenueSetupExtra" component={VenueSetupScreen} />
    </Stack.Navigator>
  );
}
