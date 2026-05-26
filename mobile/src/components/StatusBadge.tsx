import React from 'react';
import { Colors } from "../theme/colors";
import { StyleSheet, Text, View } from 'react-native';

// Tone palette — keep in sync with the web's status-pill tones.
const TONES = {
  info:    { color: Colors.info, bg: 'rgba(91,138,245,0.1)',  border: 'rgba(91,138,245,0.3)' },
  warning: { color: Colors.warning, bg: 'rgba(255,149,0,0.1)',   border: 'rgba(255,149,0,0.3)'  },
  success: { color: Colors.success, bg: 'rgba(0,217,126,0.08)',  border: 'rgba(0,217,126,0.25)' },
  danger:  { color: Colors.error, bg: 'rgba(255,69,87,0.08)',  border: 'rgba(255,69,87,0.25)' },
  neutral: { color: Colors.textSecondary, bg: 'rgba(139,144,168,0.1)', border: 'rgba(139,144,168,0.2)' },
};

const STATUS_CONFIG: Record<string, { label: string; tone: keyof typeof TONES }> = {
  // legacy operator statuses
  open:         { label: 'OPEN',   tone: 'warning' },
  under_review: { label: 'REVIEW', tone: 'info'    },
  closed:       { label: 'CLOSED', tone: 'success' },

  // Phase 3 carrier-claim statuses (mirror of CLAIM_STATUS_TONE)
  notified:            { label: 'NOTIFIED',         tone: 'info'    },
  acknowledged:        { label: 'ACKNOWLEDGED',     tone: 'info'    },
  under_investigation: { label: 'INVESTIGATING',    tone: 'warning' },
  reserved:            { label: 'RESERVED',         tone: 'warning' },
  settling:            { label: 'SETTLING',         tone: 'warning' },
  closed_paid:         { label: 'CLOSED — PAID',    tone: 'success' },
  closed_denied:       { label: 'CLOSED — DENIED',  tone: 'neutral' },
  closed_dropped:      { label: 'CLOSED — DROPPED', tone: 'neutral' },
  reopened:            { label: 'REOPENED',         tone: 'warning' },
};

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status];
  const tone = config ? TONES[config.tone] : TONES.neutral;
  const label = config?.label ?? status.toUpperCase();
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg, borderColor: tone.border }]}>
      <Text style={[styles.text, { color: tone.color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'SpaceMono_700Bold',
  },
});
