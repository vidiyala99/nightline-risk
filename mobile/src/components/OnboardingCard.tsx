import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Colors } from "../theme/colors";
import {
  CoverageLine,
  fetchCoverageLines,
  fetchVenueProfile,
  isProfileComplete,
  saveCoverageProfile,
} from "../api/coverageProfile";

type Status = "have_policy" | "uninsured" | "unsure";

const STATUS_OPTIONS: [Status, string][] = [
  ["have_policy", "I have a current policy"],
  ["uninsured", "Currently uninsured / between policies"],
  ["unsure", "Not sure"],
];

/** Operator nudge (mobile parity with web OnboardingCard): capture the insurance
 * "knowns" so a broker can shop coverage. Collapses to a confirmation once
 * complete. Logging incidents is never gated on this. */
export function OnboardingCard({ venueId, onSaved }: { venueId: string; onSaved?: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [complete, setComplete] = useState(false);
  const [lines, setLines] = useState<CoverageLine[]>([]);
  const [status, setStatus] = useState<Status>("have_policy");
  const [carrier, setCarrier] = useState("");
  const [renewal, setRenewal] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const catalog = await fetchCoverageLines();
      let profile: Record<string, unknown> | null = null;
      try {
        profile = await fetchVenueProfile(venueId);
      } catch {
        profile = null;
      }
      if (cancelled) return;
      setLines(catalog);
      const requiredDefaults = catalog.filter((l) => l.is_required_by_default).map((l) => l.id);
      if (profile) {
        setComplete(
          isProfileComplete({
            current_carrier: (profile.current_carrier as string) ?? null,
            coverage_interest: (profile.coverage_interest as string[]) ?? null,
          }),
        );
        const cc = (profile.current_carrier as string) ?? null;
        if (cc === "uninsured" || cc === "unsure") setStatus(cc);
        else if (cc) {
          setStatus("have_policy");
          setCarrier(cc);
        }
        if (profile.renewal_date) setRenewal(String(profile.renewal_date));
        const ci = Array.isArray(profile.coverage_interest) ? (profile.coverage_interest as string[]) : [];
        setSelected(ci.length ? ci : requiredDefaults);
      } else {
        setSelected(requiredDefaults);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [venueId]);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function save() {
    setError(null);
    if (status === "have_policy" && !carrier.trim()) return setError("Enter your current carrier.");
    if (status === "have_policy" && !renewal.trim()) return setError("Enter your renewal date.");
    if (selected.length === 0) return setError("Select at least one coverage line.");
    setSaving(true);
    try {
      await saveCoverageProfile(venueId, {
        current_carrier: status === "have_policy" ? carrier.trim() : status,
        renewal_date: status === "have_policy" ? renewal.trim() : null,
        coverage_interest: selected,
      });
      setComplete(true);
      onSaved?.();
    } catch {
      setError("Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  if (complete) {
    return (
      <View style={[styles.card, styles.completeRow]}>
        <View style={styles.completeDot} />
        <Text style={styles.completeText}>Profile complete — ready for quotes.</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Complete your profile to get quoted</Text>
      <Text style={styles.subtitle}>
        Tell your broker what you have today so they can shop the right coverage. You can keep
        logging incidents either way.
      </Text>

      <Text style={styles.legend}>CURRENT INSURANCE</Text>
      {STATUS_OPTIONS.map(([val, label]) => (
        <Pressable
          key={val}
          style={styles.optionRow}
          onPress={() => setStatus(val)}
          accessibilityRole="radio"
          accessibilityState={{ selected: status === val }}
          accessibilityLabel={label}
        >
          <View style={[styles.radioOuter, status === val && styles.radioOuterOn]}>
            {status === val && <View style={styles.radioDot} />}
          </View>
          <Text style={styles.optionLabel}>{label}</Text>
        </Pressable>
      ))}

      {status === "have_policy" && (
        <View style={styles.fields}>
          <Text style={styles.fieldLabel}>Current carrier</Text>
          <TextInput
            style={styles.input}
            value={carrier}
            onChangeText={setCarrier}
            placeholder="e.g. Hiscox"
            placeholderTextColor={Colors.textMuted}
          />
          <Text style={styles.fieldLabel}>
            Renewal date <Text style={{ color: Colors.error }}>*</Text>
          </Text>
          <TextInput
            style={styles.input}
            value={renewal}
            onChangeText={setRenewal}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="none"
          />
        </View>
      )}

      <Text style={styles.legend}>COVERAGE YOU WANT</Text>
      {lines.map((l) => (
        <Pressable
          key={l.id}
          style={styles.optionRow}
          onPress={() => toggle(l.id)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: selected.includes(l.id) }}
          accessibilityLabel={l.name}
        >
          <View style={[styles.checkbox, selected.includes(l.id) && styles.checkboxOn]} />
          <View style={styles.lineTextWrap}>
            <Text style={styles.optionLabel}>{l.name}</Text>
            <Text style={styles.lineDesc}>{l.description}</Text>
          </View>
        </Pressable>
      ))}

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
        onPress={save}
        disabled={saving}
        accessibilityRole="button"
      >
        {saving ? (
          <ActivityIndicator color={Colors.textInverse} />
        ) : (
          <Text style={styles.saveBtnText}>Save & get quoted</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.borderSubtle,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  completeRow: { flexDirection: "row", alignItems: "center" },
  completeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.success,
    marginRight: 10,
  },
  completeText: { color: Colors.text, fontSize: 14 },
  title: { color: Colors.text, fontSize: 15, fontWeight: "600", marginBottom: 6 },
  subtitle: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  legend: {
    color: Colors.textSecondary,
    fontSize: 11,
    letterSpacing: 0.6,
    marginTop: 8,
    marginBottom: 8,
  },
  optionRow: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: 4 },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  radioOuterOn: { borderColor: Colors.accentInk },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.accentInk },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: Colors.border,
    marginRight: 12,
    marginTop: 2,
  },
  checkboxOn: { backgroundColor: Colors.accent, borderColor: Colors.accentInk },
  optionLabel: { color: Colors.text, fontSize: 14, flexShrink: 1 },
  lineTextWrap: { flex: 1 },
  lineDesc: { color: Colors.textSecondary, fontSize: 12, lineHeight: 17 },
  fields: { marginTop: 4, marginBottom: 4 },
  fieldLabel: { color: Colors.textSecondary, fontSize: 12, marginTop: 10, marginBottom: 4 },
  input: {
    backgroundColor: Colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: Colors.text,
    fontSize: 14,
  },
  error: { color: Colors.error, fontSize: 13, marginTop: 10 },
  saveBtn: {
    backgroundColor: Colors.accent,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 16,
    minHeight: 44,
    justifyContent: "center",
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: Colors.textInverse, fontSize: 14, fontWeight: "600" },
});
