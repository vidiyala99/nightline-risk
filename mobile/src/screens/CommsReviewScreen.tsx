import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Inbox, Check, X, AlertTriangle } from 'lucide-react-native';

import { Colors } from '../theme/colors';
import { api } from '../api/client';
import { useAlert } from '../components/ThemedAlert';

interface ReviewItem {
  id: string;
  venue_id: string;
  source: string;
  raw_text: string;
  proposed_kind: string;
  confidence: number;
  rationale: string | null;
}

type Decision = 'confirm' | 'correct' | 'dismiss';
type Kind = 'incident' | 'compliance' | 'noise';

// Comms connectors review queue — low-confidence classifications from Slack,
// tickets, and texts. Mirrors web frontend/src/app/comms-review/page.tsx:
// GET /api/comms/review, then POST /api/comms/review/{id}/resolve with
// {decision, kind?}. On resolve, the item drops out of the list. Read on focus.
export function CommsReviewScreen() {
  const { show } = useAlert();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.request<ReviewItem[]>('/api/comms/review');
      setItems(Array.isArray(data) ? data : []);
    } catch {
      // keep stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const resolve = useCallback(
    async (id: string, decision: Decision, kind?: Kind) => {
      setResolving(id);
      try {
        await api.request(`/api/comms/review/${id}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ decision, kind }),
        });
        setItems((prev) => prev.filter((i) => i.id !== id));
      } catch (e: any) {
        show({
          title: 'Could not resolve',
          message: e?.message || 'Failed to resolve this signal.',
          variant: 'error',
        });
      } finally {
        setResolving(null);
      }
    },
    [show],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>REVIEW QUEUE · COMMS</Text>
        <Text style={styles.title}>Triage signals</Text>
        <Text style={styles.sub}>
          Low-confidence classifications from Slack, tickets, and texts — confirm,
          correct, or dismiss.
        </Text>
      </View>

      <FlatList
        data={[...items].sort((a, b) => a.confidence - b.confidence)}
        keyExtractor={(i) => i.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor={Colors.accent}
          />
        }
        renderItem={({ item }) => {
          const busy = resolving === item.id;
          return (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardIcon}>
                  <Inbox size={18} color={Colors.accentInk} />
                </View>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {item.proposed_kind} · {Math.round(item.confidence * 100)}%
                  </Text>
                </View>
              </View>

              <Text style={styles.rawText}>{item.raw_text}</Text>

              <View style={styles.meta}>
                <Text style={styles.metaText}>{item.source}</Text>
                {!!item.rationale && (
                  <Text style={styles.metaText} numberOfLines={2}>
                    {item.rationale}
                  </Text>
                )}
              </View>

              <View style={styles.actions}>
                <Pressable
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnPrimary,
                    (pressed || busy) && styles.btnPressed,
                  ]}
                  disabled={busy}
                  onPress={() => resolve(item.id, 'confirm')}
                  accessibilityRole="button"
                  accessibilityLabel={`Confirm ${item.proposed_kind}`}
                >
                  <Check size={14} color={Colors.bg} />
                  <Text style={[styles.btnLabel, styles.btnLabelPrimary]}>
                    Confirm {item.proposed_kind}
                  </Text>
                </Pressable>

                <Pressable
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnGhost,
                    (pressed || busy) && styles.btnPressed,
                  ]}
                  disabled={busy}
                  onPress={() => resolve(item.id, 'correct', 'incident')}
                  accessibilityRole="button"
                  accessibilityLabel="Mark as incident"
                >
                  <AlertTriangle size={14} color={Colors.text} />
                  <Text style={styles.btnLabel}>Incident</Text>
                </Pressable>

                <Pressable
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnGhost,
                    (pressed || busy) && styles.btnPressed,
                  ]}
                  disabled={busy}
                  onPress={() => resolve(item.id, 'correct', 'compliance')}
                  accessibilityRole="button"
                  accessibilityLabel="Mark as compliance"
                >
                  <Text style={styles.btnLabel}>Compliance</Text>
                </Pressable>

                <Pressable
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnGhost,
                    (pressed || busy) && styles.btnPressed,
                  ]}
                  disabled={busy}
                  onPress={() => resolve(item.id, 'dismiss')}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss"
                >
                  <X size={14} color={Colors.text} />
                  <Text style={styles.btnLabel}>Dismiss</Text>
                </Pressable>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Inbox size={40} color={Colors.textMuted} />
            <Text style={styles.emptyTitle}>Queue clear</Text>
            <Text style={styles.emptySub}>No comms signals waiting for review.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },
  header: { paddingHorizontal: 20, paddingBottom: 16, gap: 6, paddingTop: 8 },
  eyebrow: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: 'SpaceMono_700Bold',
  },
  title: {
    color: Colors.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
    fontFamily: 'BricolageGrotesque_700Bold',
  },
  sub: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19, fontFamily: 'HankenGrotesk_400Regular' },
  list: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderLeftWidth: 3,
    borderLeftColor: Colors.warning,
    padding: 16,
    gap: 10,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardIcon: {
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accentWash,
  },
  badge: {
    backgroundColor: 'rgba(180,83,9,0.12)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: {
    color: Colors.warning,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
    fontFamily: 'SpaceMono_700Bold',
  },
  rawText: { color: Colors.text, fontSize: 14, lineHeight: 20, fontFamily: 'HankenGrotesk_400Regular' },
  meta: { gap: 2 },
  metaText: { color: Colors.textMuted, fontSize: 11, fontWeight: '600', fontFamily: 'SpaceMono_400Regular' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  btnPrimary: { backgroundColor: Colors.accentInk, borderColor: Colors.accentInk },
  btnGhost: { backgroundColor: 'transparent', borderColor: Colors.border },
  btnPressed: { opacity: 0.6 },
  btnLabel: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
    fontFamily: 'HankenGrotesk_600SemiBold',
  },
  btnLabelPrimary: { color: Colors.bg },
  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyTitle: { color: Colors.text, fontSize: 18, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
  emptySub: { color: Colors.textMuted, fontSize: 14, textAlign: 'center', fontFamily: 'HankenGrotesk_400Regular' },
});
