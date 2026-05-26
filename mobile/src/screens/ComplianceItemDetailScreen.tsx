import React, { useCallback, useEffect, useState } from 'react';
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
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../api/client';

const SEVERITY_COLOR: Record<string, string> = {
  urgent: Colors.error,
  action_required: Colors.error,
  high: Colors.error,
  medium: Colors.warning,
  low: Colors.textMuted,
};

interface ComplianceItem {
  id: string;
  title?: string;
  description?: string;
  severity?: string;
  priority?: string;
  action?: string;
}

function humanize(id: string) {
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function ComplianceItemDetailScreen({ navigation, route }: any) {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const venueId: string = route?.params?.venueId ?? '';
  const itemId: string = route?.params?.itemId ?? '';
  const passedVenueName: string | undefined = route?.params?.venueName;

  const isBroker = user?.role === 'broker' || user?.role === 'admin';

  const [item, setItem] = useState<ComplianceItem | null>(null);
  const [resolvedVenueName, setResolvedVenueName] = useState<string | undefined>(passedVenueName);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  const venueName = passedVenueName ?? resolvedVenueName;

  const fetchItem = useCallback(async () => {
    if (!venueId || !itemId) { setLoading(false); return; }
    try {
      const raw = await api.request<any>(`/api/venues/${venueId}/live`);
      const queue: ComplianceItem[] = raw.compliance_queue ?? [];
      const found = queue.find(q => q.id === itemId) ?? null;
      setItem(found);
    } catch {
      setItem(null);
    } finally {
      setLoading(false);
    }
  }, [venueId, itemId]);

  useEffect(() => { fetchItem(); }, [fetchItem]);

  useEffect(() => {
    if (passedVenueName || !venueId) return;
    let cancelled = false;
    api.request<{ name?: string }>(`/api/venues/${venueId}`)
      .then(v => { if (!cancelled) setResolvedVenueName(v?.name); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [venueId, passedVenueName]);

  const handleUpload = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsEditing: false,
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: asset.uri,
        name: asset.fileName ?? 'evidence',
        type: asset.mimeType ?? 'application/octet-stream',
      } as any);
      await api.upload(`/api/venues/${venueId}/compliance/${itemId}/upload`, formData);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.goBack();
    } catch {
      setUploading(false);
    }
  };

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator color={Colors.accentInk} /></View>;
  }

  const sev = (item?.severity ?? item?.priority ?? 'low').toLowerCase();
  const sevColor = SEVERITY_COLOR[sev] ?? Colors.textMuted;
  const title = item?.title ?? (item ? humanize(item.id) : 'Compliance Item');
  const description = item?.description ?? item?.action ?? '';

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}
    >
      <Pressable onPress={() => navigation.goBack()} style={styles.backBtn}>
        <Text style={styles.backText}>← {venueName ? `Back to ${venueName}` : 'Back'}</Text>
      </Pressable>

      {!item ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyIcon}>✓</Text>
          <Text style={styles.emptyTitle}>Item not found</Text>
          <Text style={styles.emptySub}>
            This compliance item has been resolved or no longer exists.
          </Text>
        </View>
      ) : (
        <>
          <Text style={styles.eyebrow}>
            {venueName ? venueName.toUpperCase() : 'COMPLIANCE'}
          </Text>
          <Text style={styles.title}>{title}</Text>

          <View style={[styles.card, { borderLeftColor: sevColor }]}>
            <Text style={[styles.severity, { color: sevColor }]}>{sev.toUpperCase()}</Text>
            {!!description && <Text style={styles.description}>{description}</Text>}
            <Text style={styles.itemIdLabel}>ITEM ID</Text>
            <Text style={styles.itemId}>{item.id}</Text>
          </View>

          {!isBroker && (
            <Pressable
              onPress={handleUpload}
              disabled={uploading}
              style={({ pressed }) => [styles.uploadBtn, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.uploadBtnText}>
                {uploading ? 'UPLOADING...' : '↑ UPLOAD EVIDENCE'}
              </Text>
            </Pressable>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },

  backBtn: { paddingVertical: 6 },
  backText: { color: Colors.textSecondary, fontSize: 13, fontFamily: 'DMSans_500Medium' },

  eyebrow: {
    color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2,
    fontFamily: 'JetBrainsMono_700Bold', marginTop: 4,
  },
  title: {
    color: Colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5,
    fontFamily: 'CormorantGaramond_700Bold', marginBottom: 4,
  },

  card: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderLeftWidth: 3,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  severity: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },
  description: { color: Colors.text, fontSize: 15, lineHeight: 22, fontFamily: 'DMSans_400Regular' },
  itemIdLabel: {
    color: Colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5,
    fontFamily: 'JetBrainsMono_700Bold', marginTop: 6,
  },
  itemId: { color: Colors.textSecondary, fontSize: 12, fontFamily: 'JetBrainsMono_400Regular' },

  uploadBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.35)',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  uploadBtnText: { color: Colors.accentInk, fontSize: 12, fontWeight: '700', letterSpacing: 1, fontFamily: 'JetBrainsMono_700Bold' },

  emptyWrap: { alignItems: 'center', paddingTop: 80, gap: 10 },
  emptyIcon: { fontSize: 48, color: Colors.accentInk },
  emptyTitle: { color: Colors.text, fontSize: 20, fontWeight: '700', fontFamily: 'DMSans_700Bold' },
  emptySub: { color: Colors.textMuted, fontSize: 14, textAlign: 'center', paddingHorizontal: 30, fontFamily: 'DMSans_400Regular' },
});
