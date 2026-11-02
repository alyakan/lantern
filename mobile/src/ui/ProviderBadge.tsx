import { View } from "react-native";
import { Txt } from "./components";
import { radius, useColors } from "./theme";

/** The Mac sends a display name; older Claude chats leave it empty. */
export function ProviderBadge({ provider }: { provider?: string | null }) {
  const colors = useColors();
  return (
    <View style={{ flexShrink: 0, maxWidth: "45%", paddingHorizontal: 5, paddingVertical: 1, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.rule }}>
      <Txt variant="tiny" tone="ink2" numberOfLines={1}>{provider || "Claude"}</Txt>
    </View>
  );
}
