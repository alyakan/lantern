import { useState } from "react";
import { View } from "react-native";
import type { RemoteDeskCard } from "../protocol/generated/RemoteDeskCard";
import { useSyncState } from "../shell/hooks";
import { Txt } from "../ui/components";
import { ProviderBadge } from "../ui/ProviderBadge";
import { PressScale } from "../ui/motion";
import { useColors } from "../ui/theme";
import { ago } from "../view/home";
import { firstSentence } from "../view/desk";

/** How many finished answers show before "Show more". */
const FINISHED_SHOWN = 3;

/** What finished on the Mac lately, one quiet line each, newest first: a few, the rest on asking. A line opens its chat. It sits under
 * what needs you on the Chats tab (the phone has no Desk). */
export function JustFinished({ list, onOpen }: { list: RemoteDeskCard[]; onOpen: (slot: string) => void }) {
  const colors = useColors();
  const { chats } = useSyncState();
  const [all, setAll] = useState(false);
  if (list.length === 0) return null;
  const shown = all ? list : list.slice(0, FINISHED_SHOWN);
  const now = Date.now();
  return (
    <View accessibilityLabel="Just finished" style={{ gap: 2 }}>
      <Txt variant="small" tone="ink3" style={{ fontWeight: "700", marginBottom: 4 }}>
        Just finished
      </Txt>
      {shown.map((c) => {
        const bad = c.outcome !== "done";
        const line = c.said ? firstSentence(c.said) : c.outcome === "failed" ? "Failed" : c.outcome === "stopped" ? "Stopped" : "";
        return (
          <PressScale key={c.key} accessibilityRole="button" accessibilityLabel={`${c.title}: ${c.said || c.asked}`} accessibilityHint="Opens the chat" onPress={() => onOpen(c.slot)} scaleTo={0.98} style={{ flexDirection: "row", alignItems: "baseline", gap: 10, paddingVertical: 7 }}>
            <Txt variant="small" style={{ fontWeight: "700", color: bad ? colors.stop : colors.go, width: 14 }}>
              {c.outcome === "done" ? "✓" : c.outcome === "failed" ? "✕" : "■"}
            </Txt>
            <Txt variant="small" tone="ink2" numberOfLines={1} style={{ flex: 1 }}>
              <Txt variant="small" style={{ fontWeight: "700" }}>
                {c.title}
              </Txt>
              {line ? <Txt variant="small" tone={bad ? "stop" : "ink2"}>{`: ${line}`}</Txt> : null}
            </Txt>
            {chats.some((chat) => chat.slot === c.slot) && <ProviderBadge provider={chats.find((chat) => chat.slot === c.slot)?.provider} />}
            {c.at !== null && (
              <Txt variant="tiny" tone="ink3">
                {ago(c.at, now)}
              </Txt>
            )}
          </PressScale>
        );
      })}
      {list.length > FINISHED_SHOWN && (
        <PressScale accessibilityRole="button" onPress={() => setAll(!all)} hitSlop={8} style={{ alignSelf: "flex-start", paddingVertical: 4 }}>
          <Txt variant="small" tone="cobalt" style={{ fontWeight: "600" }}>
            {all ? "Show fewer" : `Show ${list.length - FINISHED_SHOWN} more`}
          </Txt>
        </PressScale>
      )}
    </View>
  );
}
