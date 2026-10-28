import { useState } from "react";
import { Text, View } from "react-native";
import { Button, Txt } from "../ui/components";
import { SwipeToAllow } from "../ui/SwipeToAllow";
import { term } from "../ui/terminal";
import { fonts, radius, shadow, space, useColors } from "../ui/theme";

/**
 * A command typed in the phone's terminal, shown back exactly as it will run, and run by a deliberate swipe (the way an
 * allow is): one swipe is one command, never a session. It is only asked after the phone has checked who is holding it.
 *
 * It sits in the chat, above the message box, drawn the way the permission prompts' swipe is: the one place the swipe is known
 * to take a drag (inside a pop-up sheet over the screen it did not). `onRun` is told once, at the swipe; the card goes by itself.
 */
export function RunCommandCard({ command, project, onRun, onCancel, onSwiping }: { command: string; project: string | null; onRun: () => void; onCancel: () => void; /** Told when a drag of the knob starts and ends (the chat holds still while it is going). */ onSwiping?: (dragging: boolean) => void }) {
  const colors = useColors();
  const [swiped, setSwiped] = useState(false);
  return (
    <View style={[{ marginHorizontal: space.lg, marginBottom: 8, backgroundColor: colors.card, borderRadius: radius.card - 6, padding: space.lg, gap: 10 }, shadow.card]}>
      <Txt variant="heading" accessibilityRole="header">
        Run on your Mac?
      </Txt>
      <Txt variant="small" tone="ink2">
        {project ? `It runs in ${project}, outside Claude, and can change anything there.` : "It runs in the chat's folder, outside Claude, and can change anything there."}
      </Txt>
      {/* The whole command, as typed: what is run is what is read here. */}
      <View style={{ backgroundColor: term.bg, borderRadius: radius.inner, padding: 12, maxHeight: 160 }}>
        <Text selectable accessibilityLabel={`Command: ${command}`} style={{ color: term.hi, fontFamily: fonts.mono, fontSize: 14, lineHeight: 20 }}>
          <Text style={{ color: term.bright }}>› </Text>
          {command}
        </Text>
      </View>
      <SwipeToAllow
        compact
        label="Swipe to run"
        doneLabel="Running"
        onDrag={onSwiping}
        onAllow={() => {
          setSwiped(true);
          onRun();
        }}
      />
      {!swiped && <Button label="Cancel" kind="ghost" onPress={onCancel} />}
    </View>
  );
}
