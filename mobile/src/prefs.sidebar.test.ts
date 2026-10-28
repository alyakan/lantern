import * as SecureStore from "expo-secure-store";
import { loadSidebarPinned, saveSidebarPinned } from "./prefs";

jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: jest.fn(), setItemAsync: jest.fn() }));

const get = SecureStore.getItemAsync as jest.Mock;
const set = SecureStore.setItemAsync as jest.Mock;
beforeEach(() => {
  get.mockReset();
  set.mockReset();
});

describe("whether a tablet keeps the chats pinned beside the chat", () => {
  it("is not pinned until it is chosen, and when it can't be read", async () => {
    get.mockResolvedValue(null);
    expect(await loadSidebarPinned()).toBe(false);
    get.mockRejectedValue(new Error("locked"));
    expect(await loadSidebarPinned()).toBe(false);
  });

  it("is what was chosen, on this tablet only", async () => {
    await saveSidebarPinned(true);
    expect(set).toHaveBeenCalledWith("lantern.sidebar-pinned", "1", expect.objectContaining({ keychainAccessible: 6 }));
    get.mockResolvedValue("1");
    expect(await loadSidebarPinned()).toBe(true);
    await saveSidebarPinned(false);
    expect(set).toHaveBeenLastCalledWith("lantern.sidebar-pinned", "0", expect.anything());
    get.mockResolvedValue("0");
    expect(await loadSidebarPinned()).toBe(false);
  });

  it("is only not remembered when it can't be saved", async () => {
    set.mockRejectedValue(new Error("full"));
    await expect(saveSidebarPinned(true)).resolves.toBeUndefined();
  });
});
