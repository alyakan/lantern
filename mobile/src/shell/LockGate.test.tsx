import { Text } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AppLock, type AuthResult, type LockMemory, type LockPlatform } from "../lock";
import { connected } from "../test/render";
import { MacSheet } from "../screens/OfflineScreen";
import { Sheet } from "../ui/Sheet";
import { LockContext } from "./lockContext";
import { LockGate } from "./LockGate";

function setup(opts: { enabled?: boolean; results?: AuthResult[]; strength?: "none" | "biometric" } = {}) {
  const results = [...(opts.results ?? [])];
  const asked: string[] = [];
  const platform: LockPlatform = {
    strength: async () => opts.strength ?? "biometric",
    method: async () => "Face ID",
    authenticate: async (reason) => {
      asked.push(reason);
      return results.shift() ?? "ok";
    },
  };
  let on = opts.enabled ?? false;
  const memory: LockMemory = { load: async () => on, save: async (v) => void (on = v) };
  return { lock: new AppLock(platform, memory), asked, saved: () => on };
}

const gate = (lock: AppLock, children = <Text>your chats</Text>) => (
  <LockContext.Provider value={lock}>
    <LockGate>{children}</LockGate>
  </LockContext.Provider>
);

describe("the lock gate", () => {
  it("shows nothing over the app when the lock is off", async () => {
    const { lock } = setup();
    await render(gate(lock));
    await act(async () => lock.start());
    expect(screen.getByText("your chats")).toBeTruthy();
    expect(screen.queryByText("Lantern is locked")).toBeNull();
  });

  it("covers the app and asks for Face ID by itself when it is on, then lets go once it passes", async () => {
    const { lock, asked } = setup({ enabled: true });
    await render(gate(lock));
    await act(async () => lock.start());
    await waitFor(() => expect(asked).toEqual(["Unlock Lantern"]));
    await waitFor(() => expect(screen.queryByText("Lantern is locked")).toBeNull());
    expect(screen.getByText("your chats")).toBeTruthy();
  });

  it("stays locked after Cancel and asks again from its button, once, not in a loop", async () => {
    const { lock, asked } = setup({ enabled: true, results: ["cancelled", "ok"] });
    await render(gate(lock));
    await act(async () => lock.start());
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(screen.getByText("Lantern is locked")).toBeTruthy();
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(asked).toHaveLength(1);
    await fireEvent.press(screen.getByRole("button", { name: "Unlock with Face ID" }));
    await waitFor(() => expect(screen.queryByText("Lantern is locked")).toBeNull());
    expect(asked).toHaveLength(2);
  });

  it("says when the check didn't match", async () => {
    const { lock } = setup({ enabled: true, results: ["failed"] });
    await render(gate(lock));
    await act(async () => lock.start());
    await waitFor(() => expect(screen.getByText("That didn't work. Try again.")).toBeTruthy());
  });
});

describe("the lock's switch in the Mac's sheet", () => {
  const sheet = (lock: AppLock) => (
    <LockContext.Provider value={lock}>
      <LockGate>
        <MacSheet state={connected} onClose={jest.fn()} onUnpair={jest.fn()} />
      </LockGate>
    </LockContext.Provider>
  );

  it("turns the lock on after a check, and off after another", async () => {
    const { lock, asked, saved } = setup();
    await render(sheet(lock));
    await act(async () => lock.start());
    const toggle = screen.getByLabelText("Lock with Face ID");
    await fireEvent(toggle, "valueChange", true);
    await waitFor(() => expect(saved()).toBe(true));
    expect(asked).toHaveLength(1);
    await fireEvent(screen.getByLabelText("Lock with Face ID"), "valueChange", false);
    await waitFor(() => expect(saved()).toBe(false));
    expect(asked).toHaveLength(2);
  });

  it("is off-limits, with the reason, on a phone with no passcode", async () => {
    const { lock } = setup({ strength: "none" });
    await render(sheet(lock));
    await act(async () => lock.start());
    expect(screen.getByLabelText("Lock with Face ID").props.disabled).toBe(true);
    expect(screen.getByText("Set a passcode on this phone to use this.")).toBeTruthy();
  });
});

describe("the lock and a sheet", () => {
  it("puts the sheet away when the app locks: a sheet sized to its content can't hide the app around it", async () => {
    const { lock } = setup({ enabled: true, results: ["cancelled"] });
    const onClose = jest.fn();
    await render(
      <LockContext.Provider value={lock}>
        <Sheet onClose={onClose}>{() => <Text>the sheet</Text>}</Sheet>
      </LockContext.Provider>,
    );
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => lock.start());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("leaves it open when the lock is off", async () => {
    const { lock } = setup();
    const onClose = jest.fn();
    await render(
      <LockContext.Provider value={lock}>
        <Sheet onClose={onClose}>{() => <Text>the sheet</Text>}</Sheet>
      </LockContext.Provider>,
    );
    await act(async () => lock.start());
    expect(screen.getByText("the sheet")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
