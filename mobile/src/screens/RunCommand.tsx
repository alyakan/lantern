import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Txt } from "../ui/components";
import { Sheet } from "../ui/Sheet";
import { SwipeToAllow } from "../ui/SwipeToAllow";
import { term } from "../ui/terminal";
import { fonts, radius, shadow, space, useColors } from "../ui/theme";

/**
 * A command typed in the phone's terminal, shown back exactly as it will run, and run by a deliberate swipe (the way an
 * allow is): one swipe is one command, never a session. It is only asked after the phone has checked who is holding it.
 * `onRun` is told once, at the swipe; the sheet closes itself after.
 */
export function RunCommandSheet({ command, project, onRun, onClose }: { command: string; project: string | null; onRun: () => void; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={[{ backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 12 }, shadow.float]}>
          <Txt variant="title" accessibilityRole="header">
            Run on your Mac?
          </Txt>
          <Txt variant="body" tone="ink2">
            {project ? `It runs in ${project}, outside Claude, and can change anything there.` : "It runs in the chat's folder, outside Claude, and can change anything there."}
          </Txt>
          {/* The whole command, as typed: what is run is what is read here. */}
          <View style={{ backgroundColor: term.bg, borderRadius: radius.inner, padding: 12, maxHeight: 220 }}>
            <Text selectable accessibilityLabel={`Command: ${command}`} style={{ color: term.hi, fontFamily: fonts.mono, fontSize: 14, lineHeight: 20 }}>
              <Text style={{ color: term.bright }}>› </Text>
              {command}
            </Text>
          </View>
          <SwipeToAllow
            label="Swipe to run"
            doneLabel="Running"
            onAllow={() => {
              onRun();
              // The card in the chat shows the rest.
              setTimeout(close, 450);
            }}
          />
          <Button label="Cancel" kind="ghost" onPress={close} />
        </View>
      )}
    </Sheet>
  );
}
