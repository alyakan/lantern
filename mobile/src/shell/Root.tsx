import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { BackHandler, Pressable, ScrollView, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ChatScreen } from "../screens/ChatScreen";
import { DecideScreen } from "../screens/DecideScreen";
import { HomeScreen } from "../screens/HomeScreen";
import { NewChatSheet, type Draft } from "../screens/NewChatSheet";
import { MacSheet, OfflineScreen, ReconnectPill } from "../screens/OfflineScreen";
import { RememberChats } from "./RememberChats";
import { PairDeviceSheet } from "../screens/PairDevice";
import { StorageSheet } from "../screens/StorageSheet";
import { ConfirmLink, PairScreen } from "../screens/PairScreen";
import { SupportSheet } from "../screens/SupportSheet";
import { TabletDetail } from "../screens/TabletDetail";
import { WhatsNewSheet } from "../screens/WhatsNewSheet";
import { loadNotesSeen, loadSidebarPinned, saveNotesSeen, saveSidebarPinned } from "../prefs";
import { hasNotes, noteAction, notesId, releaseNotes } from "../whatsNew";
import { AnimatedStack, type StackItem } from "../ui/AnimatedStack";
import { ChatToast, type ToastShown } from "../ui/ChatToast";
import { Button, Txt } from "../ui/components";
import { FadeSlideIn } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { radius, space, useColors } from "../ui/theme";
import { rows } from "../view/home";
import { statusMap, toastIsRedundant, toastNotes, type StatusMap } from "../view/toasts";
import type { Controller } from "./controller";
import { ControllerContext, useConnectionState, useController, useSyncState } from "./hooks";
import { atRoot, decision, home, navigate, shownSlot } from "./nav";
import { TabletShell } from "./TabletShell";
import { useLayout } from "./useLayout";

/** How wide the screens that are words on paper (confirming a link, can't reach the Mac) are on a tablet. */
const NARROW_MAX = 560;

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
  const { chats, workingSince } = useSyncState();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <View style={{ flexShrink: 1, backgroundColor: colors.card, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingBottom: insets.bottom + space.lg }}>
          <Txt variant="heading" style={{ padding: space.xl, paddingBottom: space.sm }}>
            Message which chat?
          </Txt>
          <ScrollView style={{ flexShrink: 1 }}>
            {rows(chats, Date.now(), null, workingSince).map((r) => (
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
            <Button label="Cancel" kind="ghost" onPress={close} />
          </View>
        </View>
      )}
    </Sheet>
  );
}

