import { View } from "react-native";
import { ProviderBadge } from "../ui/ProviderBadge";
import { Button, Tag, Txt } from "../ui/components";
import { FadeSlideIn } from "../ui/motion";
import { radius, shadow, space, useColors } from "../ui/theme";
import { countsOf, diffPreviewOf } from "../view/diffPreview";
import type { Card } from "../view/home";

/** What waits on you, one at a time: the first as a card to open or review, the next two peeking out behind it. */
export function Deck({ list, onOpenChat, onReview }: { list: Card[]; onOpenChat: (slot: string) => void; onReview: (slot: string, requestId: string) => void }) {
  const colors = useColors();
  const front = list[0];
  const behind = Math.min(2, list.length - 1);
  // A file change says how big it is before it is opened.
  const change = diffPreviewOf(front.waiting.tool_name, front.waiting.input);
  return (
    <View style={{ marginHorizontal: space.lg, paddingBottom: 14 }}>
      {behind >= 2 && <View style={{ position: "absolute", left: 14, right: 14, top: 14, bottom: -8, backgroundColor: colors.card, borderRadius: radius.card, opacity: 0.6 }} />}
      {behind >= 1 && <View style={{ position: "absolute", left: 7, right: 7, top: 7, bottom: -2, backgroundColor: colors.card, borderRadius: radius.card, opacity: 0.85 }} />}
      {/* A new card on top (the one before was answered) comes in, instead of the text changing under the eye. */}
      <FadeSlideIn key={front.waiting.request_id} from={12} style={[{ backgroundColor: colors.card, borderRadius: radius.card, padding: 18, gap: 4 }, shadow.card]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Tag>{front.view.tag}</Tag>
          {front.chat && <ProviderBadge provider={front.chat.provider} />}
        </View>
        <Txt variant="heading" style={{ marginTop: 8 }}>
          {front.view.title}
        </Txt>
        <Txt variant="small" tone="ink2">
          {front.from}
        </Txt>
        {front.view.detail && (
          <View style={{ backgroundColor: colors.paper, borderRadius: radius.inner, padding: 10, marginTop: 8 }}>
            <Txt variant="mono" numberOfLines={3}>
              {front.view.detail}
            </Txt>
          </View>
        )}
        {!!change && (
          <Txt variant="small" tone="ink2" testID="deck-change" style={{ marginTop: 6 }}>
            {change.partial ? "At least " : ""}
            {countsOf(change)} lines. Review shows the change.
          </Txt>
        )}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Button label="Open chat" kind="ghost" style={{ flex: 1 }} onPress={() => onOpenChat(front.waiting.slot)} />
          <Button label="Review" style={{ flex: 1 }} onPress={() => onReview(front.waiting.slot, front.waiting.request_id)} />
        </View>
      </FadeSlideIn>
    </View>
  );
}
