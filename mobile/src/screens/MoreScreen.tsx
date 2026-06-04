import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronRight, Activity, AlertTriangle, CheckSquare, FileText, FileSearch, Building2, FileSpreadsheet, Bell, ListChecks, MapPin, Database, Settings, TrendingUp, Users, Inbox } from 'lucide-react-native';
import { Colors } from '../theme/colors';
import { useAuth } from '../contexts/AuthContext';

type LucideIcon = typeof Activity;
type Row = { route: string; label: string; description: string; icon: LucideIcon };

const OPERATOR_OVERFLOW: Row[] = [
  { route: 'Alerts', label: 'Alerts', description: 'Real-time liability detections', icon: Bell },
  { route: 'Live', label: 'Live Terminal', description: 'Real-time venue floor activity', icon: Activity },
  { route: 'Venues', label: 'Venues', description: 'Your venue profile & roster', icon: Building2 },
  { route: 'Team', label: 'Floor Team', description: 'Staff logins for incident reporting', icon: Users },
  { route: 'CommsReview', label: 'Review Queue', description: 'Triage low-confidence comms signals', icon: Inbox },
  { route: 'Settings', label: 'Settings', description: 'Account and preferences', icon: Settings },
];

const BROKER_OVERFLOW: Row[] = [
  { route: 'Book', label: 'Book Financials', description: 'Premium, commission & loss ratio', icon: TrendingUp },
  { route: 'Policies', label: 'Policies', description: 'Your in-force book', icon: FileSpreadsheet },
  { route: 'Tasks', label: 'Tasks', description: 'Renewals & requests needing attention', icon: ListChecks },
  { route: 'IncidentList', label: 'Incidents', description: 'Operator-filed incidents to review', icon: AlertTriangle },
  { route: 'ComplianceList', label: 'Compliance', description: 'Venue compliance items', icon: CheckSquare },
  { route: 'Venues', label: 'Venues', description: 'Book and prospect venues', icon: Building2 },
  { route: 'Market', label: 'Market', description: 'NYC nightlife prospects & savings', icon: MapPin },
  { route: 'Proposals', label: 'Claim Proposals', description: 'Operator-filed proposals', icon: FileText },
  { route: 'Reports', label: 'Reports', description: 'Underwriting and loss reports', icon: FileSearch },
  { route: 'Ingestion', label: 'Ingestion', description: 'Operational-data connector runs', icon: Database },
  { route: 'CommsReview', label: 'Review Queue', description: 'Triage low-confidence comms signals', icon: Inbox },
  { route: 'Settings', label: 'Settings', description: 'Account and preferences', icon: Settings },
];

export function MoreScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const isBroker = user?.role === 'broker' || user?.role === 'admin';
  const rows = isBroker ? BROKER_OVERFLOW : OPERATOR_OVERFLOW;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: 16, paddingBottom: insets.bottom + 24 }}
    >
      <View style={styles.header}>
        <Text style={styles.eyebrow}>NAVIGATION</Text>
        <Text style={styles.title}>More</Text>
      </View>

      <View style={styles.list}>
        {rows.map(({ route, label, description, icon: Icon }) => (
          <Pressable
            key={route}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => navigation.navigate(route)}
            accessibilityRole="button"
            accessibilityLabel={label}
          >
            <View style={styles.rowIcon}>
              <Icon size={20} color={Colors.accentInk} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{label}</Text>
              <Text style={styles.rowDescription}>{description}</Text>
            </View>
            <ChevronRight size={18} color={Colors.textMuted} />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.bg },
  header: { paddingHorizontal: 20, marginBottom: 16 },
  eyebrow: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'SpaceMono_700Bold',
    marginBottom: 4,
  },
  title: {
    color: Colors.text,
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -1,
    fontFamily: 'BricolageGrotesque_700Bold',
  },
  list: { paddingHorizontal: 16, gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 4,
  },
  rowPressed: { backgroundColor: Colors.surfaceHover },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accentWash,
  },
  rowText: { flex: 1 },
  rowLabel: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
    fontFamily: 'HankenGrotesk_600SemiBold',
  },
  rowDescription: {
    color: Colors.textMuted,
    fontSize: 12,
    marginTop: 2,
    fontFamily: 'HankenGrotesk_400Regular',
  },
});