function Screens({ pendingLink, onClearLink, openSlot, onOpened }: Omit<RootProps, "controller">) {
  const controller = useController();
  const connection = useConnectionState();
  const { chats, chatsLoaded } = useSyncState();
  const [stack, go] = useReducer(navigate, home);
  // A tablet shows the chats beside the chat ("split", when they are pinned) or slides them in over it when asked and away once
  // a chat is chosen ("overlay"); a phone has the stack alone.
  const colors = useColors();
  const layout = useLayout();
  const tablet = layout !== "phone";
  const [chatsOpen, setChatsOpen] = useState(false);
  // Whether the chats are pinned beside the chat: not known (null) until it is read from this tablet's memory.
  const [pinned, setPinned] = useState<boolean | null>(null);
  const shellLayout = tablet && pinned ? "split" : "overlay";
  const listedOnce = useRef(false);
  const [macSheet, setMacSheet] = useState(false);
  // A pairing code for another device, from the Mac sheet.
  const [pairingDevice, setPairingDevice] = useState(false);
  // The Mac's storage, from the Mac sheet.
  const [storageOpen, setStorageOpen] = useState(false);
  // What changed in this build: once after an update, and from the Mac sheet.
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDue, setNotesDue] = useState(false);
  const notesChecked = useRef(false);
  const sawUnpaired = useRef(false);
  // The optional tips, from Home or from the Mac sheet.
  const [supporting, setSupporting] = useState(false);
  const [picking, setPicking] = useState(false);
  // Starting a chat from the phone: the sheet, with a draft when a suggestion made one.
  const [newChat, setNewChat] = useState<Draft | null>(null);

  // A tapped notification opens its chat.
  useEffect(() => {
    if (!openSlot) return;
    go({ type: "jump_to_chat", slot: openSlot });
    setChatsOpen(false);
    onOpened?.();
  }, [openSlot, onOpened]);

  // The chats slid in over the chat stay out of the way once the tablet is turned or resized.
  useEffect(() => setChatsOpen(false), [layout]);

  // Whether they are pinned is remembered on this tablet.
  useEffect(() => {
    let live = true;
    void loadSidebarPinned().then((p) => live && setPinned(p));
    return () => {
      live = false;
    };
  }, []);
  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    void saveSidebarPinned(next);
    // Pinned, they are beside the chat. Unpinned from the list itself, they stay slid in until a chat is chosen.
    setChatsOpen(!next);
  };
  // From the chat's own button: the chats go away entirely, and the chat has the whole width.
  const hideChats = () => {
    setPinned(false);
    void saveSidebarPinned(false);
    setChatsOpen(false);
  };

  // The notes come up once, with Home, after an update. A phone that was unpaired at some point this session was paired just
  // now (a new install: nothing is new to it), so its notes are only marked as shown.
  useEffect(() => {
    if (connection.kind === "unpaired") sawUnpaired.current = true;
  }, [connection.kind]);
  // With chats in hand a lost connection is a pill over them; with none there is nothing to show but the connecting screen.
  const noMac = chats.length === 0 && (connection.kind === "connecting" || connection.kind === "offline");
  const homeUp = !pendingLink && connection.kind !== "unpaired" && !noMac;
  // A tablet that opens on no chat, with the chats not pinned, shows them slid in once, rather than an empty screen to tap.
  useEffect(() => {
    if (listedOnce.current || !tablet || pinned === null || !homeUp) return;
    listedOnce.current = true;
    if (!pinned && !shownSlot(stack)) setChatsOpen(true);
  }, [tablet, pinned, homeUp, stack]);
  useEffect(() => {
    if (notesChecked.current || !homeUp) return;
    notesChecked.current = true;
    void loadNotesSeen().then((seen) => {
      const action = noteAction(releaseNotes, seen, sawUnpaired.current);
      if (action === "mark") void saveNotesSeen(notesId(releaseNotes));
      if (action === "show") setNotesDue(true);
    });
  }, [homeUp]);
  // Never over another sheet, a decision, a chat (a tapped notification can open one at launch) or the tablet's chats sliding
  // in: it waits until they are gone. On a tablet the chats are always a tap away, so a chat open doesn't hold it back there.
  const nothingOpen = !macSheet && !pairingDevice && !storageOpen && !supporting && !picking && !newChat && !decision(stack) && !chatsOpen && (tablet || atRoot(stack));
  useEffect(() => {
    if (!notesDue || !homeUp || !nothingOpen) return;
    setNotesDue(false);
    setNotesOpen(true);
    void saveNotesSeen(notesId(releaseNotes));
  }, [notesDue, homeUp, nothingOpen]);

  // The system's back button (Android) goes back a screen before it leaves the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (notesOpen) return setNotesOpen(false), true;
      if (pairingDevice) return setPairingDevice(false), true;
      if (storageOpen) return setStorageOpen(false), true;
      if (supporting) return setSupporting(false), true;
      if (newChat) return setNewChat(null), true;
      if (picking) return setPicking(false), true;
      if (macSheet) return setMacSheet(false), true;
      if (chatsOpen) return setChatsOpen(false), true;
      if (atRoot(stack)) return false;
      go({ type: "back" });
      return true;
    });
    return () => sub.remove();
  }, [stack, macSheet, picking, newChat, supporting, chatsOpen, pairingDevice, storageOpen, notesOpen]);

  const back = () => go({ type: "back" });
  // A tablet has Home in its chats column, beside the chat or slid in over it, so a chat taken from it replaces the one shown
  // instead of stacking on it (and, slid in, the column goes away).
  const openChat = (slot: string) => {
    go({ type: tablet ? "jump_to_chat" : "open_chat", slot });
    setChatsOpen(false);
  };
  const review = (slot: string, requestId: string) => {
    go({ type: tablet ? "jump_to_review" : "review", slot, requestId });
    setChatsOpen(false);
  };
  const unpair = async () => {
    setMacSheet(false);
    go({ type: "home" });
    await controller.unpair();
  };

  // A chat that finishes or needs you, while the chats' own list isn't there to say so: a toast.
  const [toast, setToast] = useState<ToastShown | null>(null);
  const seenStatus = useRef<StatusMap | null>(null);
  const toastId = useRef(0);
  // The chats' list says so itself when it is beside the chat (pinned) or slid in over it.
  const columnShown = shellLayout === "split" || chatsOpen;
  const watch = useRef({ stack, tablet, columnShown, chats });
  watch.current = { stack, tablet, columnShown, chats };
  useEffect(() => {
    if (!chatsLoaded) return;
    const notes = toastNotes(seenStatus.current, chats).filter((n) => !toastIsRedundant(n.slot, watch.current.stack, watch.current.tablet, watch.current.columnShown));
    seenStatus.current = statusMap(chats);
    // Several at once (a catch-up after being away) show the last: the one most recently in need of you.
    const note = notes[notes.length - 1];
    if (!note) return;
    const chat = chats.find((c) => c.slot === note.slot);
    setToast({ id: ++toastId.current, slot: note.slot, kind: note.kind, title: chat?.title?.trim() || "A chat", project: chat?.project ?? null });
  }, [chats, chatsLoaded]);
  // It goes when what it says is on the screen anyway: the chat was opened, or the chats came in.
  useEffect(() => {
    if (toast && toastIsRedundant(toast.slot, stack, tablet, columnShown)) setToast(null);
  }, [toast, stack, tablet, columnShown]);
  const clearToast = useCallback(() => setToast(null), []);

  // A screen that is not part of the stack comes in with a fade, so changing from one to another isn't a cut. Not the stack itself:
  // its chats are glass (the header, the message box), and under a fade from nothing all of their glass stayed clear, also in a
  // chat opened long after the fade was over (see `FadeSlideIn`'s `glass`). It is just there.
  const fade = (key: string, screen: ReactNode) => (
    <FadeSlideIn key={key} from={0} ms={200} glass={key === "stack"} style={{ flex: 1 }}>
      {screen}
    </FadeSlideIn>
  );
  // The screens before the chats that are words on paper (confirming a link, can't reach the Mac) keep a readable width on a tablet, in the middle.
  const narrow = (screen: ReactNode) =>
    tablet ? (
      <View style={{ flex: 1, backgroundColor: colors.paper }}>
        <View testID="narrow-column" style={{ flex: 1, width: "100%", maxWidth: NARROW_MAX, alignSelf: "center" }}>
          {screen}
        </View>
      </View>
    ) : (
      screen
    );
  if (pendingLink) return fade("confirm", narrow(<ConfirmLink link={pendingLink} onCancel={() => onClearLink?.()} onDone={() => onClearLink?.()} />));
  // The pairing screen is the camera, which has the whole screen on a tablet (it lays out its own words): it is not in the column.
  if (connection.kind === "unpaired") return fade("pair", <PairScreen />);
  if (noMac) {
    return fade("offline", narrow(<OfflineScreen state={connection} onRetry={() => controller.resume()} onUnpair={unpair} onAddress={(text) => controller.useAddress(text)} />));
  }

  const homeScreen = (selectedSlot?: string | null) => <HomeScreen onOpenChat={openChat} onReview={review} onOpenMac={() => setMacSheet(true)} onCompose={() => setPicking(true)} onNewChat={(draft) => setNewChat(draft ?? { text: "" })} onSupport={() => setSupporting(true)} selectedSlot={selectedSlot} pinned={pinned === true} onTogglePin={tablet ? togglePin : undefined} />;
  const items: StackItem[] = tablet
    ? []
    : stack.map((route, i) => {
        switch (route.name) {
          case "home":
            return { key: `${i}:home`, kind: "push", element: homeScreen() };
          case "chat":
            return { key: `${i}:chat:${route.slot}`, kind: "push", element: <ChatScreen slot={route.slot} onBack={back} onReview={(requestId) => go({ type: "review", slot: route.slot, requestId })} /> };
          case "decide":
            return { key: `${i}:decide:${route.requestId}`, kind: "modal", element: <DecideScreen slot={route.slot} requestId={route.requestId} onClose={back} /> };
        }
      });
  const shown = shownSlot(stack);
  const deciding = decision(stack);
  return fade(
    "stack",
    <View style={{ flex: 1 }}>
      {tablet ? (
        <TabletShell layout={shellLayout} open={chatsOpen} onOpen={() => setChatsOpen(true)} onClose={() => setChatsOpen(false)} sidebar={homeScreen(shown)}>
          <TabletDetail slot={shown} decide={deciding} layout={shellLayout} onShowChats={() => setChatsOpen(true)} onHideChats={hideChats} onBack={back} onReview={review} />
        </TabletShell>
      ) : (
        <AnimatedStack items={items} onBack={back} />
      )}
      {macSheet && (
        <MacSheet
          state={connection}
          onClose={() => setMacSheet(false)}
          onUnpair={unpair}
          onSupport={() => {
            setMacSheet(false);
            setSupporting(true);
          }}
          onPairDevice={() => {
            setMacSheet(false);
            setPairingDevice(true);
          }}
          onStorage={() => {
            setMacSheet(false);
            setStorageOpen(true);
          }}
          onWhatsNew={
            hasNotes(releaseNotes)
              ? () => {
                  setMacSheet(false);
                  setNotesOpen(true);
                }
              : undefined
          }
        />
      )}
      <ReconnectPill state={connection} />
      <RememberChats />
      <ChatToast toast={toast} onOpen={openChat} onDone={clearToast} />
      {pairingDevice && <PairDeviceSheet onClose={() => setPairingDevice(false)} />}
      {storageOpen && <StorageSheet onClose={() => setStorageOpen(false)} />}
      {notesOpen && <WhatsNewSheet notes={releaseNotes} onClose={() => setNotesOpen(false)} />}
      {supporting && <SupportSheet onClose={() => setSupporting(false)} />}
      {newChat && (
        <NewChatSheet
          initialText={newChat.text}
          initialProject={newChat.project}
          continueChat={newChat.continueChat}
          onClose={() => setNewChat(null)}
          onStarted={(slot) => {
            setNewChat(null);
            openChat(slot);
          }}
        />
      )}
      {picking && (
        <ChatPicker
          onClose={() => setPicking(false)}
          onPick={(slot) => {
            setPicking(false);
            openChat(slot);
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
        <StatusBar style="auto" />
        <Screens {...rest} />
      </ControllerContext.Provider>
    </SafeAreaProvider>
  );
}
