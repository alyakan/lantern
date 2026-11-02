import * as SecureStore from "expo-secure-store";
import { DRAFTS_KEPT, DRAFT_MAX_CHARS, forgetDrafts, loadDraft, resetDrafts, saveDraft } from "./drafts";

// The Keychain, as a map.
const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

beforeEach(() => {
  mockStore.clear();
  resetDrafts();
});

describe("drafts", () => {
  it("keeps what was typed for a chat and gives it back, also after the app restarted", async () => {
    await saveDraft("a", "fix the login bug");
    expect(await loadDraft("a")).toBe("fix the login bug");
    resetDrafts();
    expect(await loadDraft("a")).toBe("fix the login bug");
    expect(await loadDraft("b")).toBe("");
  });

  it("forgets a draft when the box is emptied or sent", async () => {
    await saveDraft("a", "something");
    await saveDraft("a", "   ");
    resetDrafts();
    expect(await loadDraft("a")).toBe("");
    expect([...mockStore.keys()].filter((k) => k.startsWith("lantern.draft."))).toEqual([]);
  });

  it("never keeps a terminal command", async () => {
    await saveDraft("a", "!export TOKEN=abc");
    resetDrafts();
    expect(await loadDraft("a")).toBe("");
    expect(mockStore.size).toBe(1); // only the index, with nothing in it
  });

  it("cuts a very long draft", async () => {
    await saveDraft("a", "x".repeat(DRAFT_MAX_CHARS + 500));
    resetDrafts();
    expect((await loadDraft("a")).length).toBe(DRAFT_MAX_CHARS);
  });

  it("keeps only the newest chats' drafts", async () => {
    for (let n = 0; n < DRAFTS_KEPT + 3; n++) await saveDraft(`chat${n}`, `draft ${n}`);
    resetDrafts();
    expect(await loadDraft("chat0")).toBe("");
    expect(await loadDraft("chat2")).toBe("");
    expect(await loadDraft("chat3")).toBe("draft 3");
    expect(await loadDraft(`chat${DRAFTS_KEPT + 2}`)).toBe(`draft ${DRAFTS_KEPT + 2}`);
    expect([...mockStore.keys()].filter((k) => k.startsWith("lantern.draft.")).length).toBe(DRAFTS_KEPT);
  });

  it("makes a safe key out of any slot", async () => {
    await saveDraft("a/b c:d", "hi");
    expect([...mockStore.keys()].some((k) => k === "lantern.draft.a_b_c_d")).toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalled();
  });

  it("holds a draft in memory when the Keychain can't be written", async () => {
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error("locked"));
    await saveDraft("a", "kept");
    expect(await loadDraft("a")).toBe("kept");
  });
});

describe("forgetDrafts", () => {
  it("removes every draft and the index, so none can come back for another Mac", async () => {
    await saveDraft("a", "one");
    await saveDraft("b", "two");
    await forgetDrafts();
    resetDrafts();
    expect(await loadDraft("a")).toBe("");
    expect(await loadDraft("b")).toBe("");
    expect([...mockStore.keys()]).toEqual([]);
  });
});
