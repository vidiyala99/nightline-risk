import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { BrokerPortfolioScreen } from '../screens/BrokerPortfolioScreen';
import { BrokerVenueDetailScreen } from '../screens/BrokerVenueDetailScreen';
import { RiskProfileDetailScreen } from '../screens/RiskProfileDetailScreen';
import { RenewalsScreen } from '../screens/RenewalsScreen';

const Stack = createNativeStackNavigator();

export function PortfolioStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="PortfolioList" component={BrokerPortfolioScreen} />
      <Stack.Screen name="VenueDetail" component={BrokerVenueDetailScreen} />
      <Stack.Screen name="RiskProfileDetail" component={RiskProfileDetailScreen} />
      <Stack.Screen name="Renewals" component={RenewalsScreen} />
    </Stack.Navigator>
  );
}
