import type { ReactElement } from "react";
import { Platform } from "react-native";
import { Button, ContextMenu, Host, Image, Menu, RNHostView } from "@expo/ui/swift-ui";
import { accessibilityLabel } from "@expo/ui/swift-ui/modifiers";
import type { SFSymbol } from "sf-symbols-typescript";

/** iOS has the pop-up menu; the tests (which hold a message to reach the sheet) and other systems keep the sheet. */
export const nativeMenu = () => Platform.OS === "ios" && !process.env.JEST_WORKER_ID;

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
  if (!nativeMenu() || items.length === 0) return children;
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

/** The three dots under a reply: the same actions, as iOS's menu that opens from the button. */
export function MoreMenu({ items, color }: { items: MenuItem[]; color: string }) {
  return (
    <Host matchContents style={{ minWidth: 44, minHeight: 44 }}>
      <Menu label={<Image systemName="ellipsis" size={18} color={color} />} modifiers={[accessibilityLabel("More")]}>
        {items.map((item) => (
          <Button key={item.label} label={item.label} systemImage={item.symbol} onPress={item.onPress} />
        ))}
      </Menu>
    </Host>
  );
}
