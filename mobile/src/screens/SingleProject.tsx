import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RemoteChat } from "../protocol/generated/RemoteChat";
import type { RemoteProject } from "../protocol/generated/RemoteProject";
import type { RemoteSingle } from "../protocol/generated/RemoteSingle";
import { useController } from "../shell/hooks";
import { Txt } from "../ui/components";
import { PressScale } from "../ui/motion";
import { Sheet } from "../ui/Sheet";
import { radius, space, useColors } from "../ui/theme";
import { projectColorOf } from "../view/home";

/** A target: one project at a time. Drawn as a ring with a dot, in `color`. */
export function FocusGlyph({ color, size = 16 }: { color: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1.5, borderColor: color, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: size * 0.38, height: size * 0.38, borderRadius: size, backgroundColor: color }} />
    </View>
  );
}

/** The Mac's One project, at the top of Home: its name on its colour, and × to show every project again (on the Mac too). */
export function SingleBanner({ single, onShowAll }: { single: RemoteSingle; onShowAll: () => void }) {
  const colors = useColors();
  const fill = projectColorOf(single.color) ?? colors.ink;
  return (
    <View accessibilityRole="summary" accessibilityLabel={`Only ${single.name}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: space.lg, marginTop: 12, paddingLeft: 14, paddingRight: 6, paddingVertical: 6, minHeight: 44, borderRadius: radius.inner, backgroundColor: fill }}>
      <FocusGlyph color="#ffffff" size={14} />
      <Txt variant="body" numberOfLines={1} style={{ flex: 1, color: "#ffffff", fontWeight: "700" }}>
        {single.name}
      </Txt>
      <PressScale accessibilityRole="button" accessibilityLabel="Show all projects" onPress={onShowAll} hitSlop={8} haptic="select" scaleTo={0.9} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 18 }}>
        <Txt variant="heading" style={{ color: "#ffffff", fontWeight: "500" }}>
          ×
        </Txt>
      </PressScale>
    </View>
  );
}

/**
 * Picking the One project: every project the Mac knows (open or not), each with its colour where a chat of it says one. The Mac
 * does it, and says back what it shows; this closes once it has been asked.
 */
export function SingleSheet({ chats, onDismiss }: { chats: RemoteChat[]; onDismiss: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { sync } = useController();
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    sync.projects().then(
      (all) => live.current && setProjects([...all].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))),
      () => live.current && setProjects([]),
    );
    return () => {
      live.current = false;
    };
  }, [sync]);
  const colorOf = (name: string) => projectColorOf(chats.find((c) => c.project === name)?.project_color) ?? colors.ink3;
  return (
    <Sheet onClose={onDismiss}>
      {(close) => (
        <View style={{ padding: space.xl, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 6, maxHeight: 560 }}>
          <Txt variant="heading" accessibilityRole="header">
            One project
          </Txt>
          <Txt variant="small" tone="ink2" style={{ marginBottom: 8 }}>
            Your Mac and this phone show only its chats, until you show every project again.
          </Txt>
          {problem && (
            <Txt variant="small" tone="stop" accessibilityLiveRegion="polite">
              {problem}
            </Txt>
          )}
          {projects === null ? (
            <Txt variant="small" tone="ink3">
              Asking your Mac…
            </Txt>
          ) : projects.length === 0 ? (
            <Txt variant="small" tone="ink3">
              Your Mac has no projects to pick from yet.
            </Txt>
          ) : (
            <ScrollView style={{ flexGrow: 0 }}>
              {projects.map((p) => (
                <PressScale
                  key={p.id}
                  accessibilityRole="button"
                  accessibilityLabel={p.name}
                  haptic="select"
                  scaleTo={0.98}
                  onPress={() => {
                    setProblem(null);
                    sync.setSingle(p.id).then(close, (e: unknown) => live.current && setProblem(e instanceof Error ? e.message : String(e)));
                  }}
                  style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 4, minHeight: 44 }}
                >
                  <View style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: colorOf(p.name) }} />
                  <Txt variant="body" numberOfLines={1} style={{ flex: 1 }}>
                    {p.name}
                  </Txt>
                </PressScale>
              ))}
            </ScrollView>
          )}
        </View>
      )}
    </Sheet>
  );
}
