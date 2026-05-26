import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SubmissionsListScreen } from '../screens/SubmissionsListScreen';
import { SubmissionDetailScreen } from '../screens/SubmissionDetailScreen';
import { NewSubmissionScreen } from '../screens/NewSubmissionScreen';

const Stack = createNativeStackNavigator();

export function SubmissionsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="SubmissionsList" component={SubmissionsListScreen} />
      <Stack.Screen name="SubmissionDetail" component={SubmissionDetailScreen} />
      <Stack.Screen name="NewSubmission" component={NewSubmissionScreen} />
    </Stack.Navigator>
  );
}
