import { useEffect } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EMBER, useRegular } from "./accent";
import { Txt } from "./components";
import { FadeSlideIn, PressScale } from "./motion";
import { useColors } from "./theme";

export interface ToastShown {
  /** A new one each time, so a second toast about the same chat starts over. */
  id: number;
  slot: string;
  kind: "done" | "needs";
  title: string;
  project: string | null;
}

/** How long a toast stays: one that needs you waits a little longer. */
export const TOAST_MS = { done: 5000, needs: 8000 } as const;

/**
 * A chat that finished, or needs you, while you were looking at something else: a card at the top that says so, and goes by
 * itself. Pressing it opens the chat.
 */
export function ChatToast({ toast, onOpen, onDone }: { toast: ToastShown | null; onOpen: (slot: string) => void; onDone: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const regular = useRegular();
  const id = toast?.id;
  const kind = toast?.kind;
  useEffect(() => {
    if (id === undefined || !kind) return;
    const t = setTimeout(onDone, TOAST_MS[kind]);
    return () => clearTimeout(t);
  }, [id, kind, onDone]);
  if (!toast) return null;
  const needs = toast.kind === "needs";
  const what = needs ? "Needs you" : "Finished";
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 6, left: 16, right: 16, alignItems: "center" }}>
      <FadeSlideIn key={toast.id} from={-12} ms={220}>
        <PressScale
          accessibilityRole="alert"
          accessibilityLabel={`${toast.title}: ${what.toLowerCase()}`}
          accessibilityHint="Opens the chat"
          onPress={() => {
            onDone();
            onOpen(toast.slot);
          }}
          haptic="select"
          scaleTo={0.98}
          style={{ flexDirection: "row", alignItems: "center", gap: 10, maxWidth: 420, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.rule, shadowColor: "#000", shadowOpacity: 0.14, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 4 }}
        >
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: needs ? (regular ? EMBER : colors.hi) : colors.go }} />
          <View style={{ flexShrink: 1 }}>
            <Txt variant="small" style={{ fontWeight: "700" }} numberOfLines={1}>
              {toast.title}
            </Txt>
            <Txt variant="small" tone="ink2" numberOfLines={1}>
              {toast.project ? `${what} · ${toast.project}` : what}
            </Txt>
          </View>
        </PressScale>
      </FadeSlideIn>
    </View>
  );
}
