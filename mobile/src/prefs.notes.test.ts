import * as SecureStore from "expo-secure-store";
import { loadNotesSeen, saveNotesSeen } from "./prefs";

jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: jest.fn(), setItemAsync: jest.fn() }));

const get = SecureStore.getItemAsync as jest.Mock;
const set = SecureStore.setItemAsync as jest.Mock;
beforeEach(() => {
  get.mockReset();
  set.mockReset();
});

describe("the newest build whose notes were shown", () => {
  it("is nothing before any were shown", async () => {
    get.mockResolvedValue(null);
    expect(await loadNotesSeen()).toBeNull();
  });

  it("is the build that was saved, on this phone only", async () => {
    await saveNotesSeen(15);
    expect(set).toHaveBeenCalledWith("lantern.notes-seen", "15", expect.objectContaining({ keychainAccessible: 6 }));
    get.mockResolvedValue("15");
    expect(await loadNotesSeen()).toBe(15);
  });

  it("counts as shown when it can't be read or isn't a build, so the notes never come back at every launch", async () => {
    get.mockRejectedValue(new Error("locked"));
    expect(await loadNotesSeen()).toBe(Number.MAX_SAFE_INTEGER);
    get.mockReset();
    get.mockResolvedValue("soon");
    expect(await loadNotesSeen()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("is only not remembered when it can't be saved", async () => {
    set.mockRejectedValue(new Error("full"));
    await expect(saveNotesSeen(15)).resolves.toBeUndefined();
  });
});
