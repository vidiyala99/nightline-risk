import React, { useCallback, useState } from 'react';
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
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';

const PRIORITY_COLOR: Record<string, string> = {
  urgent: '#ff4557',
  action_required: '#ff4557',
  high: '#ff4557',
  medium: '#ff9500',
  low: '#4a4f65',
};

interface ComplianceItem {
  id: string;
  action: string;
  priority: string;
}

export function OperatorComplianceScreen({ route }: any) {
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
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsEditing: false,
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setUploadingId(item.id);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: asset.uri,
        name: asset.fileName ?? 'evidence',
        type: asset.mimeType ?? 'application/octet-stream',
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
    return <View style={styles.centered}><ActivityIndicator color="#c8f000" /></View>;
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
    >
      <Text style={styles.eyebrow}>YOUR VENUE</Text>
      <Text style={styles.title}>Compliance</Text>

      {queue.length === 0 ? (
        <View style={styles.clearCard}>
          <Text style={styles.clearIcon}>✓</Text>
          <Text style={styles.clearTitle}>All Clear</Text>
          <Text style={styles.clearSub}>No pending compliance actions.</Text>
        </View>
      ) : (
        queue.map(item => {
          const color = PRIORITY_COLOR[item.priority] ?? '#4a4f65';
          return (
            <View key={item.id} style={[styles.card, { borderLeftColor: color }]}>
              <Text style={[styles.itemId, { color }]}>{item.id}</Text>
              <Text style={styles.itemAction}>{item.action}</Text>
              <View style={styles.cardFooter}>
                <Text style={[styles.severity, { color }]}>{item.priority.toUpperCase()}</Text>
                <Pressable
                  onPress={() => handleUpload(item)}
                  disabled={uploadingId === item.id}
                  style={({ pressed }) => [styles.uploadBtn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.uploadBtnText}>
                    {uploadingId === item.id ? 'UPLOADING...' : '↑ UPLOAD EVIDENCE'}
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07080f' },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 14 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#07080f' },

  eyebrow: { color: '#4a4f65', fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'JetBrainsMono_700Bold', marginBottom: 4 },
  title: { color: '#eeeef5', fontSize: 32, fontWeight: '800', letterSpacing: -1, fontFamily: 'CormorantGaramond_700Bold', marginBottom: 8 },

  clearCard: { alignItems: 'center', paddingTop: 60, gap: 10 },
  clearIcon: { fontSize: 40, color: '#c8f000' },
  clearTitle: { color: '#eeeef5', fontSize: 20, fontWeight: '700', fontFamily: 'DMSans_700Bold' },
  clearSub: { color: '#4a4f65', fontSize: 14, fontFamily: 'DMSans_400Regular' },

  card: {
    backgroundColor: '#0d0f1c',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)',
    borderLeftWidth: 3,
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  itemId: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },
  itemAction: { color: '#8b90a8', fontSize: 14, lineHeight: 20, fontFamily: 'DMSans_400Regular' },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  severity: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },
  uploadBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.35)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  uploadBtnText: { color: '#c8f000', fontSize: 10, fontWeight: '700', letterSpacing: 1, fontFamily: 'JetBrainsMono_700Bold' },
});
