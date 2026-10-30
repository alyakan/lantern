import { useEffect, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Txt } from "../ui/components";
import { movePanes } from "../ui/motion";
import { CrossFade, Rise } from "../ui/Presence";
import { space, useColors } from "../ui/theme";
import { loadChangesShare, saveChangesShare } from "../prefs";
import { useSyncState } from "../shell/hooks";
import { emptyView } from "../sync/reducer";
import { changedFileOf, changedFiles } from "../view/changes";
import { CHANGES_SHARE, changesWidth, COLUMN_MAX, hasRoomForChanges, shareOf } from "../view/layout";
import { useMacCan } from "../shell/useControls";
import { ArtifactsPane } from "./ArtifactsPane";
import { TodosPane } from "./TodosPane";
import { ChangesDock, type DockMode } from "./ChangesDock";
import { ChangesPane } from "./ChangesPane";
import { PanelMenu, type Panel } from "./PanelMenu";
import { keepPanel, panelOf } from "../view/panelChoice";
import { ChatScreen } from "./ChatScreen";
import { DecideScreen } from "./DecideScreen";

/** The widest a decision goes: it is a card to read and swipe, not a page. */
const DECISION_MAX = 560;

export interface TabletDetailProps {
  /** The chat to show; none asks to pick one. */
  slot: string | null;
  /** The prompt being decided in that chat, shown over it. */
  decide: { slot: string; requestId: string } | null;
  /** Whether the chats are beside the chat ("split") or away until asked for ("overlay"). */
  layout: "overlay" | "split";
  /** The chats are slid in over the chat: they have a button of their own then, and the chat's is under them. */
  chatsOpen: boolean;
  onShowChats: () => void;
  onBack: () => void;
  onReview: (slot: string, requestId: string) => void;
  /** The Done page's "Start something new", on the chat's project (its folder's name). */
  onStartNew?: (project: string | null) => void;
}

/**
 * What a tablet shows beside the chats: the chat they picked, in a column that reads well, or a word to pick one. Nothing here
 * cuts from one thing to the next: another chat is under the last as it fades away, the Changes pane slides in and out at the
 * right with the chat making room for it, and a decision rises over its chat and goes back down.
 *
 * Beside the chat the Changes take half the width at first; their divider drags them wider or narrower, and that share is
 * remembered. Their own button floats them over the chat as a big card, and puts them back.
 */
