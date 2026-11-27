import { useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Item } from "../sync/reducer";
import { COMPOSER_FILL, Glass, useGlass } from "../ui/Glass";
import { barRoom } from "../ui/keyboard";
import { buzz, FadeSlideIn } from "../ui/motion";
import { QuestionAsk } from "../ui/QuestionAsk";
import { useColors } from "../ui/theme";
import { questionsOf } from "../view/prompts";

/** How much of the screen's height the options may take before they scroll, so the end of the chat stays in view above them. */
const LIST_SHARE = 0.42;

/**
 * Claude's question where the chat's message box was, as the Claude app asks: the box comes back once it is answered (or
 * skipped). The question in the chat itself is only a line pointing down here. `onAnswer` rejects when the answer did not go:
 * the panel then takes presses again.
 */
export function QuestionDock({ item, onAnswer }: { item: Extract<Item, { kind: "prompt" }>; onAnswer: (allow: boolean, answers: Record<string, string> | null) => Promise<void> }) {
  const insets = useSafeAreaInsets();
  const glass = useGlass();
  const colors = useColors();
  const { height } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  // A pick that moves on, and Send pressed meanwhile, answer once.
  const answering = useRef(false);
  const go = (allow: boolean, answers: Record<string, string> | null) => {
    if (answering.current) return;
    answering.current = true;
    setBusy(true);
    onAnswer(allow, answers).then(
      () => buzz(allow ? "success" : "warning"),
      () => {
        answering.current = false;
        setBusy(false);
      },
    );
  };
  return (
    <FadeSlideIn from={16}>
      <View testID="question-dock" style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: barRoom(insets.bottom), backgroundColor: glass ? "transparent" : colors.paper }}>
        <Glass lift={0.12} fill={COMPOSER_FILL} style={{ borderRadius: 22, padding: 14 }}>
          <QuestionAsk tone="paper" questions={questionsOf(item.input)} busy={busy} maxListHeight={Math.round(height * LIST_SHARE)} onSend={(answers) => go(true, answers)} onSkip={() => go(false, null)} />
        </Glass>
      </View>
    </FadeSlideIn>
  );
}
