const mockKept = new Map<string, { value: string; options: unknown }>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "this-device-only",
  getItemAsync: async (k: string) => mockKept.get(k)?.value ?? null,
  setItemAsync: async (k: string, value: string, options: unknown) => void mockKept.set(k, { value, options }),
  deleteItemAsync: async (k: string) => void mockKept.delete(k),
}));

import { secureMacStore } from "./storage";

const mac = { macKey: "k", deviceKey: "d", hosts: ["192.168.1.2"], port: 47123, macName: "Mac" };

describe("the paired Mac, kept on the phone", () => {
  beforeEach(() => mockKept.clear());

  it("is kept on this device only, and comes back as it was", async () => {
    await secureMacStore.save(mac);
    expect(mockKept.get("lantern.paired-mac")?.options).toEqual({ keychainAccessible: "this-device-only" });
    await expect(secureMacStore.load()).resolves.toEqual(mac);
  });

  it("is gone once forgotten, and nothing kept is nothing paired", async () => {
    await expect(secureMacStore.load()).resolves.toBeNull();
    await secureMacStore.save(mac);
    await secureMacStore.forget();
    await expect(secureMacStore.load()).resolves.toBeNull();
  });

  it("a damaged entry reads as not paired", async () => {
    mockKept.set("lantern.paired-mac", { value: "{not json", options: {} });
    await expect(secureMacStore.load()).resolves.toBeNull();
    mockKept.set("lantern.paired-mac", { value: JSON.stringify({ macKey: 1 }), options: {} });
    await expect(secureMacStore.load()).resolves.toBeNull();
  });
});
