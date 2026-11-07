import * as SecureStore from "expo-secure-store";
import { loadTheme, saveTheme } from "./prefs";

jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: jest.fn(), setItemAsync: jest.fn() }));

const get = SecureStore.getItemAsync as jest.Mock;
const set = SecureStore.setItemAsync as jest.Mock;
beforeEach(() => {
  get.mockReset();
  set.mockReset();
});

describe("the theme this phone draws in", () => {
  it("follows the iPhone when nothing was chosen, what was saved is not a theme, or it can't be read", async () => {
    get.mockResolvedValue(null);
    expect(await loadTheme()).toBe("system");
    get.mockResolvedValue("fallout");
    expect(await loadTheme()).toBe("system");
    get.mockRejectedValue(new Error("locked"));
    expect(await loadTheme()).toBe("system");
  });

  it("is what was chosen, on this phone only", async () => {
    await saveTheme("rose");
    expect(set).toHaveBeenCalledWith("lantern.theme", "rose", expect.objectContaining({ keychainAccessible: 6 }));
    get.mockResolvedValue("rose");
    expect(await loadTheme()).toBe("rose");
    get.mockResolvedValue("latte");
    expect(await loadTheme()).toBe("latte");
  });

  it("is only not remembered when it can't be saved", async () => {
    set.mockRejectedValue(new Error("full"));
    await expect(saveTheme("mocha")).resolves.toBeUndefined();
  });
});
