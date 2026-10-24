import * as SecureStore from "expo-secure-store";
import { loadNotesSeen, saveNotesSeen } from "./prefs";
import { NOTES_UNREADABLE } from "./whatsNew";

jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: jest.fn(), setItemAsync: jest.fn() }));

const get = SecureStore.getItemAsync as jest.Mock;
const set = SecureStore.setItemAsync as jest.Mock;
beforeEach(() => {
  get.mockReset();
  set.mockReset();
});

describe("the build whose notes were shown last", () => {
  it("is nothing before any were shown", async () => {
    get.mockResolvedValue(null);
    expect(await loadNotesSeen()).toBeNull();
  });

  it("is what was saved, on this phone only", async () => {
    await saveNotesSeen("0.1.0-15");
    expect(set).toHaveBeenCalledWith("lantern.notes-seen", "0.1.0-15", expect.objectContaining({ keychainAccessible: 6 }));
    get.mockResolvedValue("0.1.0-15");
    expect(await loadNotesSeen()).toBe("0.1.0-15");
  });

  it("counts as everything shown when it can't be read, so the notes never come back at every launch", async () => {
    get.mockRejectedValue(new Error("locked"));
    expect(await loadNotesSeen()).toBe(NOTES_UNREADABLE);
  });

  it("is only not remembered when it can't be saved", async () => {
    set.mockRejectedValue(new Error("full"));
    await expect(saveNotesSeen("0.1.0-15")).resolves.toBeUndefined();
  });
});
