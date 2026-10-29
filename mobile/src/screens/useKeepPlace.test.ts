import { act, renderHook } from "@testing-library/react-native";
import { FREEZE_MS, RESTORE_AT_MS, useKeepPlace, type PlaceList } from "./useKeepPlace";

async function rig(first = 12) {
  const list: PlaceList = { getFirstVisibleIndex: jest.fn(() => first), scrollToEnd: jest.fn(), scrollToIndex: jest.fn() };
  const ref = { current: list };
  const hook = await renderHook(() => useKeepPlace(ref));
  const settle = () => act(() => void jest.advanceTimersByTime(Math.max(...RESTORE_AT_MS) + 10));
  return { list, ref, hook, settle };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("keeping the reader's place when the chat's width changes", () => {
  it("puts back the message that was at the top of the screen, when the reader was not at the end", async () => {
    const { list, hook, settle } = await rig(12);
    await act(() => hook.result.current.widthChanged(820));
    await act(() => hook.result.current.remember(false));
    await act(() => hook.result.current.widthChanged(480));
    await settle();
    expect(list.scrollToIndex).toHaveBeenCalledWith({ index: 12, animated: false });
    expect(list.scrollToEnd).not.toHaveBeenCalled();
  });

  it("keeps a reader at the end at the end, which is where a chat is when it opens", async () => {
    const { list, hook, settle } = await rig(40);
    await act(() => hook.result.current.widthChanged(820));
    // Never scrolled: the place is the end.
    await act(() => hook.result.current.widthChanged(480));
    await settle();
    expect(list.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(list.scrollToIndex).not.toHaveBeenCalled();
    await act(() => hook.result.current.remember(true));
    await act(() => hook.result.current.widthChanged(820));
    await settle();
    expect(list.scrollToEnd).toHaveBeenCalledTimes(RESTORE_AT_MS.length * 2);
  });

  it("does it again as the text settles, not once", async () => {
    const { list, hook } = await rig(7);
    await act(() => hook.result.current.widthChanged(820));
    await act(() => hook.result.current.remember(false));
    await act(() => hook.result.current.widthChanged(480));
    await act(() => void jest.advanceTimersByTime(RESTORE_AT_MS[0] + 1));
    expect(list.scrollToIndex).toHaveBeenCalledTimes(1);
    await act(() => void jest.advanceTimersByTime(RESTORE_AT_MS[RESTORE_AT_MS.length - 1]));
    expect(list.scrollToIndex).toHaveBeenCalledTimes(RESTORE_AT_MS.length);
  });

  it("holds still while the width is dragged, and puts the place from before the drag back once at the end", async () => {
    const { list, hook, settle } = await rig(9);
    await act(() => hook.result.current.widthChanged(820));
    await act(() => hook.result.current.remember(false));
    await act(() => hook.result.current.hold(true));
    for (const w of [800, 760, 700, 640]) {
      await act(() => hook.result.current.widthChanged(w));
      // The list moving under the drag is not the reader moving.
      (list.getFirstVisibleIndex as jest.Mock).mockReturnValue(0);
      await act(() => hook.result.current.remember(false));
    }
    await settle();
    expect(list.scrollToIndex).not.toHaveBeenCalled();
    await act(() => hook.result.current.hold(false));
    await settle();
    expect(list.scrollToIndex).toHaveBeenCalledTimes(RESTORE_AT_MS.length);
    expect(list.scrollToIndex).toHaveBeenLastCalledWith({ index: 9, animated: false });
  });

  it("puts nothing back after a drag that ended where it began", async () => {
    const { list, hook, settle } = await rig(9);
    await act(() => hook.result.current.widthChanged(820));
    await act(() => hook.result.current.hold(true));
    await act(() => hook.result.current.widthChanged(700));
    await act(() => hook.result.current.widthChanged(820));
    await act(() => hook.result.current.hold(false));
    await settle();
    expect(list.scrollToEnd).not.toHaveBeenCalled();
    expect(list.scrollToIndex).not.toHaveBeenCalled();
  });

  it("does nothing for the first layout, or for a width that is the same to within a point", async () => {
    const { list, hook, settle } = await rig();
    await act(() => hook.result.current.widthChanged(820));
    await act(() => hook.result.current.widthChanged(820.4));
    await settle();
    expect(list.scrollToEnd).not.toHaveBeenCalled();
    expect(list.scrollToIndex).not.toHaveBeenCalled();
  });

  it("does not take the list's own jump after the change for the reader's place", async () => {
    const { list, hook, settle } = await rig(12);
    await act(() => hook.result.current.widthChanged(820));
    await act(() => hook.result.current.remember(false));
    await act(() => hook.result.current.widthChanged(480));
    // The list jumps as it re-wraps: it says the first message is another one, and that the end is far.
    (list.getFirstVisibleIndex as jest.Mock).mockReturnValue(31);
    await act(() => hook.result.current.remember(false));
    await settle();
    expect(list.scrollToIndex).toHaveBeenLastCalledWith({ index: 12, animated: false });
    // Later, the reader's own scrolling counts again.
    await act(() => void jest.advanceTimersByTime(FREEZE_MS));
    await act(() => hook.result.current.remember(false));
    await act(() => hook.result.current.widthChanged(820));
    await settle();
    expect(list.scrollToIndex).toHaveBeenLastCalledWith({ index: 31, animated: false });
  });

  it("lets go of what it was about to do when the screen goes", async () => {
    const { list, hook } = await rig(5);
    await act(() => hook.result.current.widthChanged(820));
    await act(() => hook.result.current.widthChanged(480));
    await hook.unmount();
    await act(() => void jest.advanceTimersByTime(1000));
    expect(list.scrollToEnd).not.toHaveBeenCalled();
  });
});
