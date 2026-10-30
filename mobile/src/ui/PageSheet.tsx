import type { ReactNode } from "react";
import { Modal, StyleSheet, View } from "react-native";
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
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {children}
      {covered && (
        <View style={StyleSheet.absoluteFill}>
          <LockCover />
        </View>
      )}
    </Modal>
  );
}
