import type { ReactNode } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { LockCover } from "../shell/LockCover";
import { useLockState } from "../shell/lockContext";

/**
 * iOS's own page sheet: the screen behind steps back, and a swipe down puts it away (`onClose`, as the system's back does
 * elsewhere). A sheet is a Modal of its own, so where it is on top the app lock's cover is drawn in it too.
 */
export function PageSheet({ visible = true, onClose, children }: { visible?: boolean; onClose: () => void; children: ReactNode }) {
  const lock = useLockState();
  const covered = lock.ready && (lock.locked || lock.covered);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]} onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView edges={["left", "right"]} style={{ flex: 1 }}>
          {children}
        </SafeAreaView>
        {covered && (
          <View style={StyleSheet.absoluteFill}>
            <LockCover />
          </View>
        )}
      </SafeAreaProvider>
    </Modal>
  );
}
