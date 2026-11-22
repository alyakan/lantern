import type { ReactElement } from "react";
import { Platform } from "react-native";
import { Button, ContextMenu, Host, RNHostView } from "@expo/ui/swift-ui";
import type { SFSymbol } from "sf-symbols-typescript";

export interface MenuItem {
  label: string;
  symbol: SFSymbol;
  onPress: () => void;
}

/**
 * What is held down gets iOS's own pop-up menu (the one Messages and the Claude app have): the message lifts, and each action has
 * its symbol. Elsewhere it is the message, as it was.
 */
export function MessageMenu({ items, children }: { items: MenuItem[]; children: ReactElement }) {
  if (Platform.OS !== "ios" || items.length === 0) return children;
  return (
    <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
      <ContextMenu>
        <ContextMenu.Items>
          {items.map((item) => (
            <Button key={item.label} label={item.label} systemImage={item.symbol} onPress={item.onPress} />
          ))}
        </ContextMenu.Items>
        <ContextMenu.Trigger>
          <RNHostView matchContents={{ vertical: true }}>{children}</RNHostView>
        </ContextMenu.Trigger>
      </ContextMenu>
    </Host>
  );
}
