import React, { useState } from 'react';
import { Colors } from "../theme/colors";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useAlert } from '../components/ThemedAlert';

interface FormState {
  summary: string;
  location: string;
  reported_by: string;
  injury_observed: boolean;
  police_called: boolean;
  ems_called: boolean;
}

function formatDateTime(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${mm}/${dd}/${yy} ${hh}:${min}:${ss}`;
}

export function ReportIncidentScreen({ navigation }: { navigation: any }) {
  const { user } = useAuth();
  const alert = useAlert();
  const [form, setForm] = useState<FormState>({
    summary: '',
    location: '',
    reported_by: user?.name ?? '',
    injury_observed: false,
    police_called: false,
    ems_called: false,
  });
  const [occurredAt, setOccurredAt] = useState<Date | null>(null);
  // Android needs a two-step picker: date first, then time
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [footageLink, setFootageLink] = useState('');
  const [evidenceLinks, setEvidenceLinks] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function onPressDateTimeField() {
    setShowDatePicker(true);
    if (Platform.OS === 'ios') {
      // iOS shows a combined date+time picker in one sheet via mode="datetime"
      setShowTimePicker(false);
    }
  }

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    if (Platform.OS === 'android') {
      setShowDatePicker(false);
      if (event.type === 'set' && selected) {
        // Preserve existing time, just update date portion
        const next = new Date(occurredAt ?? new Date());
        next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
        setOccurredAt(next);
        // Now show the time picker
        setShowTimePicker(true);
      }
    } else {
      // iOS — combined picker, single callback
      if (selected) setOccurredAt(selected);
    }
  }

  function onTimeChange(event: DateTimePickerEvent, selected?: Date) {
    setShowTimePicker(false);
    if (event.type === 'set' && selected) {
      const next = new Date(occurredAt ?? new Date());
      next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
      setOccurredAt(next);
    }
  }

  function addFootageLink() {
    const trimmed = footageLink.trim();
    if (!trimmed) return;
    setEvidenceLinks(prev => [...prev, trimmed]);
    setFootageLink('');
  }

  async function pickImage(source: 'camera' | 'library') {
    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({ quality: 0.7 })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, allowsMultipleSelection: true });

    if (!result.canceled) {
      setImages(prev => [...prev, ...result.assets.map(a => a.uri)]);
    }
  }

  async function submit() {
    if (!form.summary.trim() || !form.location.trim()) {
      alert.show({ title: 'Missing info', message: 'Summary and location are required.', variant: 'warning' });
      return;
    }
    setSubmitting(true);
    try {
      // Collect any unsaved footage link that hasn't been confirmed yet
      const allLinks = footageLink.trim()
        ? [...evidenceLinks, footageLink.trim()]
        : evidenceLinks;

      const result = await api.request<{ incident: { id: string } }>(`/api/venues/${user!.tenant_id}/incidents`, {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          occurred_at: (occurredAt ?? new Date()).toISOString(),
          footage_links: allLinks,
        }),
      });

      for (const uri of images) {
        const fd = new FormData();
        fd.append('file', { uri, name: 'evidence.jpg', type: 'image/jpeg' } as any);
        await api.upload(`/api/incidents/${result.incident.id}/evidence`, fd);
      }

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      alert.show({
        title: 'Filed',
        message: 'Incident report submitted.',
        variant: 'success',
        buttons: [{ label: 'OK', style: 'primary', onPress: () => navigation.goBack() }],
      });
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      alert.show({ title: 'Submission failed', message: e.message ?? 'Could not submit the report.', variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: 12 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.heading}>Report{'\n'}Incident</Text>

        {/* ── DATE & TIME ── */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>DATE &amp; TIME</Text>
          <Pressable
            style={({ pressed }) => [styles.input, styles.dateTimeField, pressed && styles.dateTimeFieldPressed]}
            onPress={onPressDateTimeField}
          >
            <Text style={[styles.dateTimeText, !occurredAt && { color: Colors.border }]}>
              {occurredAt ? formatDateTime(occurredAt) : 'mm/dd/yy hh:mm:ss'}
            </Text>
            <Text style={styles.dateTimeChevron}>›</Text>
          </Pressable>

          {/* iOS: combined inline picker rendered as a sheet-style overlay */}
          {showDatePicker && Platform.OS === 'ios' && (
            <View style={styles.iosPickerCard}>
              <DateTimePicker
                value={occurredAt ?? new Date()}
                mode="datetime"
                display="spinner"
                onChange={(event, selected) => {
                  if (selected) setOccurredAt(selected);
                }}
                textColor={Colors.text}
                style={{ flex: 1 }}
              />
              <Pressable style={styles.iosPickerDone} onPress={() => setShowDatePicker(false)}>
                <Text style={styles.iosPickerDoneText}>DONE</Text>
              </Pressable>
            </View>
          )}

          {/* Android: date step */}
          {showDatePicker && Platform.OS === 'android' && (
            <DateTimePicker
              value={occurredAt ?? new Date()}
              mode="date"
              display="default"
              onChange={onDateChange}
            />
          )}

          {/* Android: time step */}
          {showTimePicker && Platform.OS === 'android' && (
            <DateTimePicker
              value={occurredAt ?? new Date()}
              mode="time"
              display="default"
              is24Hour
              onChange={onTimeChange}
            />
          )}
        </View>

        {/* ── WHAT HAPPENED ── */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>WHAT HAPPENED</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            placeholder="Describe the incident…"
            placeholderTextColor={Colors.border}
            multiline
            numberOfLines={4}
            value={form.summary}
            onChangeText={v => set('summary', v)}
          />
        </View>

        {/* ── LOCATION ── */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>LOCATION</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Rear Bar, Stairwell B"
            placeholderTextColor={Colors.border}
            value={form.location}
            onChangeText={v => set('location', v)}
          />
        </View>

        {/* ── REPORTED BY ── */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>REPORTED BY</Text>
          <TextInput
            style={styles.input}
            placeholder="Your name"
            placeholderTextColor={Colors.border}
            value={form.reported_by}
            onChangeText={v => set('reported_by', v)}
          />
        </View>

        {/* ── FLAGS ── */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>FLAGS</Text>
          <View style={styles.toggleCard}>
            <ToggleRow label="Injury observed" value={form.injury_observed} onChange={v => set('injury_observed', v)} />
            <ToggleRow label="Police called" value={form.police_called} onChange={v => set('police_called', v)} />
            <ToggleRow label="EMS called" value={form.ems_called} onChange={v => set('ems_called', v)} last />
          </View>
        </View>

        {/* ── EVIDENCE ── */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>EVIDENCE</Text>
          <View style={styles.evidenceRow}>
            <Pressable
              style={({ pressed }) => [styles.evidenceBtn, pressed && styles.evidenceBtnPressed]}
              onPress={() => pickImage('camera')}
            >
              <Text style={styles.evidenceBtnText}>CAMERA</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.evidenceBtn, pressed && styles.evidenceBtnPressed]}
              onPress={() => pickImage('library')}
            >
              <Text style={styles.evidenceBtnText}>GALLERY</Text>
            </Pressable>
          </View>
          {images.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbScroll}>
              {images.map((uri, i) => (
                <Image key={i} source={{ uri }} style={styles.thumb} />
              ))}
            </ScrollView>
          )}

          {/* ── FOOTAGE LINK ── */}
          <View style={[styles.fieldGroup, { marginTop: 16, marginBottom: 0 }]}>
            <Text style={styles.fieldLabel}>FOOTAGE LINK</Text>
            <View style={styles.linkInputRow}>
              <TextInput
                style={[styles.input, styles.linkInput]}
                placeholder="https://dropbox.com/… or NVR portal URL"
                placeholderTextColor={Colors.border}
                value={footageLink}
                onChangeText={setFootageLink}
                onSubmitEditing={addFootageLink}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="done"
              />
              {footageLink.trim().length > 0 && (
                <Pressable
                  style={({ pressed }) => [styles.linkAddBtn, pressed && styles.linkAddBtnPressed]}
                  onPress={addFootageLink}
                >
                  <Text style={styles.linkAddBtnText}>ADD</Text>
                </Pressable>
              )}
            </View>
            <Text style={styles.linkHint}>
              For large video files — link to Dropbox, Drive, or NVR portal. 24-48hr review.
            </Text>
            {evidenceLinks.map((link, i) => (
              <View key={i} style={styles.linkChip}>
                <Text style={styles.linkChipText} numberOfLines={1}>{link}</Text>
                <Pressable
                  onPress={() => setEvidenceLinks(prev => prev.filter((_, idx) => idx !== i))}
                  hitSlop={8}
                >
                  <Text style={styles.linkChipRemove}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </View>

        <Pressable
          style={({ pressed }) => [styles.submitBtn, pressed && styles.submitPressed, submitting && styles.submitDisabled]}
          onPress={submit}
          disabled={submitting}
        >
          {submitting
            ? <ActivityIndicator color={Colors.bg} />
            : <Text style={styles.submitText}>FILE REPORT</Text>
          }
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ToggleRow({ label, value, onChange, last }: { label: string; value: boolean; onChange: (v: boolean) => void; last?: boolean }) {
  return (
    <View style={[styles.toggleRow, !last && styles.toggleRowBorder]}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: Colors.borderSubtle, true: 'rgba(200,240,0,0.35)' }}
        thumbColor={value ? Colors.accent : Colors.border}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 24 },

  heading: {
    color: Colors.text,
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1.5,
    lineHeight: 42,
    marginBottom: 32,
    fontFamily: 'CormorantGaramond_700Bold',
  },

  fieldGroup: { marginBottom: 20 },
  fieldLabel: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 8,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  input: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(23,21,15,0.10)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: Colors.text,
    fontSize: 15,
    fontFamily: 'DMSans_400Regular',
  },
  multiline: { minHeight: 100, textAlignVertical: 'top' },

  // Date/time field
  dateTimeField: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dateTimeFieldPressed: { backgroundColor: 'rgba(23,21,15,0.06)' },
  dateTimeText: {
    color: Colors.text,
    fontSize: 15,
    fontFamily: 'JetBrainsMono_400Regular',
    letterSpacing: 0.5,
  },
  dateTimeChevron: {
    color: Colors.textMuted,
    fontSize: 22,
    lineHeight: 24,
  },

  // iOS spinner card
  iosPickerCard: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(23,21,15,0.10)',
    borderRadius: 12,
    marginTop: 8,
    overflow: 'hidden',
  },
  iosPickerDone: {
    paddingVertical: 12,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(23,21,15,0.10)',
  },
  iosPickerDoneText: {
    color: Colors.accentInk,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    fontFamily: 'JetBrainsMono_700Bold',
  },

  toggleCard: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(23,21,15,0.10)',
    borderRadius: 12,
    overflow: 'hidden',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  toggleRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.borderSubtle,
  },
  toggleLabel: { color: Colors.textSecondary, fontSize: 14, fontFamily: 'DMSans_500Medium' },

  evidenceRow: { flexDirection: 'row', gap: 10 },
  evidenceBtn: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  evidenceBtnPressed: { backgroundColor: 'rgba(23,21,15,0.06)' },
  evidenceBtnText: { color: Colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },
  thumbScroll: { marginTop: 10 },
  thumb: { width: 72, height: 72, borderRadius: 10, marginRight: 8 },

  // Footage link
  linkInputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  linkInput: { flex: 1, paddingVertical: 12 },
  linkAddBtn: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(200,240,0,0.3)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkAddBtnPressed: { backgroundColor: 'rgba(200,240,0,0.08)' },
  linkAddBtnText: { color: Colors.accentInk, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'JetBrainsMono_700Bold' },
  linkHint: {
    color: Colors.textMuted,
    fontSize: 10,
    fontFamily: 'DMSans_400Regular',
    marginTop: 6,
    lineHeight: 15,
  },
  linkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(23,21,15,0.10)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 6,
    gap: 8,
  },
  linkChipText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: 11,
    fontFamily: 'DMSans_400Regular',
  },
  linkChipRemove: {
    color: Colors.textMuted,
    fontSize: 18,
    lineHeight: 20,
  },

  submitBtn: {
    backgroundColor: Colors.accent,
    borderRadius: 12,
    paddingVertical: 17,
    alignItems: 'center',
    marginTop: 8,
  },
  submitPressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: Colors.bg, fontWeight: '800', fontSize: 13, letterSpacing: 1.5, fontFamily: 'DMSans_700Bold' },
});
