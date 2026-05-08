import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../contexts/AuthContext';

// Venue operator screens
import { DashboardScreen } from '../screens/DashboardScreen';
import { ReportIncidentScreen } from '../screens/ReportIncidentScreen';
import { LiveTerminalScreen } from '../screens/LiveTerminalScreen';
import { IncidentsStack } from './IncidentsStack';

// Broker screens
import { BrokerComplianceScreen } from '../screens/BrokerComplianceScreen';
import { PortfolioStack } from './PortfolioStack';
import { ReportsStack } from './ReportsStack';

const Tab = createBottomTabNavigator();

const VENUE_ICONS: Record<string, { active: string; inactive: string }> = {
  Dashboard: { active: '◈', inactive: '◇' },
  Incidents: { active: '⊞', inactive: '⊟' },
  Report:    { active: '+', inactive: '+' },
  Live:      { active: '◉', inactive: '○' },
};

const BROKER_ICONS: Record<string, { active: string; inactive: string }> = {
  Portfolio:   { active: '◈', inactive: '◇' },
  Reports:     { active: '⊞', inactive: '⊟' },
  Incidents:   { active: '◉', inactive: '○' },
  Compliance:  { active: '✓', inactive: '○' },
};

function TabIcon({ name, focused, isReport }: { name: string; focused: boolean; isReport?: boolean }) {
  if (isReport) {
    return (
      <View style={[tabStyles.reportBtn, focused && tabStyles.reportBtnActive]}>
        <Text style={[tabStyles.reportIcon, focused && tabStyles.reportIconActive]}>+</Text>
      </View>
    );
  }
  const icons = { ...VENUE_ICONS, ...BROKER_ICONS };
  return (
    <Text style={{ fontSize: 16, color: focused ? '#c8f000' : '#ffffff' }}>
      {focused ? (icons[name]?.active ?? '◈') : (icons[name]?.inactive ?? '◇')}
    </Text>
  );
}

function SignOutButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ paddingRight: 20 }}>
      <Text style={{ color: '#8b90a8', fontSize: 10, fontWeight: '700', letterSpacing: 1.5 }}>SIGN OUT</Text>
    </Pressable>
  );
}

const screenOptions = {
  headerShown: false,
  tabBarStyle: {
    backgroundColor: '#0a0b14',
    borderTopColor: 'rgba(255,255,255,0.06)',
    borderTopWidth: StyleSheet.hairlineWidth,
    height: 64,
    paddingBottom: 10,
    paddingTop: 8,
  },
  tabBarActiveTintColor: '#c8f000',
  tabBarInactiveTintColor: '#ffffff',
  tabBarLabelStyle: {
    fontSize: 10,
    fontWeight: '700' as const,
    letterSpacing: 0.5,
    marginTop: 2,
  },
};

function VenueOperatorTabs() {
  const { signOut } = useAuth();
  return (
    <Tab.Navigator screenOptions={({ route }) => ({
      ...screenOptions,
      headerShown: false,
      tabBarIcon: ({ focused }) => (
        <TabIcon name={route.name} focused={focused} isReport={route.name === 'Report'} />
      ),
    })}>
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Incidents" component={IncidentsStack} />
      <Tab.Screen name="Report" component={ReportIncidentScreen} />
      <Tab.Screen name="Live" component={LiveTerminalScreen} />
    </Tab.Navigator>
  );
}

function BrokerTabs() {
  const { signOut } = useAuth();
  return (
    <Tab.Navigator screenOptions={({ route }) => ({
      ...screenOptions,
      headerShown: false,
      tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
    })}>
      <Tab.Screen name="Portfolio" component={PortfolioStack} />
      <Tab.Screen name="Reports" component={ReportsStack} />
      <Tab.Screen name="Incidents" component={IncidentsStack} />
      <Tab.Screen name="Compliance" component={BrokerComplianceScreen} />
    </Tab.Navigator>
  );
}

export function TabNavigator() {
  const { user } = useAuth();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';
  return isBroker ? <BrokerTabs /> : <VenueOperatorTabs />;
}

const tabStyles = StyleSheet.create({
  reportBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: '#0d0f1c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reportBtnActive: { backgroundColor: '#c8f000', borderColor: '#c8f000' },
  reportIcon: { fontSize: 18, color: '#ffffff', lineHeight: 22 },
  reportIconActive: { color: '#07080f' },
});
