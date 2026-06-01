import React from 'react';
import { Colors } from '../theme/colors';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  LayoutDashboard,
  AlertTriangle,
  CheckSquare,
  Building2,
  FileSpreadsheet,
  Menu,
} from 'lucide-react-native';
import { useAuth } from '../contexts/AuthContext';

// Venue operator screens
import { DashboardStack } from './DashboardStack';
import { IncidentsStack } from './IncidentsStack';
import { OperatorClaimsStack } from './OperatorClaimsStack';
import { OperatorComplianceStack } from './OperatorComplianceStack';

// Broker screens
import { PortfolioStack } from './PortfolioStack';
import { BrokerComplianceStack } from './BrokerComplianceStack';

// Carrier-side claims — broker-only (Phase 3)
import { CarrierClaimsStack } from './CarrierClaimsStack';

// More overflow — nested stacks (Live/Proposals/Reports/Venues live here)
import { OperatorMoreStack, BrokerMoreStack } from './MoreStack';

// Mobile bottom nav — role-aware primary set capped at 5 (4 destinations + More).
// Keep in sync with the web bottom nav in
// frontend/src/components/layout/MobileBottomNav.tsx (same order, icons, labels).

const Tab = createBottomTabNavigator();

type LucideIcon = typeof LayoutDashboard;

const ICONS: Record<string, LucideIcon> = {
  Dashboard: LayoutDashboard,
  Portfolio: LayoutDashboard,
  Incidents: AlertTriangle,
  Compliance: CheckSquare,
  Venues: Building2,
  Claims: FileSpreadsheet,
  More: Menu,
};

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const Icon = ICONS[name] ?? Menu;
  return (
    <View style={[styles.iconPill, focused && styles.iconPillActive]}>
      <Icon size={20} color={focused ? Colors.accentInk : Colors.textSecondary} />
    </View>
  );
}

// Route name -> display label. Route names stay stable (other navigation code
// references "Portfolio"); only the visible label is role-aware. Keep brokers'
// home labeled "The Book" to match the web sidebar and bottom nav.
const TAB_LABELS: Record<string, string> = {
  Portfolio: 'The Book',
};

// Auto-shrinks to fit the tab cell instead of truncating with an ellipsis,
// so full words ("COMPLIANCE", "THE BOOK") render at any device font scale.
function TabLabel({ name, color }: { name: string; color: string }) {
  return (
    <Text
      numberOfLines={1}
      adjustsFontSizeToFit
      allowFontScaling={false}
      style={[styles.tabLabel, { color }]}
    >
      {TAB_LABELS[name] ?? name}
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

const headerStyle = {
  backgroundColor: Colors.bg,
  shadowOpacity: 0,
  borderBottomWidth: 0,
  elevation: 0,
};

function useScreenOptions(signOut: () => void) {
  const insets = useSafeAreaInsets();
  // Content band sized to the icon pill + label; the gesture-area inset is the
  // only thing reserved below it, so there is no extra dead space in the bar.
  const tabBarStyle = {
    backgroundColor: Colors.surfaceElevated,
    borderTopColor: Colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    height: 54 + insets.bottom,
    paddingTop: 6,
    paddingBottom: insets.bottom,
  };
  return ({ route }: { route: { name: string } }) => ({
    headerShown: true,
    headerTitle: '',
    headerStyle,
    headerShadowVisible: false,
    headerRight: () => <SignOutButton onPress={signOut} />,
    tabBarStyle,
    tabBarItemStyle: { paddingHorizontal: 0 },
    tabBarActiveTintColor: Colors.accentInk,
    tabBarInactiveTintColor: Colors.textSecondary,
    tabBarIcon: ({ focused }: { focused: boolean }) => <TabIcon name={route.name} focused={focused} />,
    tabBarLabel: ({ color }: { color: string }) => <TabLabel name={route.name} color={color} />,
  });
}

function VenueOperatorTabs() {
  const { signOut } = useAuth();
  return (
    <Tab.Navigator screenOptions={useScreenOptions(signOut)}>
      <Tab.Screen name="Dashboard" component={DashboardStack} />
      <Tab.Screen name="Incidents" component={IncidentsStack} />
      <Tab.Screen name="Claims" component={OperatorClaimsStack} />
      <Tab.Screen name="Compliance" component={OperatorComplianceStack} />
      <Tab.Screen name="More" component={OperatorMoreStack} />
    </Tab.Navigator>
  );
}

function BrokerTabs() {
  const { signOut } = useAuth();
  return (
    <Tab.Navigator screenOptions={useScreenOptions(signOut)}>
      <Tab.Screen name="Portfolio" component={PortfolioStack} />
      <Tab.Screen name="Incidents" component={IncidentsStack} />
      <Tab.Screen name="Claims" component={CarrierClaimsStack} />
      <Tab.Screen name="Compliance" component={BrokerComplianceStack} />
      <Tab.Screen name="More" component={BrokerMoreStack} />
    </Tab.Navigator>
  );
}

export function TabNavigator() {
  const { user } = useAuth();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';
  return isBroker ? <BrokerTabs /> : <VenueOperatorTabs />;
}

const styles = StyleSheet.create({
  tabLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.2,
    textTransform: 'uppercase',
    textAlign: 'center',
    width: '100%',
    paddingHorizontal: 2,
    marginTop: 3,
  },
  iconPill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
  },
  iconPillActive: {
    backgroundColor: Colors.accentWash,
  },
});
