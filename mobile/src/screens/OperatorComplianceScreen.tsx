import React, { useCallback, useState } from 'react';
import { HandAccent } from "../components/HandAccent";
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';
import { pickEvidence } from '../lib/pickEvidence';

const PRIORITY_COLOR: Record<string, string> = {
  urgent: Colors.error,
  action_required: Colors.error,
  high: Colors.error,
  medium: Colors.warning,
  low: Colors.textMuted,
};

interface ComplianceItem {
  id: string;
  action: string;
  priority: string;
}

export function OperatorComplianceScreen({ navigation, route }: any) {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [queue, setQueue] = useState<ComplianceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  // Dashboard's chip-selected venue is forwarded via nav params; fall back to
  // the operator's primary tenant_id when not overridden.
  const venueOverride: string | undefined = route?.params?.venueId;
  const venueId = venueOverride ?? user?.tenant_id ?? null;

  const fetchQueue = useCallback(async () => {
    if (!venueId) { setLoading(false); return; }
    try {
      const raw = await api.request<any>(`/api/venues/${venueId}/live`);
      const items: ComplianceItem[] = (raw.compliance_queue ?? []).map((item: any) => ({
        id: String(item.id ?? ''),
        action: String(item.action ?? item.title ?? item.description ?? ''),
        priority: String(item.priority ?? item.severity ?? 'low').toLowerCase(),
      }));
      setQueue(items);
    } catch {
      // keep stale
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  useFocusEffect(useCallback(() => { fetchQueue(); }, [fetchQueue]));

  const handleUpload = useCallback(async (item: ComplianceItem) => {
    if (!venueId) return;
    const asset = await pickEvidence();
    if (!asset) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setUploadingId(item.id);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: asset.uri,
        name: asset.name,
        type: asset.type,
      } as any);
      await api.upload(`/api/venues/${venueId}/compliance/${item.id}/upload`, formData);
      setQueue(prev => prev.filter(q => q.id !== item.id));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      // keep item on failure
    } finally {
      setUploadingId(null);
    }
  }, [venueId]);

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
    >
      <Text style={styles.eyebrow}>YOUR VENUE</Text>
      <Text style={styles.title}>Compliance</Text>
      <HandAccent>stay in the clear</HandAccent>

      {queue.length === 0 ? (
        <View style={styles.clearCard}>
          <Text style={styles.clearIcon}>✓</Text>
          <Text style={styles.clearTitle}>All Clear</Text>
          <Text style={styles.clearSub}>No pending compliance actions.</Text>
        </View>
      ) : (
        queue.map(item => {
          const color = PRIORITY_COLOR[item.priority] ?? Colors.textMuted;
          return (
            <Pressable
              key={item.id}
              style={({ pressed }) => [
                styles.card,
                { borderLeftColor: color },
                pressed && { opacity: 0.75 },
              ]}
              onPress={() =>
                navigation.navigate('ComplianceDetail', {
                  venueId,
                  itemId: item.id,
                })
              }
            >
              <Text style={[styles.itemId, { color }]}>{item.id}</Text>
              <Text style={styles.itemAction}>{item.action}</Text>
              <View style={styles.cardFooter}>
                <Text style={[styles.severity, { color }]}>{item.priority.toUpperCase()}</Text>
                <Pressable
                  onPress={(e) => { e.stopPropagation(); handleUpload(item); }}
                  disabled={uploadingId === item.id}
                  style={({ pressed }) => [styles.uploadBtn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.uploadBtnText}>
                    {uploadingId === item.id ? 'UPLOADING...' : '↑ UPLOAD EVIDENCE'}
                  </Text>
                </Pressable>
              </View>
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 14 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },

  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold', marginBottom: 4 },
  title: { color: Colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -1, fontFamily: 'BricolageGrotesque_700Bold', marginBottom: 8 },

  clearCard: { alignItems: 'center', paddingTop: 60, gap: 10 },
  clearIcon: { fontSize: 40, color: Colors.accentInk },
  clearTitle: { color: Colors.text, fontSize: 20, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  clearSub: { color: Colors.textMuted, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular' },

  card: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderLeftWidth: 3,
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  itemId: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  itemAction: { color: Colors.textSecondary, fontSize: 14, lineHeight: 20, fontFamily: 'HankenGrotesk_400Regular' },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  severity: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  uploadBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.35)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  uploadBtnText: { color: Colors.accentInk, fontSize: 10, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },
});
