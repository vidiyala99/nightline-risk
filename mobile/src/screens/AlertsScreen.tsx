/**
 * Liability alerts — mobile counterpart to /alerts on web.
 *
 * Venue-scoped real-time anomaly feed; the operator confirms or dismisses
 * each alert (feedback trains the model). Brokers can pick any book venue;
 * operators see their own venue(s).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { HandAccent } from '../components/HandAccent';
import { Colors } from '../theme/colors';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import {
  alertsApi,
  SEVERITY_LABEL,
  SEVERITY_COLOR,
  type Alert,
  type AlertFeedback,
} from '../api/alerts';
import { Fonts } from '../theme/typography';
import { bySeverity } from '../lib/listSort';

interface VenueLite {
  id: string;
  name: string;
  source?: 'book' | 'prospect';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function AlertsScreen() {
  const { user } = useAuth();

  const [venues, setVenues] = useState<VenueLite[] | null>(null);
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Operator's own venue(s): tenant_id + any extra access. Enrich names from
  // /api/venues when available, but don't depend on it (alerts work off the id).
  useEffect(() => {
    let cancelled = false;
    const ownIds = [user?.tenant_id, ...(user?.extra_venue_ids ?? [])].filter(Boolean) as string[];
    (async () => {
      const all = await api.request<VenueLite[]>('/api/venues').catch(() => [] as VenueLite[]);
      const byId = new Map(all.map((v) => [v.id, v]));
      const list: VenueLite[] = ownIds.map((id) => byId.get(id) ?? { id, name: id });
      if (cancelled) return;
      setVenues(list);
      setSelectedVenueId((prev) => prev ?? list[0]?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const loadAlerts = useCallback(async () => {
    if (!selectedVenueId) return;
    setError(null);
    try {
      setAlerts(await alertsApi.listForVenue(selectedVenueId));
    } catch {
      // Mirror web: a venue with no alert feed degrades to an empty list
      // rather than surfacing a raw backend error.
      setAlerts([]);
    }
  }, [selectedVenueId]);

  useEffect(() => {
    if (selectedVenueId) {
      setAlerts(null);
      loadAlerts();
    }
  }, [selectedVenueId, loadAlerts]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAlerts();
    setRefreshing(false);
  }, [loadAlerts]);

  const onFeedback = useCallback(
    async (alertId: string, feedback: AlertFeedback) => {
      setBusyId(alertId);
      try {
        await alertsApi.sendFeedback(alertId, feedback);
        setAlerts((prev) => (prev ? prev.map((a) => (a.id === alertId ? { ...a, feedback } : a)) : prev));
      } catch {
        // non-fatal; leave state unchanged
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const venueName = useMemo(
    () => venues?.find((v) => v.id === selectedVenueId)?.name ?? selectedVenueId ?? '',
    [venues, selectedVenueId],
  );

  if (venues === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerWrap}>
        <Text style={styles.eyebrow}>ALERTS · {venueName ? venueName.toUpperCase() : 'VENUE'}</Text>
        <Text style={styles.title}>Liability alerts</Text>
        <HandAccent>your safety net</HandAccent>
        <Text style={styles.subtitle}>Real-time detections — confirm or dismiss each.</Text>
      </View>

      {venues.length > 1 && (
        <View style={styles.venueBar}>
          <FlatList
            horizontal
            data={venues}
            keyExtractor={(v) => v.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.venueRow}
            renderItem={({ item: v }) => {
              const active = v.id === selectedVenueId;
              return (
                <Pressable
                  onPress={() => setSelectedVenueId(v.id)}
                  style={[styles.venueChip, active && styles.venueChipActive]}
                >
                  <Text style={[styles.venueChipText, active && styles.venueChipTextActive]} numberOfLines={1}>
                    {v.name}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
      )}

      {venues.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No venue assigned to your account.</Text>
        </View>
      ) : alerts === null ? (
        <View style={styles.center}><ActivityIndicator color={Colors.accentInk} /></View>
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={loadAlerts} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : alerts.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No alerts for this venue. All quiet.</Text>
        </View>
      ) : (
        <FlatList
          data={[...alerts].sort(bySeverity((a) => a.severity, (a) => a.detected_at))}
          keyExtractor={(a) => a.id}
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
          }
          renderItem={({ item }) => (
            <View style={[styles.card, { borderLeftColor: SEVERITY_COLOR[item.severity] }]}>
              <View style={styles.cardTop}>
                <Text style={[styles.sevPill, { color: SEVERITY_COLOR[item.severity] }]}>
                  {SEVERITY_LABEL[item.severity]}
                </Text>
                <Text style={styles.time}>{relativeTime(item.detected_at)}</Text>
              </View>
              <Text style={styles.event}>{titleCase(item.event_type)}</Text>
              <Text style={styles.meta}>
                {titleCase(item.zone)} · {Math.round(item.confidence * 100)}% confidence
              </Text>
              {!!item.description && <Text style={styles.desc}>{item.description}</Text>}

              {item.feedback ? (
                <Text style={styles.resolved}>
                  {item.feedback === 'confirmed' ? '✓ Confirmed' : '✕ Marked false alarm'}
                </Text>
              ) : (
                <View style={styles.actionRow}>
                  <Pressable
                    style={[styles.confirmBtn, busyId === item.id && styles.btnDisabled]}
                    disabled={busyId === item.id}
                    onPress={() => onFeedback(item.id, 'confirmed')}
                  >
                    <Text style={styles.confirmText}>Confirm</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.ghostBtn, busyId === item.id && styles.btnDisabled]}
                    disabled={busyId === item.id}
                    onPress={() => onFeedback(item.id, 'false_alarm')}
                  >
                    <Text style={styles.ghostText}>False alarm</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg, paddingVertical: 40 },
  headerWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 32, lineHeight: 36, color: Colors.text, letterSpacing: -0.5 },
  subtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, fontFamily: Fonts.sansRegular },

  venueBar: { marginTop: 10, marginBottom: 6 },
  venueRow: { paddingHorizontal: 20, gap: 8 },
  venueChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    maxWidth: 180,
  },
  venueChipActive: { borderColor: Colors.accent },
  venueChipText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12 },
  venueChipTextActive: { color: Colors.accentInk },

  card: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderLeftWidth: 3,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  sevPill: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1 },
  time: { fontFamily: Fonts.monoRegular, fontSize: 10, color: Colors.textMuted },
  event: { fontFamily: Fonts.sansSemiBold, fontSize: 16, color: Colors.text },
  meta: { fontFamily: Fonts.monoRegular, fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  desc: { fontFamily: Fonts.sansRegular, fontSize: 13, color: Colors.textSecondary, marginTop: 8, lineHeight: 18 },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  confirmBtn: { flex: 1, backgroundColor: Colors.accent, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  confirmText: { color: Colors.text, fontFamily: Fonts.monoBold, fontSize: 12, letterSpacing: 1 },
  ghostBtn: { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  ghostText: { color: Colors.textSecondary, fontFamily: Fonts.monoBold, fontSize: 12, letterSpacing: 1 },
  btnDisabled: { opacity: 0.4 },
  resolved: { fontFamily: Fonts.sansMedium, fontSize: 12, color: Colors.textSecondary, marginTop: 12 },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: { color: Colors.textSecondary, textAlign: 'center', fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