export function TabletDetail({ slot, decide, layout, chatsOpen, onShowChats, onBack, onReview, onStartNew }: TabletDetailProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const { views, chats } = useSyncState();
  // With the chats away and the window wide enough, the files the chat has changed are beside it, and the chat's Changes button
  // shows or hides them. Otherwise that button opens them in a sheet over the chat.
  const [changesOpen, setChangesOpen] = useState(true);
  const [floating, setFloating] = useState(false);
  const changed = slot ? changedFiles((views[slot] ?? emptyView).items) : [];
  // What the pane shows: the chat's changes, (a Mac that lists "artifacts") its folder's artifacts, or (one that lists "todos")
  // its project's to-do list, picked from the pane's title or the chat bar's To-dos.
  const canArtifacts = useMacCan("artifacts");
  const canTodos = useMacCan("todos");
  // Each chat's own: the one picked in it the last time it was on screen.
  const [picked, setPicked] = useState<{ slot: string | null; panel: Panel }>(() => ({ slot, panel: panelOf(slot) }));
  const panel = picked.slot === slot ? picked.panel : panelOf(slot);
  const setPanel = (p: Panel) => {
    keepPanel(slot, p);
    setPicked({ slot, panel: p });
  };
  const showing: Panel = panel === "artifacts" && canArtifacts ? "artifacts" : panel === "todos" && canTodos ? "todos" : "changes";
  // The pane stays once artifacts or to-dos were picked, even back on Changes with none: the menu is in it.
  const [otherPicked, setOtherPicked] = useState(false);
  const pick = (p: Panel) => {
    if (p !== "changes") setOtherPicked(true);
    setPanel(p);
  };
  const room = hasRoomForChanges(layout, win.width) && (changed.length > 0 || otherPicked || showing !== "changes");
  const project = (slot && chats.find((c) => c.slot === slot)?.project) || null;
  const mode: DockMode = !slot || !room || !changesOpen ? "hidden" : floating ? "float" : "dock";
  // The room this has (the window, less the chats when they are beside it), as laid out.
  const [size, setSize] = useState({ width: win.width, height: win.height });
  // The pane's share of that width beside the chat: half until dragged, then what it was dragged to (remembered). The saved
  // one arrives a moment after the screen; a drag before then wins.
  const [share, setShare] = useState(CHANGES_SHARE);
  const touched = useRef(false);
  useEffect(() => {
    let live = true;
    void loadChangesShare().then((saved) => live && saved !== null && !touched.current && setShare(saved));
    return () => {
      live = false;
    };
  }, []);
  const [resizing, setResizing] = useState(false);
  const paneWidth = changesWidth(share, size.width);
  const resizeTo = (w: number) => {
    touched.current = true;
    setShare(shareOf(w, size.width));
  };
  const toggleChanges = (open: boolean) => {
    movePanes();
    setChangesOpen(open);
  };
  // A file link tapped in the chat: one of the files it changed is shown in the pane (brought back if it was put away), not in a
  // sheet over the chat with the pane right beside it.
  const [focus, setFocus] = useState<{ path: string; n: number } | undefined>(undefined);
  useEffect(() => setFocus(undefined), [slot]);
  const showFile = (link: string) => {
    const path = room ? changedFileOf(changed, link) : null;
    if (!path) return false;
    setFocus((f) => ({ path, n: (f?.n ?? 0) + 1 }));
    setPanel("changes");
    if (!changesOpen) toggleChanges(true);
    return true;
  };
  const toggleFloat = () => {
    movePanes();
    setFloating((f) => !f);
  };
  // The chat bar's To-dos: the pane on the to-dos wherever the window has room for it, even a chat that changed nothing yet.
  const showTodos = hasRoomForChanges(layout, win.width)
    ? () => {
        movePanes();
        pick("todos");
        setChangesOpen(true);
      }
    : undefined;
  const main = slot ? (
    <View style={{ flex: 1, width: "100%", maxWidth: COLUMN_MAX, alignSelf: "center" }}>
      {/* Keyed by the chat: another chat is a new screen, which follows its own events and keeps nothing of the last one's. */}
      <ChatScreen key={slot} slot={slot} resizing={resizing} changesPane={room ? { shown: changesOpen, onToggle: () => toggleChanges(!changesOpen), onFile: showFile } : undefined} onTodos={showTodos} lead={layout === "split" ? "none" : "sidebar"} leadHidden={chatsOpen} onSidebar={onShowChats} onBack={onBack} onReview={(requestId) => onReview(slot, requestId)} onStartNew={onStartNew} />
    </View>
  ) : (
    <View testID="pick-a-chat" style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, paddingTop: insets.top, gap: 12 }}>
      <Txt variant="heading">Pick a chat</Txt>
      <Txt variant="body" tone="ink2" style={{ textAlign: "center" }}>
        {layout === "split" ? "Choose one from the list, or start a new one." : "Open the list of chats, then choose one or start a new one."}
      </Txt>
      {layout === "overlay" && <Button label="Show chats" onPress={onShowChats} />}
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }} onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
      <View style={{ flex: 1, marginRight: mode === "dock" ? paneWidth : 0 }}>
        {/* Each screen has the paper under it, so the one going hides the one coming until it has faded. */}
        <CrossFade id={slot ?? ""}>
          <View style={{ flex: 1, backgroundColor: colors.paper }}>{main}</View>
        </CrossFade>
      </View>
      <ChangesDock
        mode={mode}
        width={paneWidth}
        room={{ ...size, top: insets.top, bottom: insets.bottom }}
        onScrim={() => toggleChanges(false)}
        onResizeStart={() => setResizing(true)}
        onResize={resizeTo}
        onResizeEnd={() => {
          setResizing(false);
          void saveChangesShare(shareOf(paneWidth, size.width));
        }}
        onStep={(dir) => {
          const next = shareOf(paneWidth + dir * size.width * 0.05, size.width);
          touched.current = true;
          movePanes();
          setShare(next);
          void saveChangesShare(next);
        }}
        share={`${Math.round((paneWidth / size.width) * 100)}%`}
      >
        {slot && (
          <CrossFade id={slot}>
            <View style={{ flex: 1, backgroundColor: colors.card }}>
              {showing === "artifacts" ? (
                <ArtifactsPane key={slot} slot={slot} onHide={() => toggleChanges(false)} title={<PanelMenu value="artifacts" artifacts todos={canTodos} onPick={pick} />} float={{ floating, onToggle: toggleFloat }} />
              ) : showing === "todos" ? (
                <TodosPane key={slot} projectName={project} onHide={() => toggleChanges(false)} title={<PanelMenu value="todos" artifacts={canArtifacts} todos onPick={pick} />} float={{ floating, onToggle: toggleFloat }} />
              ) : (
                <ChangesPane key={slot} slot={slot} focus={focus} onHide={() => toggleChanges(false)} title={canArtifacts || canTodos ? <PanelMenu value="changes" artifacts={canArtifacts} todos={canTodos} onPick={pick} /> : undefined} float={{ floating, onToggle: toggleFloat }} />
              )}
            </View>
          </CrossFade>
        )}
      </ChangesDock>
      <Rise testID="decision-pane" shown={!!decide} style={{ backgroundColor: colors.night }}>
        {decide && (
          <View style={{ flex: 1, width: "100%", maxWidth: DECISION_MAX, alignSelf: "center" }}>
            <DecideScreen key={decide.requestId} slot={decide.slot} requestId={decide.requestId} onClose={onBack} />
          </View>
        )}
      </Rise>
    </View>
  );
}
