/**
 * Broker tasks — mobile counterpart to /tasks on web.
 *
 * Prioritized "needs your attention" feed: renewals coming due + pending
 * operator requests. Each row deep-links to where it gets actioned
 * (Renewals or Policy Requests, both in the Portfolio tab).
 */
import React, { useCallback, useState } from 'react';
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
import { useFocusEffect } from '@react-navigation/native';

import { tasksApi, URGENCY_LABEL, URGENCY_COLOR, type BrokerTask } from '../api/tasks';
import { Fonts } from '../theme/typography';

function taskTitle(t: BrokerTask): string {
  return t.kind === 'renewal' ? `Renewal — ${t.title}` : `${t.title} request`;
}

function taskSubtitle(t: BrokerTask): string {
  if (t.kind === 'renewal') {
    const d = t.days_until ?? 0;
    const when = d <= 0 ? `expired ${-d}d ago` : `expires in ${d}d`;
    return `${t.venue_id} · ${when}${t.due_date ? ` (${t.due_date})` : ''}`;
  }
  return `${t.venue_id}${t.note ? ` · ${t.note}` : ''}`;
}

export function TasksScreen({ navigation }: any) {
  const [tasks, setTasks] = useState<BrokerTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTasks(await tasksApi.list());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load tasks');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const openTask = (t: BrokerTask) =>
    navigation.navigate('Portfolio', {
      screen: t.kind === 'renewal' ? 'Renewals' : 'PolicyRequests',
    });

  if (tasks === null && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentInk} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerWrap}>
        <Text style={styles.eyebrow}>BROKER · TO-DO</Text>
        <Text style={styles.title}>Tasks</Text>
        <HandAccent>most urgent first</HandAccent>
        <Text style={styles.subtitle}>Renewals coming due and requests awaiting your decision.</Text>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : tasks!.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Nothing needs your attention right now. You&rsquo;re caught up.</Text>
        </View>
      ) : (
        <FlatList
          data={tasks!}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
          }
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => openTask(item)}>
              <View style={[styles.rail, { backgroundColor: URGENCY_COLOR[item.urgency] }]} />
              <View style={styles.body}>
                <Text style={styles.rowTitle} numberOfLines={1}>{taskTitle(item)}</Text>
                <Text style={styles.rowSub} numberOfLines={1}>{taskSubtitle(item)}</Text>
              </View>
              <Text style={[styles.urgencyPill, { color: URGENCY_COLOR[item.urgency] }]}>
                {URGENCY_LABEL[item.urgency]}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  headerWrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  eyebrow: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1.4, color: Colors.textSecondary, marginBottom: 6 },
  title: { fontFamily: Fonts.displayBold, fontSize: 32, lineHeight: 36, color: Colors.text, letterSpacing: -0.5 },
  subtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, fontFamily: Fonts.sansRegular },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    overflow: 'hidden',
  },
  rail: { width: 4, alignSelf: 'stretch' },
  body: { flex: 1, paddingVertical: 14, paddingHorizontal: 14 },
  rowTitle: { fontFamily: Fonts.sansSemiBold, fontSize: 15, color: Colors.text },
  rowSub: { fontFamily: Fonts.monoRegular, fontSize: 11, color: Colors.textMuted, marginTop: 3 },
  urgencyPill: { fontFamily: Fonts.monoBold, fontSize: 10, letterSpacing: 1, paddingRight: 14 },

  empty: { padding: 32, alignItems: 'center' },
  emptyText: { color: Colors.textSecondary, textAlign: 'center', fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },
  errorBox: { padding: 24 },
  errorText: { color: Colors.error, marginBottom: 12, fontFamily: Fonts.sansMedium },
  retryBtn: { alignSelf: 'flex-start', borderColor: Colors.accent, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 },
  retryText: { color: Colors.accentInk, fontFamily: Fonts.sansMedium },
});
