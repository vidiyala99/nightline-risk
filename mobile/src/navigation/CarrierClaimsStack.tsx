/**
 * Stack for carrier-side Claims — the Phase 3 entity distinct from
 * ClaimProposal. Broker-only tab; operators don't see this stack.
 *
 * Screens:
 *   CarrierClaimsList     — broker's open carrier-claim portfolio
 *   CarrierClaimDetail    — single claim: status + lifecycle + ledgers
 *   FileFnol              — file FNOL against a policy (full-screen form)
 *   RecordReserve         — record carrier's reserve (bottom sheet)
 *   RecordPayment         — record a payment (bottom sheet)
 *
 * Close + Reopen are inline action sheets from CarrierClaimDetail,
 * not separate screens.
 */
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { CarrierClaimsListScreen } from '../screens/CarrierClaimsListScreen';
import { CarrierClaimDetailScreen } from '../screens/CarrierClaimDetailScreen';
import { FileFnolScreen } from '../screens/FileFnolScreen';
import { RecordReserveScreen } from '../screens/RecordReserveScreen';
import { RecordPaymentScreen } from '../screens/RecordPaymentScreen';

const Stack = createNativeStackNavigator();

export function CarrierClaimsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="CarrierClaimsList" component={CarrierClaimsListScreen} />
      <Stack.Screen name="CarrierClaimDetail" component={CarrierClaimDetailScreen} />
      <Stack.Screen
        name="FileFnol"
        component={FileFnolScreen}
        options={{ presentation: 'card' }}
      />
      <Stack.Screen
        name="RecordReserve"
        component={RecordReserveScreen}
        options={{ presentation: 'modal' }}
      />
      <Stack.Screen
        name="RecordPayment"
        component={RecordPaymentScreen}
        options={{ presentation: 'modal' }}
      />
    </Stack.Navigator>
  );
}
