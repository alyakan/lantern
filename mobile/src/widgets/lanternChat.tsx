import { HStack, Image, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { fixedSize, font, foregroundStyle, lineLimit, minimumScaleFactor, monospacedDigit, multilineTextAlignment, opacity, padding, tint } from "@expo/ui/swift-ui/modifiers";
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
  /**
   * A summary card (a Mac that lists "livesummary"): up to three chats (a lock-screen card is short), those that need you first, then those working, then those
   * that finished while it was up; each its project, state, its own title when it has one, and when a working one began.
   */
  chats?: { project: string; status: "working" | "needs_you" | "done" | "failed"; title?: string; since?: number }[];
  /** A summary card: how many chats are in each state (more than `chats` lists). */
  counts?: { needs_you: number; working: number; done: number; failed: number };
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
  if (Array.isArray(props.chats)) {
    const dim = environment.isLuminanceReduced === true;
    const late = environment.isStale === true && (props.status === "working" || props.status === "needs_you");
    const n = (v: unknown) => (typeof v === "number" && v > 0 ? Math.round(v) : 0);
    const c = props.counts ?? { needs_you: 0, working: 0, done: 0, failed: 0 };
    const needsN = n(c.needs_you);
    const workingN = n(c.working);
    const doneN = n(c.done);
    const failedN = n(c.failed);
    const hueOf = (st: string) => (dim ? "#FFFFFF" : late ? "#8E8E93" : st === "working" ? "#3B82F6" : st === "needs_you" ? "#F59E0B" : st === "done" ? "#22C55E" : "#EF4444");
    const symbolOf = (st: string) => (st === "working" ? "ellipsis.bubble.fill" : st === "needs_you" ? "exclamationmark.bubble.fill" : st === "done" ? "checkmark.circle.fill" : "xmark.octagon.fill");
    const wordOf = (st: string) => (st === "working" ? "Working" : st === "needs_you" ? "Needs you" : st === "done" ? "Done" : "Stopped");
    const parts = [needsN > 0 ? `${needsN} need${needsN === 1 ? "s" : ""} you` : "", workingN > 0 ? `${workingN} working` : "", workingN + needsN === 0 && doneN > 0 ? `${doneN} done` : "", workingN + needsN === 0 && failedN > 0 ? `${failedN} stopped` : ""].filter((t) => t !== "");
    const headline = late ? "Not updating" : parts.length > 0 ? parts.join(" · ") : "Nothing running";
    const top = late ? "zzz" : symbolOf(props.status);
    const topHue = hueOf(props.status);
    const list = props.chats;
    const shown = Math.min(list.length, 3);
    const more = needsN + workingN + doneN + failedN - shown;
    const row = (i: number) => {
      if (i >= shown) return null;
      const r = list[i];
      const hue = hueOf(r.status);
      const title = typeof r.title === "string" && r.title !== "" ? r.title : "";
      const end =
        r.status === "working" && !late && typeof r.since === "number" ? (
          <Text date={new Date(r.since)} dateStyle="timer" modifiers={[font({ size: 13 }), monospacedDigit(), foregroundStyle(hue), fixedSize({ horizontal: true }), multilineTextAlignment("trailing")]} />
        ) : (
          <Text modifiers={[font({ size: 13, weight: "semibold" }), foregroundStyle(hue)]}>{wordOf(r.status)}</Text>
        );
      return (
        <HStack spacing={8}>
          <Image systemName={symbolOf(r.status)} color={hue} size={14} />
          <Text modifiers={[font({ size: 14, weight: "semibold" }), lineLimit(1)]}>{r.project}</Text>
          {title !== "" ? <Text modifiers={[font({ size: 13 }), opacity(0.7), lineLimit(1)]}>{title}</Text> : null}
          <Spacer />
          {end}
        </HStack>
      );
    };
    const rows = (
      <VStack spacing={6} alignment="leading">
        {row(0)}
        {row(1)}
        {row(2)}
        {more > 0 ? <Text modifiers={[font({ size: 12 }), opacity(0.6)]}>{`and ${more} more`}</Text> : null}
      </VStack>
    );
    const head = (
      <HStack spacing={10}>
        <Image systemName={top} color={topHue} size={22} />
        <Text modifiers={[font({ size: 17, weight: "bold" })]}>Lantern</Text>
        <Spacer />
        <Text modifiers={[font({ size: 14, weight: "semibold" }), foregroundStyle(topHue)]}>{headline}</Text>
      </HStack>
    );
    const short = late ? "…" : needsN > 0 ? `${needsN}!` : workingN > 0 ? `${workingN}` : "✓";
    return {
      banner: (
        <VStack spacing={10} alignment="leading" modifiers={[padding({ all: 14 })]}>
          {head}
          {rows}
        </VStack>
      ),
      compactLeading: <Image systemName={top} color={topHue} />,
      compactTrailing: <Text modifiers={[font({ size: 13, weight: "semibold" }), monospacedDigit(), foregroundStyle(topHue)]}>{short}</Text>,
      minimal: <Image systemName={top} color={topHue} />,
      expandedLeading: (
        <VStack modifiers={[padding({ all: 12 })]}>
          <Image systemName={top} color={topHue} size={28} />
        </VStack>
      ),
      expandedTrailing: (
        <VStack modifiers={[padding({ all: 12 })]}>
          <Text modifiers={[font({ size: 15, weight: "semibold" }), foregroundStyle(topHue)]}>{headline}</Text>
        </VStack>
      ),
      expandedBottom: <VStack modifiers={[padding({ all: 12 })]}>{rows}</VStack>,
    };
  }
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
        {plan >= 0 ? <Text modifiers={[font({ size: 12 }), monospacedDigit(), foregroundStyle(planColour)]}>{`Session ${plan}%`}</Text> : null}
      </HStack>
    ) : null;
  const status = working ? (
    <VStack spacing={2} alignment="trailing">
      <Text modifiers={[font({ size: 15, weight: "semibold" }), foregroundStyle(hue)]}>{words}</Text>
      <Text date={new Date(props.since)} dateStyle="timer" modifiers={[font({ size: 13 }), monospacedDigit(), foregroundStyle(hue), fixedSize({ horizontal: true }), multilineTextAlignment("trailing")]} />
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
