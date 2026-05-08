import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { BrokerReportsScreen } from '../screens/BrokerReportsScreen';
import { BrokerReportDetailScreen } from '../screens/BrokerReportDetailScreen';

const Stack = createNativeStackNavigator();

export function ReportsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="ReportsList" component={BrokerReportsScreen} />
      <Stack.Screen name="ReportDetail" component={BrokerReportDetailScreen} />
    </Stack.Navigator>
  );
}
