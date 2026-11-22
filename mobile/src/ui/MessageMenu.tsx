import type { ReactElement } from "react";
import { Platform, View } from "react-native";
import { Button, ContextMenu, Host, Image, Menu, RNHostView } from "@expo/ui/swift-ui";
import { accessibilityLabel, padding } from "@expo/ui/swift-ui/modifiers";
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

/** How far the dots' touch area reaches beyond the dots on every side: padding inside the menu's label, so the dots themselves stay where the layout puts them. */
const REACH = 12;
/** The empty room the ellipsis symbol (size 18) leaves left and right of its dots, measured on the simulator. */
const BEARING = { left: 1.7, right: 1.7 };
/** The dots' own width and the height of the box they sit in. */
const DOTS = { width: 16.67, height: 18 };

/**
 * The three dots under a message: the same actions, as iOS's menu that opens from the button. The native menu is a SwiftUI
 * view that cannot be told which edge to sit against, so the box it is in has a fixed size and it is placed in the box:
 * "leading" and "trailing" put the dots' own edge (not the symbol's room around it) on the edge of the words or the bubble
 * above; "center" is a 44-point box with the dots in the middle, like the copy icon beside it. The touch area reaches REACH
 * beyond the dots on every side.
 */
export function MoreMenu({ items, color, align = "center" }: { items: MenuItem[]; color: string; align?: "leading" | "center" | "trailing" }) {
  const place = align === "leading" ? { left: -(REACH + BEARING.left) } : align === "trailing" ? { right: -(REACH + BEARING.right) } : { left: 0, right: 0 };
  return (
    <View style={{ width: align === "center" ? 44 : DOTS.width, height: DOTS.height }}>
      <View style={{ position: "absolute", top: -REACH, bottom: -REACH, justifyContent: "center", alignItems: "center", ...place }}>
        <Host matchContents>
          <Menu label={<Image systemName="ellipsis" size={18} color={color} modifiers={[padding({ all: REACH })]} />} modifiers={[accessibilityLabel("More")]}>
            {items.map((item) => (
              <Button key={item.label} label={item.label} systemImage={item.symbol} onPress={item.onPress} />
            ))}
          </Menu>
        </Host>
      </View>
    </View>
  );
}
