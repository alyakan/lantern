import { useEffect, useReducer, useState } from "react";
import { BackHandler, Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ChatScreen } from "../screens/ChatScreen";
import { DecideScreen } from "../screens/DecideScreen";
import { HomeScreen } from "../screens/HomeScreen";
import { MacSheet, OfflineScreen } from "../screens/OfflineScreen";
import { ConfirmLink, PairScreen } from "../screens/PairScreen";
import { Button, Txt } from "../ui/components";
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

  // A tapped notification opens its chat.
  useEffect(() => {
    if (!openSlot) return;
    go({ type: "jump_to_chat", slot: openSlot });
    onOpened?.();
  }, [openSlot, onOpened]);

  // The system's back button (Android) goes back a screen before it leaves the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (picking) return setPicking(false), true;
      if (macSheet) return setMacSheet(false), true;
      if (atRoot(stack)) return false;
      go({ type: "back" });
      return true;
    });
    return () => sub.remove();
  }, [stack, macSheet, picking]);

  const back = () => go({ type: "back" });
  const unpair = async () => {
    setMacSheet(false);
    go({ type: "home" });
    await controller.unpair();
  };

  if (pendingLink) return <ConfirmLink link={pendingLink} onCancel={() => onClearLink?.()} onDone={() => onClearLink?.()} />;
  if (connection.kind === "unpaired") return <PairScreen />;
  if (connection.kind === "connecting" || (connection.kind === "offline" && chats.length === 0)) {
    return <OfflineScreen state={connection} onRetry={() => controller.resume()} onUnpair={unpair} />;
  }

  const route = stack[stack.length - 1];
  return (
    <View style={{ flex: 1 }}>
      {route.name === "home" && <HomeScreen onOpenChat={(slot) => go({ type: "open_chat", slot })} onReview={(slot, requestId) => go({ type: "review", slot, requestId })} onOpenMac={() => setMacSheet(true)} onCompose={() => setPicking(true)} />}
      {route.name === "chat" && <ChatScreen key={route.slot} slot={route.slot} onBack={back} onReview={(requestId) => go({ type: "review", slot: route.slot, requestId })} />}
      {route.name === "decide" && <DecideScreen key={route.requestId} slot={route.slot} requestId={route.requestId} onClose={back} />}
      {macSheet && <MacSheet state={connection} onClose={() => setMacSheet(false)} onUnpair={unpair} />}
      {picking && (
        <ChatPicker
          onClose={() => setPicking(false)}
          onPick={(slot) => {
            setPicking(false);
            go({ type: "open_chat", slot } satisfies NavAction);
          }}
        />
      )}
    </View>
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
