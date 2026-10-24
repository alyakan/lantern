import { HStack, Image, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, monospacedDigit, padding } from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity, type LiveActivityEnvironment } from "expo-widgets";

/**
 * What the card on the lock screen says. The Mac sends exactly this (a JSON string, `props`) with each update, so the two
 * must agree: see ACTIVITY_NAME and props_json in src-tauri/src/remote/live_activity.rs. It is the project's name and a state,
 * and when the turn began (the timer counts from it): never a chat's title, a command, a file or any of Claude's words.
 */
export type ChatCardProps = {
  project: string;
  status: "working" | "needs_you" | "done" | "failed";
  /** When the turn began, ms since the epoch. */
  since: number;
};

/**
 * The widget runtime draws only Expo UI's own components and runs this function alone: nothing from outside it (no
 * constants, no helpers, no hooks), so the words and colours are worked out in here. No comments inside it either: the build
 * turns the function into one string of source for the card's own process to run.
 *
 * Stale (the Mac hasn't updated the card for a while, say because it went to sleep) it says so, in grey, instead of going on
 * saying Working. With the screen dimmed (always-on) colour gives way to white.
 */
const LanternChat = (props: ChatCardProps, environment: LiveActivityEnvironment) => {
  "widget";
  const stale = environment.isStale === true && (props.status === "working" || props.status === "needs_you");
  const working = props.status === "working" && !stale;
  const words = stale ? "Not updating" : props.status === "working" ? "Working" : props.status === "needs_you" ? "Needs you" : props.status === "done" ? "Done" : "Stopped";
  const colour = stale ? "#8E8E93" : props.status === "working" ? "#3B82F6" : props.status === "needs_you" ? "#F59E0B" : props.status === "done" ? "#22C55E" : "#EF4444";
  const symbol = stale ? "zzz" : props.status === "working" ? "ellipsis.bubble.fill" : props.status === "needs_you" ? "exclamationmark.bubble.fill" : props.status === "done" ? "checkmark.circle.fill" : "xmark.octagon.fill";
  const tint = environment.isLuminanceReduced ? "#FFFFFF" : colour;
  const status = working ? (
    <HStack spacing={8}>
      <Text modifiers={[font({ size: 15, weight: "semibold" }), foregroundStyle(tint)]}>{words}</Text>
      <Text date={new Date(props.since)} dateStyle="timer" modifiers={[font({ size: 15 }), monospacedDigit(), foregroundStyle(tint)]} />
    </HStack>
  ) : (
    <Text modifiers={[font({ size: 15, weight: "semibold" }), foregroundStyle(tint)]}>{words}</Text>
  );
  return {
    banner: (
      <HStack spacing={12} modifiers={[padding({ all: 14 })]}>
        <Image systemName={symbol} color={tint} size={26} />
        <VStack spacing={2} alignment="leading">
          <Text modifiers={[font({ size: 17, weight: "bold" })]}>{props.project}</Text>
          {status}
        </VStack>
      </HStack>
    ),
    compactLeading: <Image systemName={symbol} color={tint} />,
    compactTrailing: <Text modifiers={[font({ size: 13, weight: "semibold" }), foregroundStyle(tint)]}>{words}</Text>,
    minimal: <Image systemName={symbol} color={tint} />,
    expandedLeading: (
      <VStack modifiers={[padding({ all: 12 })]}>
        <Image systemName={symbol} color={tint} size={28} />
      </VStack>
    ),
    expandedTrailing: (
      <VStack modifiers={[padding({ all: 12 })]}>
        <Text modifiers={[font({ size: 15, weight: "semibold" }), foregroundStyle(tint)]}>{words}</Text>
      </VStack>
    ),
    expandedBottom: (
      <VStack modifiers={[padding({ all: 12 })]}>
        <Text modifiers={[font({ size: 15, weight: "bold" })]}>{props.project}</Text>
      </VStack>
    ),
  };
};

/** The name the Mac's pushes say they are updating (ACTIVITY_NAME on the Mac). */
export const ACTIVITY_NAME = "LanternChat";

export default createLiveActivity<ChatCardProps>(ACTIVITY_NAME, LanternChat);
