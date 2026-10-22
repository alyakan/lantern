import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { Button, Txt } from "../ui/components";
import { DarkLantern } from "../ui/lanterns";
import { space, useColors } from "../ui/theme";
import { useAppLock, useLockState } from "./lockContext";

/**
 * What covers the app: the lock screen while it is locked, and the app's own plain colour while it is only covered (before the
 * setting is read, or while the app switcher takes its picture), so nothing flashes and no chat shows. It is drawn by the
 * lock's Modal and also inside every sheet, so whichever of them is on top at that moment shows it.
 */
export function LockCover() {
  const lock = useAppLock();
  const colors = useColors();
  const { ready, locked, authenticating, method, problem } = useLockState();
  const lockedNow = ready && locked;
  return (
    <View style={{ flex: 1, backgroundColor: lockedNow ? colors.night : colors.paper, alignItems: "center", justifyContent: "center", padding: space.xl }}>
      {lockedNow && (
        <>
          <StatusBar style="light" />
          <DarkLantern />
          <Txt variant="title" tone="white" style={{ textAlign: "center" }} accessibilityRole="header">
            Lantern is locked
          </Txt>
          <Txt variant="body" tone="night" style={{ textAlign: "center", marginTop: 8, marginBottom: 22 }}>
            Unlock to see your chats and answer what Claude asks.
          </Txt>
          {problem && (
            <Txt variant="small" tone="night-stop" accessibilityRole="alert" style={{ textAlign: "center", marginBottom: 12 }}>
              {problem}
            </Txt>
          )}
          <Button label={`Unlock with ${method}`} kind="hi" disabled={authenticating} onPress={() => void lock.unlock()} style={{ alignSelf: "stretch" }} />
        </>
      )}
    </View>
  );
}
