import { HStack, Image, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, minimumScaleFactor, monospacedDigit, opacity, padding, tint } from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity, type LiveActivityEnvironment } from "expo-widgets";

/**
 * What the card on the lock screen says. The Mac sends exactly this (a JSON string, `props`) with each update, so the two
 * must agree: see ACTIVITY_NAME, Detail and props_json in src-tauri/src/remote/live_activity.rs. The project's name, a state and
 * when the turn began (the timer counts from it), and then what the Mac adds, each only when it has it: the chat's own title,
 * how many steps of its plan are done, what a chat that needs you is asking for (one word), and how much of the plan's usage
 * window is used. Never a command, a file, a question or any of Claude's words.
 */
export type ChatCardProps = {
  project: string;
  status: "working" | "needs_you" | "done" | "failed";
  /** When the turn began, ms since the epoch. */
  since: number;
  title?: string;
  steps_done?: number;
  steps_total?: number;
  needs?: "command" | "edit" | "question" | "approval" | "tool";
  /** How much of the plan's five-hour window is used, 0 to 100. */
  plan?: number;
};

/**
 * The widget runtime draws only Expo UI's own components and runs this function alone: nothing from outside it (no
 * constants, no helpers, no hooks), so the words, colours and the defaults for what an older Mac doesn't send are worked out in
 * here. No comments inside it either: the build turns the function into one string of source for the card's own process to run.
 *
 * Stale (the Mac hasn't updated the card for a while, say because it went to sleep) it says so, in grey, instead of going on
 * saying Working. With the screen dimmed (always-on) colour gives way to white. The usage is grey until 80%, then yellow, and
 * red at the limit, as on the phone's Home.
 */
const LanternChat = (props: ChatCardProps, environment: LiveActivityEnvironment) => {
  "widget";
  const stale = environment.isStale === true && (props.status === "working" || props.status === "needs_you");
  const working = props.status === "working" && !stale;
  const words = stale ? "Not updating" : props.status === "working" ? "Working" : props.status === "needs_you" ? "Needs you" : props.status === "done" ? "Done" : "Stopped";
  const colour = stale ? "#8E8E93" : props.status === "working" ? "#3B82F6" : props.status === "needs_you" ? "#F59E0B" : props.status === "done" ? "#22C55E" : "#EF4444";
  const symbol = stale ? "zzz" : props.status === "working" ? "ellipsis.bubble.fill" : props.status === "needs_you" ? "exclamationmark.bubble.fill" : props.status === "done" ? "checkmark.circle.fill" : "xmark.octagon.fill";
  const hue = environment.isLuminanceReduced ? "#FFFFFF" : colour;
  const title = typeof props.title === "string" ? props.title : "";
  const total = typeof props.steps_total === "number" && props.steps_total > 0 ? Math.round(props.steps_total) : 0;
  const done = total > 0 && typeof props.steps_done === "number" ? Math.min(Math.max(Math.round(props.steps_done), 0), total) : 0;
  const plan = typeof props.plan === "number" ? Math.min(Math.max(Math.round(props.plan), 0), 100) : -1;
  const planColour = environment.isLuminanceReduced ? "#FFFFFF" : plan >= 100 ? "#EF4444" : plan >= 80 ? "#F59E0B" : "#8E8E93";
  const asks = props.status === "needs_you" && !stale ? (props.needs === "command" ? "Wants to run a command" : props.needs === "edit" ? "Wants to change a file" : props.needs === "question" ? "Has a question" : props.needs === "approval" ? "Needs your approval" : props.needs === "tool" ? "Wants to use a tool" : "") : "";
  const steps = total > 0 ? (
    <VStack spacing={4} alignment="leading">
      <ProgressView value={done / total} modifiers={[tint(hue)]} />
      <Text modifiers={[font({ size: 12 }), monospacedDigit(), opacity(0.7)]}>{done === total ? `All ${total} steps done` : `${done} of ${total} steps`}</Text>
    </VStack>
  ) : null;
  const footer =
    asks !== "" || plan >= 0 ? (
      <HStack spacing={8}>
        {asks !== "" ? <Text modifiers={[font({ size: 13, weight: "semibold" }), foregroundStyle(hue)]}>{asks}</Text> : null}
        <Spacer />
        {plan >= 0 ? <Text modifiers={[font({ size: 12 }), monospacedDigit(), foregroundStyle(planColour)]}>{`Plan ${plan}%`}</Text> : null}
      </HStack>
    ) : null;
  const status = working ? (
    <VStack spacing={2} alignment="trailing">
      <Text modifiers={[font({ size: 15, weight: "semibold" }), foregroundStyle(hue)]}>{words}</Text>
      <Text date={new Date(props.since)} dateStyle="timer" modifiers={[font({ size: 13 }), monospacedDigit(), foregroundStyle(hue)]} />
    </VStack>
  ) : (
    <Text modifiers={[font({ size: 15, weight: "semibold" }), foregroundStyle(hue)]}>{words}</Text>
  );
  const heading = (
    <VStack spacing={2} alignment="leading">
      <Text modifiers={[font({ size: 17, weight: "bold" })]}>{props.project}</Text>
      {title !== "" ? <Text modifiers={[font({ size: 13 }), opacity(0.7), minimumScaleFactor(0.8)]}>{title}</Text> : null}
    </VStack>
  );
  return {
    banner: (
      <VStack spacing={8} alignment="leading" modifiers={[padding({ all: 14 })]}>
        <HStack spacing={12}>
          <Image systemName={symbol} color={hue} size={26} />
          {heading}
          <Spacer />
          {status}
        </HStack>
        {steps}
        {footer}
      </VStack>
    ),
    compactLeading: <Image systemName={symbol} color={hue} />,
    compactTrailing: <Text modifiers={[font({ size: 13, weight: "semibold" }), monospacedDigit(), foregroundStyle(hue)]}>{total > 0 && working ? `${done}/${total}` : words}</Text>,
    minimal: <Image systemName={symbol} color={hue} />,
    expandedLeading: (
      <VStack modifiers={[padding({ all: 12 })]}>
        <Image systemName={symbol} color={hue} size={28} />
      </VStack>
    ),
    expandedTrailing: (
      <VStack modifiers={[padding({ all: 12 })]}>
        <Text modifiers={[font({ size: 15, weight: "semibold" }), foregroundStyle(hue)]}>{words}</Text>
      </VStack>
    ),
    expandedBottom: (
      <VStack spacing={6} alignment="leading" modifiers={[padding({ all: 12 })]}>
        {heading}
        {steps}
        {footer}
      </VStack>
    ),
  };
};

/** The name the Mac's pushes say they are updating (ACTIVITY_NAME on the Mac). */
export const ACTIVITY_NAME = "LanternChat";

export default createLiveActivity<ChatCardProps>(ACTIVITY_NAME, LanternChat);
