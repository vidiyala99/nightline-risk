import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '../theme/colors';
import { sendCopilotMessage, type CopilotReply, type ProposedAction } from '../api/copilot';

/**
 * Operator Copilot — grounded conversational intelligence (RN port of the web
 * /copilot surface). Read answers are grounded by the backend faithfulness guard;
 * follow-ups are tappable; a proposed action can be confirmed inline when it needs
 * no file attachment (the attachment path stays on web for v1).
 */

type ChatMsg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; reply: CopilotReply }
  | { role: 'error'; text: string };

const STARTERS = [
  'What needs my attention?',
  'Why is my risk where it is?',
  'How much am I paying?',
];

export function CopilotScreen() {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const send = useCallback(
    async (message: string, confirmAction?: ProposedAction) => {
      const text = message.trim();
      if ((!text && !confirmAction) || loading) return;
      setInput('');
      setMessages((m) => [...m, { role: 'user', text: text || `Confirm: ${confirmAction?.summary ?? ''}` }]);
      setLoading(true);
      try {
        const reply = await sendCopilotMessage({ message: text, confirm_action: confirmAction });
        setMessages((m) => [...m, { role: 'assistant', reply }]);
      } catch (e: any) {
        setMessages((m) => [...m, { role: 'error', text: e?.message ?? 'Copilot is unavailable right now.' }]);
      } finally {
        setLoading(false);
      }
    },
    [loading],
  );

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <Text style={styles.eyebrow}>OPERATOR · COPILOT</Text>
        <Text style={styles.title}>Copilot</Text>
        <Text style={styles.subtitle}>Grounded answers about your risk, coverage &amp; claims</Text>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.log}
        contentContainerStyle={styles.logContent}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              Ask about what needs your attention, your premium, your risk factors, or a claim.
            </Text>
            <View style={styles.chips}>
              {STARTERS.map((s) => (
                <Pressable key={s} style={styles.chip} onPress={() => send(s)} accessibilityRole="button">
                  <Text style={styles.chipText}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {messages.map((msg, i) => {
          if (msg.role === 'user') {
            return (
              <View key={i} style={[styles.bubble, styles.bubbleUser]}>
                <Text style={styles.bubbleUserText}>{msg.text}</Text>
              </View>
            );
          }
          if (msg.role === 'error') {
            return (
              <View key={i} style={[styles.bubble, styles.bubbleError]}>
                <Text style={styles.bubbleErrorText}>{msg.text}</Text>
              </View>
            );
          }
          const { reply } = msg;
          return (
            <View key={i} style={[styles.bubble, styles.bubbleBot]}>
              <Text style={styles.bubbleBotText}>{reply.text}</Text>

              {reply.citations.length > 0 && (
                <View style={styles.cites}>
                  {reply.citations.map((c, ci) => (
                    <View key={ci} style={styles.cite}>
                      <Text style={styles.citeText}>{(c.source_type || 'source').toUpperCase()}</Text>
                    </View>
                  ))}
                </View>
              )}

              {reply.proposed_action && (
                <View style={styles.action}>
                  <Text style={styles.actionLabel}>SUGGESTED ACTION</Text>
                  <Text style={styles.actionSummary}>{reply.proposed_action.summary}</Text>
                  {reply.proposed_action.gating_passed && !reply.proposed_action.requires_attachment ? (
                    <Pressable
                      style={styles.confirmBtn}
                      onPress={() => send('', reply.proposed_action ?? undefined)}
                      accessibilityRole="button"
                    >
                      <Text style={styles.confirmBtnText}>Confirm</Text>
                    </Pressable>
                  ) : reply.proposed_action.requires_attachment ? (
                    <Text style={styles.actionNote}>Needs a file — confirm this one in the web app.</Text>
                  ) : (
                    <Text style={styles.actionNote}>Not available yet.</Text>
                  )}
                </View>
              )}

              {reply.link && <Text style={styles.link}>↗ {reply.link.label}</Text>}

              {reply.followups.length > 0 && (
                <View style={styles.chips}>
                  {reply.followups.map((f) => (
                    <Pressable key={f} style={styles.chip} onPress={() => send(f)} accessibilityRole="button">
                      <Text style={styles.chipText}>{f}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          );
        })}

        {loading && (
          <View style={[styles.bubble, styles.bubbleBot, styles.thinking]}>
            <ActivityIndicator color={Colors.accentInk} />
          </View>
        )}
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: insets.bottom + 8 }]}>
        <TextInput
          style={styles.input}
          placeholder="Ask the copilot…"
          placeholderTextColor={Colors.textMuted}
          value={input}
          onChangeText={setInput}
          multiline
          onSubmitEditing={() => send(input)}
        />
        <Pressable
          style={[styles.sendBtn, (!input.trim() || loading) && { opacity: 0.5 }]}
          onPress={() => send(input)}
          disabled={!input.trim() || loading}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          <Text style={styles.sendBtnText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  header: { paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderSubtle },
  eyebrow: { color: Colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 2, fontFamily: 'SpaceMono_700Bold' },
  title: { color: Colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5, marginTop: 2, fontFamily: 'BricolageGrotesque_700Bold' },
  subtitle: { color: Colors.textMuted, fontSize: 12, marginTop: 4, fontFamily: 'HankenGrotesk_400Regular' },

  log: { flex: 1 },
  logContent: { padding: 16, gap: 10 },

  empty: { paddingVertical: 24, gap: 14 },
  emptyText: { color: Colors.textSecondary, fontSize: 14, lineHeight: 21, fontFamily: 'HankenGrotesk_400Regular' },

  bubble: { borderRadius: 14, padding: 12, maxWidth: '92%' },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: Colors.accentWash, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.accent },
  bubbleUserText: { color: Colors.text, fontSize: 14, lineHeight: 20, fontFamily: 'HankenGrotesk_500Medium' },
  bubbleBot: { alignSelf: 'flex-start', backgroundColor: Colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, gap: 8 },
  bubbleBotText: { color: Colors.text, fontSize: 14, lineHeight: 21, fontFamily: 'HankenGrotesk_400Regular' },
  bubbleError: { alignSelf: 'flex-start', backgroundColor: 'rgba(200,52,30,0.06)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(200,52,30,0.25)' },
  bubbleErrorText: { color: Colors.error, fontSize: 13, lineHeight: 19, fontFamily: 'HankenGrotesk_400Regular' },
  thinking: { paddingVertical: 14 },

  cites: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cite: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, backgroundColor: Colors.bg },
  citeText: { color: Colors.accentInk, fontSize: 8, fontWeight: '700', letterSpacing: 1, fontFamily: 'SpaceMono_700Bold' },

  action: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.borderSubtle, paddingTop: 8, gap: 6 },
  actionLabel: { color: Colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, fontFamily: 'SpaceMono_700Bold' },
  actionSummary: { color: Colors.text, fontSize: 13, lineHeight: 19, fontFamily: 'HankenGrotesk_600SemiBold' },
  actionNote: { color: Colors.textMuted, fontSize: 12, fontFamily: 'HankenGrotesk_400Regular' },
  confirmBtn: { alignSelf: 'flex-start', minHeight: 40, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 8, backgroundColor: Colors.accent },
  confirmBtnText: { color: Colors.textInverse, fontSize: 13, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },

  link: { color: Colors.accentInk, fontSize: 12, fontFamily: 'HankenGrotesk_600SemiBold' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, backgroundColor: Colors.surface },
  chipText: { color: Colors.accentInk, fontSize: 12, fontWeight: '600', fontFamily: 'HankenGrotesk_600SemiBold' },

  composer: { flexDirection: 'row', gap: 8, alignItems: 'flex-end', paddingHorizontal: 16, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.borderSubtle, backgroundColor: Colors.surfaceElevated },
  input: { flex: 1, minHeight: 44, maxHeight: 120, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.borderSubtle, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: Colors.text, fontSize: 14, fontFamily: 'HankenGrotesk_400Regular', backgroundColor: Colors.bg },
  sendBtn: { minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 8, backgroundColor: Colors.accent },
  sendBtnText: { color: Colors.textInverse, fontSize: 14, fontWeight: '700', fontFamily: 'HankenGrotesk_700Bold' },
});
