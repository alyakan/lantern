import { useEffect, useReducer, useState, type ReactNode } from "react";
import { BackHandler, Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ChatScreen } from "../screens/ChatScreen";
import { DecideScreen } from "../screens/DecideScreen";
import { HomeScreen } from "../screens/HomeScreen";
import { NewChatSheet, type Draft } from "../screens/NewChatSheet";
import { MacSheet, OfflineScreen } from "../screens/OfflineScreen";
import { ConfirmLink, PairScreen } from "../screens/PairScreen";
import { AnimatedStack, type StackItem } from "../ui/AnimatedStack";
import { Button, Txt } from "../ui/components";
import { FadeSlideIn } from "../ui/motion";
import { colors, radius, space } from "../ui/theme";
import { rows } from "../view/home";
import type { Controller } from "./controller";
import { ControllerContext, useConnectionState, useController, useSyncState } from "./hooks";
import { atRoot, home, navigate, type NavAction } from "./nav";

export interface RootProps {
  controller: Controller;
  /** A pairing link that arrived by itself (a deep link): confirmed before anything pairs. */
  pendingLink?: string | null;
  onClearLink?: () => void;
  /** A tapped notification named this chat: open it, then say so. */
  openSlot?: string | null;
  onOpened?: () => void;
}

/** Android's "Message a chat": pick which. */
function ChatPicker({ onPick, onClose }: { onPick: (slot: string) => void; onClose: () => void }) {
  const { chats } = useSyncState();
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" transparent onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close" style={{ flex: 1, backgroundColor: "#00000066" }} onPress={onClose} />
      <View style={{ maxHeight: "70%", backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingBottom: insets.bottom + space.lg }}>
        <Txt variant="heading" style={{ padding: space.xl, paddingBottom: space.sm }}>
          Message which chat?
        </Txt>
        <ScrollView>
          {rows(chats, Date.now()).map((r) => (
            <Pressable key={r.slot} accessibilityRole="button" accessibilityLabel={r.title} onPress={() => onPick(r.slot)} style={{ paddingHorizontal: space.xl, paddingVertical: 12, minHeight: 52, justifyContent: "center" }}>
              <Txt variant="body" style={{ fontWeight: "600" }}>
                {r.title}
              </Txt>
              {!!r.project && (
                <Txt variant="small" tone="ink2">
                  {r.project}
                </Txt>
              )}
            </Pressable>
          ))}
        </ScrollView>
        <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
          <Button label="Cancel" kind="ghost" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function Screens({ pendingLink, onClearLink, openSlot, onOpened }: Omit<RootProps, "controller">) {
  const controller = useController();
  const connection = useConnectionState();
  const { chats } = useSyncState();
  const [stack, go] = useReducer(navigate, home);
  const [macSheet, setMacSheet] = useState(false);
  const [picking, setPicking] = useState(false);
  // Starting a chat from the phone: the sheet, with a draft when a suggestion made one.
  const [newChat, setNewChat] = useState<Draft | null>(null);

  // A tapped notification opens its chat.
  useEffect(() => {
    if (!openSlot) return;
    go({ type: "jump_to_chat", slot: openSlot });
    onOpened?.();
  }, [openSlot, onOpened]);

  // The system's back button (Android) goes back a screen before it leaves the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (newChat) return setNewChat(null), true;
      if (picking) return setPicking(false), true;
      if (macSheet) return setMacSheet(false), true;
      if (atRoot(stack)) return false;
      go({ type: "back" });
      return true;
    });
    return () => sub.remove();
  }, [stack, macSheet, picking, newChat]);

  const back = () => go({ type: "back" });
  const unpair = async () => {
    setMacSheet(false);
    go({ type: "home" });
    await controller.unpair();
  };

  // A screen that is not part of the stack comes in with a fade, so changing from one to another isn't a cut.
  const fade = (key: string, screen: ReactNode) => (
    <FadeSlideIn key={key} from={0} ms={200} style={{ flex: 1 }}>
      {screen}
    </FadeSlideIn>
  );
  if (pendingLink) return fade("confirm", <ConfirmLink link={pendingLink} onCancel={() => onClearLink?.()} onDone={() => onClearLink?.()} />);
  if (connection.kind === "unpaired") return fade("pair", <PairScreen />);
  if (connection.kind === "connecting" || (connection.kind === "offline" && chats.length === 0)) {
    return fade("offline", <OfflineScreen state={connection} onRetry={() => controller.resume()} onUnpair={unpair} />);
  }

  const items: StackItem[] = stack.map((route, i) => {
    switch (route.name) {
      case "home":
        return { key: `${i}:home`, kind: "push", element: <HomeScreen onOpenChat={(slot) => go({ type: "open_chat", slot })} onReview={(slot, requestId) => go({ type: "review", slot, requestId })} onOpenMac={() => setMacSheet(true)} onCompose={() => setPicking(true)} onNewChat={(draft) => setNewChat(draft ?? { text: "" })} /> };
      case "chat":
        return { key: `${i}:chat:${route.slot}`, kind: "push", element: <ChatScreen slot={route.slot} onBack={back} onReview={(requestId) => go({ type: "review", slot: route.slot, requestId })} /> };
      case "decide":
        return { key: `${i}:decide:${route.requestId}`, kind: "modal", element: <DecideScreen slot={route.slot} requestId={route.requestId} onClose={back} /> };
    }
  });
  return fade(
    "stack",
    <View style={{ flex: 1 }}>
      <AnimatedStack items={items} />
      {macSheet && <MacSheet state={connection} onClose={() => setMacSheet(false)} onUnpair={unpair} />}
      {newChat && (
        <NewChatSheet
          initialText={newChat.text}
          initialProject={newChat.project}
          continueChat={newChat.continueChat}
          onClose={() => setNewChat(null)}
          onStarted={(slot) => {
            setNewChat(null);
            go({ type: "open_chat", slot } satisfies NavAction);
          }}
        />
      )}
      {picking && (
        <ChatPicker
          onClose={() => setPicking(false)}
          onPick={(slot) => {
            setPicking(false);
            go({ type: "open_chat", slot } satisfies NavAction);
          }}
        />
      )}
    </View>,
  );
}

/** The app: which screen is up, from where the connection stands and where the user has been. */
export function Root({ controller, ...rest }: RootProps) {
  return (
    <SafeAreaProvider>
      <ControllerContext.Provider value={controller}>
        <StatusBar style="dark" />
        <Screens {...rest} />
      </ControllerContext.Provider>
    </SafeAreaProvider>
  );
}
