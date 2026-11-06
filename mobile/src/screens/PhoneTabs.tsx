/**
 * A phone's bottom screen: the chats, Your work and Insights, one at a time under the tab bar, with the button that starts a chat
 * beside it. A chat opened from any of them is pushed over all of this, tab bar included.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { loadTab, saveTab, type Tab } from "../prefs";
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

export function PhoneTabs({ onComposeNew, ...home }: PhoneTabsProps) {
  const colors = useColors();
  const { waiting, chats, work } = useSyncState();
  const canWork = useMacCan("work");
  const canInsights = useMacCan("insights");
  const [chosen, setChosen] = useState<Tab>("chats");
  useEffect(() => {
    let live = true;
    void loadTab().then((t) => live && setChosen(t));
    return () => {
      live = false;
    };
  }, []);
  // A tab the Mac doesn't have (an older one) is the chats.
  const tab: Tab = (chosen === "work" && !canWork) || (chosen === "insights" && !canInsights) ? "chats" : chosen;
  const pick = (t: Tab) => {
    setChosen(t);
    void saveTab(t);
  };
  const tabs: TabChoice[] = [{ id: "chats", label: "Chats", badge: cards(waiting, chats).length }, ...(canWork ? [{ id: "work" as const, label: "Work", badge: work ? nextSteps(work.items).length : 0 }] : []), ...(canInsights ? [{ id: "insights" as const, label: "Insights" }] : [])];
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      {tab === "work" ? <WorkScreen onOpenChat={home.onOpenChat} tabbed /> : tab === "insights" ? <InsightsScreen top={<Header title="Insights" />} onOpenChat={home.onOpenChat} /> : <HomeScreen {...home} tabbed />}
      <TabBar tabs={tabs} value={tab} onChange={pick} onCompose={() => onComposeNew(false)} onComposeVoice={() => onComposeNew(true)} />
    </View>
  );
}
