import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import type { Item } from "../sync/reducer";
import { fonts, radius } from "../ui/theme";
import { term } from "../ui/terminal";
import { cleanOutput, endLine, lastLines, PROMPT_PAUSE_MS, SHOWN_LINES, took } from "../view/shell";

type Shell = Extract<Item, { kind: "shell" }>;

/** How long a running command has been going on the screen (null for one this card never saw running). */
function useElapsed(running: boolean): number | null {
  const startedAt = useRef<number | null>(running ? Date.now() : null);
  const [ms, setMs] = useState<number | null>(running ? 0 : null);
  useEffect(() => {
    if (!running) return;
    startedAt.current ??= Date.now();
    const t = setInterval(() => setMs(Date.now() - startedAt.current!), 1000);
    return () => clearInterval(t);
  }, [running]);
  // The last tick before it ended is not how long it took: one measured at the end is.
  useEffect(() => {
    if (!running && startedAt.current !== null) setMs(Date.now() - startedAt.current);
  }, [running]);
  return ms;
}

/**
 * A command run from the phone's terminal, as a little terminal: the command, its output as it comes, how it ended. While it
 * runs it can be stopped, and when it asks something (a password, a code, y/n) a field appears to answer it: a hidden one
 * for a password, whose text is never kept.
 */
export function ShellCard({ item, onInput, onStop, onTell }: { item: Shell; onInput: (text: string) => void; onStop: () => void; /** Puts what the command printed in the message box, to tell Claude (the person reads it and sends it). */ onTell?: () => void }) {
  const [all, setAll] = useState(false);
  const clean = cleanOutput(item.output);
  const shown = all ? { text: clean.replace(/\n$/, ""), hidden: 0 } : lastLines(clean, SHOWN_LINES);
  const running = item.status === "running";
  const elapsed = useElapsed(running);

  // Asking something: reading a secret, or its output stopped mid-line ("Continue? [y/N] ") for a moment. Answered or
  // dismissed, the field waits for the command to print something new.
  const [paused, setPaused] = useState(false);
  const [settledAt, setSettledAt] = useState(-1);
  const [opened, setOpened] = useState(false);
  const midLine = clean !== "" && !clean.endsWith("\n");
  useEffect(() => {
    setPaused(false);
    if (!running || !midLine) return;
    const t = setTimeout(() => setPaused(true), PROMPT_PAUSE_MS);
    return () => clearTimeout(t);
  }, [item.output, running, midLine]);
  const asking = running && settledAt !== item.output.length && (item.secret || paused);
  const open = running && (asking || opened);
  const settle = () => {
    setSettledAt(item.output.length);
    setOpened(false);
  };

  const failed = item.status === "failed";
  const end = endLine(item.status, item.code);
  return (
    <View accessible={false} accessibilityLabel={`Command: ${item.command}`} style={{ backgroundColor: term.bg, borderColor: failed ? `${term.fail}66` : term.line, borderWidth: 1, borderRadius: radius.inner, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingLeft: 12, paddingRight: 8, paddingVertical: 6 }}>
        <Text accessibilityElementsHidden style={{ color: term.bright, fontFamily: fonts.mono, fontSize: 14 }}>
          ›
        </Text>
        <Text selectable style={{ flex: 1, color: term.hi, fontFamily: fonts.mono, fontSize: 13 }}>
          {item.command}
        </Text>
        {running ? (
          <>
            <ActivityIndicator accessibilityLabel="Running" size="small" color={term.bright} />
            {!open && <HeaderButton label="Reply" hint="Type something to this command" onPress={() => setOpened(true)} />}
            <HeaderButton label="Stop" hint="Stop this command" onPress={onStop} />
          </>
        ) : (
          <>
            {/* Not for a command that read a password: its output is not offered to anyone. */}
            {onTell && !item.secret && !!clean.trim() && <HeaderButton label="Tell Claude" hint="Puts what it printed in the message box, to read and send" onPress={onTell} />}
            <Text style={{ color: failed ? term.fail : term.dim, fontFamily: fonts.mono, fontSize: 11 }}>
              {end}
              {elapsed !== null && elapsed >= 1000 ? `${end ? " · " : ""}${took(elapsed)}` : ""}
            </Text>
          </>
        )}
      </View>
      {shown.hidden > 0 && (
        <Pressable accessibilityRole="button" onPress={() => setAll(true)} style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
          <Text style={{ color: term.dim, fontFamily: fonts.mono, fontSize: 11, textDecorationLine: "underline" }}>Show all {shown.hidden + SHOWN_LINES} lines</Text>
        </Pressable>
      )}
      {!!shown.text && (
        <Text selectable accessibilityLabel="Command output" style={{ color: term.out, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, paddingHorizontal: 12, paddingBottom: 10 }}>
          {shown.text}
        </Text>
      )}
      {open && (
        <ShellAsk
          prompt={midLine ? (clean.split("\n").pop() ?? "").trim() : ""}
          secret={item.secret}
          onSend={(text) => {
            onInput(text);
            settle();
          }}
          onDismiss={settle}
        />
      )}
    </View>
  );
}

function HeaderButton({ label, hint, onPress }: { label: string; hint: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} onPress={onPress} hitSlop={6} style={{ height: 24, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: term.line, justifyContent: "center" }}>
      <Text style={{ color: term.text, fontFamily: fonts.mono, fontSize: 11 }}>{label}</Text>
    </Pressable>
  );
}

/** What a running command asked, and the field to answer it: hidden for a password, and never kept or shown. */
function ShellAsk({ prompt, secret, onSend, onDismiss }: { prompt: string; secret: boolean; onSend: (text: string) => void; onDismiss: () => void }) {
  const [reply, setReply] = useState("");
  const send = () => {
    onSend(reply);
    setReply("");
  };
  return (
    <View style={{ margin: 8, marginTop: 0, padding: 8, gap: 6, borderRadius: radius.inner, borderWidth: 1, borderColor: `${term.bright}59`, backgroundColor: term.field }}>
      <Text numberOfLines={1} style={{ color: term.hi, fontFamily: fonts.mono, fontSize: 12 }}>
        {secret ? `🔒 ${prompt || "Password"}` : prompt || "Reply to the command"}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          accessibilityLabel={secret ? "Password for the command" : "Reply to the command"}
          value={reply}
          onChangeText={setReply}
          secureTextEntry={secret}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          textContentType={secret ? "password" : "none"}
          returnKeyType="send"
          blurOnSubmit={false}
          onSubmitEditing={send}
          placeholderTextColor={term.dim}
          style={{ flex: 1, minHeight: 34, color: term.hi, fontFamily: fonts.mono, fontSize: 14, paddingVertical: 4 }}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Send reply" onPress={send} style={{ height: 30, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: term.bright, justifyContent: "center" }}>
          <Text style={{ color: term.bg, fontFamily: fonts.mono, fontSize: 12, fontWeight: "700" }}>Send</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Not now" onPress={onDismiss} hitSlop={8}>
          <Text style={{ color: term.dim, fontFamily: fonts.mono, fontSize: 12 }}>Not now</Text>
        </Pressable>
      </View>
    </View>
  );
}
