import { act, renderHook } from "@testing-library/react-native";
import { Platform } from "react-native";
import { useReturnToSend } from "./useReturnToSend";

const mockKeys = { setEnabled: jest.fn(), remove: jest.fn(), handler: null as null | (() => void) };

jest.mock("../../modules/composer-keys", () => ({
  ComposerKeys: {
    setEnabled: (on: boolean) => mockKeys.setEnabled(on),
    addListener: (_event: string, listener: () => void) => {
      mockKeys.handler = listener;
      return { remove: mockKeys.remove };
    },
  },
}));

const setPad = (isPad: boolean) => Object.defineProperty(Platform, "isPad", { value: isPad, configurable: true });

beforeEach(() => {
  mockKeys.setEnabled.mockClear();
  mockKeys.remove.mockClear();
  mockKeys.handler = null;
  Platform.OS = "ios";
  setPad(true);
});

describe("useReturnToSend", () => {
  it("takes Return over while the message box has the keyboard, and gives it back after", async () => {
    const send = jest.fn();
    const { rerender, unmount } = await renderHook(({ active }: { active: boolean }) => useReturnToSend(active, send), { initialProps: { active: false } });
    expect(mockKeys.setEnabled).not.toHaveBeenCalled();
    await rerender({ active: true });
    expect(mockKeys.setEnabled).toHaveBeenLastCalledWith(true);
    await act(async () => mockKeys.handler?.());
    expect(send).toHaveBeenCalledTimes(1);
    await rerender({ active: false });
    expect(mockKeys.setEnabled).toHaveBeenLastCalledWith(false);
    expect(mockKeys.remove).toHaveBeenCalledTimes(1);
    await rerender({ active: true });
    await unmount();
    expect(mockKeys.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("sends with what is typed at the time of the key, not when the box got the keyboard", async () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = await renderHook(({ send }: { send: () => void }) => useReturnToSend(true, send), { initialProps: { send: first } });
    await rerender({ send: second });
    await act(async () => mockKeys.handler?.());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a phone", async () => {
    setPad(false);
    await renderHook(() => useReturnToSend(true, jest.fn()));
    expect(mockKeys.setEnabled).not.toHaveBeenCalled();
    expect(mockKeys.handler).toBeNull();
  });
});
