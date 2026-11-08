import { act, renderHook } from "@testing-library/react-native";
import { Platform } from "react-native";
import { useShortcut } from "./useShortcut";

const mockKeys = { setShortcuts: jest.fn(), listeners: new Set<(e: { name: string }) => void>() };

jest.mock("../../modules/composer-keys", () => ({
  ComposerKeys: {
    setEnabled: jest.fn(),
    setShortcuts: (on: boolean) => mockKeys.setShortcuts(on),
    addListener: (_event: string, listener: (e: { name: string }) => void) => {
      mockKeys.listeners.add(listener);
      return { remove: () => mockKeys.listeners.delete(listener) };
    },
  },
}));

const press = (name: string) => act(async () => mockKeys.listeners.forEach((l) => l({ name })));
const setPad = (isPad: boolean) => Object.defineProperty(Platform, "isPad", { value: isPad, configurable: true });

beforeEach(() => {
  mockKeys.setShortcuts.mockClear();
  mockKeys.listeners.clear();
  Platform.OS = "ios";
  setPad(true);
});

describe("useShortcut", () => {
  it("answers its own shortcut only, and turns the keyboard's commands on while any screen listens", async () => {
    const newChat = jest.fn();
    const find = jest.fn();
    const a = await renderHook(() => useShortcut("newChat", newChat));
    const b = await renderHook(() => useShortcut("find", find));
    expect(mockKeys.setShortcuts).toHaveBeenCalledTimes(1);
    expect(mockKeys.setShortcuts).toHaveBeenLastCalledWith(true);
    await press("newChat");
    expect(newChat).toHaveBeenCalledTimes(1);
    expect(find).not.toHaveBeenCalled();
    await a.unmount();
    expect(mockKeys.setShortcuts).toHaveBeenCalledTimes(1);
    await b.unmount();
    expect(mockKeys.setShortcuts).toHaveBeenLastCalledWith(false);
  });

  it("does nothing while not active, or on a phone", async () => {
    const run = jest.fn();
    const { rerender, unmount } = await renderHook(({ active }: { active: boolean }) => useShortcut("escape", run, active), { initialProps: { active: false } });
    await press("escape");
    expect(run).not.toHaveBeenCalled();
    await rerender({ active: true });
    await press("escape");
    expect(run).toHaveBeenCalledTimes(1);
    await unmount();
    setPad(false);
    await renderHook(() => useShortcut("escape", run));
    await press("escape");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
