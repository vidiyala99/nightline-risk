/**
 * File FNOL — full-screen form, deeper than the bottom-sheet pattern
 * because of the field count and the autosave behavior.
 *
 * Draft autosave: every state change persists to SecureStore keyed by
 * policy_id. On mount, if a draft exists, we surface a "Continue draft"
 * banner. Brokers field FNOLs from cabs and venues — losing typing is
 * unforgivable.
 *
 * Param contract:
 *   policyId, policyNumber, coverageLines: string[], effectiveDate,
 *   expirationDate, onSuccess: () => void
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Colors } from "../theme/colors";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';

import { claimsApi, type FileFnolBody } from '../api/claims';
import { Fonts } from '../theme/typography';
import { Field } from './RecordReserveScreen';

const DRAFT_PREFIX = 'fnol-draft:';

interface RouteParams {
  policyId: string;
  policyNumber: string | null;
  coverageLines: string[];
  effectiveDate: string;
  expirationDate: string;
  onSuccess?: (claimId: string) => void;
}

interface DraftState {
  coverageLine: string;
  dateOfLoss: string;
  incidentId: string;
  proposalId: string;
  defensePackageId: string;
  carrierClaimNumber: string;
  adjusterName: string;
  adjusterEmail: string;
  savedAt: string;
}

const EMPTY_DRAFT: DraftState = {
  coverageLine: '',
  dateOfLoss: '',
  incidentId: '',
  proposalId: '',
  defensePackageId: '',
  carrierClaimNumber: '',
  adjusterName: '',
  adjusterEmail: '',
  savedAt: '',
};

export function FileFnolScreen({ route, navigation }: any) {
  const params = route.params as RouteParams;
  const { policyId, policyNumber, coverageLines, effectiveDate, expirationDate, onSuccess } = params;

  const [d, setD] = useState<DraftState>({
    ...EMPTY_DRAFT,
    coverageLine: coverageLines.length === 1 ? coverageLines[0] : '',
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftAvailable, setDraftAvailable] = useState<DraftState | null>(null);
  const [showCarrier, setShowCarrier] = useState(false);

  const draftKey = `${DRAFT_PREFIX}${policyId}`;

  // Load existing draft on mount.
  useEffect(() => {
    SecureStore.getItemAsync(draftKey).then((raw) => {
      if (!raw) return;
      try {
        const parsed: DraftState = JSON.parse(raw);
        // Only offer the banner if there's something meaningful saved.
        if (parsed.coverageLine || parsed.dateOfLoss || parsed.incidentId) {
          setDraftAvailable(parsed);
        }
      } catch {
        // ignore malformed drafts
      }
    });
  }, [draftKey]);

  // Autosave on change — debounced via setTimeout.
  useEffect(() => {
    const hasContent =
      d.coverageLine || d.dateOfLoss || d.incidentId ||
      d.proposalId || d.defensePackageId ||
      d.carrierClaimNumber || d.adjusterName || d.adjusterEmail;
    if (!hasContent) return;
    const timer = setTimeout(() => {
      SecureStore.setItemAsync(
        draftKey,
        JSON.stringify({ ...d, savedAt: new Date().toISOString() }),
      ).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [d, draftKey]);

  const restoreDraft = useCallback(() => {
    if (!draftAvailable) return;
    setD(draftAvailable);
    setDraftRestored(true);
    setDraftAvailable(null);
    if (draftAvailable.carrierClaimNumber || draftAvailable.adjusterName || draftAvailable.adjusterEmail) {
      setShowCarrier(true);
    }
  }, [draftAvailable]);

  const discardDraft = useCallback(() => {
    SecureStore.deleteItemAsync(draftKey).catch(() => {});
    setDraftAvailable(null);
  }, [draftKey]);

  async function submit() {
    setError(null);
    if (!d.coverageLine) {
      setError('Pick a coverage line from the policy.');
      return;
    }
    if (!d.dateOfLoss) {
      setError('Date of loss is required.');
      return;
    }
    if (d.dateOfLoss < effectiveDate) {
      setError(`Date of loss is before policy effective date (${effectiveDate}).`);
      return;
    }
    if (d.dateOfLoss > expirationDate) {
      setError(`Date of loss is after policy expiration (${expirationDate}).`);
      return;
    }
    if (d.adjusterEmail && !/^\S+@\S+\.\S+$/.test(d.adjusterEmail)) {
      setError('Adjuster email is not valid.');
      return;
    }

    const body: FileFnolBody = {
      coverage_line: d.coverageLine,
      date_of_loss: d.dateOfLoss,
      incident_id: d.incidentId.trim() || undefined,
      proposal_id: d.proposalId.trim() || undefined,
      defense_package_id: d.defensePackageId.trim() || undefined,
      carrier_claim_number: d.carrierClaimNumber.trim() || undefined,
      adjuster_name: d.adjusterName.trim() || undefined,
      adjuster_email: d.adjusterEmail.trim() || undefined,
    };

    setSubmitting(true);
    try {
      const claim = await claimsApi.fileFnol(policyId, body);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      SecureStore.deleteItemAsync(draftKey).catch(() => {});
      onSuccess?.(claim.id);
      navigation.replace('CarrierClaimDetail', { cid: claim.id });
    } catch (e: any) {
      setError(e?.message ?? 'Failed to file FNOL.');
    } finally {
      setSubmitting(false);
    }
  }

  function attemptCancel() {
    const dirty =
      !!(d.coverageLine || d.dateOfLoss || d.incidentId ||
         d.carrierClaimNumber || d.adjusterName);
    if (!dirty) {
      navigation.goBack();
      return;
    }
    Alert.alert('Discard filing?', 'Your draft will be kept for next time.', [
      { text: 'Keep drafting', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => navigation.goBack() },
    ]);
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable onPress={attemptCancel}>
            <Text style={styles.back}>← {policyNumber ?? policyId}</Text>
          </Pressable>
          <Text style={styles.eyebrow}>FNOL</Text>
          <Text style={styles.title}>File a carrier claim</Text>
          <Text style={styles.subtitle}>
            Against policy {policyNumber ?? policyId}. Term: {effectiveDate} – {expirationDate}.
          </Text>
        </View>

        {draftAvailable && !draftRestored && (
          <View style={styles.draftBanner}>
            <Text style={styles.draftText}>
              Continue draft from{' '}
              {new Date(draftAvailable.savedAt || Date.now()).toLocaleString()}?
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable onPress={restoreDraft} style={styles.draftBtnPrimary}>
                <Text style={styles.draftBtnPrimaryText}>Restore</Text>
              </Pressable>
              <Pressable onPress={discardDraft} style={styles.draftBtnGhost}>
                <Text style={styles.draftBtnGhostText}>Discard</Text>
              </Pressable>
            </View>
          </View>
        )}

        <SectionHeading>Loss details</SectionHeading>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>
            Coverage line <Text style={styles.required}>*</Text>
          </Text>
          <View style={styles.chipsRow}>
            {coverageLines.map((line) => {
              const active = d.coverageLine === line;
              return (
                <Pressable
                  key={line}
                  onPress={() => setD({ ...d, coverageLine: line })}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {line.toUpperCase()}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Field
          label="Date of loss"
          required
          value={d.dateOfLoss}
          onChangeText={(t) => setD({ ...d, dateOfLoss: t })}
          placeholder="YYYY-MM-DD"
          hint={`Must fall within ${effectiveDate} – ${expirationDate}.`}
        />

        <SectionHeading>Linkages (optional)</SectionHeading>
        <Field
          label="Originating incident"
          value={d.incidentId}
          onChangeText={(t) => setD({ ...d, incidentId: t })}
          placeholder="inc-… (paste from incident detail)"
          hint="Optional — links the operator-reported incident that triggered this loss."
        />
        <Field
          label="Origin proposal"
          value={d.proposalId}
          onChangeText={(t) => setD({ ...d, proposalId: t })}
          placeholder="clp-… (paste from claim proposal)"
          hint="Optional — links the ClaimProposal that became this FNOL."
        />
        <Field
          label="Defense package"
          value={d.defensePackageId}
          onChangeText={(t) => setD({ ...d, defensePackageId: t })}
          placeholder="pkt-… (paste from underwriter detail)"
          hint="Optional — links a frozen underwriting packet. You can attach later."
        />

        <Pressable onPress={() => setShowCarrier((s) => !s)} style={styles.disclosure}>
          <Text style={styles.disclosureText}>
            Carrier contact {showCarrier ? '▾' : '▸'}
          </Text>
        </Pressable>

        {showCarrier && (
          <>
            <Field
              label="Carrier claim number"
              value={d.carrierClaimNumber}
              onChangeText={(t) => setD({ ...d, carrierClaimNumber: t })}
              placeholder="As issued by the carrier (often arrives later)"
            />
            <Field
              label="Adjuster name"
              value={d.adjusterName}
              onChangeText={(t) => setD({ ...d, adjusterName: t })}
              autoComplete="name"
            />
            <Field
              label="Adjuster email"
              value={d.adjusterEmail}
              onChangeText={(t) => setD({ ...d, adjusterEmail: t })}
              keyboardType="email-address"
              autoComplete="email"
            />
          </>
        )}

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.actions}>
          <Pressable onPress={attemptCancel} style={styles.btnGhost} disabled={submitting}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </Pressable>
          <Pressable onPress={submit} style={styles.btnPrimary} disabled={submitting}>
            <Text style={styles.btnPrimaryText}>{submitting ? 'Filing…' : 'File FNOL'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <Text style={styles.section}>{String(children).toUpperCase()}</Text>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: 20, paddingBottom: 80 },
  header: { marginBottom: 18 },
  back: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 13, marginBottom: 8 },
  eyebrow: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  title: {
    fontFamily: Fonts.displayBold,
    fontSize: 32,
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: 6,
  },
  subtitle: { color: Colors.textSecondary, fontFamily: Fonts.sansRegular, fontSize: 13, lineHeight: 18 },

  draftBanner: {
    backgroundColor: 'rgba(200,240,0,0.06)',
    borderColor: Colors.accent,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    marginBottom: 18,
  },
  draftText: { color: Colors.text, fontFamily: Fonts.sansMedium, fontSize: 13 },
  draftBtnPrimary: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: Colors.accent,
  },
  draftBtnPrimaryText: { color: Colors.text, fontFamily: Fonts.sansSemiBold, fontSize: 12 },
  draftBtnGhost: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(23,21,15,0.14)',
  },
  draftBtnGhostText: { color: Colors.textSecondary, fontFamily: Fonts.sansMedium, fontSize: 12 },

  section: {
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.6,
    color: Colors.textSecondary,
    marginTop: 8,
    marginBottom: 10,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(23,21,15,0.10)',
  },

  field: { marginBottom: 14 },
  fieldLabel: { color: Colors.text, fontFamily: Fonts.sansSemiBold, fontSize: 13, marginBottom: 6 },
  required: { color: Colors.accentInk },

  chipsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(23,21,15,0.14)',
  },
  chipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(200,240,0,0.06)' },
  chipText: { color: Colors.textSecondary, fontFamily: Fonts.monoBold, fontSize: 11 },
  chipTextActive: { color: Colors.accentInk },

  disclosure: { paddingVertical: 12 },
  disclosureText: {
    color: Colors.text,
    fontFamily: Fonts.monoBold,
    fontSize: 10,
    letterSpacing: 1.6,
  },

  errorBox: {
    backgroundColor: 'rgba(255,69,87,0.08)',
    borderColor: Colors.error,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
    marginBottom: 12,
  },
  errorText: { color: Colors.error, fontFamily: Fonts.sansMedium, fontSize: 13 },

  actions: { flexDirection: 'row', gap: 8, marginTop: 12, justifyContent: 'flex-end' },
  btnGhost: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(23,21,15,0.16)',
  },
  btnGhostText: { color: Colors.text, fontFamily: Fonts.sansMedium },
  btnPrimary: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: Colors.accent,
  },
  btnPrimaryText: { color: Colors.text, fontFamily: Fonts.sansBold },
});
