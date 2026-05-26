import React from 'react';
import { Colors } from "../theme/colors";
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../contexts/AuthContext';

// Venue operator screens
import { DashboardStack } from './DashboardStack';
import { IncidentsStack } from './IncidentsStack';
import { LiveStack } from './LiveStack';
import { VenuesStack } from './VenuesStack';
import { OperatorComplianceStack } from './OperatorComplianceStack';

// Broker screens
import { PortfolioStack } from './PortfolioStack';
import { ReportsStack } from './ReportsStack';
import { BrokerVenuesStack } from './BrokerVenuesStack';
import { BrokerComplianceStack } from './BrokerComplianceStack';

// Claim proposals — both roles
import { ClaimProposalsStack } from './ClaimProposalsStack';

// Carrier-side claims — broker-only (Phase 3)
import { CarrierClaimsStack } from './CarrierClaimsStack';

const Tab = createBottomTabNavigator();

const VENUE_ICONS: Record<string, { active: string; inactive: string }> = {
  Dashboard:  { active: '◈', inactive: '◇' },
  Venues:     { active: '⊟', inactive: '⊞' },
  Incidents:  { active: '!', inactive: '!' },
  Live:       { active: '◉', inactive: '○' },
  Compliance: { active: '✓', inactive: '○' },
  Proposals:  { active: '⊡', inactive: '⊡' },
  Reports:    { active: '⊞', inactive: '⊟' },
};

const BROKER_ICONS: Record<string, { active: string; inactive: string }> = {
  Portfolio:   { active: '◈', inactive: '◇' },
  Reports:     { active: '⊞', inactive: '⊟' },
  Venues:      { active: '⊟', inactive: '⊞' },
  Incidents:   { active: '◉', inactive: '○' },
  Compliance:  { active: '✓', inactive: '○' },
  Proposals:   { active: '⊡', inactive: '⊡' },
  Claims:      { active: '◆', inactive: '◇' },
};

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const icons = { ...VENUE_ICONS, ...BROKER_ICONS };
  return (
    <Text style={{ fontSize: 16, color: focused ? Colors.accentInk : Colors.textMuted }}>
      {focused ? (icons[name]?.active ?? '◈') : (icons[name]?.inactive ?? '◇')}
    </Text>
  );
}

function SignOutButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ paddingRight: 20 }}>
      <Text style={{ color: Colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 }}>SIGN OUT</Text>
    </Pressable>
  );
}

const tabBarStyle = {
  backgroundColor: Colors.tabBar,
  borderTopColor: Colors.borderSubtle,
  borderTopWidth: StyleSheet.hairlineWidth,
  height: 64,
  paddingBottom: 10,
  paddingTop: 8,
};

const headerStyle = {
  backgroundColor: Colors.bg,
  shadowOpacity: 0,
  borderBottomWidth: 0,
  elevation: 0,
};

function VenueOperatorTabs() {
  const { signOut } = useAuth();
  return (
    <Tab.Navigator screenOptions={({ route }) => ({
      headerShown: true,
      headerTitle: '',
      headerStyle,
      headerShadowVisible: false,
      headerRight: () => <SignOutButton onPress={signOut} />,
      tabBarStyle,
      tabBarActiveTintColor: Colors.accentInk,
      tabBarInactiveTintColor: Colors.textMuted,
      tabBarLabelStyle: { fontSize: 10, fontWeight: '700' as const, letterSpacing: 0.5, marginTop: 2 },
      tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
    })}>
      <Tab.Screen name="Dashboard" component={DashboardStack} />
      <Tab.Screen name="Reports" component={ReportsStack} />
      <Tab.Screen name="Incidents" component={IncidentsStack} />
      <Tab.Screen name="Proposals" component={ClaimProposalsStack} />
      <Tab.Screen name="Venues" component={VenuesStack} />
      <Tab.Screen name="Live" component={LiveStack} />
      <Tab.Screen name="Compliance" component={OperatorComplianceStack} />
    </Tab.Navigator>
  );
}

function BrokerTabs() {
  const { signOut } = useAuth();
  return (
    <Tab.Navigator screenOptions={({ route }) => ({
      headerShown: true,
      headerTitle: '',
      headerStyle,
      headerShadowVisible: false,
      headerRight: () => <SignOutButton onPress={signOut} />,
      tabBarStyle,
      tabBarActiveTintColor: Colors.accentInk,
      tabBarInactiveTintColor: Colors.textMuted,
      tabBarLabelStyle: { fontSize: 10, fontWeight: '700' as const, letterSpacing: 0.5, marginTop: 2 },
      tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
    })}>
      <Tab.Screen name="Portfolio" component={PortfolioStack} />
      <Tab.Screen name="Reports" component={ReportsStack} />
      <Tab.Screen name="Claims" component={CarrierClaimsStack} />
      <Tab.Screen name="Proposals" component={ClaimProposalsStack} />
      <Tab.Screen name="Venues" component={BrokerVenuesStack} />
      <Tab.Screen name="Incidents" component={IncidentsStack} />
      <Tab.Screen name="Compliance" component={BrokerComplianceStack} />
    </Tab.Navigator>
  );
}

export function TabNavigator() {
  const { user } = useAuth();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';
  return isBroker ? <BrokerTabs /> : <VenueOperatorTabs />;
}

