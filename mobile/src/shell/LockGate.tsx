import { useEffect, useRef, type ReactNode } from "react";
import { Modal } from "react-native";
import { LockCover } from "./LockCover";
import { useAppLock, useLockState } from "./lockContext";

/**
 * What stands between the app and whoever holds the phone, when the lock is on: the app is always there underneath (so the
 * connection and the chats carry on), and this covers it. It is a Modal over the app, and every sheet draws the same cover
 * inside itself (a Modal can't always be shown over another: iOS presents one at a time, and Android shows the newest on
 * top), so the app is covered whichever is on top. It also covers the app while the phone takes its picture for the app
 * switcher.
 */
export function LockGate({ children }: { children: ReactNode }) {
  const lock = useAppLock();
  const { ready, locked, covered } = useLockState();
  const shown = !ready || locked || covered;
  // Asked once each time the app locks, as it comes to the front; after Cancel, the button asks again.
  const asked = useRef(false);
  useEffect(() => {
    if (!locked) asked.current = false;
    else if (ready && !covered && !asked.current) {
      asked.current = true;
      void lock.unlock();
    }
  }, [locked, ready, covered, lock]);
  return (
    <>
      {children}
      <Modal visible={shown} animationType="none" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={() => {}}>
        <LockCover />
      </Modal>
    </>
  );
}
