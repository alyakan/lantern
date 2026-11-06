/**
 * A phone's bottom screen: the chats, Your work and Insights, one at a time under the tab bar, with the button that starts a chat
 * beside it. A chat opened from any of them is pushed over all of this, tab bar included.
 */
import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { loadTab, saveTab, type Tab } from "../prefs";
import { known } from "../prefsKnown";
import { useSyncState } from "../shell/hooks";
import { useMacCan } from "../shell/useControls";
import { TabBar, type TabChoice } from "../ui/TabBar";
import { TopBar } from "../ui/TopBar";
import { Txt } from "../ui/components";
import { useColors } from "../ui/theme";
import { cards } from "../view/home";
import { nextSteps } from "../view/work";
import { HomeScreen, type HomeProps } from "./HomeScreen";
import { InsightsScreen } from "./InsightsScreen";
import { WorkScreen } from "./WorkScreen";
import { badgeCount, markWorkSeen, stepId, useWorkBadge } from "../workBadge";

export interface PhoneTabsProps extends Omit<HomeProps, "selectedSlot" | "pinned" | "onTogglePin" | "onOpenWork" | "workShown"> {
  /** The compose button: typed, or (held down) by talking. */
  onComposeNew: (voice: boolean) => void;
}

/** A tab's own header: its name in the glass bar the chats have. */
function Header({ title }: { title: string }) {
  return (
    <TopBar>
      <Txt variant="body" accessibilityRole="header" style={{ fontWeight: "700" }}>
        {title}
      </Txt>
    </TopBar>
  );
}

/**
 * A tab once opened stays as it was left while another is shown, as iOS's tab bars keep theirs: where it was scrolled to, what
 * was open in it, and no entrance played again on coming back. The one not shown is out of sight and out of reach.
 */
function Kept({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <View style={[StyleSheet.absoluteFill, { display: shown ? "flex" : "none" }]} accessibilityElementsHidden={!shown} importantForAccessibility={shown ? "auto" : "no-hide-descendants"}>
      {children}
    </View>
  );
}

export function PhoneTabs({ onComposeNew, ...home }: PhoneTabsProps) {
  const colors = useColors();
  const { waiting, chats, work } = useSyncState();
  const canWork = useMacCan("work");
  const canInsights = useMacCan("insights");
  // The tab last used, as read already in this run of the app (so the chats aren't drawn first and then swapped away).
  const [chosen, setChosen] = useState<Tab>(known.tab ?? "chats");
  useEffect(() => {
    if (known.tab !== undefined) return;
    let live = true;
    void loadTab().then((t) => live && setChosen(t));
    return () => {
      live = false;
    };
  }, []);
  // A tab the Mac doesn't have (an older one) is the chats.
  const tab: Tab = (chosen === "work" && !canWork) || (chosen === "insights" && !canInsights) ? "chats" : chosen;
  // The tabs opened so far: only those are drawn (Insights isn't asked for until it is looked at).
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set([tab]));
  if (!opened.has(tab)) setOpened(new Set([...opened, tab]));
  const pick = (t: Tab) => {
    setChosen(t);
    void saveTab(t);
  };
  // Work's badge: the steps waiting, as the phone's setting says (by default only those new since Work was looked at). Looking
  // at Work sees them, and so do steps that come in while it is open.
  const badge = useWorkBadge();
  const steps = work ? nextSteps(work.items).map(stepId) : [];
  const stepsKey = steps.join("\n");
  useEffect(() => {
    if (tab === "work" && work) markWorkSeen(steps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, stepsKey, !!work]);
  const tabs: TabChoice[] = [{ id: "chats", label: "Chats", badge: cards(waiting, chats).length }, ...(canWork ? [{ id: "work" as const, label: "Work", badge: tab === "work" && badge.mode !== "always" ? 0 : badgeCount(badge, steps) }] : []), ...(canInsights ? [{ id: "insights" as const, label: "Insights" }] : [])];
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      {opened.has("chats") && (
        <Kept shown={tab === "chats"}>
          <HomeScreen {...home} tabbed />
        </Kept>
      )}
      {canWork && opened.has("work") && (
        <Kept shown={tab === "work"}>
          <WorkScreen onOpenChat={home.onOpenChat} tabbed />
        </Kept>
      )}
      {canInsights && opened.has("insights") && (
        <Kept shown={tab === "insights"}>
          <InsightsScreen top={<Header title="Insights" />} onOpenChat={home.onOpenChat} />
        </Kept>
      )}
      <TabBar tabs={tabs} value={tab} onChange={pick} onCompose={() => onComposeNew(false)} onComposeVoice={() => onComposeNew(true)} />
    </View>
  );
}
